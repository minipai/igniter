// Minimal Linear GraphQL client over HTTPS.
// The API key travels in the Authorization header only; it is never logged,
// written to disk, or included in error messages.

export const LINEAR_API_URL = "https://api.linear.app/graphql";

export class LinearError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "LinearError";
    this.status = status;
  }
}

export interface LinearTeam {
  id: string;
  name: string;
  key: string;
}

export interface WorkflowState {
  id: string;
  name: string;
  type: string;
}

export interface LinearProject {
  id: string;
  name: string;
  slugId: string;
  teamIds: string[];
}

export interface LinearIssueState {
  id: string;
  name: string;
  /** Workflow type: unstarted, started, completed, canceled, backlog, triage. */
  type?: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  updatedAt: string;
  state: LinearIssueState;
  projectId?: string;
  labels?: LinearLabel[];
}

export interface LinearLabel {
  id: string;
  name: string;
}

export interface LinearLabelNode {
  id: string;
  name: string;
  parent: { id: string; name: string } | null;
}

export interface LinearComment {
  id: string;
  body: string;
  /** Creation time; comment order across pages is normalized on this. */
  createdAt: string;
}

export interface LinearAttachment {
  id: string;
  title: string;
  subtitle: string | null;
  url: string;
  metadata: Record<string, unknown>;
}

export interface LinearAttachmentCreateInput {
  issueId: string;
  url: string;
  title: string;
  subtitle?: string;
  metadata?: Record<string, unknown>;
}

