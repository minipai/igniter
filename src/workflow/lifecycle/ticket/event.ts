import { createHash } from "node:crypto";
import { parseRecord, recordBlock, RecordParseError, strictFields, type RecordValue } from "./record.ts";

const EVENT = "igniter_event";
const BEGIN_STAGES = ["build", "review", "deliver"] as const;
const APPROVAL_SOURCES = ["build", "review", "deliver"] as const;
const APPROVAL_TARGETS = ["review", "deliver", "done"] as const;
const BLOCKED_STAGES = ["todo", "build", "review", "deliver"] as const;
const INCOMPLETE_STAGES = ["build", "review", "deliver"] as const;

export type BeginStage = (typeof BEGIN_STAGES)[number];
export type ApprovalSource = (typeof APPROVAL_SOURCES)[number];
export type ApprovalTarget = (typeof APPROVAL_TARGETS)[number];
export type BlockedStage = (typeof BLOCKED_STAGES)[number];
export type IncompleteStage = (typeof INCOMPLETE_STAGES)[number];

export function beginEventBody(ticket: string, stage: BeginStage, after: string | null): string {
  return eventBlock("begin", [["ticket", ticket], ["stage", stage], ["after", after]]);
}

export function parseBeginEvent(body: string): { ticket: string; stage: BeginStage; after: string | null } | null {
  const event = parseEvent(body);
  if (event?.kind === "begin") {
    return {
      ticket: field(event.fields, "ticket", "begin"),
      stage: enumField(event.fields, "stage", "begin", BEGIN_STAGES),
      after: event.fields["after"] === "null" ? null : field(event.fields, "after", "begin"),
    };
  }
  if (event) return null;

  const record = legacyJson(body, /^<!-- igniter:begin (\{[^\n]+\}) -->/);
  if (!record || record["v"] !== 1 || typeof record["ticket"] !== "string" ||
      !BEGIN_STAGES.includes(record["stage"] as BeginStage)) return null;
  return {
    ticket: record["ticket"],
    stage: record["stage"] as BeginStage,
    after: typeof record["after"] === "string" ? record["after"] : null,
  };
}

export function approvalEventBody(
  ticket: string,
  receipt: string,
  submission: string,
  checkpoint: string,
  source: ApprovalSource,
  target: ApprovalTarget,
): string {
  return eventBlock("approval", [
    ["ticket", ticket],
    ["receipt", receipt],
    ["submission", submission],
    ["checkpoint", checkpoint],
    ["source", source],
    ["target", target],
  ]);
}

export function parseApprovalEvent(body: string): {
  ticket: string;
  receipt: string;
  submission: string;
  checkpoint: string;
  source: ApprovalSource;
  target: ApprovalTarget;
} | null {
  const event = parseEvent(body);
  if (event?.kind === "approval") {
    return {
      ticket: field(event.fields, "ticket", "approval"),
      receipt: field(event.fields, "receipt", "approval"),
      submission: field(event.fields, "submission", "approval"),
      checkpoint: field(event.fields, "checkpoint", "approval"),
      source: enumField(event.fields, "source", "approval", APPROVAL_SOURCES),
      target: enumField(event.fields, "target", "approval", APPROVAL_TARGETS),
    };
  }
  if (event) return null;

  const record = legacyJson(body, /^<!-- igniter:approval (\{[^\n]+\}) -->/);
  if (!record || record["v"] !== 1) return null;
  const { ticket, receipt, submission, checkpoint, source, target } = record;
  if (typeof ticket !== "string" || typeof receipt !== "string" || typeof submission !== "string" ||
      typeof checkpoint !== "string" || !APPROVAL_SOURCES.includes(source as ApprovalSource) ||
      !APPROVAL_TARGETS.includes(target as ApprovalTarget)) return null;
  return {
    ticket,
    receipt,
    submission,
    checkpoint,
    source: source as ApprovalSource,
    target: target as ApprovalTarget,
  };
}

export function blockedEventBody(ticket: string, stage: BlockedStage, reason: string): string {
  return eventBlock("blocked", [["ticket", ticket], ["stage", stage], ["reason", textFingerprint(reason)]]);
}

export function parseBlockedEvent(body: string): { ticket: string; stage: BlockedStage; reason: string } | null {
  const event = parseEvent(body);
  if (!event || event.kind !== "blocked") return null;
  return {
    ticket: field(event.fields, "ticket", "blocked"),
    stage: enumField(event.fields, "stage", "blocked", BLOCKED_STAGES),
    reason: field(event.fields, "reason", "blocked"),
  };
}

