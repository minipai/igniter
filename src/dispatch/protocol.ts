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
import type { CommandWorkspaces, SnapshotWorkspace } from "./workspaces.ts";
import { ticketWorktree, type GitRunner } from "./worktrees.ts";
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

export function receiptMarker(kind: ReceiptKind, checkpoint: string, submission: string): string {
  return `<!-- igniter:receipt ${kind} ${checkpoint} ${submission} -->`;
}

export interface ParsedReceipt {
  kind: ReceiptKind;
  checkpoint: string;
  submission: string;
}

const RECEIPT_MARKER_RE = /<!-- igniter:receipt (build|review-pass|review-fail|deliver) (\S+) (\S+) -->/;

export function parseReceiptMarker(body: string): ParsedReceipt | null {
  const match = RECEIPT_MARKER_RE.exec(body);
  if (!match) return null;
  return { kind: match[1] as ReceiptKind, checkpoint: match[2] as string, submission: match[3] as string };
}

export function findReceipt(
  comments: { id?: string; body: string }[],
  kind: ReceiptKind,
  submission: string,
): { id: string | null; body: string } | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const parsed = parseReceiptMarker(comments[i]?.body ?? "");
    if (parsed && parsed.kind === kind && parsed.submission === submission) {
      return { id: comments[i]?.id ?? null, body: comments[i]?.body ?? "" };
    }
  }
  return null;
}

/** Latest receipt of any kind, for owner-move validation against metadata. */
export function latestReceipt(comments: { body: string }[]): (ParsedReceipt & { body: string }) | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const parsed = parseReceiptMarker(comments[i]?.body ?? "");
    if (parsed) return { ...parsed, body: comments[i]?.body ?? "" };
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

