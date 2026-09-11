// In-memory fake of the Herdr side of dispatch: workspaces, agents, panes,
// and metadata tokens. Tests drive worker lifecycle flows
// here with no daemon, no socket, and no real panes.

import {
  extractRunningTickets,
  KNOWN_AGENT_KINDS,
  type CommandWorkspaces,
  type SnapshotAgent,
  type SnapshotPane,
  type SnapshotWorkspace,
  type WorkspaceSnapshot,
} from "../service/workspace/workspaces.ts";

export interface FakeAgent extends SnapshotAgent {
  kind: string;
  inbox: string[];
}

export interface FakeWorkspace extends SnapshotWorkspace {
  panes: string[];
  closed: boolean;
}

export interface FakeCall {
  method: string;
  params: Record<string, unknown>;
}

/** Real Herdr rejects a metadata report wider than this; the fake matches. */
export const MAX_METADATA_TOKENS = 16;

export class FakeWorkspaces implements CommandWorkspaces {
  workspaces: FakeWorkspace[] = [];
  agents: FakeAgent[] = [];
  kinds: string[] = [...KNOWN_AGENT_KINDS];
  /** Pane output served back by readPane, keyed by pane id. */
  paneText: Record<string, string> = {};
  /** Output revisions served back by readPane; tests bump one to fake new output. */
  paneRevision: Record<string, number> = {};
  calls: FakeCall[] = [];
  snapshotCalls = 0;
  /** Throw from every method whose name appears here. */
  failMethods = new Set<string>();
  /** Throw from only the next N calls, for retry protocol tests. */
  failNextMethods = new Map<string, number>();
  failMessage = "fake herdr exploded";
  /**
   * Deterministic prompt-consumption simulation for prompt-delivery tests:
   * - `consumed`: the agent takes the prompt (lifecycle advances);
   * - `input-buffer`: the text lands in the input box only (STA-197/STA-222);
   * - `lost-response`: the prompt lands, then the response is lost (throws).
   */
  promptMode: "consumed" | "input-buffer" | "lost-response" = "consumed";
  /** Per-agent override of promptMode. */
  promptModes: Record<string, "consumed" | "input-buffer" | "lost-response"> = {};
  private workspaceCounter = 0;
  private paneCounter = 0;
  private tabCounter = 0;

  async runningTickets(): Promise<Set<string>> {
    return extractRunningTickets({
      agents: this.agents.map((a) => ({ name: a.name })),
      workspaces: this.liveWorkspaces().map((w) => ({ tokens: w.tokens })),
    });
  }

  async snapshot(): Promise<WorkspaceSnapshot> {
    this.snapshotCalls += 1;
    this.failWhen("snapshot");
    const live = this.liveWorkspaces();
    const liveIds = new Set(live.map((w) => w.workspaceId));
    return {
      workspaces: live.map((w) => ({
        workspaceId: w.workspaceId,
        label: w.label,
        tokens: { ...w.tokens },
      })),
      agents: this.agents
        .filter((a) => liveIds.has(a.workspaceId))
        .map((a) => ({ name: a.name, agentStatus: a.agentStatus, workspaceId: a.workspaceId, paneId: a.paneId, session: a.session, revision: a.revision })),
      panes: live.flatMap((w): SnapshotPane[] =>
        w.panes.map((paneId) => ({ paneId, workspaceId: w.workspaceId })),
      ),
    };
  }

  async create(input: { label: string; cwd: string; env: Record<string, string> }): Promise<{
    workspaceId: string;
    rootPaneId: string;
  }> {
    this.calls.push({ method: "workspace.create", params: { ...input } });
    this.failWhen("workspace.create");
    this.workspaceCounter += 1;
    this.paneCounter += 1;
    const workspaceId = `ws-${this.workspaceCounter}`;
    const rootPaneId = `pane-${this.paneCounter}`;
    this.workspaces.push({ workspaceId, label: input.label, tokens: {}, panes: [rootPaneId], closed: false });
    return { workspaceId, rootPaneId };
  }

