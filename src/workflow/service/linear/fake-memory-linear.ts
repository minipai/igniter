// Stateful in-memory Linear client for black-box CLI end-to-end tests.
//
// Real CLI subprocesses reach this client through the E2E fixture's test-only
// process boundary. There is no real Linear endpoint or credential. Owner moves
// (Todo→Build→…→Done in the Linear UI) are simulated by direct world
// mutation through the `owner*` helpers only; submits never merge git.
//
// Fixture state stays independent from production transition functions:
// this client is a dumb store implementing the LinearClientLike method
// contracts (unconditional state writes, whole-set label replacement,
// (issue, url) attachment dedupe, oldest-first comments). All state
// derivation, receipt parsing, and slot counting happen in production code.
import {
  LinearError,
  type LinearAttachment,
  type LinearAttachmentCreateInput,
  type LinearClientLike,
  type LinearComment,
  type LinearIssue,
  type LinearLabel,
  type LinearLabelNode,
  type LinearProject,
  type LinearTeam,
  type WorkflowState,
} from "./linear.ts";

export interface MemoryComment {
  id: string;
  body: string;
  createdAt: string;
}

export interface MemoryAttachment {
  id: string;
  title: string;
  subtitle: string | null;
  url: string;
  metadata: Record<string, unknown>;
}

export interface MemoryLabel {
  id: string;
  name: string;
  teamId: string;
  parentId: string | null;
}

export interface MemoryIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  updatedAt: string;
  stateId: string;
  projectId: string;
  labelIds: string[];
  comments: MemoryComment[];
  attachments: MemoryAttachment[];
}

export interface MemoryTeam {
  id: string;
  name: string;
  key: string;
}

export interface MemoryProject {
  id: string;
  name: string;
  slugId: string;
  teamIds: string[];
}

export interface MemoryWorld {
  teams: MemoryTeam[];
  statesByTeam: Record<string, WorkflowState[]>;
  projects: MemoryProject[];
  issues: MemoryIssue[];
  labels: MemoryLabel[];
}

export function standardStates(): WorkflowState[] {
  return [
    { id: "st-backlog", name: "Backlog", type: "backlog" },
    { id: "st-todo", name: "Todo", type: "unstarted" },
    { id: "st-build", name: "Build", type: "started" },
    { id: "st-acceptance", name: "Acceptance", type: "started" },
    { id: "st-deliver", name: "Deliver", type: "started" },
    { id: "st-done", name: "Done", type: "completed" },
    { id: "st-canceled", name: "Canceled", type: "canceled" },
  ];
}

export function standardProgressLabels(): MemoryLabel[] {
  return [
    { id: "label-progress", name: "Progress", teamId: "team-1", parentId: null },
    { id: "label-pending", name: "Pending", teamId: "team-1", parentId: "label-progress" },
    { id: "label-in-progress", name: "In progress", teamId: "team-1", parentId: "label-progress" },
    { id: "label-complete", name: "Complete", teamId: "team-1", parentId: "label-progress" },
    { id: "label-blocked", name: "Blocked", teamId: "team-1", parentId: "label-progress" },
  ];
}

export function standardMemoryWorld(): MemoryWorld {
  return {
    teams: [{ id: "team-1", name: "Starcoder", key: "STA" }],
    statesByTeam: { "team-1": standardStates() },
    projects: [{ id: "proj-1", name: "igniter", slugId: "igniter", teamIds: ["team-1"] }],
    issues: [],
    labels: standardProgressLabels(),
  };
}

let issueCounter = 0;
let commentCounter = 0;
let attachmentCounter = 0;
let labelCounter = 1000;
let clock = 0;

function nextUpdatedAt(): string {
  clock += 1;
  return `2026-09-08T00:00:${String(clock).padStart(2, "0")}.000Z`;
}

function nextCommentAt(): string {
  clock += 1;
  return `2026-09-08T00:00:00.${String(clock).padStart(6, "0")}Z`;
}

export function memoryAddIssue(
  world: MemoryWorld,
  issue: Partial<Omit<MemoryIssue, "comments" | "attachments">> & {
    identifier: string;
    stateId: string;
    comments?: { id: string; body: string; createdAt?: string }[];
    attachments?: MemoryAttachment[];
  },
): MemoryIssue {
  issueCounter += 1;
  const full: MemoryIssue = {
    id: issue.id ?? `issue-${issueCounter}`,
    identifier: issue.identifier,
    title: issue.title ?? issue.identifier,
    description: issue.description ?? null,
    priority: issue.priority ?? 0,
    updatedAt: issue.updatedAt ?? nextUpdatedAt(),
    stateId: issue.stateId,
    projectId: issue.projectId ?? "proj-1",
    labelIds: issue.labelIds ?? [],
    comments: (issue.comments ?? []).map((c) => ({ createdAt: nextCommentAt(), ...c })),
    attachments: issue.attachments ?? [],
  };
  world.issues.push(full);
  return full;
}