export function hasBlockedEvent(
  comments: { body: string }[],
  ticket: string,
  stage: BlockedStage,
  reason: string,
): boolean {
  const fingerprint = textFingerprint(reason);
  return comments.some(({ body }) => {
    try {
      const event = parseBlockedEvent(body);
      return event?.ticket === ticket && event.stage === stage && event.reason === fingerprint;
    } catch {
      return false;
    }
  });
}

export function failedEventBody(ticket: string, reason: string): string {
  return eventBlock("failed", [["ticket", ticket], ["reason", textFingerprint(reason)]]);
}

export function parseFailedEvent(body: string): { ticket: string; reason: string } | null {
  const event = parseEvent(body);
  if (!event || event.kind !== "failed") return null;
  return {
    ticket: field(event.fields, "ticket", "failed"),
    reason: field(event.fields, "reason", "failed"),
  };
}

export function hasFailedEvent(comments: { body: string }[], ticket: string, reason: string): boolean {
  const fingerprint = textFingerprint(reason);
  return comments.some(({ body }) => {
    try {
      const event = parseFailedEvent(body);
      return event?.ticket === ticket && event.reason === fingerprint;
    } catch {
      return false;
    }
  });
}

export function incompleteEventBody(
  ticket: string,
  stage: IncompleteStage,
  progress: string,
  receipt: string,
  decision: string,
): string {
  return eventBlock("incomplete-state", [
    ["ticket", ticket],
    ["stage", stage],
    ["progress", progress],
    ["receipt", receipt],
    ["decision", decision],
  ]);
}

export function parseIncompleteEvent(body: string): {
  ticket: string | null;
  stage: IncompleteStage;
  progress: string;
  receipt: string;
  decision: string;
} | null {
  const event = parseEvent(body);
  if (event?.kind === "incomplete-state") {
    return {
      ticket: field(event.fields, "ticket", "incomplete-state"),
      stage: enumField(event.fields, "stage", "incomplete-state", INCOMPLETE_STAGES),
      progress: field(event.fields, "progress", "incomplete-state"),
      receipt: field(event.fields, "receipt", "incomplete-state"),
      decision: field(event.fields, "decision", "incomplete-state"),
    };
  }
  if (event) return null;

  const match = /^<!-- igniter:incomplete-state -->\r?\n<!-- fingerprint: (\S+) -->/.exec(body);
  const parts = match?.[1]?.split("|");
  if (!parts || parts.length !== 4 || !INCOMPLETE_STAGES.includes(parts[0] as IncompleteStage)) return null;
  return {
    ticket: null,
    stage: parts[0] as IncompleteStage,
    progress: parts[1]!,
    receipt: parts[2]!,
    decision: parts[3]!,
  };
}

export function textFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

type EventKind = "begin" | "approval" | "blocked" | "failed" | "incomplete-state";

interface ParsedEvent {
  kind: EventKind;
  fields: Record<string, string>;
}

function eventBlock(kind: EventKind, fields: readonly (readonly [string, RecordValue])[]): string {
  return recordBlock(EVENT, [["kind", kind], ...fields]);
}

function parseEvent(body: string): ParsedEvent | null {
  const record = parseRecord(body, EVENT);
  if (!record) return null;
  const kind = record.get("kind");
  if (!kind) throw new RecordParseError(`refused: event misses required field "kind"`);

  let keys: readonly string[];
  switch (kind) {
    case "begin":
      keys = ["ticket", "stage", "after"];
      break;
    case "approval":
      keys = ["ticket", "receipt", "submission", "checkpoint", "source", "target"];
      break;
    case "blocked":
      keys = ["ticket", "stage", "reason"];
      break;
    case "failed":
      keys = ["ticket", "reason"];
      break;
    case "incomplete-state":
      keys = ["ticket", "stage", "progress", "receipt", "decision"];
      break;
    default:
      throw new RecordParseError(`refused: unknown event kind ${JSON.stringify(kind)}`);
  }
  const fields = strictFields(record, ["kind", ...keys], ["kind", ...keys], `${kind} event`);
  delete fields["kind"];
  return { kind, fields };
}

function field(fields: Record<string, string>, key: string, kind: string): string {
  const value = fields[key];
  if (!value || value === "null") {
    throw new RecordParseError(`refused: ${kind} event needs a non-empty "${key}"`);
  }
  return value;
}

function enumField<T extends string>(
  fields: Record<string, string>,
  key: string,
  kind: string,
  allowed: readonly T[],
): T {
  const value = field(fields, key, kind);
  if (!allowed.includes(value as T)) {
    throw new RecordParseError(
      `refused: ${kind} event needs "${key}" to be one of ${allowed.join(", ")}; got ${JSON.stringify(value)}`,
    );
  }
  return value as T;
}

function legacyJson(body: string, pattern: RegExp): Record<string, unknown> | null {
  const json = pattern.exec(body)?.[1];
  if (!json) return null;
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
