// Stage-aware Linear delivery protocol (STA-186).
//
// Linear status and Progress are the authoritative state; Herdr workspace
// metadata only mirrors them. Every mutation below follows one order:
//
//   validate -> publish receipt/evidence -> readback -> metadata identity
//   -> status/label -> final readback/mirror
//
// There is no transaction between Linear and Herdr, so the order plus the
// submission identity plus read-back is what converges a retry instead of
// duplicating. `Complete` is never shown before its receipt reads back.
//
// Status vocabulary: backlog, todo, build, review, deliver, done.
// Progress vocabulary: pending, in_progress, complete, blocked.
// Todo, Build, Review, Deliver carry exactly one Progress label; Backlog
// and Done carry none. Status says which stage the work is in; Progress
// says how far that stage has come.

import { createHash } from "node:crypto";
import type { LinearClient, LinearComment, LinearIssue, LinearLabel } from "./linear.ts";
import type { ResolvedDispatch, DecisionLog, CommandResult, ClaimSink, ClaimedTicket } from "./claims.ts";
import { WorkspaceSinkError } from "./claims.ts";
import { launchProblems } from "./agents.ts";
import type { CommandWorkspaces, SnapshotWorkspace } from "./workspaces.ts";
import { commanderName } from "./workspaces.ts";
import { cleanupTicketCheckout, ticketWorktree, type GitRunner } from "./worktrees.ts";
import { LinearError } from "./linear.ts";

export type ProtocolStatus = "backlog" | "todo" | "build" | "review" | "deliver" | "done";
export type ProtocolProgress = "pending" | "in_progress" | "complete" | "blocked";

export const STATUSES: ProtocolStatus[] = ["backlog", "todo", "build", "review", "deliver", "done"];
export const PROGRESSES: ProtocolProgress[] = ["pending", "in_progress", "complete", "blocked"];

/** Active stages carry exactly one Progress label. */
export function statusNeedsProgress(status: ProtocolStatus): boolean {
  return status === "todo" || status === "build" || status === "review" || status === "deliver";
}

export interface ProtocolDeps {
  client: LinearClient;
  resolved: ResolvedDispatch;
  workspaces: CommandWorkspaces;
  decisions: DecisionLog;
  git: GitRunner;
  repoRoot: string;
}

export type FullIssue = LinearIssue & { comments: LinearComment[]; labels: LinearLabel[] };

/** A refusal names the current state, the precondition, and the next step. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function isTransientLinearError(error: unknown): boolean {
  return error instanceof LinearError && (error.status === 0 || error.status === 429 || error.status >= 500);
}

// ---------------------------------------------------------------------------
// Acceptance criteria
// ---------------------------------------------------------------------------

const CRITERIA_HEADING = /^#{1,6}\s+.*(驗收條件|acceptance\s+criteri(a|on))/im;
const HEADING_LINE = /^#{1,6}\s+/;
const CHECKLIST_ITEM = /^\s*[-*]\s+\[[ xX]\]\s+(.*\S)\s*$/;

/**
 * Checklist items under the first acceptance-criteria heading, up to the
 * next heading. Empty when the block is absent or holds no items.
 */
export function parseAcceptanceCriteria(description: string | null): string[] {
  if (!description) return [];
  const lines = description.split("\n");
  const start = lines.findIndex((line) => CRITERIA_HEADING.test(line));
  if (start < 0) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (HEADING_LINE.test(line)) break;
    const item = CHECKLIST_ITEM.exec(line)?.[1];
    if (item) items.push(item.trim());
  }
  return items;
}

// ---------------------------------------------------------------------------
// Authoritative state derivation
// ---------------------------------------------------------------------------

export interface AuthoritativeState {
  status: ProtocolStatus;
  /** Null for backlog/done, which carry no Progress. */
  progress: ProtocolProgress | null;
  criteria: string[];
}

/** Map a Linear state id back to the protocol status; null when unknown. */
export function statusOf(resolved: ResolvedDispatch, stateId: string): ProtocolStatus | null {
  for (const status of STATUSES) {
    if (resolved.stateIds[status] === stateId) return status;
  }
  return null;
}

/** Map a Linear label id back to Progress; undefined when not a Progress label. */
export function progressOf(resolved: ResolvedDispatch, labelId: string): ProtocolProgress | undefined {
  for (const progress of PROGRESSES) {
    if (resolved.progress.ids[progress] === labelId) return progress;
  }
  return undefined;
}

/**
 * Derive the authoritative (status, progress) pair from a fully read
 * issue. Throws ProtocolError on an unknown status, on multiple Progress
 * labels, or on a missing/extra Progress label for the status.
 */
export function deriveState(resolved: ResolvedDispatch, full: FullIssue): AuthoritativeState {
  const status = statusOf(resolved, full.state.id);
  if (!status) {
    throw new ProtocolError(
      `refused: ${full.identifier} sits in unknown Linear status "${full.state.name}"; ` +
        `expected one of ${STATUSES.map((s) => resolved.config.states[s]).join(", ")}`,
    );
  }
  const found = (full.labels ?? [])
    .map((l) => progressOf(resolved, l.id))
    .filter((p): p is ProtocolProgress => p !== undefined);
  if (found.length > 1) {
    throw new ProtocolError(
      `refused: ${full.identifier} carries ${found.length} Progress labels (${found.join(", ")}); ` +
        `an owner must leave exactly one before any workspace command runs`,
    );
  }
  const progress = found[0] ?? null;
  if (statusNeedsProgress(status) && !progress) {
    throw new ProtocolError(
      `refused: ${full.identifier} is ${resolved.config.states[status]} with no Progress label; ` +
        `dispatch normalizes it to ${resolved.config.progress.pending} first`,
    );
  }
  if (!statusNeedsProgress(status) && progress) {
    throw new ProtocolError(
      `refused: ${full.identifier} is ${resolved.config.states[status]} but still carries Progress ` +
        `"${progress}"; dispatch clears Progress on arrival here`,
    );
  }
  return { status, progress, criteria: parseAcceptanceCriteria(full.description) };
}

// ---------------------------------------------------------------------------
// Receipts and submission identity
// ---------------------------------------------------------------------------

export const RECEIPT_SOURCE = "igniter";
export const RECEIPT_METADATA_VERSION = 1;

export type ReceiptKind = "build" | "review-pass" | "review-fail" | "deliver";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
  return `{${entries.join(",")}}`;
}

/** Submission identity: same ticket, stage, checkpoint, and payload, same id. */
export function submissionId(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex").slice(0, 16);
}

export const RECEIPT_VERSION = 1;

const RECEIPT_KINDS: ReceiptKind[] = ["build", "review-pass", "review-fail", "deliver"];

/**
 * The machine-readable receipt tail of every receipt comment: one fenced
 * YAML block after the human report. Owners and Herdr read the same block;
 * no hidden HTML marker is written anymore. Old HTML receipts stay in
 * history but are never parsed back into state.
 */
export function receiptBlock(kind: ReceiptKind, checkpoint: string, submission: string): string {
  return (
    "```yaml\n" +
    "igniter_receipt:\n" +
    `  version: ${RECEIPT_VERSION}\n` +
    `  kind: ${kind}\n` +
    `  checkpoint: ${checkpoint}\n` +
    `  submission: ${submission}\n` +
    "```"
  );
}

export interface ParsedReceipt {
  kind: ReceiptKind;
  checkpoint: string;
  submission: string;
}

/** A receipt block that fails validation names what is wrong with it. */
export class ReceiptParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptParseError";
  }
}

const FENCE_RE = /^```(yaml|yml)[ \t]*\n([\s\S]*?)^```[ \t]*$/gm;
const RECEIPT_HEAD_RE = /^igniter_receipt[ \t]*:[ \t]*$/;
const RECEIPT_FIELD_RE = /^  ([A-Za-z_]+)[ \t]*:[ \t]*(\S+)[ \t]*$/;
const RECEIPT_FIELDS = ["version", "kind", "checkpoint", "submission"] as const;

/** A fenced block counts as a receipt block when it names the receipt head, even malformed. */
function isReceiptBlock(content: string): boolean {
  return content.split("\n").some((line) => /^\s*igniter_receipt\b/.test(line));
}

function receiptBlocks(body: string): string[] {
  const blocks: string[] = [];
  for (const match of body.matchAll(FENCE_RE)) {
    const content = match[2] ?? "";
    if (isReceiptBlock(content)) blocks.push(content);
  }
  return blocks;
}

/**
 * Parse the single `igniter_receipt` YAML block in a comment body. Null
 * when the body holds no receipt block. Throws ReceiptParseError on a
 * duplicate block, an unknown version or kind, missing or extra fields,
 * or any malformed YAML shape.
 */