export function memoryAddLabel(
  world: MemoryWorld,
  label: { name: string; teamId?: string; parentId?: string | null },
): MemoryLabel {
  labelCounter += 1;
  const full: MemoryLabel = {
    id: `label-${labelCounter}`,
    name: label.name,
    teamId: label.teamId ?? "team-1",
    parentId: label.parentId ?? null,
  };
  world.labels.push(full);
  return full;
}

// ---------------------------------------------------------------------------
// Owner moves: the only writers besides dispatch. They simulate the owner
// dragging the ticket in the Linear UI: status and Progress labels change,
// nothing else (no receipts, no metadata, no git).
// ---------------------------------------------------------------------------

export function ownerSetState(world: MemoryWorld, identifier: string, statusName: string): MemoryIssue {
  const issue = world.issues.find((i) => i.identifier === identifier);
  if (!issue) throw new Error(`memory linear: no issue ${identifier}`);
  const project = world.projects.find((p) => p.id === issue.projectId);
  const teamId = project?.teamIds[0] ?? "team-1";
  const state = world.statesByTeam[teamId]?.find((s) => s.name === statusName);
  if (!state) throw new Error(`memory linear: no status "${statusName}" on ${teamId}`);
  issue.stateId = state.id;
  issue.updatedAt = nextUpdatedAt();
  return issue;
}

function isProgressLabel(world: MemoryWorld, labelId: string): boolean {
  const label = world.labels.find((l) => l.id === labelId);
  if (!label || !label.parentId) return false;
  return world.labels.find((l) => l.id === label.parentId)?.name === "Progress";
}

/** Replace the Progress label set, keeping every non-Progress label. */
export function ownerSetProgress(
  world: MemoryWorld,
  identifier: string,
  progressName: string | null,
): MemoryIssue {
  const issue = world.issues.find((i) => i.identifier === identifier);
  if (!issue) throw new Error(`memory linear: no issue ${identifier}`);
  const keep = issue.labelIds.filter((id) => !isProgressLabel(world, id));
  if (progressName !== null) {
    const label = world.labels.find((l) => l.name === progressName);
    if (!label) throw new Error(`memory linear: no label "${progressName}"`);
    keep.push(label.id);
  }
  issue.labelIds = keep;
  issue.updatedAt = nextUpdatedAt();
  return issue;
}

// ---------------------------------------------------------------------------
// Fault injection: fail-before-write (nothing persisted) or lose-response
// (write persisted, then a transient error). Reads fail the same way.
// ---------------------------------------------------------------------------

export type MemoryMethod =
  | "listTeams"
  | "teamStates"
  | "listProjects"
  | "teamLabels"
  | "listIssuesByState"
  | "fetchIssue"
  | "setIssueState"
  | "addComment"
  | "listAttachments"
  | "createAttachment"
  | "lookupIssueLabel"
  | "createIssueLabel"
  | "setIssueLabels";

export interface MemoryFault {
  /** HTTP-ish status carried on the LinearError (0, 429, 5xx = transient). */
  status: number;
  message: string;
  /** True: perform the write, then throw (lost response). */
  afterWrite: boolean;
}

export interface MemoryCall {
  method: MemoryMethod;
  detail: Record<string, unknown>;
}

function transientError(fault: MemoryFault): LinearError {
  return new LinearError(fault.status, fault.message);
}

export class MemoryLinearClient implements LinearClientLike {
  readonly world: MemoryWorld;
  calls: MemoryCall[] = [];
  private faults: { method: MemoryMethod; skip: number; fault: MemoryFault }[] = [];
  private gates: { method: MemoryMethod; release: Promise<void>; markEntered: () => void; entered: Promise<void> }[] = [];

  constructor(world: MemoryWorld) {
    this.world = world;
  }

  /** Fail the next call to `method`: before the write, or after it when `afterWrite`. */
  failNext(method: MemoryMethod, fault: MemoryFault): void {
    this.faults.push({ method, skip: 0, fault });
  }

  /** Let `skip` calls succeed, then fail the following call. */
  failAfter(method: MemoryMethod, skip: number, fault: MemoryFault): void {
    this.faults.push({ method, skip, fault });
  }