interface IssuePage extends Omit<LinearIssue, "labels"> {
  project: { id: string };
  labels: { nodes: LinearLabel[] };
  comments: { nodes: LinearComment[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
}

export interface LinearClientOptions {
  apiKey: string;
  endpoint?: string;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Per-request timeout; a hung connection must never park the caller. */
  timeoutMs?: number;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

const TEAMS_QUERY = `query { teams { nodes { id name key } } }`;

const TEAM_STATES_QUERY = `query($teamId: String!) {
  team(id: $teamId) { id states { nodes { id name type } } }
}`;

const PROJECTS_QUERY = `query {
  projects { nodes { id name slugId teams { nodes { id } } } }
}`;

const ISSUES_BY_STATE_QUERY = `query($projectId: ID!, $stateId: ID!, $first: Int!) {
  issues(filter: { project: { id: { eq: $projectId } }, state: { id: { eq: $stateId } } }, first: $first) {
    nodes { id identifier title description priority updatedAt state { id name type } labels { nodes { id name } } }
  }
}`;

const ISSUE_QUERY = `query($id: String!, $after: String) {
  issue(id: $id) {
    id identifier title description priority updatedAt
    state { id name type }
    project { id }
    labels { nodes { id name } }
    comments(first: 100, after: $after) {
      nodes { id body createdAt }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const ISSUE_UPDATE_MUTATION = `mutation($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success issue { id identifier state { id name } }
  }
}`;

const COMMENT_CREATE_MUTATION = `mutation($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success comment { id }
  }
}`;

const ATTACHMENTS_QUERY = `query($id: String!) {
  issue(id: $id) {
    id attachments(first: 100) {
      nodes { id title subtitle url metadata }
    }
  }
}`;

const ATTACHMENT_CREATE_MUTATION = `mutation($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) {
    success attachment { id title subtitle url metadata }
  }
}`;

const TEAM_LABELS_QUERY = `query($teamId: String!) {
  team(id: $teamId) { id labels(first: 250) { nodes { id name parent { id name } } } }
}`;

const ISSUE_LABEL_LOOKUP_QUERY = `query($name: String!) {
  issueLabels(filter: { name: { eq: $name } }, first: 1) {
    nodes { id name }
  }
}`;

const ISSUE_LABEL_CREATE_MUTATION = `mutation($name: String!, $teamId: String!) {
  issueLabelCreate(input: { name: $name, teamId: $teamId }) {
    success issueLabel { id name }
  }
}`;

const ISSUE_LABELS_UPDATE_MUTATION = `mutation($id: String!, $labelIds: [String!]!) {
  issueUpdate(id: $id, input: { labelIds: $labelIds }) {
    success issue { id }
  }
}`;

export class LinearClient {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  private readonly timeoutMs: number;

  constructor(options: LinearClientOptions) {
    if (!options.apiKey) {
      throw new Error("LINEAR_API_KEY is not set; export it in the environment (it is never stored in the repo)");
    }
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? LINEAR_API_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const controller = new AbortController();
    // One timer drives both: the AbortSignal releases a hung real
    // connection, and the race still settles when an impl ignores signals.
    let onTimeout: () => void = () => {};
    const timeoutRejection = new Promise<never>((_, reject) => {
      onTimeout = () => {
        controller.abort();
        reject(new LinearError(0, `Linear request timed out after ${this.timeoutMs}ms`));
      };
    });
    const timer = setTimeout(onTimeout, this.timeoutMs);
    let res: Response;
    try {
      res = await Promise.race([
        this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: this.apiKey,
          },
          body: JSON.stringify({ query, variables }),
          signal: controller.signal,
        }),
        timeoutRejection,
      ]);
    } catch (error) {
      if (error instanceof LinearError && error.status === 0 && error.message.includes("timed out")) throw error;
      if (controller.signal.aborted) {
        throw new LinearError(0, `Linear request timed out after ${this.timeoutMs}ms`);
      }
      throw new LinearError(0, `Linear is unreachable at ${this.endpoint}: ${(error as Error).message}`);
    }
    try {
      if (!res.ok) {
        // The body may describe the failure; the API key is never part of it.
        const hint = await res.text().catch(() => "");
        const suffix = hint.trim() ? `: ${hint.trim().slice(0, 300)}` : "";
        throw new LinearError(res.status, `Linear request failed with HTTP ${res.status}${suffix}`);
      }
      const payload = (await res.json()) as GraphQLResponse<T>;
      if (payload.errors?.length) {
        throw new LinearError(200, `Linear GraphQL error: ${payload.errors.map((e) => e.message).join("; ").slice(0, 500)}`);
      }
      if (!payload.data) {
        throw new LinearError(200, "Linear returned no data");
      }
      return payload.data;
    } catch (error) {
      if (error instanceof LinearError) throw error;
      if (controller.signal.aborted) {
        throw new LinearError(0, `Linear request timed out after ${this.timeoutMs}ms`);
      }
      throw new LinearError(0, `Linear response body failed: ${(error as Error).message}`);
    } finally {
      // The timeout covers the body read too: a connection that dies after
      // the headers must still settle, and abort cuts the stalled stream.
      clearTimeout(timer);
    }
  }

  async listTeams(): Promise<LinearTeam[]> {
    const data = await this.graphql<{ teams: { nodes: LinearTeam[] } }>(TEAMS_QUERY);
    return data.teams.nodes;
  }

  async teamStates(teamId: string): Promise<WorkflowState[]> {
    const data = await this.graphql<{ team: { states: { nodes: WorkflowState[] } } | null }>(
      TEAM_STATES_QUERY,
      { teamId },
    );
    if (!data.team) throw new LinearError(200, "Linear team lookup returned nothing");
    return data.team.states.nodes;
  }

  async listProjects(): Promise<LinearProject[]> {
    const data = await this.graphql<{
      projects: { nodes: { id: string; name: string; slugId: string; teams: { nodes: { id: string }[] } }[] };
    }>(PROJECTS_QUERY);
    return data.projects.nodes.map((p) => ({
      id: p.id,
      name: p.name,
      slugId: p.slugId,
      teamIds: p.teams.nodes.map((t) => t.id),
    }));
  }

  /** Every label on the team, with its group parent when grouped. */
  async teamLabels(teamId: string): Promise<LinearLabelNode[]> {
    const data = await this.graphql<{
      team: { labels: { nodes: { id: string; name: string; parent: { id: string; name: string } | null }[] } } | null;
    }>(TEAM_LABELS_QUERY, { teamId });
    if (!data.team) throw new LinearError(200, "Linear team lookup returned nothing");
    return data.team.labels.nodes.map((l) => ({ id: l.id, name: l.name, parent: l.parent }));
  }

  async listIssuesByState(projectId: string, stateId: string, first = 100): Promise<LinearIssue[]> {
    const data = await this.graphql<{
      issues: {
        nodes: (Omit<LinearIssue, "labels"> & { labels?: { nodes: LinearLabel[] } })[];
      };
    }>(ISSUES_BY_STATE_QUERY, {
      projectId,
      stateId,
      first,
    });
    return data.issues.nodes.map(({ labels, ...issue }) => ({
      ...issue,
      labels: labels?.nodes ?? [],
    }));
  }

  async fetchIssue(idOrIdentifier: string): Promise<(LinearIssue & { comments: LinearComment[] }) | null> {    // The claim protocol needs read-back to see every claim comment, so
    // comments are followed through pageInfo instead of trusting one page.
    const comments: LinearComment[] = [];
    let after: string | null = null;
    let header: IssuePage | null = null;
    for (let page = 0; page < 10; page++) {
      const data: { issue: IssuePage | null } = await this.graphql(ISSUE_QUERY, {
        id: idOrIdentifier,
        after,
      });
      if (!data.issue) return null;
      header = data.issue;
      comments.push(...data.issue.comments.nodes);
      if (!data.issue.comments.pageInfo.hasNextPage) break;
      after = data.issue.comments.pageInfo.endCursor;
    }
    if (!header) return null;
    // Linear does not promise comment order across pages: normalize to
    // oldest-first here, once, so every receipt lookup reads newest-last.
    // The sort is stable, so equal timestamps keep their server order.
    comments.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    const { project, labels, comments: _pages, ...issue } = header;
    void _pages;
    return { ...issue, projectId: project.id, labels: labels?.nodes ?? [], comments };
  }

  /**
   * Move an issue to a new workflow state. Linear's update is unconditional:
   * writing the state the issue already has succeeds, so callers must not
   * read any locking semantic out of this call (see claims.ts).
   */
  async setIssueState(issueId: string, stateId: string): Promise<void> {
    const data = await this.graphql<{
      issueUpdate: { success: boolean; issue: { id: string; state: { id: string } } };
    }>(ISSUE_UPDATE_MUTATION, { id: issueId, stateId });
    if (!data.issueUpdate.success) {
      throw new LinearError(200, "Linear refused the state change");
    }
  }

  async addComment(issueId: string, body: string): Promise<string> {
    const data = await this.graphql<{ commentCreate: { success: boolean; comment: { id: string } } }>(
      COMMENT_CREATE_MUTATION,
      { issueId, body },
    );
    if (!data.commentCreate.success) {
      throw new LinearError(200, "Linear refused the comment");
    }
    return data.commentCreate.comment.id;
  }

  /**
   * List the issue's attachments with their metadata round-tripped.
   * Evidence read-back reads this, never receipt prose.
   */
  async listAttachments(issueIdOrIdentifier: string): Promise<LinearAttachment[]> {
    const data = await this.graphql<{
      issue: { id: string; attachments: { nodes: LinearAttachment[] } } | null;
    }>(ATTACHMENTS_QUERY, { id: issueIdOrIdentifier });
    if (!data.issue) return [];
    return data.issue.attachments.nodes;
  }

  /**
   * Create an attachment, or update the one already stored under the same
   * url on the same issue: Linear dedupes on (issueId, url), so a retried
   * submit with the same evidence url updates instead of duplicating.
   * Returns the attachment id.
   */
  async createAttachment(input: LinearAttachmentCreateInput): Promise<string> {
    const data = await this.graphql<{
      attachmentCreate: { success: boolean; attachment: { id: string } };
    }>(ATTACHMENT_CREATE_MUTATION, {
      input: {
        issueId: input.issueId,
        url: input.url,
        title: input.title,
        ...(input.subtitle !== undefined ? { subtitle: input.subtitle } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
    });
    if (!data.attachmentCreate.success) {
      throw new LinearError(200, "Linear refused the attachment");
    }
    return data.attachmentCreate.attachment.id;
  }

  /**
   * Find a workspace-wide label by name. Labels may belong to no team, so
   * filtering by team misses them — and creating a same-named team label
   * then fails as a duplicate.
   */
  async lookupIssueLabel(name: string): Promise<LinearLabel | null> {
    const data = await this.graphql<{ issueLabels: { nodes: LinearLabel[] } }>(
      ISSUE_LABEL_LOOKUP_QUERY,
      { name },
    );
    return data.issueLabels.nodes[0] ?? null;
  }

  async createIssueLabel(teamId: string, name: string): Promise<LinearLabel> {
    const data = await this.graphql<{
      issueLabelCreate: { success: boolean; issueLabel: LinearLabel };
    }>(ISSUE_LABEL_CREATE_MUTATION, { name, teamId });
    if (!data.issueLabelCreate.success) {
      throw new LinearError(200, "Linear refused the label creation");
    }
    return data.issueLabelCreate.issueLabel;
  }

  /**
   * Replace the whole label set: callers read the current labels first and
   * pass them back with the addition, because Linear has no append call.
   */
  async setIssueLabels(issueId: string, labelIds: string[]): Promise<void> {
    const data = await this.graphql<{ issueUpdate: { success: boolean } }>(
      ISSUE_LABELS_UPDATE_MUTATION,
      { id: issueId, labelIds },
    );
    if (!data.issueUpdate.success) {
      throw new LinearError(200, "Linear refused the label update");
    }
  }
}

/** Read the API key from the environment and nowhere else. */
export function requireLinearApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env["LINEAR_API_KEY"];
  if (!key) {
    throw new Error("LINEAR_API_KEY is not set; export it in the environment (it is never stored in the repo)");
  }
  return key;
}