  async close(workspaceId: string): Promise<void> {
    this.calls.push({ method: "workspace.close", params: { workspaceId } });
    this.failWhen("workspace.close");
    const workspace = this.workspaces.find((w) => w.workspaceId === workspaceId);
    if (workspace) workspace.closed = true;
  }

  async createTab(input: { workspaceId: string; cwd?: string; title?: string }): Promise<{ tabId: string }> {
    this.calls.push({ method: "tab.create", params: { ...input } });
    this.failWhen("tab.create");
    const workspace = this.workspaces.find((w) => w.workspaceId === input.workspaceId && !w.closed);
    if (!workspace) throw new Error(`fake herdr: workspace ${input.workspaceId} does not exist`);
    this.paneCounter += 1;
    this.tabCounter += 1;
    workspace.panes.push(`pane-${this.paneCounter}`);
    return { tabId: `tab-${this.tabCounter}` };
  }

  async startAgent(input: { paneId: string; kind: string; name: string; args?: string[] }): Promise<void> {
    this.calls.push({ method: "agent.start", params: { ...input } });
    this.failWhen("agent.start");
    const workspace = this.workspaces.find((w) => w.panes.includes(input.paneId) && !w.closed);
    if (!workspace) throw new Error(`fake herdr: pane ${input.paneId} is not in a live workspace`);
    if (this.agents.some((a) => a.paneId === input.paneId)) {
      throw new Error(`fake herdr: agent target pane ${input.paneId} is not an available shell`);
    }
    const ended = this.agents.findIndex((agent) =>
      agent.name === input.name && /^(done|ended|exited|failed|gone|stopped)$/i.test(agent.agentStatus.trim())
    );
    if (ended >= 0) this.agents.splice(ended, 1);
    this.agents.push({
      name: input.name,
      kind: input.kind,
      agentStatus: "working",
      workspaceId: workspace.workspaceId,
      paneId: input.paneId,
      session: null,
      revision: null,
      inbox: [],
    });
  }

  async stopAgent(agentName: string): Promise<void> {
    this.calls.push({ method: "agent.stop", params: { target: agentName } });
    this.failWhen("agent.stop");
    const agent = this.agents.find((a) => a.name === agentName);
    if (!agent) return;
    this.agents = this.agents.filter((a) => a.name !== agentName);
    for (const workspace of this.workspaces) workspace.panes = workspace.panes.filter((p) => p !== agent.paneId);
  }

  async prompt(agentName: string, text: string): Promise<void> {
    this.calls.push({ method: "agent.prompt", params: { target: agentName, text } });
    this.failWhen("agent.prompt");
    const agent = this.agents.find((a) => a.name === agentName);
    if (!agent) throw new Error(`fake herdr: agent ${agentName} is not running`);
    agent.inbox.push(text);
    const mode = this.promptModes[agentName] ?? this.promptMode;
    if (mode === "lost-response") {
      this.consumePrompt(agent);
      throw new Error("fake herdr: prompt applied but the response was lost");
    }
    if (mode === "consumed") this.consumePrompt(agent);
    // input-buffer: the text sits in the input box; the lifecycle is untouched.
  }

  /**
   * Advance the lifecycle the way a Herdr agent that took its prompt does:
   * the pane produces output (pane revision moves) while the agent row is
   * left alone — the watch loop keys wake-ups off agent status and revision,
   * so a prompt must never rewrite them behind its back.
   */
  private consumePrompt(agent: FakeAgent): void {
    this.paneRevision[agent.paneId] = (this.paneRevision[agent.paneId] ?? 0) + 1;
  }

  /** Raw keys sent to a pane, in order. Tests assert the answer key landed. */
  sentKeys: { paneId: string; keys: string[] }[] = [];

  async sendKeys(paneId: string, keys: string[]): Promise<void> {
    this.calls.push({ method: "pane.send_keys", params: { pane_id: paneId, keys } });
    this.failWhen("pane.send_keys");
    this.sentKeys.push({ paneId, keys: [...keys] });
  }