export function parseReceiptBlock(body: string): ParsedReceipt | null {
  const blocks = receiptBlocks(body);
  if (blocks.length === 0) return null;
  if (blocks.length > 1) {
    throw new ReceiptParseError(`refused: comment holds ${blocks.length} igniter_receipt blocks; one receipt needs exactly one`);
  }
  const content = blocks[0] as string;
  const lines = content.split("\n").map((line) => line.replace(/\r$/, ""));
  const headIndex = lines.findIndex((line) => line.trim() !== "");
  const head = headIndex >= 0 ? lines[headIndex] : undefined;
  if (head === undefined || !RECEIPT_HEAD_RE.test(head)) {
    throw new ReceiptParseError(`refused: receipt block must start with "igniter_receipt:"`);
  }
  const seen = new Map<string, string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.trim() === "" || index === headIndex) continue;
    if (line.trimStart().startsWith("#")) {
      throw new ReceiptParseError(`refused: receipt block holds a comment line; one receipt needs exactly version, kind, checkpoint, submission`);
    }
    const field = RECEIPT_FIELD_RE.exec(line);
    if (!field) {
      throw new ReceiptParseError(`refused: malformed receipt line ${JSON.stringify(line)}; fields need two-space "key: value" scalars`);
    }
    const key = field[1] as string;
    const value = field[2] as string;
    if (!((RECEIPT_FIELDS as readonly string[]).includes(key))) {
      throw new ReceiptParseError(`refused: unknown receipt field "${key}"; expected version, kind, checkpoint, submission`);
    }
    if (seen.has(key)) {
      throw new ReceiptParseError(`refused: duplicate receipt field "${key}"`);
    }
    seen.set(key, value);
  }
  for (const key of RECEIPT_FIELDS) {
    if (!seen.has(key)) {
      throw new ReceiptParseError(`refused: receipt block misses "${key}"; one receipt needs version, kind, checkpoint, submission`);
    }
  }
  const version = seen.get("version") as string;
  if (version !== String(RECEIPT_VERSION)) {
    throw new ReceiptParseError(`refused: unknown receipt version ${JSON.stringify(version)}; this dispatch reads version 1`);
  }
  const kind = seen.get("kind") as string;
  if (!(RECEIPT_KINDS as readonly string[]).includes(kind)) {
    throw new ReceiptParseError(`refused: unknown receipt kind ${JSON.stringify(kind)}; expected build, review-pass, review-fail, or deliver`);
  }
  return {
    kind: kind as ReceiptKind,
    checkpoint: seen.get("checkpoint") as string,
    submission: seen.get("submission") as string,
  };
}

export interface FoundReceipt {
  id: string | null;
  body: string;
  receipt: ParsedReceipt;
}

/**
 * The newest comment holding a receipt of the given kind and submission.
 * Comments without a block or with an invalid block never match; the
 * retry dedupes on submission identity, not on prose.
 */
export function findReceipt(
  comments: { id?: string; body: string }[],
  kind: ReceiptKind,
  submission: string,
): FoundReceipt | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    let parsed: ParsedReceipt | null;
    try {
      parsed = parseReceiptBlock(comments[i]?.body ?? "");
    } catch {
      continue;
    }
    if (parsed && parsed.kind === kind && parsed.submission === submission) {
      return { id: comments[i]?.id ?? null, body: comments[i]?.body ?? "", receipt: parsed };
    }
  }
  return null;
}

/**
 * The newest valid Igniter receipt, newest comment first. Comments without
 * a block — and comments with an invalid one — are skipped, so one pasted
 * code fence can never brick the ticket's protocol state.
 */
export function latestValidReceipt(comments: { id?: string; body: string }[]): FoundReceipt | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    let parsed: ParsedReceipt | null;
    try {
      parsed = parseReceiptBlock(comments[i]?.body ?? "");
    } catch {
      continue;
    }
    if (parsed) return { id: comments[i]?.id ?? null, body: comments[i]?.body ?? "", receipt: parsed };
  }
  return null;
}

export const BLOCK_MARKER = "<!-- igniter:blocked -->";

// ---------------------------------------------------------------------------
// Submit payload validation (the kind only rejects wrong data; the Linear
// status selects the schema and the transition)
// ---------------------------------------------------------------------------

export interface BuildSubmit {
  v: 1;
  kind: "build";
  checkpoint: string;
  checks: string[];
  results: { criterion: string; ok: boolean; note?: string }[];
  reproduction: string;
}

export interface CommandEvidence {
  kind: "command";
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ReviewEvidence = string | CommandEvidence;

/** Per-criterion transcript budget: over this, submit an attachment or URL instead. */
export const MAX_COMMAND_EVIDENCE_CHARS = 4000;

export interface ReviewResult {
  criterion: string;
  expected: string;
  actual: string;
  evidence: ReviewEvidence;
  ok: boolean;
}

export interface ReviewSubmit {
  v: 1;
  kind: "review";
  verdict: "pass" | "fail";
  checkpoint: string;
  results: ReviewResult[];
  environment: string;
  reproduction: string;
}

export interface DeliverSubmit {
  v: 1;
  kind: "deliver";
  checkpoint: string;
  lineage: string;
  merge_ready: boolean;
  owner_actions: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function absoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.host !== "";
  } catch {
    return false;
  }
}

function checkCoverage(kind: string, criteria: string[], names: string[]): void {
  const missing = criteria.filter((c) => !names.includes(c));
  if (missing.length > 0) {
    throw new ProtocolError(
      `refused: ${kind} submit misses ${missing.length} acceptance criterion: ${missing.map((c) => `"${c}"`).join(", ")}`,
    );
  }
  const extra = names.filter((n) => !criteria.includes(n));
  if (extra.length > 0) {
    throw new ProtocolError(
      `refused: ${kind} submit names unknown criteria: ${extra.map((c) => `"${c}"`).join(", ")}; report exactly the ticket's criteria`,
    );
  }
}

export function parseBuildSubmit(raw: unknown, criteria: string[]): BuildSubmit {
  if (!isRecord(raw) || raw["v"] !== 1 || raw["kind"] !== "build") {
    throw new ProtocolError(`refused: build submit needs {"v":1,"kind":"build",...}; got ${JSON.stringify(raw)?.slice(0, 120)}`);
  }
  if (!nonEmpty(raw["checkpoint"])) throw new ProtocolError(`refused: build submit needs a "checkpoint"`);
  if (!Array.isArray(raw["checks"]) || raw["checks"].length === 0 || !raw["checks"].every(nonEmpty)) {
    throw new ProtocolError(`refused: build submit needs a non-empty "checks" list of commands run`);
  }
  if (!Array.isArray(raw["results"]) || raw["results"].length === 0) {
    throw new ProtocolError(`refused: build submit needs a non-empty "results" list, one per criterion`);
  }
  const results = raw["results"].map((entry: unknown) => {
    if (!isRecord(entry) || !nonEmpty(entry["criterion"]) || typeof entry["ok"] !== "boolean") {
      throw new ProtocolError(`refused: every build result needs {"criterion": "...", "ok": true|false}`);
    }
    return {
      criterion: (entry["criterion"] as string).trim(),
      ok: entry["ok"] as boolean,
      ...(nonEmpty(entry["note"]) ? { note: (entry["note"] as string).trim() } : {}),
    };
  });
  checkCoverage("build", criteria, results.map((r) => r.criterion));
  if (!nonEmpty(raw["reproduction"])) throw new ProtocolError(`refused: build submit needs "reproduction" steps`);
  return {
    v: 1,
    kind: "build",
    checkpoint: (raw["checkpoint"] as string).trim(),
    checks: (raw["checks"] as string[]).map((c) => c.trim()),
    results,
    reproduction: (raw["reproduction"] as string).trim(),
  };
}

/** True when a result carries reproducible evidence: a URL or a transcript. */
export function hasReviewEvidence(evidence: ReviewEvidence): boolean {
  if (typeof evidence === "string") return evidence !== "";
  return true;
}

/**
 * URL evidence stays a trimmed string; command evidence is a
 * `{"kind":"command","command","exitCode","stdout","stderr"}` transcript.
 * The verdict always comes from the Acceptance agent's `ok` flags: igniter
 * never derives it from an exit code.
 */