  /** Fail the next `count` calls to `method` before any write. */
  failNextReads(method: MemoryMethod, count: number, status = 502, message = "memory linear exploded"): void {
    for (let i = 0; i < count; i += 1) {
      this.faults.push({ method, skip: 0, fault: { status, message, afterWrite: false } });
    }
  }

  /**
   * Park the next call to `method` at entry until `release` runs. The call
   * is already recorded in `calls`, so a test can wait for entry, kill the
   * CLI, then release and observe the real outcome.
   */
  gateNext(method: MemoryMethod): { release: () => void; entered: Promise<void> } {
    let unblock!: () => void;
    let markEntered!: () => void;
    const release = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    this.gates.push({ method, release, markEntered, entered });
    return { release: unblock, entered };
  }

  private record(method: MemoryMethod, detail: Record<string, unknown> = {}): void {
    this.calls.push({ method, detail });
  }

  private takeFault(method: MemoryMethod): MemoryFault | null {
    const at = this.faults.findIndex((f) => f.method === method);
    if (at < 0) return null;
    const queued = this.faults[at];
    if (queued && queued.skip > 0) {
      queued.skip -= 1;
      return null;
    }
    return this.faults.splice(at, 1)[0]?.fault ?? null;
  }

  private takeGate(method: MemoryMethod): Promise<void> | null {
    const at = this.gates.findIndex((g) => g.method === method);
    if (at < 0) return null;
    const gate = this.gates.splice(at, 1)[0];
    gate?.markEntered();
    return gate?.release ?? null;
  }

  private async enter(method: MemoryMethod, detail: Record<string, unknown> = {}): Promise<MemoryFault | null> {
    this.record(method, detail);
    const gate = this.takeGate(method);
    if (gate) await gate;
    return this.takeFault(method);
  }

  private findIssue(idOrIdentifier: string): MemoryIssue | undefined {
    return this.world.issues.find((i) => i.id === idOrIdentifier)
      ?? this.world.issues.find((i) => i.identifier === idOrIdentifier);
  }

  private stateOf(teamId: string, stateId: string): { id: string; name: string; type: string } {
    const state = this.world.statesByTeam[teamId]?.find((s) => s.id === stateId);
    return { id: stateId, name: state?.name ?? stateId, type: state?.type ?? "unstarted" };
  }

  async listTeams(): Promise<LinearTeam[]> {
    const fault = await this.enter("listTeams");
    if (fault && !fault.afterWrite) throw transientError(fault);
    return this.world.teams.map((t) => ({ ...t }));
  }

  async teamStates(teamId: string): Promise<WorkflowState[]> {
    const fault = await this.enter("teamStates", { teamId });
    if (fault && !fault.afterWrite) throw transientError(fault);
    const states = this.world.statesByTeam[teamId];
    if (!states) throw new LinearError(200, "Linear team lookup returned nothing");
    return states.map((s) => ({ ...s }));
  }

  async listProjects(): Promise<LinearProject[]> {
    const fault = await this.enter("listProjects");
    if (fault && !fault.afterWrite) throw transientError(fault);
    return this.world.projects.map((p) => ({ ...p, teamIds: [...p.teamIds] }));
  }

  async teamLabels(teamId: string): Promise<LinearLabelNode[]> {
    const fault = await this.enter("teamLabels", { teamId });
    if (fault && !fault.afterWrite) throw transientError(fault);
    const known = this.world.teams.some((t) => t.id === teamId);
    if (!known) throw new LinearError(200, "Linear team lookup returned nothing");
    return this.world.labels
      .filter((l) => l.teamId === teamId || l.teamId === "")
      .map((l) => ({
        id: l.id,
        name: l.name,
        parent: l.parentId
          ? (() => {
            const parent = this.world.labels.find((p) => p.id === l.parentId);
            return parent ? { id: parent.id, name: parent.name } : null;
          })()
          : null,
      }));
  }

  async listIssuesByState(projectId: string, stateId: string, first = 100): Promise<LinearIssue[]> {
    const fault = await this.enter("listIssuesByState", { projectId, stateId });
    if (fault && !fault.afterWrite) throw transientError(fault);
    return this.world.issues
      .filter((i) => i.projectId === projectId && i.stateId === stateId)
      .slice(0, first)
      .map((i) => this.shape(i));
  }

  async fetchIssue(idOrIdentifier: string): Promise<(LinearIssue & { comments: LinearComment[] }) | null> {
    const fault = await this.enter("fetchIssue", { id: idOrIdentifier });
    if (fault && !fault.afterWrite) throw transientError(fault);
    const issue = this.findIssue(idOrIdentifier);
    if (!issue) return null;
    const shaped = this.shape(issue);
    // Oldest-first, like the real adapter normalizes; stable on ties.
    const comments = [...issue.comments]
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .map((c) => ({ ...c }));
    return { ...shaped, comments };
  }

