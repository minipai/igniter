// Worker scratch and permission boundary (STA-189). Igniter owns one
// deterministic scratch dir per workflow worker; the hard floor pre-authorizes
// only the ticket worktree, bundled read-only assets, and that worker's
// scratch. Everything else escalates. Paths canonicalize first and fail
// closed, never following a symlink out of scope.

import { createHash } from "node:crypto";
import { realpathSync, lstatSync } from "node:fs";
import { dirname, basename, join, resolve, sep } from "node:path";
import { lstat, mkdir, rm } from "node:fs/promises";

export type WorkerName = "builder" | "reviewer" | "deliverer";
export const WORKER_NAMES: WorkerName[] = ["builder", "reviewer", "deliverer"];

/** Deterministic scratch root for a ticket under the repo's ignored runtime data. */
export function scratchRootFor(repoRoot: string, identifier: string): string {
  const ticket = identifier.toLowerCase();
  if (!/^[a-z]{2,}-[0-9]+$/.test(ticket)) {
    throw new ScratchError(`refused: bad ticket identifier "${identifier}"`);
  }
  return join(repoRoot, ".igniter", "runtime", "scratch", ticket);
}

/** Deterministic scratch dir for one workflow worker. */
export function scratchFor(repoRoot: string, identifier: string, worker: WorkerName): string {
  return join(scratchRootFor(repoRoot, identifier), worker);
}

/** Bundled read-only assets Igniter ships (Commander prompts, rules). */
export function bundledAssetsDir(repoRoot: string): string {
  return join(repoRoot, "src", "commander");
}

export class ScratchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScratchError";
  }
}

/**
 * Create a scratch dir without following symlinks out of scope. Any
 * pre-existing symlink on the path itself throws instead of writing through
 * it, so a link pointing outside is never used as a directory.
 */
export async function ensureScratchDir(path: string, root: string): Promise<void> {
  const canonical = lexicalCanonical(path);
  const rootLex = lexicalCanonical(root);
  if (canonical !== rootLex && !canonical.startsWith(rootLex + sep)) {
    throw new ScratchError(`refused: scratch ${path} escapes its root ${root}`);
  }
  const relative = canonical.slice(rootLex.length).split(sep).filter(Boolean);
  let cursor = rootLex;
  for (const part of relative) {
    cursor = cursor + sep + part;
    let stat;
    try {
      stat = await lstat(cursor);
    } catch {
      stat = null;
    }
    if (stat && stat.isSymbolicLink()) {
      throw new ScratchError(`refused: scratch component ${cursor} is a symlink; remove it first`);
    }
    if (stat && !stat.isDirectory()) {
      throw new ScratchError(`refused: scratch component ${cursor} is not a directory`);
    }
  }
  await mkdir(canonical, { recursive: true });
  const final = await lstat(canonical);
  if (final.isSymbolicLink() || !final.isDirectory()) {
    throw new ScratchError(`refused: scratch ${canonical} is not a directory`);
  }
}

/**
 * Repair a scratch dir whose leaf went wrong: a symlink leaf is removed as
 * a link (its target is never touched) and the real dir is recreated.
 * Returns what was repaired: "created", "recreated-link", or "ok".
 */
export async function repairScratchDir(path: string, root: string): Promise<string> {
  if (typeof path !== "string" || typeof root !== "string" || path === "" || root === "") {
    throw new ScratchError(`repairScratchDir needs { path: string, root: string }`);
  }
  const canonical = lexicalCanonical(path);
  const rootLex = lexicalCanonical(root);
  if (canonical === rootLex || !canonical.startsWith(rootLex + sep)) {
    throw new ScratchError(`refused: scratch ${path} escapes its root ${root}`);
  }
  const leaf = await lstat(canonical).catch(() => null);
  if (leaf && leaf.isSymbolicLink()) {
    await rm(canonical);
    await mkdir(canonical, { recursive: true });
    return "recreated-link";
  }
  await ensureScratchDir(path, root);
  return leaf ? "ok" : "created";
}