export function parseReviewEvidence(raw: unknown, criterion: string): ReviewEvidence {
  if (typeof raw === "string") {
    const evidence = raw.trim();
    if (evidence !== "" && !absoluteHttpUrl(evidence)) {
      throw new ProtocolError(
        `refused: review evidence must be an absolute http or https URL or a command transcript {"kind":"command",...}; criterion "${criterion}" has ${JSON.stringify(evidence)?.slice(0, 120)}`,
      );
    }
    return evidence;
  }
  if (isRecord(raw) && raw["kind"] === "command") {
    if (!nonEmpty(raw["command"])) {
      throw new ProtocolError(`refused: review evidence for criterion "${criterion}" needs a non-empty "command"`);
    }
    if (typeof raw["exitCode"] !== "number" || !Number.isInteger(raw["exitCode"])) {
      throw new ProtocolError(`refused: review evidence for criterion "${criterion}" needs an integer "exitCode"`);
    }
    if (typeof raw["stdout"] !== "string" || typeof raw["stderr"] !== "string") {
      throw new ProtocolError(
        `refused: review evidence for criterion "${criterion}" needs "stdout" and "stderr" strings`,
      );
    }
    const stdout = raw["stdout"] as string;
    const stderr = raw["stderr"] as string;
    if (stdout.trim() === "" && stderr.trim() === "") {
      throw new ProtocolError(
        `refused: review evidence for criterion "${criterion}" needs non-empty "stdout" or "stderr" output`,
      );
    }
    const command = (raw["command"] as string).trim();
    const size = command.length + stdout.length + stderr.length;
    if (size > MAX_COMMAND_EVIDENCE_CHARS) {
      throw new ProtocolError(
        `refused: review evidence for criterion "${criterion}" exceeds ${MAX_COMMAND_EVIDENCE_CHARS} chars (got ${size}); publish an attachment or external artifact URL instead, never truncate failure output`,
      );
    }
    return { kind: "command", command, exitCode: raw["exitCode"] as number, stdout, stderr };
  }
  throw new ProtocolError(
    `refused: review evidence for criterion "${criterion}" must be an absolute http or https URL or a command transcript {"kind":"command","command","exitCode","stdout","stderr"}`,
  );
}

export function parseReviewSubmit(raw: unknown, criteria: string[]): ReviewSubmit {
  if (!isRecord(raw) || raw["v"] !== 1 || raw["kind"] !== "review") {
    throw new ProtocolError(`refused: review submit needs {"v":1,"kind":"review",...}; got ${JSON.stringify(raw)?.slice(0, 120)}`);
  }
  if (raw["verdict"] !== "pass" && raw["verdict"] !== "fail") {
    throw new ProtocolError(`refused: review submit needs "verdict": "pass" or "fail"`);
  }
  if (!nonEmpty(raw["checkpoint"])) throw new ProtocolError(`refused: review submit needs a "checkpoint"`);
  if (!Array.isArray(raw["results"]) || raw["results"].length === 0) {
    throw new ProtocolError(`refused: review submit needs a non-empty "results" list, one per criterion`);
  }
  const results = raw["results"].map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      !nonEmpty(entry["criterion"]) ||
      !nonEmpty(entry["expected"]) ||
      !nonEmpty(entry["actual"]) ||
      typeof entry["ok"] !== "boolean" ||
      !("evidence" in entry)
    ) {
      throw new ProtocolError(
        `refused: every review result needs {"criterion", "expected", "actual", "evidence", "ok"}`,
      );
    }
    const criterion = (entry["criterion"] as string).trim();
    return {
      criterion,
      expected: (entry["expected"] as string).trim(),
      actual: (entry["actual"] as string).trim(),
      evidence: parseReviewEvidence(entry["evidence"], criterion),
      ok: entry["ok"] as boolean,
    };
  });
  checkCoverage("review", criteria, results.map((r) => r.criterion));
  if (!nonEmpty(raw["environment"])) throw new ProtocolError(`refused: review submit needs "environment"`);
  if (!nonEmpty(raw["reproduction"])) throw new ProtocolError(`refused: review submit needs "reproduction" steps`);
  const verdict = raw["verdict"] as "pass" | "fail";
  if (verdict === "pass") {
    const bad = results.filter((r) => !r.ok || !hasReviewEvidence(r.evidence));
    if (bad.length > 0) {
      throw new ProtocolError(
        `refused: a PASS verdict needs every criterion ok with evidence; failing: ${bad.map((r) => `"${r.criterion}"`).join(", ")}`,
      );
    }
  } else {
    const failing = results.filter((r) => !r.ok);
    if (failing.length === 0) {
      throw new ProtocolError(`refused: a FAIL verdict needs at least one criterion with "ok": false`);
    }
    const noEvidence = failing.filter((r) => !hasReviewEvidence(r.evidence));
    if (noEvidence.length > 0) {
      throw new ProtocolError(
        `refused: every failing criterion needs reproducible "evidence"; missing: ${noEvidence.map((r) => `"${r.criterion}"`).join(", ")}`,
      );
    }
  }
  return {
    v: 1,
    kind: "review",
    verdict,
    checkpoint: (raw["checkpoint"] as string).trim(),
    results,
    environment: (raw["environment"] as string).trim(),
    reproduction: (raw["reproduction"] as string).trim(),
  };
}

export function parseDeliverSubmit(raw: unknown): DeliverSubmit {
  if (!isRecord(raw) || raw["v"] !== 1 || raw["kind"] !== "deliver") {
    throw new ProtocolError(`refused: deliver submit needs {"v":1,"kind":"deliver",...}; got ${JSON.stringify(raw)?.slice(0, 120)}`);
  }
  if (!nonEmpty(raw["checkpoint"])) throw new ProtocolError(`refused: deliver submit needs a "checkpoint"`);
  if (!nonEmpty(raw["lineage"])) throw new ProtocolError(`refused: deliver submit needs "lineage" (commit ancestry)`);
  if (raw["merge_ready"] !== true) throw new ProtocolError(`refused: deliver submit needs "merge_ready": true`);
  if (!Array.isArray(raw["owner_actions"]) || raw["owner_actions"].length === 0 || !raw["owner_actions"].every(nonEmpty)) {
    throw new ProtocolError(`refused: deliver submit needs a non-empty "owner_actions" list of steps left for the owner`);
  }
  return {
    v: 1,
    kind: "deliver",
    checkpoint: (raw["checkpoint"] as string).trim(),
    lineage: (raw["lineage"] as string).trim(),
    merge_ready: true,
    owner_actions: (raw["owner_actions"] as string[]).map((a) => a.trim()),
  };
}

// ---------------------------------------------------------------------------
// Receipt bodies (a Markdown report for people, then the one YAML receipt
// block both owners and dispatch parse back into state; workspace metadata
// only caches the same identity for display)
// ---------------------------------------------------------------------------

export function buildReceiptBody(payload: BuildSubmit, submission: string): string {
  const lines = [
    `# Build receipt`,
    ``,
    `Checkpoint: \`${payload.checkpoint}\``,
    `Checks: ${payload.checks.map((c) => `\`${c}\``).join(", ")}`,
    ``,
    `Self-acceptance (not an independent approval):`,
    ...payload.results.map((r) => `- [${r.ok ? "x" : " "}] ${r.criterion}${r.note ? ` — ${r.note}` : ""}`),
    ``,
    `Reproduction:`,
    payload.reproduction,
    ``,
    receiptBlock("build", payload.checkpoint, submission),
  ];
  return lines.join("\n") + "\n";
}

/** One receipt line per evidence shape; transcripts keep command, exit, and output. */
export function formatReviewEvidence(evidence: ReviewEvidence): string[] {
  if (typeof evidence === "string") return [`  Evidence: ${evidence}`];
  return [
    `  Evidence: command \`${evidence.command}\` (exit ${evidence.exitCode})`,
    `    stdout: ${evidence.stdout}`,
    `    stderr: ${evidence.stderr}`,
  ];
}

export function reviewReceiptBody(payload: ReviewSubmit, submission: string): string {
  const verdict = payload.verdict === "pass" ? "PASS" : "FAIL";
  const lines = [
    `Agent acceptance: ${verdict}`,
    ``,
    `Checkpoint: \`${payload.checkpoint}\``,
    `Environment: ${payload.environment}`,
    ``,
    ...payload.results.flatMap((r) => [
      `- [${r.ok ? "x" : " "}] ${r.criterion}`,
      `  Expected: ${r.expected}`,
      `  Actual: ${r.actual}`,
      ...formatReviewEvidence(r.evidence),
    ]),
    ``,
    `Reproduction:`,
    payload.reproduction,
    ``,
    receiptBlock(payload.verdict === "pass" ? "review-pass" : "review-fail", payload.checkpoint, submission),
  ];
  return lines.join("\n") + "\n";
}

export function deliverReceiptBody(payload: DeliverSubmit, submission: string): string {
  const lines = [
    `# Deliver receipt`,
    ``,
    `Checkpoint: \`${payload.checkpoint}\``,
    `Lineage:`,
    payload.lineage,
    ``,
    `Merge preparation: complete. Still for the owner:`,
    ...payload.owner_actions.map((a) => `- ${a}`),
    ``,
    receiptBlock("deliver", payload.checkpoint, submission),
  ];
  return lines.join("\n") + "\n";
}

