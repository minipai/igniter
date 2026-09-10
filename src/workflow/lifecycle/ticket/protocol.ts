// Stage-aware Linear delivery protocol (STA-186).
//
// Linear status and Progress are the authoritative state; Herdr workspace
// metadata never authorizes their mutations. Every mutation follows one order:
//
//   validate -> publish receipt/evidence -> readback -> metadata identity
//   -> status/label -> final readback
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
import type { LinearClientLike, LinearComment, LinearIssue, LinearLabel } from "../../service/linear/linear.ts";
import type { ResolvedDispatch, DecisionLog, CommandResult } from "../../config/claims.ts";
import type { CommandWorkspaces } from "../../service/workspace/workspaces.ts";
import { ticketWorktree, type GitRunner } from "../../service/worktree/worktrees.ts";
import { LinearError } from "../../service/linear/linear.ts";

export type ProtocolStatus = "backlog" | "todo" | "build" | "review" | "deliver" | "done";
export type ProtocolProgress = "pending" | "in_progress" | "complete" | "blocked";

export const STATUSES: ProtocolStatus[] = ["backlog", "todo", "build", "review", "deliver", "done"];
export const PROGRESSES: ProtocolProgress[] = ["pending", "in_progress", "complete", "blocked"];

/** Active stages carry exactly one Progress label. */
export function statusNeedsProgress(status: ProtocolStatus): boolean {
  return status === "todo" || status === "build" || status === "review" || status === "deliver";
}