export interface ReviewResult {
  criterion: string;
  expected: string;
  actual: string;
  evidence: string;
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
      typeof entry["ok"] !== "boolean"
    ) {
      throw new ProtocolError(
        `refused: every review result needs {"criterion", "expected", "actual", "evidence", "ok"}`,
      );
    }
    const evidence = typeof entry["evidence"] === "string" ? (entry["evidence"] as string).trim() : "";
    if (evidence !== "" && !absoluteHttpUrl(evidence)) {
      throw new ProtocolError(
        `refused: review evidence must be an absolute http or https URL; criterion "${(entry["criterion"] as string).trim()}" has ${JSON.stringify(evidence)}`,
      );
    }
    return {
      criterion: (entry["criterion"] as string).trim(),
      expected: (entry["expected"] as string).trim(),
      actual: (entry["actual"] as string).trim(),
      evidence,
      ok: entry["ok"] as boolean,
    };
  });
  checkCoverage("review", criteria, results.map((r) => r.criterion));
  if (!nonEmpty(raw["environment"])) throw new ProtocolError(`refused: review submit needs "environment"`);
  if (!nonEmpty(raw["reproduction"])) throw new ProtocolError(`refused: review submit needs "reproduction" steps`);
  const verdict = raw["verdict"] as "pass" | "fail";
  if (verdict === "pass") {
    const bad = results.filter((r) => !r.ok || !r.evidence);
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
    const noEvidence = failing.filter((r) => !r.evidence);
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
// Receipt bodies (Markdown for people; the marker line is the machine part,
// and workspace metadata carries the identity — Markdown is never parsed
// back into state)
// ---------------------------------------------------------------------------

export function buildReceiptBody(payload: BuildSubmit, submission: string): string {
  const lines = [
    receiptMarker("build", payload.checkpoint, submission),
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
  ];
  return lines.join("\n") + "\n";
}

export function reviewReceiptBody(payload: ReviewSubmit, submission: string): string {
  const verdict = payload.verdict === "pass" ? "PASS" : "FAIL";
  const lines = [
    receiptMarker(payload.verdict === "pass" ? "review-pass" : "review-fail", payload.checkpoint, submission),
    `Agent acceptance: ${verdict}`,
    ``,
    `Checkpoint: \`${payload.checkpoint}\``,
    `Environment: ${payload.environment}`,
    ``,
    ...payload.results.flatMap((r) => [
      `- [${r.ok ? "x" : " "}] ${r.criterion}`,
      `  Expected: ${r.expected}`,
      `  Actual: ${r.actual}`,
      `  Evidence: ${r.evidence}`,
    ]),
    ``,
    `Reproduction:`,
    payload.reproduction,
  ];
  return lines.join("\n") + "\n";
}

export function deliverReceiptBody(payload: DeliverSubmit, submission: string): string {
  const lines = [
    receiptMarker("deliver", payload.checkpoint, submission),
    `# Deliver receipt`,
    ``,
    `Checkpoint: \`${payload.checkpoint}\``,
    `Lineage:`,
    payload.lineage,
    ``,
    `Merge preparation: complete. Still for the owner:`,
    ...payload.owner_actions.map((a) => `- ${a}`),
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
      results: [{ criterion: "<criterion>", expected: "", actual: "", evidence: "<url>", ok: true }],
      environment: "<where acceptance ran>",
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
  const receiptKind = (meta["receipt_kind"] ?? null) as ReceiptKind | null;
  return {
    ticket: {
      identifier: full.identifier,
      title: full.title,
      description: full.description ?? "",
      criteria: state.criteria,
    },
    status: state.status,
    progress: state.progress,
    checkpoint: meta["checkpoint"] ?? null,
    receipt: {
      kind: receiptKind,
      id: meta["receipt_id"] ?? null,
      checkpoint: meta["checkpoint"] ?? null,
      submission: meta["submission"] ?? null,
    },
    block_reason: meta["block_reason"] ?? null,
    next,
    note,
    submit_schema: submitSchemaFor(state.status, meta["checkpoint"] ?? null),
  };
}

// ---------------------------------------------------------------------------
// Claim path (shared by the watcher and `igniter start`)
// ---------------------------------------------------------------------------

export interface ClaimOptions {
  agent?: string;
  builder?: string;
}

export interface AdoptOptions {
  agent?: string;
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
  const kind = options.agent ?? "claude";
  const builder = options.builder ?? resolved.config.models.builder;
  if (options.agent !== undefined) {
    const kinds = await deps.workspaces.agentKinds();
    if (!kinds.includes(kind)) {
      throw new ProtocolError(`refused: unknown agent kind "${kind}"; known kinds: ${kinds.join(", ")}`);
    }
  }
  const from = full.state.name;
  const ticket: ClaimedTicket = {
    id: full.id,
    identifier: full.identifier,
    title: full.title,
    host: deps.host,
    slot: used,
    agent: kind,
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
 * Adopt a ticket whose workspace was lost: reopen through the same sink,
 * then reset its Progress to Pending inside the current status. The
 * receipt identity died with the old workspace, so the run continues from
 * a fresh submit; nothing is rebuilt from comments. Pending always leaves
 * a legal next step (`begin`), so no adopted ticket is ever stuck.
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
  const ticket: ClaimedTicket = {
    id: full.id,
    identifier: full.identifier,
    title: full.title,
    host: deps.host,
    slot: 0,
    agent: options.agent ?? "claude",
    builder: options.builder ?? deps.resolved.config.models.builder,
  };
  let opened: { workspaceId: string; commander: string; builder: string };
  try {
    opened = (await deps.sink(ticket)) ?? { workspaceId: "", commander: ticket.agent ?? "claude", builder: ticket.builder ?? "" };
  } catch (error) {
    if (error instanceof WorkspaceSinkError) throw error;
    throw new WorkspaceSinkError((error as Error).message);
  }
  if (!opened.workspaceId) {
    await deps.decisions.record(full.identifier, `adopted: no workspace found`);
    return opened;
  }
  await setProgress(deps, full, "pending");
  const verified = await readback(deps, full.id);
  const restate = deriveState(deps.resolved, verified);
  if (restate.status !== state.status || restate.progress !== "pending") {
    throw new WorkspaceSinkError(`Linear did not converge on ${state.status}+pending`, opened.workspaceId);
  }
  await mirror(deps, opened.workspaceId, { status: state.status, progress: "pending" });
  await deps.decisions.record(
    full.identifier,
    `adopted: no workspace found, reopened (${opened.workspaceId}) at ${state.status}+pending`,
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
  const from = full.state.name;
  await moveStatus(deps, full, "build", "in_progress");
  await mirror(deps, workspaceId, { status: "build", progress: "in_progress" });
  const ticket: ClaimedTicket = {
    id: full.id,
    identifier: full.identifier,
    title: full.title,
    host: deps.host,
    slot,
    agent: meta["commander"] ?? "claude",
    builder: meta["builder"] ?? resolved.config.models.builder,
  };
  await deps.decisions.record(full.identifier, `claimed: ${from} → ${resolved.config.states.build} (slot ${slot})`);
  await deps.decisions.record(full.identifier, `claim finished in existing workspace (${workspaceId})`);
  return { ...ticket, workspaceId, commander: ticket.agent ?? "claude", builder: ticket.builder ?? "" };
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
  const meta = metaOf(await workspaceOf(deps, workspaceId));
  if (state.status === "build") {
    const payload = parseBuildSubmit(raw, state.criteria);
    return submitBuild(deps, workspaceId, full, payload);
  }
  if (state.status === "review") {
    if (!isRecord(raw) || raw["kind"] !== "review") {
      throw new ProtocolError(`refused: this ticket is in Review; submit {"v":1,"kind":"review",...}`);
    }
    const payload = parseReviewSubmit(raw, state.criteria);
    if (meta["checkpoint"] && payload.checkpoint !== meta["checkpoint"]) {
      throw new ProtocolError(
        `refused: submit names checkpoint ${payload.checkpoint} but the build receipt binds ${meta["checkpoint"]}; ` +
          `a new checkpoint needs a new build submit first`,
      );
    }
    return submitReview(deps, workspaceId, full, payload);
  }
  if (state.status === "deliver") {
    if (!isRecord(raw) || raw["kind"] !== "deliver") {
      throw new ProtocolError(`refused: this ticket is in Deliver; submit {"v":1,"kind":"deliver",...}`);
    }
    const payload = parseDeliverSubmit(raw);
    if (meta["checkpoint"] && payload.checkpoint !== meta["checkpoint"]) {
      throw new ProtocolError(
        `refused: submit names checkpoint ${payload.checkpoint} but approval binds ${meta["checkpoint"]}; ` +
          `re-approval starts from a new build submit`,
      );
    }
    return submitDeliver(deps, workspaceId, full, payload);
  }
  throw new ProtocolError(
    `refused: submit applies to Build, Review, or Deliver; ${full.identifier} is ${state.status}`,
  );
}

async function workspaceOf(deps: ProtocolDeps, workspaceId: string): Promise<SnapshotWorkspace> {
  const snapshot = await deps.workspaces.snapshot();
  const workspace = snapshot.workspaces.find((w) => w.workspaceId === workspaceId);
  if (!workspace) throw new ProtocolError(`unknown workspace "${workspaceId}"`);
  return workspace;
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
  const urls = [...new Set(payload.results.map((r) => r.evidence).filter((u) => u !== ""))];
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
// Owner moves in Linear (the watcher normalizes these against metadata and
// the current receipt; an inherited Complete is never a new completion)
// ---------------------------------------------------------------------------

/**
 * Normalize one owner status move. The workspace metadata must still name
 * the previous status+Complete, and the stored receipt must bind the current
 * checkpoint. Anything else is refused with a line and left alone.
 */
export async function normalizeOwnerMove(
  deps: ClaimDeps,
  workspaceId: string,
  meta: WorkspaceMeta,
  full: FullIssue,
): Promise<CommandResult> {
  const { resolved } = deps;
  const fail = (text: string): CommandResult => ({ ok: false, text });
  if (full.projectId !== resolved.projectId) {
    return fail(`${full.identifier} is not in project "${resolved.config.project}"; ignoring`);
  }
  const linearStatus = statusOf(resolved, full.state.id);
  if (!linearStatus) {
    return fail(`${full.identifier} sits in unknown Linear status "${full.state.name}"; ignoring`);
  }
  const metaStatus = meta["status"];
  const metaProgress = meta["progress"];
  if ((metaStatus !== "review" && metaStatus !== "deliver") || metaProgress !== "complete") {
    return fail(
      `${full.identifier}: workspace metadata is ${metaStatus ?? "?"}+${metaProgress ?? "?"}; ` +
        `owner moves only normalize from Review+Complete or Deliver+Complete`,
    );
  }
  if (linearStatus === metaStatus) {
    return fail(`${full.identifier}: Linear still shows ${metaStatus}; nothing to normalize`);
  }
  const checkpoint = meta["checkpoint"];
  const submission = meta["submission"];
  const receiptKind = meta["receipt_kind"];
  if (!checkpoint || !submission || !receiptKind) {
    return fail(
      `${full.identifier}: owner moved ${metaStatus} → ${linearStatus} but the workspace holds no receipt identity; ` +
        `refusing to treat the inherited state as progress`,
    );
  }
  const reread = await deps.client.fetchIssue(full.id);
  if (!reread) return fail(`${full.identifier} vanished from Linear; ignoring`);
  const receipt = findReceipt(reread.comments, receiptKind as ReceiptKind, submission);
  if (!receipt) {
    return fail(
      `${full.identifier}: owner moved ${metaStatus} → ${linearStatus} but receipt ${submission} does not read back; refusing`,
    );
  }
  const parsed = parseReceiptMarker(receipt.body);
  if (!parsed || parsed.checkpoint !== checkpoint) {
    return fail(
      `${full.identifier}: owner moved ${metaStatus} → ${linearStatus} but the receipt binds a stale checkpoint; refusing`,
    );
  }
  if (metaStatus === "review" && linearStatus === "deliver" && receiptKind === "review-pass") {
    await setProgress(deps, reread as FullIssue, "pending");
    const verified = await readback(deps, full.id);
    const restate = deriveState(resolved, verified);
    if (restate.status !== "deliver" || restate.progress !== "pending") {
      throw new ProtocolError(`Linear did not converge on deliver+pending; the next poll retries`);
    }
    await mirror(deps, workspaceId, {
      status: "deliver",
      progress: "pending",
      receipt_id: null,
      receipt_kind: null,
      submission: null,
    });
    return { ok: true, text: `approved: Review+Complete → Deliver+Pending (PASS receipt ${submission} binds ${checkpoint})` };
  }
  if (metaStatus === "review" && linearStatus === "build" && (receiptKind === "review-pass" || receiptKind === "review-fail")) {
    await setProgress(deps, reread as FullIssue, "pending");
    const verified = await readback(deps, full.id);
    const restate = deriveState(resolved, verified);
    if (restate.status !== "build" || restate.progress !== "pending") {
      throw new ProtocolError(`Linear did not converge on build+pending; the next poll retries`);
    }
    await mirror(deps, workspaceId, {
      status: "build",
      progress: "pending",
      receipt_id: null,
      receipt_kind: null,
      submission: null,
    });
    return { ok: true, text: `sent back: Review+Complete → Build+Pending (receipt ${submission} binds ${checkpoint})` };
  }
  if (metaStatus === "deliver" && linearStatus === "done" && receiptKind === "deliver") {
    await setProgress(deps, reread as FullIssue, null);
    const verified = await readback(deps, full.id);
    const restate = deriveState(resolved, verified);
    if (restate.status !== "done" || restate.progress !== null) {
      throw new ProtocolError(`Linear did not converge on done; the next poll retries`);
    }
    try {
      await deps.workspaces.close(workspaceId);
    } catch (error) {
      throw new ProtocolError(`landed but workspace close failed: ${(error as Error).message}`);
    }
    return { ok: true, text: `done: Deliver+Complete → Done (delivery receipt ${submission} binds ${checkpoint}); workspace closed` };
  }
  return fail(
    `${full.identifier}: owner moved ${metaStatus} → ${linearStatus}, which matches no approved handoff; ignoring`,
  );
}