export function blockCommentBody(reason: string): string {
  return `${BLOCK_MARKER}\nBlocked: ${reason}\n`;
}

// ---------------------------------------------------------------------------
// Linear write helpers: fixed order, read-back, safe retry
// ---------------------------------------------------------------------------

async function readback(deps: ProtocolDeps, issueId: string): Promise<FullIssue> {
  const full = await deps.client.fetchIssue(issueId);
  if (!full) throw new ProtocolError(`Linear lost the issue mid-protocol; retry the command`);
  return full as FullIssue;
}

/**
 * Publish a receipt comment exactly once per submission: an existing
 * receipt with the same identity is adopted instead of duplicated, and a
 * lost write result (504 / unknown outcome) reads back before deciding
 * whether to write. Same submission never produces two receipts.
 */
export async function publishReceipt(
  deps: ProtocolDeps,
  issueId: string,
  kind: ReceiptKind,
  submission: string,
  body: string,
): Promise<string> {
  const before = await readback(deps, issueId);
  const already = findReceipt(before.comments, kind, submission);
  if (already?.id) return already.id;
  try {
    return await deps.client.addComment(issueId, body);
  } catch (error) {
    if (!isTransientLinearError(error)) throw error;
  }
  const full = await readback(deps, issueId);
  const existing = findReceipt(full.comments, kind, submission);
  if (existing?.id) return existing.id;
  return deps.client.addComment(issueId, body);
}

/** Verify a published receipt reads back; the Complete label waits on this. */
export async function verifyReceipt(
  deps: ProtocolDeps,
  issueId: string,
  kind: ReceiptKind,
  submission: string,
): Promise<void> {
  const full = await readback(deps, issueId);
  if (!findReceipt(full.comments, kind, submission)) {
    throw new ProtocolError(`receipt ${submission} did not read back from Linear; retry the command`);
  }
}

/**
 * Publish one evidence attachment per url (idempotent on (issue, url)),
 * then verify every url reads back.
 */
export async function publishEvidence(
  deps: ProtocolDeps,
  issueId: string,
  checkpoint: string,
  submission: string,
  verdict: "pass" | "fail",
  urls: string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const url of urls) {
    const metadata = {
      v: RECEIPT_METADATA_VERSION,
      source: RECEIPT_SOURCE,
      kind: "review-evidence",
      verdict,
      checkpoint,
      submission,
    };
    try {
      ids.push(
        await deps.client.createAttachment({ issueId, url, title: `evidence ${submission}`, metadata }),
      );
    } catch (error) {
      if (!isTransientLinearError(error)) throw error;
      const listed = await deps.client.listAttachments(issueId);
      const adopted = listed.find((a) => a.url === url);
      if (!adopted) throw error;
      ids.push(adopted.id);
    }
  }
  const listed = await deps.client.listAttachments(issueId);
  const missing = urls.filter((url) => !listed.some((a) => a.url === url));
  if (missing.length > 0) {
    throw new ProtocolError(`evidence did not read back from Linear (${missing.join(", ")}); retry the command`);
  }
  return ids;
}

/**
 * Replace the Progress label set, keeping every non-Progress label.
 * `to` null clears Progress (backlog/done carry none).
 */
export async function setProgress(
  deps: ProtocolDeps,
  full: FullIssue,
  to: ProtocolProgress | null,
): Promise<void> {
  const keep = (full.labels ?? []).map((l) => l.id).filter((id) => progressOf(deps.resolved, id) === undefined);
  const ids = to ? [...keep, deps.resolved.progress.ids[to]] : keep;
  try {
    await deps.client.setIssueLabels(full.id, ids);
  } catch (error) {
    if (!isTransientLinearError(error)) throw error;
    const current = await readback(deps, full.id);
    const have = new Set((current.labels ?? []).map((l) => l.id));
    if (to && !have.has(deps.resolved.progress.ids[to])) throw error;
    if (!to && [...have].some((id) => progressOf(deps.resolved, id) !== undefined)) throw error;
  }
}

/** Move status and Progress together, then read back and verify both. */
export async function moveStatus(
  deps: ProtocolDeps,
  full: FullIssue,
  status: ProtocolStatus,
  progress: ProtocolProgress | null,
): Promise<FullIssue> {
  await deps.client.setIssueState(full.id, deps.resolved.stateIds[status]);
  const moved = await readback(deps, full.id);
  await setProgress(deps, moved as FullIssue, progress);
  const verified = await readback(deps, full.id);
  const state = deriveState(deps.resolved, verified as FullIssue);
  if (state.status !== status || state.progress !== progress) {
    throw new ProtocolError(
      `Linear did not converge on ${status}+${progress ?? "no progress"}; retry the command`,
    );
  }
  return verified as FullIssue;
}

/** Current worktree HEAD for the ticket; submits must name exactly this. */
export async function worktreeHead(deps: ProtocolDeps, identifier: string): Promise<string> {
  const worktree = ticketWorktree(deps.repoRoot, identifier);
  try {
    const out = await deps.git.run(["rev-parse", "HEAD"], worktree.path);
    const head = out.stdout.trim().split("\n")[0]?.trim() ?? "";
    if (!head) throw new Error("empty HEAD");
    return head;
  } catch (error) {
    throw new ProtocolError(
      `refused: cannot read worktree HEAD for ${identifier} (${(error as Error).message}); the worktree may be missing`,
    );
  }
}

// ---------------------------------------------------------------------------
// Workspace mirror (Herdr only mirrors, after the Linear read-back)
// ---------------------------------------------------------------------------

export type WorkspaceMeta = Record<string, string>;

export function metaOf(workspace: SnapshotWorkspace): WorkspaceMeta {
  return { ...workspace.tokens };
}

/** Mirror the authoritative pair plus receipt identity into workspace metadata. */
export async function mirror(
  deps: ProtocolDeps,
  workspaceId: string,
  tokens: Record<string, string | null>,
): Promise<void> {
  await deps.workspaces.reportMetadata(workspaceId, tokens);
}

// ---------------------------------------------------------------------------
// state --json
// ---------------------------------------------------------------------------

export interface StateJson {
  ticket: { identifier: string; title: string; description: string; criteria: string[] };
  status: ProtocolStatus;
  progress: ProtocolProgress | null;
  checkpoint: string | null;
  receipt: { kind: ReceiptKind | null; id: string | null; checkpoint: string | null; submission: string | null };
  block_reason: string | null;
  next: string[];
  note: string | null;
  submit_schema: unknown;
}

function submitSchemaFor(status: ProtocolStatus, checkpoint: string | null): unknown {
  const at = checkpoint ?? "<worktree HEAD>";
  if (status === "build") {
    return {
      v: 1,
      kind: "build",
      checkpoint: at,
      checks: ["<command you ran, e.g. bun run check>"],
      results: [{ criterion: "<one acceptance criterion>", ok: true, note: "" }],
      reproduction: "<steps to reproduce your self-acceptance>",
    };
  }
  if (status === "review") {
    return {
      v: 1,
      kind: "review",
      verdict: "pass|fail",
      checkpoint: at,
      results: [
        {
          criterion: "<criterion>",
          expected: "",
          actual: "",
          evidence: '<absolute http(s) URL> or {"kind":"command","command":"<ran>","exitCode":0,"stdout":"<excerpt>","stderr":""}',
          ok: true,
        },
      ],
      environment: "<where acceptance ran, with its limits>",
      reproduction: "<steps to reproduce>",
    };
  }
  if (status === "deliver") {
    return {
      v: 1,
      kind: "deliver",
      checkpoint: at,
      lineage: "<commit ancestry since approval>",
      merge_ready: true,
      owner_actions: ["<push/deploy step left for the owner>"],
    };
  }
  return null;
}

function nextFor(status: ProtocolStatus, progress: ProtocolProgress | null): { next: string[]; note: string | null } {
  if (status === "backlog" || status === "done") {
    return { next: [], note: `no workspace command applies in ${status}; dispatch owns this state` };
  }
  if (status === "todo") {
    if (progress === "pending") return { next: ["block"], note: "waiting for dispatch claim (Todo+Pending)" };
    if (progress === "blocked") return { next: ["unblock"], note: null };
    return { next: [], note: `unexpected Todo+${progress}; dispatch normalizes it` };
  }
  if (progress === "pending") return { next: ["begin", "block"], note: null };
  if (progress === "in_progress") return { next: ["submit", "block"], note: null };
  if (progress === "blocked") return { next: ["unblock"], note: null };
  if (status === "review" && progress === "complete") {
    return { next: [], note: "waiting for the owner to approve (Deliver) or send back (Build) in Linear" };
  }
  if (status === "deliver" && progress === "complete") {
    return { next: [], note: "waiting for the owner to confirm landing and move to Done in Linear" };
  }
  return { next: [], note: `unexpected ${status}+${progress}; dispatch normalizes it` };
}