/** Remove one scratch tree; refuses anything outside its root. */
export async function removeScratchDir(path: string, root: string): Promise<void> {
  const canonical = lexicalCanonical(path);
  const rootLex = lexicalCanonical(root);
  if (canonical === rootLex || !canonical.startsWith(rootLex + sep)) {
    throw new ScratchError(`refused: will not remove outside the scratch root`);
  }
  const top = await lstat(canonical).catch(() => null);
  if (top && top.isSymbolicLink()) {
    await rm(canonical);
    return;
  }
  await rm(canonical, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Hard floor: canonicalize, then contain. Anything unrecognized escalates.
// ---------------------------------------------------------------------------

export interface WorkerScope {
  worktree: string;
  scratch: string;
  assets: string;
  home: string;
}

export interface PathVerdict {
  allow: boolean;
  rule: string;
  canonical: string;
}

export interface ClassifyOptions {
  /** Resolve a lexical path to its on-disk target; defaults to realpath. */
  resolveLink?: (path: string) => string;
}

const SHELL_META = /[><|;&`\n\r]/;
const SHELL_SUBST = /\$\(/;
const REMOTE_RE = /^(ssh:|https?:\/\/[^/]*@|[^/:@\s]+@[^/:@\s]+:|\[[0-9a-fA-F:]+\]:|\/\/[^/])/i;
/** Bare host:port is a network target, never a task file. */
const HOST_PORT_RE = /^[^/\s:@]+:\d+(\/|$)/;
const HOME_CONFIG_RE = /(^|\/)\.(ssh|aws|gnupg|pki|docker|config|local|cache|npm|gitconfig|git-credentials|profile|bashrc|zshrc)(\/|$)/;
const CRED_FILE_RE = /(\.pem$|\.p12$|\.pfx$|\.key$|credentials\.json$|^id_rsa$|^id_ed25519$)/i;
const SYSTEM_RE = /^(\/etc|\/usr|\/bin|\/sbin|\/System|\/Library|\/private|\/var|\/boot|\/proc|\/sys|\/dev)(\/|$)/;

function macAlias(path: string): string {
  if (path === "/var" || path.startsWith("/var/")) return `/private${path}`;
  if (path === "/tmp" || path.startsWith("/tmp")) return path.replace(/^\/tmp/, "/private/tmp");
  return path;
}

function lexicalCanonical(raw: string): string {
  return macAlias(resolve(raw));
}

function defaultResolveLink(path: string): string {
  return existingTarget(path);
}

/**
 * Resolve the deepest existing ancestor, then re-append the missing tail
 * lexically. A write to `worktree/link/newfile` where `link` points outside
 * therefore canonicalizes outside instead of looking like a worktree file.
 */
function existingTarget(lexical: string): string {
  let cursor = lexical;
  const tail: string[] = [];
  for (;;) {
    try {
      lstatSync(cursor);
      break;
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return lexical;
      tail.unshift(basename(cursor));
      cursor = parent;
    }
  }
  let target: string;
  try {
    target = macAlias(realpathSync(cursor));
  } catch {
    return lexical;
  }
  return tail.length > 0 ? join(target, ...tail) : target;
}

/** Canonicalize without ever throwing: failure keeps the lexical form. */
export function canonicalizePath(
  rawPath: string,
  scope: Pick<WorkerScope, "worktree" | "home">,
  opts: ClassifyOptions = {},
): string {
  let raw = rawPath.trim();
  if (raw.startsWith("~")) raw = join(scope.home, raw.slice(1).replace(/^\//, ""));
  const absolute = raw.startsWith("/") ? raw : join(scope.worktree, raw);
  const lexical = lexicalCanonical(absolute);
  try {
    return (opts.resolveLink ?? defaultResolveLink)(lexical);
  } catch {
    return lexical;
  }
}

/** Same canonicalization for a scope root, so both sides share a namespace. */
function canonicalRoot(root: string, opts: ClassifyOptions): string {
  const lexical = lexicalCanonical(root);
  try {
    return (opts.resolveLink ?? existingTarget)(lexical);
  } catch {
    return lexical;
  }
}

/**
 * Decide one file operation. Allows only worktree read/write, scratch
 * read/write, and assets read; everything else escalates. Fails closed on
 * shell metacharacters, remote targets, home/credential/system paths, and
 * any canonical path outside the three roots.
 */
export function classifyPath(
  rawPath: string,
  scope: WorkerScope,
  op: "read" | "write",
  opts: ClassifyOptions = {},
): PathVerdict {
  if (typeof rawPath !== "string" || !rawPath || rawPath.trim() === "" || rawPath.includes("\0")) {
    return { allow: false, rule: "empty-path", canonical: "" };
  }
  if (typeof scope !== "object" || scope === null) {
    throw new Error(`classifyPath needs scope { worktree: string, scratch: string, assets: string, home: string }`);
  }
  const trimmed = rawPath.trim();
  if (SHELL_META.test(trimmed) || SHELL_SUBST.test(trimmed)) {
    return { allow: false, rule: "shell-meta", canonical: trimmed.slice(0, 160) };
  }
  if (REMOTE_RE.test(trimmed) || HOST_PORT_RE.test(trimmed) || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return { allow: false, rule: "remote-host", canonical: trimmed.slice(0, 160) };
  }
  const canonical = canonicalizePath(trimmed, scope, opts);
  const worktree = canonicalRoot(scope.worktree, opts);
  const scratch = canonicalRoot(scope.scratch, opts);
  const assets = canonicalRoot(scope.assets, opts);
  const home = lexicalCanonical(scope.home);
  const inside = (root: string): boolean => canonical === root || canonical.startsWith(root + sep);
  // Scope roots win over generic system/home patterns: a worktree under
  // $HOME or under /private/var is still the task scope. The bundled assets
  // root is consulted before the worktree: it may lie inside the worktree,
  // and its read-only rule must not be shadowed by worktree-scope.
  if (inside(scratch)) return { allow: true, rule: "scratch-scope", canonical };
  if (inside(assets)) {
    return op === "read"
      ? { allow: true, rule: "assets-read", canonical }
      : { allow: false, rule: "assets-readonly", canonical };
  }
  if (inside(worktree)) return { allow: true, rule: "worktree-scope", canonical };
  if (canonical === home || canonical.startsWith(home + sep)) {
    if (HOME_CONFIG_RE.test(canonical) || CRED_FILE_RE.test(canonical)) {
      return { allow: false, rule: "home-credential", canonical };
    }
    return { allow: false, rule: "home-config", canonical };
  }
  if (CRED_FILE_RE.test(canonical)) {
    return { allow: false, rule: "credential-file", canonical };
  }
  if (SYSTEM_RE.test(canonical)) {
    return { allow: false, rule: "system-location", canonical };
  }
  return { allow: false, rule: "outside-scope", canonical };
}

/** Network outside the task scope is never auto-approved. */
export function classifyNetwork(_target: string): { allow: false; rule: string } {
  return { allow: false, rule: "network-escalate" };
}

// ---------------------------------------------------------------------------
// Permission-dialog binding: one exact pane, agent, revision, and screen.
// The caller rereads immediately before sending; any change refuses, the
// keys never fall through to another pane, and dedupe keys include the
// revision so a fresh dialog with the same text is answered again.
// ---------------------------------------------------------------------------

export interface DialogSnapshot {
  paneId: string;
  agentName: string;
  text: string;
  revision: number | null;
}

export function dialogKey(dialog: DialogSnapshot): string {
  if (
    typeof dialog !== "object" ||
    dialog === null ||
    typeof dialog.paneId !== "string" ||
    typeof dialog.agentName !== "string" ||
    typeof dialog.text !== "string"
  ) {
    throw new Error(`dialogKey needs { paneId: string, agentName: string, text: string, revision: number | null }`);
  }
  const hash = createHash("sha256").update(dialog.text).digest("hex").slice(0, 16);
  return `${dialog.paneId}:${dialog.agentName}:${dialog.revision ?? "norev"}:${hash}`;
}

/** True only when the reread shows the same pane, agent, revision, and text. A vanished dialog is never current. */
export function dialogStillCurrent(
  before: DialogSnapshot | null | undefined,
  after: DialogSnapshot | null | undefined,
): boolean {
  if (before === null || before === undefined || after === null || after === undefined) return false;
  return (
    before.paneId === after.paneId &&
    before.agentName === after.agentName &&
    before.revision === after.revision &&
    before.revision !== null &&
    before.text === after.text
  );
}

export interface AutoAnswerRequest {
  dialog: DialogSnapshot | null | undefined;
  reread: DialogSnapshot | null | undefined;
  op: "read" | "write";
  path: string;
  scope: WorkerScope;
  /** Revisions already answered, as a Set or array of dialogKey strings. */
  answered: Set<string> | string[];
  keys: string[];
  opts?: ClassifyOptions;
  /** Receives the formatApprovalLog line on every send. */
  record?: (line: string) => void;
}

export interface AutoAnswerDecision {
  send: boolean;
  paneId?: string;
  keys?: string[];
  reason: string;
  verdict?: PathVerdict;
  /** The audit line for this send; null when nothing was sent. */
  log: string | null;
}

/**
 * Caller obligation: parse `path`/`op` from `dialog.text` itself, so the
 * verdict below always binds the operation the dialog actually asks about.
 * Call as `decideAutoAnswer({ dialog, reread, op, path, scope, answered, keys })`.
 * A vanished dialog refuses; malformed requests throw naming the fields.
 */
export function decideAutoAnswer(req: AutoAnswerRequest): AutoAnswerDecision {
  if (typeof req !== "object" || req === null) {
    throw new Error(`decideAutoAnswer needs { dialog, reread, op: "read" | "write", path, scope, answered, keys }`);
  }
  if (req.dialog === null || req.dialog === undefined || req.reread === null || req.reread === undefined) {
    return { send: false, reason: "dialog-gone", log: null };
  }
  if ((req.op !== "read" && req.op !== "write") || typeof req.path !== "string" || !Array.isArray(req.keys)) {
    throw new Error(`decideAutoAnswer needs { dialog, reread, op: "read" | "write", path: string, scope, answered, keys: string[] }`);
  }
  if (typeof req.scope !== "object" || req.scope === null) {
    throw new Error(`decideAutoAnswer needs scope { worktree: string, scratch: string, assets: string, home: string }`);
  }
  const answered = req.answered instanceof Set ? req.answered : new Set(req.answered ?? []);
  if (!dialogStillCurrent(req.dialog, req.reread)) {
    return { send: false, reason: "dialog-changed", log: null };
  }
  const verdict = classifyPath(req.path, req.scope, req.op, req.opts);
  if (!verdict.allow) {
    return { send: false, reason: `escalate:${verdict.rule}`, verdict, log: null };
  }
  const key = dialogKey(req.reread);
  if (answered.has(key)) {
    return { send: false, reason: "already-answered", verdict, log: null };
  }
  const log = formatApprovalLog({
    agent: req.reread.agentName,
    op: req.op,
    canonical: verdict.canonical,
    revision: req.reread.revision,
    rule: verdict.rule,
  });
  req.record?.(log);
  return { send: true, paneId: req.reread.paneId, keys: [...req.keys], reason: `allow:${verdict.rule}`, verdict, log };
}

/** One decision line per auto-approval: agent, op, canonical path, revision, rule. */
export function formatApprovalLog(input: {
  agent: string;
  op: string;
  canonical: string;
  revision: number | null;
  rule: string;
}): string {
  return `auto-approved agent=${input.agent} op=${input.op} path=${input.canonical} revision=${input.revision ?? "norev"} rule=${input.rule}`;
}