  async setIssueState(issueId: string, stateId: string): Promise<void> {
    const fault = await this.enter("setIssueState", { issueId, stateId });
    if (fault && !fault.afterWrite) throw transientError(fault);
    const issue = this.findIssue(issueId);
    if (!issue) throw new LinearError(200, "issue not found");
    // Unconditional, like the real mutation: same-state writes succeed.
    issue.stateId = stateId;
    issue.updatedAt = nextUpdatedAt();
    if (fault?.afterWrite) throw transientError(fault);
  }

  async addComment(issueId: string, body: string): Promise<string> {
    const fault = await this.enter("addComment", { issueId });
    if (fault && !fault.afterWrite) throw transientError(fault);
    const issue = this.findIssue(issueId);
    if (!issue) throw new LinearError(200, "issue not found");
    commentCounter += 1;
    const comment: MemoryComment = { id: `memory-comment-${commentCounter}`, body, createdAt: nextCommentAt() };
    issue.comments.push(comment);
    if (fault?.afterWrite) throw transientError(fault);
    return comment.id;
  }

  async listAttachments(issueIdOrIdentifier: string): Promise<LinearAttachment[]> {
    const fault = await this.enter("listAttachments", { id: issueIdOrIdentifier });
    if (fault && !fault.afterWrite) throw transientError(fault);
    const issue = this.findIssue(issueIdOrIdentifier);
    if (!issue) return [];
    return issue.attachments.map((a) => ({ ...a, metadata: { ...a.metadata } }));
  }

  async createAttachment(input: LinearAttachmentCreateInput): Promise<string> {
    const fault = await this.enter("createAttachment", { issueId: input.issueId, url: input.url });
    if (fault && !fault.afterWrite) throw transientError(fault);
    if (!input.issueId || !input.url || !input.title) {
      throw new LinearError(200, "issueId, url, and title are required");
    }
    const issue = this.findIssue(input.issueId);
    if (!issue) throw new LinearError(200, "issue not found");
    const metadata = { ...(input.metadata ?? {}) };
    const subtitle = input.subtitle ?? null;
    const existing = issue.attachments.find((a) => a.url === input.url);
    if (existing) {
      existing.title = input.title;
      existing.subtitle = subtitle;
      existing.metadata = metadata;
      if (fault?.afterWrite) throw transientError(fault);
      return existing.id;
    }
    attachmentCounter += 1;
    const attachment: MemoryAttachment = {
      id: `memory-attachment-${attachmentCounter}`,
      title: input.title,
      subtitle,
      url: input.url,
      metadata,
    };
    issue.attachments.push(attachment);
    if (fault?.afterWrite) throw transientError(fault);
    return attachment.id;
  }

  async lookupIssueLabel(name: string): Promise<LinearLabel | null> {
    const fault = await this.enter("lookupIssueLabel", { name });
    if (fault && !fault.afterWrite) throw transientError(fault);
    const label = this.world.labels.find((l) => l.name === name);
    return label ? { id: label.id, name: label.name } : null;
  }

  async createIssueLabel(teamId: string, name: string): Promise<LinearLabel> {
    const fault = await this.enter("createIssueLabel", { teamId, name });
    if (fault && !fault.afterWrite) throw transientError(fault);
    const label = memoryAddLabel(this.world, { name, teamId });
    if (fault?.afterWrite) throw transientError(fault);
    return { id: label.id, name: label.name };
  }

  async setIssueLabels(issueId: string, labelIds: string[]): Promise<void> {
    const fault = await this.enter("setIssueLabels", { issueId });
    if (fault && !fault.afterWrite) throw transientError(fault);
    const issue = this.findIssue(issueId);
    if (!issue) throw new LinearError(200, "issue not found");
    // Whole-set replacement, like the real mutation.
    issue.labelIds = [...labelIds];
    if (fault?.afterWrite) throw transientError(fault);
  }

  private shape(issue: MemoryIssue): LinearIssue {
    const project = this.world.projects.find((p) => p.id === issue.projectId);
    const teamId = project?.teamIds[0] ?? "team-1";
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      updatedAt: issue.updatedAt,
      state: this.stateOf(teamId, issue.stateId),
      projectId: issue.projectId,
      labels: issue.labelIds
        .map((id) => this.world.labels.find((l) => l.id === id))
        .filter((l) => l !== undefined)
        .map((l) => ({ id: l.id, name: l.name })),
    };
  }
}