export function describeState(
  full: FullIssue,
  meta: WorkspaceMeta,
  state: AuthoritativeState,
): StateJson {
  const { next, note } = nextFor(state.status, state.progress);
  // The Linear receipt is the protocol truth; workspace tokens only fill
  // the display cache when Linear holds no receipt yet.
  const linear = latestValidReceipt(full.comments);
  const receiptKind = (linear?.receipt.kind ?? meta["receipt_kind"] ?? null) as ReceiptKind | null;
  const checkpoint = linear?.receipt.checkpoint ?? meta["checkpoint"] ?? null;
  return {
    ticket: {
      identifier: full.identifier,
      title: full.title,
      description: full.description ?? "",
      criteria: state.criteria,
    },
    status: state.status,
    progress: state.progress,
    checkpoint,
    receipt: {
      kind: receiptKind,
      id: linear?.id ?? meta["receipt_id"] ?? null,
      checkpoint,
      submission: linear?.receipt.submission ?? meta["submission"] ?? null,
    },
    block_reason: meta["block_reason"] ?? null,
    next,
    note,
    submit_schema: submitSchemaFor(state.status, checkpoint),
  };
}

// ---------------------------------------------------------------------------
// Claim path (shared by the watcher and `igniter start`)
// ---------------------------------------------------------------------------

export interface ClaimOptions {
  builder?: string;
}

export interface AdoptOptions {
  builder?: string;
}

export interface ClaimDeps extends ProtocolDeps {
  sink: ClaimSink;
  host: string;
}

/** A ticket is claimable only as Todo+Pending with observable criteria. */
export function claimable(state: AuthoritativeState): string | null {
  if (state.status !== "todo" || state.progress !== "pending") {
    return `claim needs Todo+Pending, got ${state.status}+${state.progress ?? "no progress"}`;
  }
  if (state.criteria.length === 0) {
    return `claim needs an acceptance-criteria checklist in the description`;
  }
  return null;
}

/**
 * Build tickets holding a slot: every Build-state issue whose Progress is
 * anything but Blocked. Blocked workspaces stay open but free their slot.
 * Tickets with an unreadable Progress pair still hold one: never claim
 * over a ticket dispatch cannot see.
 */
export async function countBuildSlots(client: LinearClient, resolved: ResolvedDispatch): Promise<number> {
  const issues = await client.listIssuesByState(resolved.projectId, resolved.stateIds.build);
  let used = 0;
  for (const issue of issues) {
    const progresses = (issue.labels ?? [])
      .map((l) => progressOf(resolved, l.id))
      .filter((p) => p !== undefined);
    if (progresses.length !== 1 || progresses[0] !== "blocked") used += 1;
  }
  return used;
}

/**
 * Claim a Todo+Pending ticket with observable criteria: the sink opens the
 * worktree and workspace, writes the ticket metadata, and starts the
 * Commander; then Linear moves to Build+In progress. Throws ProtocolError
 * on any refusal (no writes) and WorkspaceSinkError past the workspace
 * point. The watcher and `igniter start` share exactly this path.
 */
export async function claimTicket(
  deps: ClaimDeps,
  full: FullIssue,
  options: ClaimOptions = {},
): Promise<ClaimedTicket & { workspaceId: string; commander: string; builder: string }> {
  const { resolved } = deps;
  const state = deriveState(resolved, full);
  const blocked = claimable(state);
  if (blocked) {
    throw new ProtocolError(`refused: ${full.identifier} is not claimable: ${blocked}`);
  }
  const used = await countBuildSlots(deps.client, resolved);
  if (used >= resolved.config.maxRunning) {
    throw new ProtocolError(
      `refused: at max_running (${resolved.config.maxRunning}); ${used} Build tickets hold slots`,
    );
  }
  const kind = resolved.config.commander.agents.commander.harness;
  const builder = options.builder ?? resolved.config.commander.agents.builder.model;
  const kinds = await deps.workspaces.agentKinds();
  if (!kinds.includes(kind)) {
    throw new ProtocolError(`refused: unknown agent kind "${kind}"; known kinds: ${kinds.join(", ")}`);
  }
  const problems = launchProblems(resolved.config);
  if (problems.length > 0) {
    throw new ProtocolError(`refused: ${problems.join("; ")}`);
  }
  const from = full.state.name;
  const ticket: ClaimedTicket = {
    id: full.id,
    identifier: full.identifier,
    title: full.title,
    host: deps.host,
    slot: used,
    builder,
  };
  let opened: { workspaceId: string; commander: string; builder: string };
  try {
    opened = (await deps.sink(ticket)) ?? { workspaceId: "", commander: kind, builder };
  } catch (error) {
    if (error instanceof WorkspaceSinkError) throw error;
    throw new WorkspaceSinkError((error as Error).message);
  }
  try {
    await moveStatus(deps, full, "build", "in_progress");
  } catch (error) {
    throw new WorkspaceSinkError((error as Error).message, opened.workspaceId || undefined);
  }
  if (opened.workspaceId) {
    await mirror(deps, opened.workspaceId, { status: "build", progress: "in_progress" });
  }
  await deps.decisions.record(full.identifier, `claimed: ${from} → ${resolved.config.states.build} (slot ${used})`);
  if (opened.workspaceId) {
    await deps.decisions.record(
      full.identifier,
      `workspace opened (${opened.workspaceId}) commander=${opened.commander} builder=${opened.builder}`,
    );
  }
  return { ...ticket, ...opened };
}

/**
 * Adopt a ticket whose workspace was lost: reopen through the same sink and
 * mirror the authoritative Linear state into it. Linear is never written
 * here — the receipt history in the comments already carries the run's
 * identity, so even a Complete stage is kept as is (its `state --json`
 * note says what it waits for) instead of being reset to Pending.
 */
export async function adoptTicket(
  deps: ClaimDeps,
  full: FullIssue,
  options: AdoptOptions = {},
): Promise<{ workspaceId: string; commander: string; builder: string }> {
  const state = deriveState(deps.resolved, full);
  if (state.status !== "build" && state.status !== "review" && state.status !== "deliver") {
    throw new ProtocolError(
      `refused: adopt needs a Build, Review, or Deliver ticket, got ${state.status}`,
    );
  }
  const kind = deps.resolved.config.commander.agents.commander.harness;
  const kinds = await deps.workspaces.agentKinds();
  if (!kinds.includes(kind)) {
    throw new ProtocolError(`refused: unknown agent kind "${kind}"; known kinds: ${kinds.join(", ")}`);
  }
  const problems = launchProblems(deps.resolved.config);
  if (problems.length > 0) {
    throw new ProtocolError(`refused: ${problems.join("; ")}`);
  }
  const ticket: ClaimedTicket = {
    id: full.id,
    identifier: full.identifier,
    title: full.title,
    host: deps.host,
    slot: 0,
    builder: options.builder ?? deps.resolved.config.commander.agents.builder.model,
  };
  let opened: { workspaceId: string; commander: string; builder: string };
  try {
    opened = (await deps.sink(ticket)) ?? { workspaceId: "", commander: deps.resolved.config.commander.agents.commander.harness, builder: ticket.builder ?? "" };
  } catch (error) {
    if (error instanceof WorkspaceSinkError) throw error;
    throw new WorkspaceSinkError((error as Error).message);
  }
  if (!opened.workspaceId) {
    await deps.decisions.record(full.identifier, `adopted: no workspace found`);
    return opened;
  }
  const linear = latestValidReceipt(full.comments);
  try {
    await mirror(deps, opened.workspaceId, {
      status: state.status,
      progress: state.progress,
      checkpoint: linear?.receipt.checkpoint ?? null,
      receipt_id: linear?.id ?? null,
      receipt_kind: linear?.receipt.kind ?? null,
      submission: linear?.receipt.submission ?? null,
    });
  } catch (error) {
    throw new WorkspaceSinkError((error as Error).message, opened.workspaceId);
  }
  await deps.decisions.record(
    full.identifier,
    `adopted: no workspace found, reopened (${opened.workspaceId}) at ${state.status}+${state.progress ?? "no progress"} (Linear kept)`,
  );
  return opened;
}

/**
 * Finish a half-written claim: the workspace is already open with ticket
 * metadata, but Linear never reached Build+In progress. Moves Linear and
 * mirrors, without opening a second workspace.
 */