export interface ProtocolDeps {
  client: LinearClientLike;
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
        `begin normalizes a bare Todo to ${resolved.config.progress.pending} and ` +
        `reconcile converges incomplete active stages`,
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

/**
 * Read-only recognition of a bare Todo: Todo status with no Progress label.
 * Null for any other status or Progress combination, so unknown or
 * conflicting sets never read as a bare Todo. Ticket-targeted `begin`
 * normalizes this state itself; `status` reports it without writing.
 */
export function bareTodoState(resolved: ResolvedDispatch, full: FullIssue): AuthoritativeState | null {
  const status = statusOf(resolved, full.state.id);
  const progresses = (full.labels ?? [])
    .map((l) => progressOf(resolved, l.id))
    .filter((p): p is ProtocolProgress => p !== undefined);
  if (status !== "todo" || progresses.length !== 0) return null;
  return { status: "todo", progress: null, criteria: parseAcceptanceCriteria(full.description) };
}

/**
 * Linear's GitHub integration can move a ticket to Done as soon as its pull
 * request merges, before the Commander records the delivery receipt. Expose
 * only that receipt-proven gap as an in-progress Deliver submit. Every other
 * Done + Progress combination keeps failing closed through deriveState.
 */
export function mergedDeliveryState(
  resolved: ResolvedDispatch,
  full: FullIssue,
): AuthoritativeState | null {
  if (statusOf(resolved, full.state.id) !== "done") return null;
  const progresses = (full.labels ?? [])
    .map((label) => progressOf(resolved, label.id))
    .filter((progress): progress is ProtocolProgress => progress !== undefined);
  if (progresses.length !== 1) return null;
  const latest = latestValidReceipt(full.comments);
  const resumable =
    (latest?.receipt.kind === "review-pass" && progresses[0] === "in_progress") ||
    (latest?.receipt.kind === "deliver" &&
      (progresses[0] === "in_progress" || progresses[0] === "complete"));
  if (!resumable) return null;
  return {
    status: "deliver",
    progress: "in_progress",
    criteria: parseAcceptanceCriteria(full.description),
  };
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
 * history but are never parsed back into state. Deliver receipts also carry
 * the landed commit, which may differ from the approved checkpoint after a
 * Deliver rebase; every other kind carries the checkpoint alone.
 */
export function receiptBlock(kind: ReceiptKind, checkpoint: string, submission: string, landed?: string): string {
  return (
    "```yaml\n" +
    "igniter_receipt:\n" +
    `  version: ${RECEIPT_VERSION}\n` +
    `  kind: ${kind}\n` +
    `  checkpoint: ${checkpoint}\n` +
    (landed !== undefined ? `  landed: ${landed}\n` : "") +
    `  submission: ${submission}\n` +
    "```"
  );
}

export interface ParsedReceipt {
  kind: ReceiptKind;
  checkpoint: string;
  /** The landed commit on a deliver receipt; absent on every other kind. */
  landed?: string;
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
const RECEIPT_FIELDS = ["version", "kind", "checkpoint", "landed", "submission"] as const;
const RECEIPT_REQUIRED_FIELDS = ["version", "kind", "checkpoint", "submission"] as const;

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
  for (const key of RECEIPT_REQUIRED_FIELDS) {
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
  const checkpoint = seen.get("checkpoint") as string;
  const landed = seen.get("landed");
  if (landed !== undefined && kind !== "deliver") {
    throw new ReceiptParseError(`refused: only a deliver receipt carries "landed"; ${kind} needs version, kind, checkpoint, submission`);
  }
  return {
    kind: kind as ReceiptKind,
    checkpoint,
    // Deliver receipts written before landed identity was introduced used
    // the approved checkpoint as the direct-merge landing. Preserve that
    // v1 read contract in memory without rewriting the historical comment;
    // new Deliver submits still require an explicit landed commit.
    ...(kind === "deliver" ? { landed: landed ?? checkpoint } : {}),
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

/**
 * The newest valid receipt excluding one submission identity. A Build
 * submit classifies initial vs correction from the history before its own
 * submission, so a retry that already landed its receipt classifies
 * exactly like its first attempt instead of reading its own build receipt
 * as the newest history.
 */
export function latestValidReceiptExcluding(
  comments: { id?: string; body: string }[],
  submission: string,
): FoundReceipt | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    let parsed: ParsedReceipt | null;
    try {
      parsed = parseReceiptBlock(comments[i]?.body ?? "");
    } catch {
      continue;
    }
    if (parsed && parsed.submission !== submission) {
      return { id: comments[i]?.id ?? null, body: comments[i]?.body ?? "", receipt: parsed };
    }
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
  /** The approved checkpoint: must match the review-pass receipt. */
  checkpoint: string;
  /** The landed commit: must exist and read back from the local target branch. May equal the checkpoint. */
  landed: string;
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
  if (!nonEmpty(raw["checkpoint"])) throw new ProtocolError(`refused: deliver submit needs a "checkpoint" (the approved SHA)`);
  if (!nonEmpty(raw["landed"])) throw new ProtocolError(`refused: deliver submit needs a "landed" commit (the SHA on local main)`);
  if (!nonEmpty(raw["lineage"])) throw new ProtocolError(`refused: deliver submit needs "lineage" (commit ancestry)`);
  if (raw["merge_ready"] !== true) throw new ProtocolError(`refused: deliver submit needs "merge_ready": true`);
  if (!Array.isArray(raw["owner_actions"]) || raw["owner_actions"].length === 0 || !raw["owner_actions"].every(nonEmpty)) {
    throw new ProtocolError(`refused: deliver submit needs a non-empty "owner_actions" list of steps left for the owner`);
  }
  return {
    v: 1,
    kind: "deliver",
    checkpoint: (raw["checkpoint"] as string).trim(),
    landed: (raw["landed"] as string).trim(),
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
    `Approved checkpoint: \`${payload.checkpoint}\``,
    `Landed commit: \`${payload.landed}\``,
    `Lineage:`,
    payload.lineage,
    ``,
    `Merge preparation: complete. Still for the owner:`,
    ...payload.owner_actions.map((a) => `- ${a}`),
    ``,
    receiptBlock("deliver", payload.checkpoint, submission, payload.landed),
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

/**
 * Normalize a bare Todo (no Progress label) to Todo+Pending through the
 * shared `setProgress` boundary: every non-Progress label is kept and
 * exactly Pending is added. Unknown or conflicting Progress combinations
 * never reach this path — `bareTodoState` must already have named the ticket
 * a bare Todo. Linear is read back and verified before returning; the write
 * itself carries the same owner-race behavior as every other `setProgress`
 * call, and the command lock serializes dispatch commands. The ticket stays
 * Todo until an explicit begin command records the Build stage start.
 */
export async function normalizeBareTodo(
  deps: ProtocolDeps,
  full: FullIssue,
): Promise<FullIssue> {
  const status = statusOf(deps.resolved, full.state.id);
  const progresses = (full.labels ?? [])
    .map((l) => progressOf(deps.resolved, l.id))
    .filter((p): p is ProtocolProgress => p !== undefined);
  if (status !== "todo" || progresses.length !== 0) {
    throw new ProtocolError(
      `refused: begin normalizes only a bare Todo (no Progress label); ` +
        `${full.identifier} is ${status ?? full.state.name}+${progresses.join("+") || "no progress"}`,
    );
  }
  await setProgress(deps, full, "pending");
  const verified = await readback(deps, full.id);
  const state = deriveState(deps.resolved, verified);
  if (state.status !== "todo" || state.progress !== "pending") {
    throw new ProtocolError(`Linear did not converge on Todo+Pending; retry the command`);
  }
  return verified;
}

/** Move status and Progress together, then read back and verify both. */
export async function moveStatus(
  deps: ProtocolDeps,
  full: FullIssue,
  status: ProtocolStatus,
  progress: ProtocolProgress | null,
): Promise<FullIssue> {
  const targetState = deps.resolved.stateIds[status];
  let moved: FullIssue;
  try {
    await deps.client.setIssueState(full.id, targetState);
    moved = await readback(deps, full.id);
  } catch (error) {
    if (!isTransientLinearError(error)) throw error;
    const current = await readback(deps, full.id);
    if (current.state.id !== targetState) throw error;
    moved = current;
  }
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
// Workspace metadata for status display
// ---------------------------------------------------------------------------

export type WorkspaceMeta = Record<string, string>;

// ---------------------------------------------------------------------------
// status <ticket> --json
// ---------------------------------------------------------------------------

export interface StateJson {
  ticket: { identifier: string; title: string; description: string; criteria: string[] };
  status: ProtocolStatus;
  progress: ProtocolProgress | null;
  checkpoint: string | null;
  /** The landed commit from the newest deliver receipt; null until delivered. */
  landed: string | null;
  receipt: { kind: ReceiptKind | null; id: string | null; checkpoint: string | null; landed: string | null; submission: string | null };
  block_reason: string | null;
  next: string[];
  note: string | null;
  submit_schema: unknown;
}

/** Canonical submit shape shared by status and worker work orders. */
export function submitSchemaFor(status: ProtocolStatus, checkpoint: string | null): unknown {
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
      landed: "<landed commit already on local main; equals the checkpoint when no rebase happened>",
      lineage: "<commit ancestry since approval>",
      merge_ready: true,
      owner_actions: ["<push/deploy step left for the owner>"],
    };
  }
  return null;
}

function nextFor(status: ProtocolStatus, progress: ProtocolProgress | null): { next: string[]; note: string | null } {
  if (status === "backlog") return { next: [], note: "Backlog has no pending stage action" };
  if (status === "done") return { next: ["worker stop"], note: "run worker stop for guarded cleanup; validate the Deliver receipt and preserve uncommitted or unmerged work" };
  if (status === "todo") {
    if (progress === null) return { next: ["worker start", "begin"], note: "bare Todo (no Progress label): confirm worker start delivery before begin records Build+In progress" };
    if (progress === "pending") return { next: ["worker start", "begin"], note: "confirm worker start delivery before begin" };
    if (progress === "blocked") return { next: ["unblock"], note: null };
    return { next: [], note: `unexpected Todo+${progress}; begin refuses it` };
  }
  if (progress === "pending") return { next: ["worker start", "begin", "block"], note: "confirm worker start delivery before begin" };
  if (progress === "in_progress") return { next: ["submit", "block"], note: null };
  if (progress === "blocked") return { next: ["unblock"], note: null };
  if (status === "build" && progress === "complete") {
    return { next: ["approve"], note: "after owner approval: approve <ticket> --receipt <receipt.id>" };
  }
  if (status === "review" && progress === "complete") {
    return { next: ["approve"], note: "after owner approval: approve <ticket> --receipt <receipt.id>; owner may send back to Build" };
  }
  if (status === "deliver" && progress === "complete") {
    return { next: ["approve"], note: "after owner confirms landing: approve <ticket> --receipt <receipt.id>" };
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
  const receiptKind = (linear ? linear.receipt.kind : (meta["receipt_kind"] ?? null)) as ReceiptKind | null;
  const checkpoint = linear ? linear.receipt.checkpoint : (meta["checkpoint"] ?? null);
  const landed = linear ? (linear.receipt.landed ?? null) : (meta["landed"] ?? null);
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
    landed,
    receipt: {
      kind: receiptKind,
      id: linear ? linear.id : (meta["receipt_id"] ?? null),
      checkpoint,
      landed,
      submission: linear ? linear.receipt.submission : (meta["submission"] ?? null),
    },
    block_reason: meta["block_reason"] ?? null,
    next,
    note,
    submit_schema: submitSchemaFor(state.status, checkpoint),
  };
}

/**
 * Build tickets holding a slot: every Build-state issue whose Progress is
 * anything but Blocked. Blocked workspaces stay open but free their slot.
 * Tickets with an unreadable Progress pair still hold one: never start Build
 * over a ticket dispatch cannot see.
 */
export async function countBuildSlots(client: LinearClientLike, resolved: ResolvedDispatch): Promise<number> {
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

/** A durable start boundary prevents an old submit from rewinding a newer round. */
export async function recordStageStart(
  deps: ProtocolDeps,
  full: FullIssue,
  stage: ProtocolStatus,
): Promise<FullIssue> {
  const after = latestValidReceipt(full.comments)?.receipt.submission ?? null;
  const body = `<!-- igniter:begin ${JSON.stringify({ v: 1, ticket: full.identifier, stage, after })} -->\n` +
    `Stage started: ${stage}; preceding receipt ${after ?? "none"}.`;
  const expectedProgress = deriveState(deps.resolved, full).progress;
  const before = await readback(deps, full.id);
  if ((latestValidReceipt(before.comments)?.receipt.submission ?? null) !== after || before.state.id !== full.state.id ||
      deriveState(deps.resolved, before).progress !== expectedProgress) {
    throw new ProtocolError("ticket moved while recording begin; read status before retrying");
  }
  if (!before.comments.some((comment) => comment.body === body)) {
    try {
      await deps.client.addComment(full.id, body);
    } catch (error) {
      if (!isTransientLinearError(error)) throw error;
      const read = await readback(deps, full.id);
      if (!read.comments.some((comment) => comment.body === body)) throw error;
    }
  }
  const verified = await readback(deps, full.id);
  if (!verified.comments.some((comment) => comment.body === body)) {
    throw new ProtocolError("stage start did not read back from Linear; retry begin");
  }
  if ((latestValidReceipt(verified.comments)?.receipt.submission ?? null) !== after || verified.state.id !== full.state.id ||
      deriveState(deps.resolved, verified).progress !== expectedProgress) {
    throw new ProtocolError("ticket moved while recording begin; read status before retrying");
  }
  return verified;
}

export function stageStartedAfterReceipt(full: FullIssue, submission: string, stage?: ProtocolStatus): boolean {
  let seen = false;
  for (const comment of full.comments) {
    try {
      if (parseReceiptBlock(comment.body)?.submission === submission) seen = true;
    } catch { /* An unrelated malformed comment cannot authorize a retry. */ }
    if (!seen) continue;
    const match = /^<!-- igniter:begin (\{[^\n]+\}) -->\n/.exec(comment.body);
    if (!match) continue;
    try {
      const record: unknown = JSON.parse(match[1]!);
      if (isRecord(record) && record["v"] === 1 && record["ticket"] === full.identifier &&
          ["build", "review", "deliver"].includes(String(record["stage"])) && (!stage || record["stage"] === stage)) return true;
    } catch { /* Only valid stage-start records establish the boundary. */ }
  }
  return false;
}

/**
 * Submit versioned JSON from stdin. The Linear status selects the schema
 * and the transition; the payload kind only rejects wrong data.
 */
export async function submitMutation(
  deps: ProtocolDeps,
  full: FullIssue,
  state: AuthoritativeState,
  raw: unknown,
): Promise<string> {
  const mergedDone = statusOf(deps.resolved, full.state.id) === "done";
  const resumed = await resumeWrittenTransition(deps, full, state, raw);
  if (resumed) return resumed;
  const repeated = mergedDone ? null : completedSubmission(full, state, raw);
  if (repeated) return repeated;
  if (state.progress !== "in_progress") {
    throw new ProtocolError(
      `refused: submit needs an In progress stage; ` +
        `${full.identifier} is ${state.status}+${state.progress ?? "no progress"} (run \`igniter begin ${full.identifier}\` first)`,
    );
  }
  if (state.status === "build") {
    const payload = parseBuildSubmit(raw, state.criteria);
    return submitBuild(deps, full, payload);
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
    return submitReview(deps, full, payload);
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
    return mergedDone
      ? submitMergedDelivery(deps, full, payload)
      : submitDeliver(deps, full, payload);
  }
  throw new ProtocolError(
    `refused: submit applies to Build, Review, or Deliver; ${full.identifier} is ${state.status}`,
  );
}

/** Finish the only cross-status partial writes a lost readback can expose. */
async function resumeWrittenTransition(
  deps: ProtocolDeps,
  full: FullIssue,
  state: AuthoritativeState,
  raw: unknown,
): Promise<string | null> {
  if (!isRecord(raw)) return null;
  // Complete/Pending already reached the target: acknowledge the receipt below.
  if (state.progress !== "in_progress") return null;
  if (raw["kind"] === "build" && state.status === "review" && state.progress === "in_progress") {
    if (!latestReceiptOf(full.comments, "build")) return null;
    const payload = parseBuildSubmit(raw, state.criteria);
    const submission = submissionId({ ticket: full.identifier, ...payload });
    const receipt = findReceipt(full.comments, "build", submission);
    if (!receipt?.id) return null;
    if (!partialSubmissionMarked(full, submission)) return null;
    const prior = latestValidReceiptExcluding(full.comments, submission);
    if (!prior || (prior.receipt.kind !== "review-fail" && prior.receipt.kind !== "review-pass")) return null;
    await moveStatus(deps, full, "review", "pending");
    return `resumed build ${payload.checkpoint} → Review+Pending (receipt ${receipt.id})`;
  }
  if (raw["kind"] === "review" && state.status === "build" && state.progress === "in_progress") {
    if (!latestReceiptOf(full.comments, "review-fail")) return null;
    const payload = parseReviewSubmit(raw, state.criteria);
    if (payload.verdict !== "fail") return null;
    const submission = submissionId({ ticket: full.identifier, ...payload });
    const receipt = findReceipt(full.comments, "review-fail", submission);
    if (!receipt?.id) return null;
    if (!partialSubmissionMarked(full, submission)) return null;
    await moveStatus(deps, full, "build", "pending");
    return `resumed review FAIL ${payload.checkpoint} → Build+Pending (receipt ${receipt.id})`;
  }
  return null;
}

/** Retries require the latest receipt and no later stage start. */
function partialSubmissionMarked(full: FullIssue, submission: string): boolean {
  return !stageStartedAfterReceipt(full, submission)
    && latestValidReceipt(full.comments)?.receipt.submission === submission;
}

/**
 * A caller may lose the result after Igniter completed the Linear transition.
 * The safe retry then arrives in the next stage, where normal
 * schema dispatch would otherwise misread the old payload. Recognize only an
 * exact, fully validated submission identity already present in Linear; this
 * acknowledges the completed write without replaying any transition.
 */
function completedSubmission(
  full: FullIssue,
  state: AuthoritativeState,
  raw: unknown,
): string | null {
  if (!isRecord(raw) || typeof raw["kind"] !== "string") return null;
  const canAcknowledge = (submission: string) =>
    latestValidReceipt(full.comments)?.receipt.submission !== submission || stageStartedAfterReceipt(full, submission);
  try {
    if (raw["kind"] === "build") {
      const payload = parseBuildSubmit(raw, state.criteria);
      const submission = submissionId({ ticket: full.identifier, ...payload });
      const receipt = findReceipt(full.comments, "build", submission);
      if (receipt?.id && (!(state.status === "build" && state.progress === "in_progress") || canAcknowledge(submission))) {
        return `already submitted build ${payload.checkpoint}; Linear is ${state.status}+${state.progress ?? "no progress"} (receipt ${receipt.id})`;
      }
    }
    if (raw["kind"] === "review") {
      const payload = parseReviewSubmit(raw, state.criteria);
      const kind: ReceiptKind = payload.verdict === "pass" ? "review-pass" : "review-fail";
      const submission = submissionId({ ticket: full.identifier, ...payload });
      const receipt = findReceipt(full.comments, kind, submission);
      if (receipt?.id && (!(state.status === "review" && state.progress === "in_progress") || canAcknowledge(submission))) {
        return `already submitted review ${payload.verdict.toUpperCase()} ${payload.checkpoint}; Linear is ${state.status}+${state.progress ?? "no progress"} (receipt ${receipt.id})`;
      }
    }
    if (raw["kind"] === "deliver") {
      const payload = parseDeliverSubmit(raw);
      const submission = submissionId({ ticket: full.identifier, ...payload });
      const receipt = findReceipt(full.comments, "deliver", submission);
      if (receipt?.id && (!(state.status === "deliver" && state.progress === "in_progress") || canAcknowledge(submission))) {
        return `already submitted deliver approved ${payload.checkpoint} landed ${payload.landed}; Linear is ${state.status}+${state.progress ?? "no progress"} (receipt ${receipt.id})`;
      }
    }
  } catch {
    // Invalid retries go through the normal stage-specific parser below so
    // callers receive its precise contract error and no false acknowledgement.
  }
  return null;
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
  // Initial vs correction reads the receipt history before this
  // submission, excluding the submission itself so a retry classifies
  // exactly like its first attempt. Only Linear history decides; workspace
  // metadata never authorizes the target. No prior review receipt means
  // the first Build: it stops at Build+Complete for owner acceptance.
  // A newest review-fail receipt means an Acceptance correction; a
  // newest review-pass receipt means an owner send-back correction (the
  // ticket could only return to Build+In progress through the send-back
  // reconcile): both return straight to Review+Pending.
  const prior = latestValidReceiptExcluding(full.comments, submission);
  const correctionKind =
    prior !== null && (prior.receipt.kind === "review-fail" || prior.receipt.kind === "review-pass")
      ? prior.receipt.kind
      : null;
  const body = buildReceiptBody(payload, submission);
  const commentId = await publishReceipt(deps, full.id, "build", submission, body);
  await verifyReceipt(deps, full.id, "build", submission);
  if (correctionKind !== null) {
    await moveStatus(deps, full, "review", "pending");
    const text =
      `submitted build ${payload.checkpoint} → Review+Pending ` +
      `(correction after ${correctionKind} receipt ${prior!.id ?? prior!.receipt.submission}; receipt ${commentId})`;
    await deps.decisions.record(full.identifier, text);
    return text;
  }
  await moveStatus(deps, full, "build", "complete");
  const text =
    `submitted build ${payload.checkpoint} → Build+Complete ` +
    `(awaiting owner acceptance; receipt ${commentId})`;
  await deps.decisions.record(full.identifier, text);
  return text;
}

async function submitReview(
  deps: ProtocolDeps,
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
    await moveStatus(deps, full, "review", "complete");
    const text = `submitted review PASS ${payload.checkpoint} → Review+Complete (receipt ${commentId})`;
    await deps.decisions.record(full.identifier, text);
    return text;
  }
  await moveStatus(deps, full, "build", "pending");
  const text = `submitted review FAIL ${payload.checkpoint} → Build+Pending (receipt ${commentId})`;
  await deps.decisions.record(full.identifier, text);
  return text;
}

async function submitDeliver(
  deps: ProtocolDeps,
  full: FullIssue,
  payload: DeliverSubmit,
): Promise<string> {
  // The approved checkpoint binds the review-pass receipt; the worktree HEAD
  // is intentionally not compared. Deliver owns the rebase, so a rebased
  // branch legitimately heads a new SHA while the approval still binds the
  // old one. Only a new code change — a new checkpoint needing a new build
  // submit and acceptance — invalidates the approval, and that returns
  // through the normal build/review path, never through an automatic
  // content-equivalence proof here.
  if (!/^[0-9a-f]{7,64}$/.test(payload.landed)) {
    throw new ProtocolError(
      `refused: landed commit ${JSON.stringify(payload.landed)} is not a Git hash; submit the landed commit SHA, not a branch or revision expression`,
    );
  }
  const target = deps.resolved.config.targetBranch;
  try {
    await deps.git.run(["merge-base", "--is-ancestor", payload.landed, target], deps.repoRoot);
  } catch (error) {
    throw new ProtocolError(
      `refused: landed commit ${payload.landed} is not on local ${target} ` +
        `(${(error as Error).message}); land the rebased branch first, then submit its SHA as "landed"`,
    );
  }
  const submission = submissionId({ ticket: full.identifier, ...payload });
  const body = deliverReceiptBody(payload, submission);
  const commentId = await publishReceipt(deps, full.id, "deliver", submission, body);
  await verifyReceipt(deps, full.id, "deliver", submission);
  await moveStatus(deps, full, "deliver", "complete");
  const text = `submitted deliver approved ${payload.checkpoint} landed ${payload.landed} → Deliver+Complete (receipt ${commentId})`;
  await deps.decisions.record(full.identifier, text);
  return text;
}

/** Record a delivery after Linear's GitHub integration already moved Done. */
async function submitMergedDelivery(
  deps: ProtocolDeps,
  full: FullIssue,
  payload: DeliverSubmit,
): Promise<string> {
  if (!/^[0-9a-f]{7,64}$/.test(payload.landed)) {
    throw new ProtocolError(
      `refused: landed commit ${JSON.stringify(payload.landed)} is not a Git hash; submit the landed commit SHA, not a branch or revision expression`,
    );
  }
  const target = deps.resolved.config.targetBranch;
  try {
    await deps.git.run(["merge-base", "--is-ancestor", payload.landed, target], deps.repoRoot);
  } catch (error) {
    throw new ProtocolError(
      `refused: landed commit ${payload.landed} is not on local ${target} ` +
        `(${(error as Error).message}); update the local target after the pull request merges, then submit its SHA as "landed"`,
    );
  }
  const submission = submissionId({ ticket: full.identifier, ...payload });
  const body = deliverReceiptBody(payload, submission);
  await publishReceipt(deps, full.id, "deliver", submission, body);
  await verifyReceipt(deps, full.id, "deliver", submission);
  const fresh = await readback(deps, full.id);
  const receipt = findReceipt(fresh.comments, "deliver", submission);
  if (!receipt) throw new ProtocolError(`Linear lost the delivery receipt mid-protocol; retry the command`);
  const landed = await landDone(
    deps,
    fresh,
    `submitted deliver approved ${payload.checkpoint} landed ${payload.landed} → Done`,
  );
  const text = landed.result?.text ??
    `submitted deliver approved ${payload.checkpoint} landed ${payload.landed} → Done`;
  await deps.decisions.record(full.identifier, text);
  return text;
}

/** Keep the status, move to Blocked with a reason. Build frees its slot. */
export async function blockMutation(
  deps: ProtocolDeps,
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
  const slot = state.status === "build" ? " (build slot freed)" : "";
  await deps.decisions.record(full.identifier, `blocked: ${state.status} kept, reason "${reason}"${slot}`);
}

/** Keep the status, return from Blocked to Pending. Never straight to In progress. */
export async function unblockMutation(
  deps: ProtocolDeps,
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
  await deps.decisions.record(
    full.identifier,
    `unblocked: ${state.status}+blocked → ${state.status}+pending; run \`igniter begin ${full.identifier}\``,
  );
}

// ---------------------------------------------------------------------------
// Incomplete active state (STA-190)
//
// An owner move or a half-written label update can leave Build, Review, or
// Deliver with zero or several Progress labels. That state is incomplete:
// dispatch starts no stage agent on it, guesses no checkpoint or completion,
// and never picks one of several carried labels. The ticket-targeted
// `reconcile` converges it from the current Linear status plus Progress plus
// the newest valid YAML receipt alone — Herdr snapshots and workspace
// metadata never authorize the outcome, and no workspace is opened here.
//
// Only a receipt that uniquely proves the expected Progress repairs Linear
// (a label-only write; status, checkpoint, and receipts never change).
// Anything else — no receipt, a stale checkpoint, a receipt kind that
// belongs to another stage, or a correction receipt whose stage moved on —
// parks the ticket as same-stage Blocked with one actionable comment. The
// comment carries a fingerprint of the exact error, so an unchanged bad
// state never comments twice: after a park the ticket reads Blocked (a
// complete pair) and later reconciles stay quiet.
// ---------------------------------------------------------------------------

export const INCOMPLETE_MARKER = "<!-- igniter:incomplete-state -->";

export type IncompleteKind = "missing-progress" | "multiple-progress";

export interface IncompleteDiagnosis {
  status: "build" | "review" | "deliver";
  kind: IncompleteKind;
  progresses: ProtocolProgress[];
}

/**
 * The incomplete active state of a fully read issue, or null when the
 * ticket is not in scope (not Build/Review/Deliver, or exactly one
 * Progress). Todo keeps its own normalization; Backlog/Done carry none.
 */
export function diagnoseIncompleteState(resolved: ResolvedDispatch, full: FullIssue): IncompleteDiagnosis | null {
  const status = statusOf(resolved, full.state.id);
  if (status !== "build" && status !== "review" && status !== "deliver") return null;
  const progresses = (full.labels ?? [])
    .map((l) => progressOf(resolved, l.id))
    .filter((p): p is ProtocolProgress => p !== undefined);
  if (progresses.length === 1) return null;
  return {
    status,
    kind: progresses.length === 0 ? "missing-progress" : "multiple-progress",
    progresses,
  };
}

/**
 * Read-only diagnosis for `status` and `begin`: names the incomplete pair
 * and points at `reconcile` without writing Linear or opening anything.
 * Null when the ticket is not incomplete.
 */
export function incompleteStatusText(resolved: ResolvedDispatch, full: FullIssue): string | null {
  const diagnosis = diagnoseIncompleteState(resolved, full);
  if (!diagnosis) return null;
  const pair = diagnosis.progresses.length === 0
    ? "no Progress label"
    : `${diagnosis.progresses.length} Progress labels (${[...diagnosis.progresses].sort().join(", ")})`;
  const latest = latestValidReceipt(full.comments);
  const receipt = latest
    ? `newest receipt: ${latest.receipt.kind} binds ${latest.receipt.checkpoint}`
    : "newest receipt: none";
  const stage = resolved.config.states[diagnosis.status];
  return (
    `${full.identifier}: ${stage} carries ${pair} (${receipt}); ` +
    `dispatch starts no worker on an incomplete active state — ` +
    `run \`igniter reconcile ${full.identifier}\` to converge it ` +
    `(a receipt-proven repair, or same-stage Blocked with manual steps)`
  );
}

type IncompleteParkReason = "no-receipt" | "stale-checkpoint" | "kind-mismatch" | "stage-conflict";

/**
 * The Progress a receipt uniquely proves for an incomplete active status,
 * or null when no receipt proves exactly one outcome. The owner's status
 * is trusted (repairs never move stage); only the Progress is derived:
 *
 * - build receipt: initial Build proves Complete, unless a prior review
 *   receipt marks it a correction that belongs in Review (stage conflict);
 *   in Review it proves Pending; in Deliver it proves nothing.
 * - review-pass: Review proves Complete, Deliver proves Pending (approval),
 *   Build proves Pending (send-back).
 * - review-fail: Build proves Pending; Review/Deliver prove nothing (a
 *   failure belongs in Build).
 * - deliver: Deliver proves Complete; anywhere else proves nothing.
 */
function repairTargetFor(
  status: "build" | "review" | "deliver",
  latestKind: ReceiptKind,
  priorKind: ReceiptKind | null,
): ProtocolProgress | null {
  if (status === "build") {
    if (latestKind === "build") {
      return priorKind === "review-pass" || priorKind === "review-fail" ? null : "complete";
    }
    if (latestKind === "review-pass" || latestKind === "review-fail") return "pending";
    return null;
  }
  if (status === "review") {
    if (latestKind === "build") return "pending";
    if (latestKind === "review-pass") return "complete";
    return null;
  }
  if (latestKind === "review-pass") return "pending";
  if (latestKind === "deliver") return "complete";
  return null;
}

function progressKeyOf(diagnosis: IncompleteDiagnosis): string {
  return diagnosis.progresses.length === 0 ? "none" : [...diagnosis.progresses].sort().join("+");
}

function parkReasonText(
  diagnosis: IncompleteDiagnosis,
  reason: IncompleteParkReason,
  latest: FoundReceipt | null,
  prior: FoundReceipt | null,
): string {
  const stage = diagnosis.status;
  if (reason === "no-receipt") {
    return `${stage} carries ${progressKeyOf(diagnosis) === "none" ? "no Progress label" : "several Progress labels"} and Linear holds no valid Igniter receipt; no checkpoint or completion can be proven`;
  }
  if (reason === "stale-checkpoint" && latest) {
    return `${stage} names checkpoint ${latest.receipt.checkpoint} (${latest.receipt.kind} receipt ${latest.receipt.submission}) but it is not in the ticket branch lineage; the receipt is stale`;
  }
  if (reason === "stage-conflict" && latest && prior) {
    return `${stage} holds a correction build receipt (${latest.receipt.submission} binds ${latest.receipt.checkpoint} after ${prior.receipt.kind}); it belongs in Review+Pending, not ${stage} — the stage needs an owner move, not a label guess`;
  }
  if (latest) {
    return `${stage} with ${latest.receipt.kind} receipt ${latest.receipt.submission} proves no single Progress here; only its owning stage converges from it`;
  }
  return `${stage} proves no single Progress from the receipt history`;
}

function incompleteFingerprint(
  diagnosis: IncompleteDiagnosis,
  latest: FoundReceipt | null,
  decision: string,
): string {
  return `${diagnosis.status}|${progressKeyOf(diagnosis)}|${latest?.receipt.submission ?? "no-receipt"}|${decision}`;
}

function incompleteParkBody(
  identifier: string,
  diagnosis: IncompleteDiagnosis,
  latest: FoundReceipt | null,
  prior: FoundReceipt | null,
  reason: IncompleteParkReason,
  fingerprint: string,
  resolved: ResolvedDispatch,
): string {
  const stage = resolved.config.states[diagnosis.status];
  const lines = [
    `${INCOMPLETE_MARKER}`,
    `<!-- fingerprint: ${fingerprint} -->`,
    `Blocked: ${identifier} is ${stage} with ${progressKeyOf(diagnosis) === "none" ? "no Progress label" : `several Progress labels (${progressKeyOf(diagnosis)})`} — ${parkReasonText(diagnosis, reason, latest, prior)}.`,
    ``,
    `Dispatch parked it as ${stage}+Blocked without guessing a checkpoint or completion, and starts no worker here.`,
    `To fix manually:`,
    `- Keep the ticket in ${stage} and leave exactly one Progress label (Pending, In progress, Complete, or Blocked) that matches the newest valid receipt${latest ? ` (${latest.receipt.kind} binds ${latest.receipt.checkpoint})` : ""};`,
    `- or move the ticket to the stage the receipt belongs to, with its converging Progress;`,
    `- then run \`igniter reconcile ${identifier}\`.`,
    ``,
    `This diagnosis posts once per unchanged error; a changed status, Progress set, or newest receipt diagnoses again.`,
  ];
  return lines.join("\n") + "\n";
}

function hasIncompleteComment(comments: { body: string }[], fingerprint: string): boolean {
  return comments.some((c) => c.body.includes(INCOMPLETE_MARKER) && c.body.includes(fingerprint));
}

/**
 * Converge one incomplete active state without Herdr and without opening a
 * workspace: a receipt-proven repair writes exactly one Progress label, and
 * anything else parks as same-stage Blocked with one fingerprinted comment.
 * Both paths read Linear back and verify the converged pair; the checkpoint
 * and the receipt history never change here. Throws ProtocolError (retry
 * the command) when Linear does not converge or moves mid-write.
 */
export async function convergeIncompleteState(
  deps: ProtocolDeps,
  full: FullIssue,
  diagnosis: IncompleteDiagnosis,
): Promise<OwnerMoveOutcome> {
  const { resolved } = deps;
  const latest = latestValidReceipt(full.comments);
  const prior = latest ? latestValidReceiptExcluding(full.comments, latest.receipt.submission) : null;
  const target = latest ? repairTargetFor(diagnosis.status, latest.receipt.kind, prior?.receipt.kind ?? null) : null;

  if (latest && target) {
    // Every repair except a landed delivery still binds the ticket branch:
    // a replaced branch refuses as stale instead of endorsing an old
    // completion or handoff.
    if (!(diagnosis.status === "deliver" && latest.receipt.kind === "deliver")) {
      const inLineage = await checkpointInLineage(deps, full.identifier, latest.receipt.checkpoint);
      if (!inLineage) {
        return parkIncomplete(deps, full);
      }
    }
    // Re-read before writing: the keep-list and the decision must come from
    // fresh Linear, so a concurrent owner fix is never clobbered. A changed
    // newest receipt retries instead of converging on stale history; only
    // receipt identity guards the write, so a benign concurrent comment
    // does not force a retry.
    const fresh = await readback(deps, full.id);
    if (!diagnoseIncompleteState(resolved, fresh as FullIssue)) {
      return alreadyConverged(deps, full, fresh);
    }
    const freshLatest = latestValidReceipt(fresh.comments);
    if ((freshLatest?.receipt.submission ?? null) !== latest.receipt.submission) {
      throw new ProtocolError(`Linear changed mid-repair; retry the command`);
    }
    await setProgress(deps, fresh as FullIssue, target);
    const verified = await readback(deps, full.id);
    const restate = deriveState(resolved, verified);
    if (restate.status !== diagnosis.status || restate.progress !== target) {
      throw new ProtocolError(`Linear did not converge on ${diagnosis.status}+${target}; retry the command`);
    }
    const after = latestValidReceipt(verified.comments);
    if ((after?.receipt.submission ?? null) !== latest.receipt.submission) {
      throw new ProtocolError(`Linear changed mid-repair; retry the command`);
    }
    const from = progressKeyOf(diagnosis);
    const text =
      `repaired: ${full.identifier} ${diagnosis.status}+${from} → ${diagnosis.status}+${target} ` +
      `(${latest.receipt.kind} receipt ${latest.receipt.submission} binds ${latest.receipt.checkpoint}; checkpoint and receipts kept)`;
    return { result: { ok: true, text } };
  }

  return parkIncomplete(deps, full);
}

/**
 * The park reason for a fresh snapshot. Stale beats stage-conflict: a
 * correction receipt the branch no longer contains misdirects as a Review
 * handoff when the checkpoint itself is unprovable.
 */
async function parkReasonFor(
  deps: ProtocolDeps,
  identifier: string,
  diagnosis: IncompleteDiagnosis,
  latest: FoundReceipt | null,
  prior: FoundReceipt | null,
): Promise<IncompleteParkReason> {
  if (!latest) return "no-receipt";
  if (latest.receipt.kind === "deliver" && diagnosis.status === "deliver") return "kind-mismatch";
  if (!(await checkpointInLineage(deps, identifier, latest.receipt.checkpoint))) return "stale-checkpoint";
  if (
    latest.receipt.kind === "build" && diagnosis.status === "build"
    && (prior?.receipt.kind === "review-pass" || prior?.receipt.kind === "review-fail")
  ) {
    return "stage-conflict";
  }
  return "kind-mismatch";
}

/** The pair a fresh read actually holds, for already-converged notes. */
function freshPairText(resolved: ResolvedDispatch, fresh: FullIssue): string {
  const status = statusOf(resolved, fresh.state.id) ?? fresh.state.name;
  const progresses = (fresh.labels ?? [])
    .map((l) => progressOf(resolved, l.id))
    .filter((p): p is ProtocolProgress => p !== undefined);
  return `${status}+${progresses.length === 0 ? "none" : [...progresses].sort().join("+")}`;
}

/** A concurrent change already converged the ticket: report it, write nothing. */
function alreadyConverged(deps: ProtocolDeps, full: FullIssue, fresh: FullIssue): OwnerMoveOutcome {
  void deps;
  return {
    result: {
      ok: true,
      text: `${full.identifier}: Linear already converged while diagnosing (now ${freshPairText(deps.resolved, fresh)}); no change made`,
    },
  };
}

async function parkIncomplete(
  deps: ProtocolDeps,
  full: FullIssue,
): Promise<OwnerMoveOutcome> {
  const { resolved } = deps;
  // Every input below is recomputed from fresh Linear: the fingerprint
  // describes the current error, and a concurrent owner fix returns
  // without writes instead of being clobbered back to Blocked.
  const fresh = await readback(deps, full.id);
  const diagnosis = diagnoseIncompleteState(resolved, fresh as FullIssue);
  if (!diagnosis) {
    return alreadyConverged(deps, full, fresh);
  }
  const latest = latestValidReceipt(fresh.comments);
  const prior = latest ? latestValidReceiptExcluding(fresh.comments, latest.receipt.submission) : null;
  const reason = await parkReasonFor(deps, full.identifier, diagnosis, latest, prior);
  const fingerprint = incompleteFingerprint(diagnosis, latest, `park:${reason}`);
  if (!hasIncompleteComment(fresh.comments, fingerprint)) {
    const body = incompleteParkBody(full.identifier, diagnosis, latest, prior, reason, fingerprint, resolved);
    try {
      await deps.client.addComment(full.id, body);
    } catch (error) {
      if (!isTransientLinearError(error)) throw error;
      const reread = await readback(deps, full.id);
      if (!hasIncompleteComment(reread.comments, fingerprint)) throw error;
    }
  }
  const current = await readback(deps, full.id);
  if (!diagnoseIncompleteState(resolved, current as FullIssue)) {
    return alreadyConverged(deps, full, current);
  }
  await setProgress(deps, current as FullIssue, "blocked");
  const verified = await readback(deps, full.id);
  const restate = deriveState(resolved, verified);
  if (restate.status !== diagnosis.status || restate.progress !== "blocked") {
    throw new ProtocolError(`Linear did not converge on ${diagnosis.status}+blocked; retry the command`);
  }
  const after = latestValidReceipt(verified.comments);
  if ((after?.receipt.submission ?? null) !== (latest?.receipt.submission ?? null)) {
    throw new ProtocolError(`Linear changed mid-park; retry the command`);
  }
  const stage = resolved.config.states[diagnosis.status];
  const text =
    `${full.identifier}: ${diagnosis.status}+${progressKeyOf(diagnosis)} is incomplete — ` +
    `${parkReasonText(diagnosis, reason, latest, prior)}; ` +
    `parked as ${stage}+Blocked (no worker started; run \`igniter reconcile ${full.identifier}\` after fixing)`;
  return { result: { ok: false, text } };
}

// ---------------------------------------------------------------------------
// Owner moves in Linear (normalized from the current Linear status +
// Progress + the newest valid receipt alone; workspace metadata never
// authorizes a transition, and an inherited Complete is never a new
// completion)
// ---------------------------------------------------------------------------

export interface OwnerMoveOutcome {
  /** Null when Linear is already converged. */
  result: CommandResult | null;
}

/** The receipt checkpoint must still bind the ticket branch lineage. */
export async function checkpointInLineage(
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

/** Reconcile an explicit ticket from its Linear status, Progress, and receipts. */
export async function normalizeOwnerMove(
  deps: ProtocolDeps,
  full: FullIssue,
): Promise<OwnerMoveOutcome> {
  const { resolved } = deps;
  const fail = (text: string): OwnerMoveOutcome => ({ result: { ok: false, text } });
  const quiet = (): OwnerMoveOutcome => ({ result: null });
  if (full.projectId !== resolved.projectId) {
    return fail(`${full.identifier} is not in project "${resolved.config.project}"; ignoring`);
  }
  const linearStatus = statusOf(resolved, full.state.id);
  if (!linearStatus) {
    return fail(`${full.identifier} sits in unknown Linear status "${full.state.name}"; ignoring`);
  }
  // Incomplete active states converge through the receipt-proven repair
  // or the same-stage Blocked park below — never by picking one of
  // several carried labels, never by guessing. Other statuses keep the
  // plain refusal: Todo normalizes elsewhere, Backlog/Done carry none.
  if (linearStatus === "build" || linearStatus === "review" || linearStatus === "deliver") {
    const incomplete = diagnoseIncompleteState(resolved, full);
    if (incomplete) {
      return convergeIncompleteState(deps, full, incomplete);
    }
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
    return landDone(deps, reread);
  }

  // An inherited Complete only converges when its receipt checkpoint still
  // binds the ticket branch lineage; a replaced branch refuses with a line.
  // This gate guards the approval handoff only: once a deliver receipt names
  // a landed commit, the rebased branch legitimately no longer contains the
  // approved SHA, so deliver receipts skip the branch-lineage gate and the
  // Done landing verifies the landed commit on the target branch instead.
  if (latest.receipt.kind !== "deliver" && !(await checkpointInLineage(deps, full.identifier, checkpoint))) {
    return fail(
      `${full.identifier}: ${linearStatus}+complete names checkpoint ${checkpoint} but it is not in the ticket branch lineage; ` +
        `the receipt is stale, refusing`,
    );
  }

  if (linearStatus === "review") {
    if (kind === "review-pass") return quiet(); // Waiting for the owner to approve or send back.
    if (kind === "build") {
      return inheritInto(deps, reread, latest, "review", "approved: Build+Complete → Review+Pending");
    }
    return fail(
      `${full.identifier}: Review+Complete but the newest receipt is ${kind}, not build or review-pass; ` +
        `only a completed Build handoff or passing review belongs here, refusing`,
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
    // An initial Build+Complete bound to its build receipt waits for the
    // owner's acceptance: only the owner moves it to
    // Review. Reconcile keeps it still — no transition, no line, no
    // worker start — however often it runs.
    if (kind === "build") return quiet();
    if (kind === "review-pass" || kind === "review-fail") {
      return inheritInto(deps, reread, latest, "build", "sent back: Review+Complete → Build+Pending");
    }
    return fail(
      `${full.identifier}: Build+Complete but the newest receipt is ${kind}, not a build or review receipt; ` +
        `refusing to treat the inherited state as progress`,
    );
  }
  return fail(
    `${full.identifier}: ${linearStatus}+complete matches no approved handoff; ignoring`,
  );
}

/** Clear an inherited Complete only after the receipt authorizes the handoff. */
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
    throw new ProtocolError(`Linear did not converge on ${status}+pending; retry the command`);
  }
  return {
    result: { ok: true, text: `${headline} (${latest.receipt.kind} receipt ${submission} binds ${checkpoint})` },
  };
}

/** Clear leftover Progress on Done; guarded cleanup remains an explicit worker command. */
async function landDone(
  deps: ProtocolDeps,
  full: FullIssue,
  headline = "done: Deliver+Complete → Done",
): Promise<OwnerMoveOutcome> {
  await setProgress(deps, full, null);
  const verified = await readback(deps, full.id);
  const restate = deriveState(deps.resolved, verified);
  if (restate.status !== "done" || restate.progress !== null) {
    throw new ProtocolError(`Linear did not converge on done; retry the command`);
  }
  return { result: { ok: true, text: `${headline}; run worker stop ${full.identifier} for guarded Done cleanup` } };
}