  async readPane(paneId: string, lines: number): Promise<{ text: string; revision: number | null }> {
    this.calls.push({ method: "pane.read", params: { pane_id: paneId, lines } });
    this.failWhen("pane.read");
    return { text: this.paneText[paneId] ?? "", revision: this.paneRevision[paneId] ?? 0 };
  }

  async reportMetadata(workspaceId: string, tokens: Record<string, string | null>): Promise<void> {
    this.calls.push({ method: "workspace.report_metadata", params: { workspace_id: workspaceId, tokens } });
    this.failWhen("workspace.report_metadata");
    // The real Herdr rejects an over-wide report; the fake enforces the
    // same 16-token cap so an over-wide write fails in tests, not in prod.
    if (Object.keys(tokens).length > MAX_METADATA_TOKENS) {
      throw new Error(
        `fake herdr: a metadata report may update at most ${MAX_METADATA_TOKENS} tokens (got ${Object.keys(tokens).length})`,
      );
    }
    const workspace = this.workspaces.find((w) => w.workspaceId === workspaceId);
    if (!workspace) throw new Error(`fake herdr: workspace ${workspaceId} does not exist`);
    for (const [key, value] of Object.entries(tokens)) {
      if (value === null) delete workspace.tokens[key];
      else workspace.tokens[key] = value;
    }
  }

  async agentKinds(): Promise<string[]> {
    this.failWhen("server.agent_manifests");
    return [...this.kinds];
  }

  /** Seed a live workspace the way a previous start would have left it. */
  seedWorkspace(
    label: string,
    tokens: Record<string, string> = {},
    options: { paneText?: string } = {},
  ): FakeWorkspace {
    this.workspaceCounter += 1;
    this.paneCounter += 1;
    const workspaceId = `ws-${this.workspaceCounter}`;
    const paneId = `pane-${this.paneCounter}`;
    const workspace: FakeWorkspace = {
      workspaceId,
      label,
      tokens: { ...tokens },
      panes: [paneId],
      closed: false,
    };
    this.workspaces.push(workspace);
    if (options.paneText !== undefined) this.paneText[paneId] = options.paneText;
    return workspace;
  }

  promptsFor(agentName: string): string[] {
    return this.agents.find((a) => a.name === agentName)?.inbox ?? [];
  }

  /** Occupy a workspace pane with a named stage agent, the way a live Builder or Acceptance tab does. */
  seedAgent(
    label: string,
    name: string,
    kind = "builder",
    options: { agentStatus?: string; session?: string | null; revision?: number | null } = {},
  ): void {
    const workspace = this.workspaces.find((w) => w.label === label && !w.closed);
    if (!workspace) throw new Error(`fake herdr: workspace ${label} does not exist`);
    const paneId = workspace.panes[0];
    if (!paneId) throw new Error(`fake herdr: workspace ${label} has no pane`);
    this.agents.push({ name, kind, agentStatus: options.agentStatus ?? "working", workspaceId: workspace.workspaceId, paneId, session: options.session ?? null, revision: options.revision ?? null, inbox: [] });
  }

  tokensFor(label: string): Record<string, string> {
    return this.workspaces.find((w) => w.label === label && !w.closed)?.tokens ?? {};
  }

  failNext(method: string, count = 1): void {
    this.failNextMethods.set(method, (this.failNextMethods.get(method) ?? 0) + count);
  }

  private liveWorkspaces(): FakeWorkspace[] {
    return this.workspaces.filter((w) => !w.closed);
  }

  private failWhen(method: string): void {
    const remaining = this.failNextMethods.get(method) ?? 0;
    if (remaining > 0) {
      if (remaining === 1) this.failNextMethods.delete(method);
      else this.failNextMethods.set(method, remaining - 1);
      throw new Error(this.failMessage);
    }
    if (this.failMethods.has(method)) throw new Error(this.failMessage);
  }
}