export async function finishClaim(
  deps: ClaimDeps,
  full: FullIssue,
  workspaceId: string,
  meta: WorkspaceMeta,
  slot: number,
): Promise<ClaimedTicket & { workspaceId: string; commander: string; builder: string }> {
  const { resolved } = deps;
  const state = deriveState(resolved, full);
  const blocked = claimable(state);
  if (blocked) {
    throw new ProtocolError(`refused: ${full.identifier} is not claimable: ${blocked}`);
  }
  const ticket: ClaimedTicket = {
    id: full.id,
    identifier: full.identifier,
    title: full.title,
    host: deps.host,
    slot,
    builder: meta["builder"] ?? resolved.config.commander.agents.builder.model,
  };
  let opened: { workspaceId: string; commander: string; builder: string };
  try {
    opened = (await deps.sink(ticket, { workspaceId })) ?? {
      workspaceId,
      commander: resolved.config.commander.agents.commander.harness,
      builder: ticket.builder ?? "",
    };
  } catch (error) {
    if (error instanceof WorkspaceSinkError) throw error;
    throw new WorkspaceSinkError((error as Error).message, workspaceId);
  }
  if (opened.workspaceId !== workspaceId) {
    throw new WorkspaceSinkError(
      `existing claim recovery returned workspace ${opened.workspaceId}, expected ${workspaceId}`,
      workspaceId,
    );
  }
  const from = full.state.name;
  await moveStatus(deps, full, "build", "in_progress");
  await mirror(deps, workspaceId, { status: "build", progress: "in_progress" });
  await deps.decisions.record(full.identifier, `claimed: ${from} → ${resolved.config.states.build} (slot ${slot})`);
  await deps.decisions.record(full.identifier, `claim finished in existing workspace (${workspaceId})`);
  return { ...ticket, ...opened };
}

// ---------------------------------------------------------------------------
// Workspace mutations
// ---------------------------------------------------------------------------

/** Pending becomes In progress; the status never changes here. */
export async function beginMutation(
  deps: ProtocolDeps,
  workspaceId: string,
  full: FullIssue,
  state: AuthoritativeState,
): Promise<void> {
  const { resolved } = deps;
  if ((state.status !== "build" && state.status !== "review" && state.status !== "deliver") || state.progress !== "pending") {
    throw new ProtocolError(
      `refused: begin needs Build, Review, or Deliver + Pending; ` +
        `${full.identifier} is ${state.status}+${state.progress ?? "no progress"}`,
    );
  }
  await setProgress(deps, full, "in_progress");
  const verified = await readback(deps, full.id);
  const restate = deriveState(resolved, verified);
  if (restate.status !== state.status || restate.progress !== "in_progress") {
    throw new ProtocolError(`Linear did not converge on ${state.status}+in_progress; retry the command`);
  }
  await mirror(deps, workspaceId, { status: state.status, progress: "in_progress" });
  await deps.decisions.record(
    full.identifier,
    `begin: ${state.status}+pending → ${state.status}+in_progress`,
  );
}

/**
 * Submit versioned JSON from stdin. The Linear status selects the schema
 * and the transition; the payload kind only rejects wrong data.
 */
export async function submitMutation(
  deps: ProtocolDeps,
  workspaceId: string,
  full: FullIssue,
  state: AuthoritativeState,
  raw: unknown,
): Promise<string> {
  if (state.progress !== "in_progress") {
    throw new ProtocolError(
      `refused: submit needs an In progress stage; ` +
        `${full.identifier} is ${state.status}+${state.progress ?? "no progress"} (run \`igniter begin\` first)`,
    );
  }
  if (state.status === "build") {
    const payload = parseBuildSubmit(raw, state.criteria);
    return submitBuild(deps, workspaceId, full, payload);
  }
  if (state.status === "review") {
    if (!isRecord(raw) || raw["kind"] !== "review") {
      throw new ProtocolError(`refused: this ticket is in Review; submit {"v":1,"kind":"review",...}`);
    }
    const payload = parseReviewSubmit(raw, state.criteria);
    const bound = latestReceiptOf(full.comments, "build");
    if (!bound) {
      throw new ProtocolError(
        `refused: submit names checkpoint ${payload.checkpoint} but Linear holds no build receipt; ` +
          `a build submit comes first`,
      );
    }
    if (payload.checkpoint !== bound.receipt.checkpoint) {
      throw new ProtocolError(
        `refused: submit names checkpoint ${payload.checkpoint} but the build receipt binds ${bound.receipt.checkpoint}; ` +
          `a new checkpoint needs a new build submit first`,
      );
    }
    checkNotSuperseded(full, payload.checkpoint);
    return submitReview(deps, workspaceId, full, payload);
  }
  if (state.status === "deliver") {
    if (!isRecord(raw) || raw["kind"] !== "deliver") {
      throw new ProtocolError(`refused: this ticket is in Deliver; submit {"v":1,"kind":"deliver",...}`);
    }
    const payload = parseDeliverSubmit(raw);
    const bound = latestReceiptOf(full.comments, "review-pass");
    if (!bound) {
      throw new ProtocolError(
        `refused: submit names checkpoint ${payload.checkpoint} but Linear holds no review-pass receipt; ` +
          `the owner approves in Linear first`,
      );
    }
    if (payload.checkpoint !== bound.receipt.checkpoint) {
      throw new ProtocolError(
        `refused: submit names checkpoint ${payload.checkpoint} but approval binds ${bound.receipt.checkpoint}; ` +
          `re-approval starts from a new build submit`,
      );
    }
    checkNotSuperseded(full, payload.checkpoint);
    return submitDeliver(deps, workspaceId, full, payload);
  }
  throw new ProtocolError(
    `refused: submit applies to Build, Review, or Deliver; ${full.identifier} is ${state.status}`,
  );
}

/**
 * A newer valid receipt for another stage supersedes the binding receipt:
 * the submit names a checkpoint history already moved past.
 */
function checkNotSuperseded(full: FullIssue, checkpoint: string): void {
  const newest = latestValidReceipt(full.comments);
  if (newest && newest.receipt.checkpoint !== checkpoint) {
    throw new ProtocolError(
      `refused: submit names checkpoint ${checkpoint} but the newest Linear receipt binds ${newest.receipt.checkpoint}; ` +
        `history moved on, a fresh submit comes first`,
    );
  }
}

/** Newest valid receipt of one kind, newest comment first. */
export function latestReceiptOf(
  comments: { id?: string; body: string }[],
  kind: ReceiptKind,
): FoundReceipt | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    let parsed: ParsedReceipt | null;
    try {
      parsed = parseReceiptBlock(comments[i]?.body ?? "");
    } catch {
      continue;
    }
    if (parsed && parsed.kind === kind) {
      return { id: comments[i]?.id ?? null, body: comments[i]?.body ?? "", receipt: parsed };
    }
  }
  return null;
}

async function submitBuild(
  deps: ProtocolDeps,
  workspaceId: string,
  full: FullIssue,
  payload: BuildSubmit,
): Promise<string> {
  const head = await worktreeHead(deps, full.identifier);
  if (payload.checkpoint !== head) {
    throw new ProtocolError(
      `refused: submit names checkpoint ${payload.checkpoint} but the worktree HEAD is ${head}`,
    );
  }
  const submission = submissionId({ ticket: full.identifier, ...payload });
  const body = buildReceiptBody(payload, submission);
  const commentId = await publishReceipt(deps, full.id, "build", submission, body);
  await verifyReceipt(deps, full.id, "build", submission);
  await mirror(deps, workspaceId, {
    status: "build",
    progress: "in_progress",
    checkpoint: payload.checkpoint,
    receipt_id: commentId,
    receipt_kind: "build",
    submission,
  });
  await moveStatus(deps, full, "review", "pending");
  await mirror(deps, workspaceId, { status: "review", progress: "pending" });
  const text = `submitted build ${payload.checkpoint} → Review+Pending (receipt ${commentId})`;
  await deps.decisions.record(full.identifier, text);
  return text;
}

async function submitReview(
  deps: ProtocolDeps,
  workspaceId: string,
  full: FullIssue,
  payload: ReviewSubmit,
): Promise<string> {
  const head = await worktreeHead(deps, full.identifier);
  if (payload.checkpoint !== head) {
    throw new ProtocolError(
      `refused: submit names checkpoint ${payload.checkpoint} but the worktree HEAD is ${head}; ` +
        `a new checkpoint invalidates earlier receipts`,
    );
  }
  const submission = submissionId({ ticket: full.identifier, ...payload });
  const urls = [
    ...new Set(
      payload.results
        .map((r) => (typeof r.evidence === "string" ? r.evidence : ""))
        .filter((u) => u !== ""),
    ),
  ];
  await publishEvidence(deps, full.id, payload.checkpoint, submission, payload.verdict, urls);
  const kind: ReceiptKind = payload.verdict === "pass" ? "review-pass" : "review-fail";
  const body = reviewReceiptBody(payload, submission);
  const commentId = await publishReceipt(deps, full.id, kind, submission, body);
  await verifyReceipt(deps, full.id, kind, submission);
  if (payload.verdict === "pass") {
    await mirror(deps, workspaceId, {
      status: "review",
      progress: "in_progress",
      checkpoint: payload.checkpoint,
      receipt_id: commentId,
      receipt_kind: kind,
      submission,
    });
    await moveStatus(deps, full, "review", "complete");
    await mirror(deps, workspaceId, { status: "review", progress: "complete" });
    const text = `submitted review PASS ${payload.checkpoint} → Review+Complete (receipt ${commentId})`;
    await deps.decisions.record(full.identifier, text);
    return text;
  }
  await mirror(deps, workspaceId, {
    status: "review",
    progress: "in_progress",
    checkpoint: payload.checkpoint,
    receipt_id: commentId,
    receipt_kind: kind,
    submission,
  });
  await moveStatus(deps, full, "build", "pending");
  await mirror(deps, workspaceId, {
    status: "build",
    progress: "pending",
    receipt_id: null,
    receipt_kind: null,
    submission: null,
  });
  const text = `submitted review FAIL ${payload.checkpoint} → Build+Pending (receipt ${commentId})`;
  await deps.decisions.record(full.identifier, text);
  return text;
}

async function submitDeliver(
  deps: ProtocolDeps,
  workspaceId: string,
  full: FullIssue,
  payload: DeliverSubmit,
): Promise<string> {
  const head = await worktreeHead(deps, full.identifier);
  if (payload.checkpoint !== head) {
    throw new ProtocolError(
      `refused: submit names checkpoint ${payload.checkpoint} but the worktree HEAD is ${head}`,
    );
  }
  const submission = submissionId({ ticket: full.identifier, ...payload });
  const body = deliverReceiptBody(payload, submission);
  const commentId = await publishReceipt(deps, full.id, "deliver", submission, body);
  await verifyReceipt(deps, full.id, "deliver", submission);
  await mirror(deps, workspaceId, {
    status: "deliver",
    progress: "in_progress",
    checkpoint: payload.checkpoint,
    receipt_id: commentId,
    receipt_kind: "deliver",
    submission,
  });
  await moveStatus(deps, full, "deliver", "complete");
  await mirror(deps, workspaceId, { status: "deliver", progress: "complete" });
  const text = `submitted deliver ${payload.checkpoint} → Deliver+Complete (receipt ${commentId})`;
  await deps.decisions.record(full.identifier, text);
  return text;
}

/** Keep the status, move to Blocked with a reason. Build frees its slot. */
export async function blockMutation(
  deps: ProtocolDeps,
  workspaceId: string,
  full: FullIssue,
  state: AuthoritativeState,
  reason: string,
): Promise<void> {
  if (!statusNeedsProgress(state.status) || (state.progress !== "pending" && state.progress !== "in_progress")) {
    throw new ProtocolError(
      `refused: block needs Todo, Build, Review, or Deliver + Pending or In progress; ` +
        `${full.identifier} is ${state.status}+${state.progress ?? "no progress"}`,
    );
  }
  await deps.client.addComment(full.id, blockCommentBody(reason));
  const moved = await readback(deps, full.id);
  await setProgress(deps, moved, "blocked");
  const verified = await readback(deps, full.id);
  const restate = deriveState(deps.resolved, verified);
  if (restate.progress !== "blocked") {
    throw new ProtocolError(`Linear did not converge on ${state.status}+blocked; retry the command`);
  }
  await mirror(deps, workspaceId, { status: state.status, progress: "blocked", block_reason: reason });
  const slot = state.status === "build" ? " (build slot freed)" : "";
  await deps.decisions.record(full.identifier, `blocked: ${state.status} kept, reason "${reason}"${slot}`);
}

/** Keep the status, return from Blocked to Pending. Never straight to In progress. */
export async function unblockMutation(
  deps: ProtocolDeps,
  workspaceId: string,
  full: FullIssue,
  state: AuthoritativeState,
): Promise<void> {
  if (!statusNeedsProgress(state.status) || state.progress !== "blocked") {
    throw new ProtocolError(
      `refused: unblock needs a Blocked stage; ` +
        `${full.identifier} is ${state.status}+${state.progress ?? "no progress"}`,
    );
  }
  await setProgress(deps, full, "pending");
  const verified = await readback(deps, full.id);
  const restate = deriveState(deps.resolved, verified);
  if (restate.status !== state.status || restate.progress !== "pending") {
    throw new ProtocolError(`Linear did not converge on ${state.status}+pending; retry the command`);
  }
  await mirror(deps, workspaceId, { status: state.status, progress: "pending", block_reason: null });
  await deps.decisions.record(
    full.identifier,
    `unblocked: ${state.status}+blocked → ${state.status}+pending; run \`igniter begin\``,
  );
}

// ---------------------------------------------------------------------------
// Owner moves in Linear (normalized from the current Linear status +
// Progress + the newest valid receipt alone; workspace metadata never
// authorizes a transition, and an inherited Complete is never a new
// completion)
// ---------------------------------------------------------------------------

/** Follow-up work a later poll retries: mirror the converged state and wake the Commander. */
export interface OwnerMoveFollowUp {
  /** Null when Herdr was unreachable: the retry locates the workspace by ticket. */
  workspaceId: string | null;
  tokens: Record<string, string | null>;
  wakeText: string;
}

export interface OwnerMoveOutcome {
  /** Null when Linear is already converged: the watcher stays silent. */
  result: CommandResult | null;
  /** Set when the mirror or the wake-up failed and a later poll should retry. */
  followUp: OwnerMoveFollowUp | null;
  /** Set when the Done workspace close failed and a later poll should retry it. */
  closeDue: { workspaceId: string | null; checkpoint: string } | null;
}

/** The receipt checkpoint must still bind the ticket branch lineage. */
async function checkpointInLineage(
  deps: ProtocolDeps,
  identifier: string,
  checkpoint: string,
): Promise<boolean> {
  // Linear-controlled text never reaches git as a flag.
  if (checkpoint.startsWith("-")) return false;
  const { branch } = ticketWorktree(deps.repoRoot, identifier);
  try {
    await deps.git.run(["merge-base", "--is-ancestor", checkpoint, branch], deps.repoRoot);
    return true;
  } catch {
    return false;
  }
}

function wakeTextFor(
  identifier: string,
  status: ProtocolStatus,
  checkpoint: string,
  submission: string,
): string {
  return (
    `igniter: the owner moved ${identifier}; Linear is now ${status}+pending ` +
    `(receipt ${submission} binds ${checkpoint}). Run \`igniter state --json\` and continue from there; do not restart.`
  );
}

/**
 * Normalize one owner move from the current Linear state alone. Returns
 * null when Linear is already converged (a Complete the owner still owns,
 * or a clean Done): the watcher records nothing. Anything else returns a
 * line and leaves Linear alone, except the three approved handoffs, which
 * clear the inherited Complete first and only then best-effort mirror,
 * wake, or close — a Herdr failure never rolls a verified Linear
 * transition back.
 */
export async function normalizeOwnerMove(
  deps: ProtocolDeps,
  full: FullIssue,
): Promise<OwnerMoveOutcome> {
  const { resolved } = deps;
  const fail = (text: string): OwnerMoveOutcome => ({ result: { ok: false, text }, followUp: null, closeDue: null });
  const quiet = (): OwnerMoveOutcome => ({ result: null, followUp: null, closeDue: null });
  if (full.projectId !== resolved.projectId) {
    return fail(`${full.identifier} is not in project "${resolved.config.project}"; ignoring`);
  }
  const linearStatus = statusOf(resolved, full.state.id);
  if (!linearStatus) {
    return fail(`${full.identifier} sits in unknown Linear status "${full.state.name}"; ignoring`);
  }
  const progresses = (full.labels ?? [])
    .map((l) => progressOf(resolved, l.id))
    .filter((p): p is ProtocolProgress => p !== undefined);
  if (progresses.length > 1) {
    return fail(
      `${full.identifier}: carries ${progresses.length} Progress labels (${progresses.join(", ")}); ` +
        `an owner must leave exactly one before dispatch converges it`,
    );
  }
  const progress = progresses[0] ?? null;

  // Worker-owned states and clean landings converge by themselves.
  if (progress !== "complete" && !(linearStatus === "done" && progress !== null)) {
    return quiet();
  }

  const reread = (await deps.client.fetchIssue(full.id)) as FullIssue | null;
  if (!reread) return fail(`${full.identifier} vanished from Linear; ignoring`);
  const latest = latestValidReceipt(reread.comments);
  if (!latest) {
    return fail(
      `${full.identifier}: ${linearStatus}+${progress ?? "no progress"} holds no valid Igniter receipt; ` +
        `refusing to treat the inherited state as progress`,
    );
  }
  const { kind, checkpoint } = latest.receipt;

  if (linearStatus === "done") {
    if (progress === null) return quiet();
    if (kind !== "deliver") {
      return fail(
        `${full.identifier}: Done still carries Progress "${progress}" but the newest receipt is ${kind}, not deliver; ` +
          `the owner lands the delivery first, then moves to Done`,
      );
    }
    return landDone(deps, reread, latest);
  }

  // An inherited Complete only converges when its receipt checkpoint still
  // binds the ticket branch lineage; a replaced branch refuses with a line.
  if (!(await checkpointInLineage(deps, full.identifier, checkpoint))) {
    return fail(
      `${full.identifier}: ${linearStatus}+complete names checkpoint ${checkpoint} but it is not in the ticket branch lineage; ` +
        `the receipt is stale, refusing`,
    );
  }

  if (linearStatus === "review") {
    if (kind === "review-pass") return quiet(); // Waiting for the owner to approve or send back.
    return fail(
      `${full.identifier}: Review+Complete but the newest receipt is ${kind}, not review-pass; ` +
        `only a passing review completes the stage, refusing`,
    );
  }
  if (linearStatus === "deliver") {
    if (kind === "deliver") return quiet(); // Waiting for the owner to confirm the landing.
    if (kind === "review-pass") {
      return inheritInto(deps, reread, latest, "deliver", "approved: Review+Complete → Deliver+Pending");
    }
    return fail(
      `${full.identifier}: Deliver+Complete but the newest receipt is ${kind}; ` +
        `only a review-pass approval converges here, refusing`,
    );
  }
  if (linearStatus === "build") {
    if (kind === "review-pass" || kind === "review-fail") {
      return inheritInto(deps, reread, latest, "build", "sent back: Review+Complete → Build+Pending");
    }
    return fail(
      `${full.identifier}: Build+Complete but the newest receipt is ${kind}, not a review receipt; ` +
        `refusing to treat the inherited state as progress`,
    );
  }
  return fail(
    `${full.identifier}: ${linearStatus}+complete matches no approved handoff; ignoring`,
  );
}

/**
 * Clear the inherited Complete into Pending inside the moved-to status,
 * then best-effort mirror the converged pair plus the Linear receipt and
 * wake the Commander. The Linear transition stands whatever Herdr does;
 * a failed mirror or wake-up returns as follow-up work for a later poll.
 */
async function inheritInto(
  deps: ProtocolDeps,
  full: FullIssue,
  latest: FoundReceipt,
  status: ProtocolStatus,
  headline: string,
): Promise<OwnerMoveOutcome> {
  const { checkpoint, submission } = latest.receipt;
  await setProgress(deps, full, "pending");
  const verified = await readback(deps, full.id);
  const restate = deriveState(deps.resolved, verified);
  if (restate.status !== status || restate.progress !== "pending") {
    throw new ProtocolError(`Linear did not converge on ${status}+pending; the next poll retries`);
  }
  const tokens: Record<string, string | null> = {
    status,
    progress: "pending",
    checkpoint,
    receipt_id: latest.id,
    receipt_kind: latest.receipt.kind,
    submission,
  };
  const wakeText = wakeTextFor(full.identifier, status, checkpoint, submission);
  const followUp = await mirrorAndWake(deps, full, tokens, wakeText);
  const suffix = followUp ? `; mirror or wake-up deferred, the next poll retries` : "";
  const text = `${headline} (${latest.receipt.kind} receipt ${submission} binds ${checkpoint})${suffix}`;
  return {
    result: { ok: true, text },
    followUp,
    closeDue: null,
  };
}

/**
 * Mirror the converged state into the ticket workspace and prompt its
 * Commander. Returns null on full success; otherwise a follow-up naming
 * what the next poll retries. A missing workspace is a note, never a
 * failure: Linear already converged without it. An unreachable Herdr or
 * a missing Commander keeps a follow-up, so the retry heals it.
 */
async function mirrorAndWake(
  deps: ProtocolDeps,
  full: FullIssue,
  tokens: Record<string, string | null>,
  wakeText: string,
): Promise<OwnerMoveFollowUp | null> {
  let snapshot;
  try {
    snapshot = await deps.workspaces.snapshot();
  } catch (error) {
    await guardRecord(
      deps,
      full.identifier,
      `mirror deferred: herdr unreachable (${(error as Error).message}); the next poll retries`,
    );
    return { workspaceId: null, tokens, wakeText };
  }
  const workspace = snapshot.workspaces.find((w) => w.tokens["ticket"] === full.identifier);
  if (!workspace) {
    await guardRecord(deps, full.identifier, `no workspace for ${full.identifier}; Linear converged without it`);
    return null;
  }
  try {
    await deps.workspaces.reportMetadata(workspace.workspaceId, tokens);
  } catch (error) {
    const note = `workspace mirror failed (${(error as Error).message}); the next poll retries`;
    await guardRecord(deps, full.identifier, note);
    return { workspaceId: workspace.workspaceId, tokens, wakeText };
  }
  const commander = snapshot.agents.find((a) => a.name === commanderName(full.identifier));
  if (!commander) {
    await guardRecord(
      deps,
      full.identifier,
      `commander not running; the wake-up rides on the next poll`,
    );
    return { workspaceId: workspace.workspaceId, tokens, wakeText };
  }
  try {
    await deps.workspaces.prompt(commander.name, wakeText);
  } catch (error) {
    const note = `commander wake-up failed (${(error as Error).message}); the next poll retries`;
    await guardRecord(deps, full.identifier, note);
    return { workspaceId: workspace.workspaceId, tokens, wakeText };
  }
  return null;
}

/**
 * Land a Done the owner moved: clear the leftover Progress, then
 * best-effort close the workspace and recycle the checkout. The landing
 * stands whatever happens below — a failed close returns as close-due
 * for a later poll, and cleanup only keeps with a reason, never throws.
 */
async function landDone(
  deps: ProtocolDeps,
  full: FullIssue,
  latest: FoundReceipt,
): Promise<OwnerMoveOutcome> {
  const { checkpoint, submission } = latest.receipt;
  await setProgress(deps, full, null);
  const verified = await readback(deps, full.id);
  const restate = deriveState(deps.resolved, verified);
  if (restate.status !== "done" || restate.progress !== null) {
    throw new ProtocolError(`Linear did not converge on done; the next poll retries`);
  }
  let closeDue: { workspaceId: string | null; checkpoint: string } | null = null;
  let closeNote = "no workspace to close";
  let snapshot;
  try {
    snapshot = await deps.workspaces.snapshot();
  } catch (error) {
    snapshot = null;
    // Herdr is unreachable, not gone: the close retries on a later poll.
    closeDue = { workspaceId: null, checkpoint };
    closeNote = `workspace close deferred (herdr unreachable: ${(error as Error).message}); the next poll retries`;
  }
  if (closeDue === null) {
    const workspace = snapshot?.workspaces.find((w) => w.tokens["ticket"] === full.identifier) ?? null;
    if (!workspace) {
      closeNote = "no workspace to close";
    } else {
      try {
        await deps.workspaces.close(workspace.workspaceId);
        closeNote = "workspace closed";
      } catch (error) {
        closeDue = { workspaceId: workspace.workspaceId, checkpoint };
        closeNote = `workspace close failed (${(error as Error).message}); the next poll retries`;
      }
    }
  }
  // else: snapshot failed above; closeNote and closeDue are already set.
  // The Done landing stands whatever happens below: cleanup only recycles
  // the checkout and never rolls the ticket back.
  let cleanupNote = "checkout cleanup skipped";
  try {
    const cleanup = await cleanupTicketCheckout(deps.git, deps.repoRoot, full.identifier, {
      checkpoint,
      targetBranch: deps.resolved.config.targetBranch,
    });
    await guardRecord(deps, full.identifier, cleanup.detail);
    cleanupNote = cleanup.ok ? "checkout cleaned" : "checkout kept";
  } catch (error) {
    await guardRecord(deps, full.identifier, `${full.identifier}: cleanup skipped: ${(error as Error).message}`);
  }
  const text =
    `done: Deliver+Complete → Done (delivery receipt ${submission} binds ${checkpoint}); ` +
    `${closeNote}; ${cleanupNote}`;
  return { result: { ok: true, text }, followUp: null, closeDue };
}

/** Activity lines must never fail a validated transition. */
async function guardRecord(deps: ProtocolDeps, ticket: string, message: string): Promise<void> {
  try {
    await deps.decisions.record(ticket, message);
  } catch {
    // The Linear transition stands; the line is lost.
  }
}
