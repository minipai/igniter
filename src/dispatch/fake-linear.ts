// In-memory fake of the Linear GraphQL endpoint used by dispatch tests.
// It speaks the same operations as LinearClient so tests run offline with no
// real credentials. Real credentials, real providers, and real projects are
// forbidden by AGENTS.md; every dispatch test builds its world here.

export interface FakeState {
  id: string;
  name: string;
  type: string;
}

export interface FakeComment {
  id: string;
  body: string;
}

export interface FakeLabel {
  id: string;
  name: string;
  teamId: string;
}

export interface FakeIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  updatedAt: string;
  stateId: string;
  projectId: string;
  labelIds: string[];
  comments: FakeComment[];
}

export interface FakeTeam {
  id: string;
  name: string;
  key: string;
}

export interface FakeProject {
  id: string;
  name: string;
  slugId: string;
  teamIds: string[];
}

export interface FakeLinearWorld {
  apiKey: string;
  teams: FakeTeam[];
  statesByTeam: Record<string, FakeState[]>;
  projects: FakeProject[];
  issues: FakeIssue[];
  labels: FakeLabel[];
  /** Artificial delay per request, to prove polls never overlap. */
  delayMs?: number;
  /** Fail the first N requests with HTTP 500, to prove polls survive. */
  failFirst?: number;
  /** Fail the next comment creation with a GraphQL error, to prove recovery. */
  failNextComment?: boolean;
  /** Fail the first N requests with HTTP 429, to prove poll backoff. */
  failRateLimitFirst?: number;
  /** Answer the first N requests with a body that never ends, to prove body timeouts. */
  stallBodyFirst?: number;
}

export interface FakeLinearHandle {
  url: string;
  world: FakeLinearWorld;
  requests: number;
  maxConcurrent: number;
  /** True when the API key ever appeared outside the Authorization header. */
  sawKeyOutsideHeader: boolean;
  stop: () => void;
}

export function standardStates(): FakeState[] {
  return [
    { id: "st-backlog", name: "Backlog", type: "backlog" },
    { id: "st-todo", name: "Todo", type: "unstarted" },
    { id: "st-ready", name: "Ready to build", type: "unstarted" },
    { id: "st-building", name: "Building", type: "started" },
    { id: "st-review", name: "Ready to review", type: "started" },
    { id: "st-merge", name: "Ready to merge", type: "started" },
    { id: "st-done", name: "Done", type: "completed" },
    { id: "st-canceled", name: "Canceled", type: "canceled" },
  ];
}

export function standardWorld(apiKey = "test-key"): FakeLinearWorld {
  return {
    apiKey,
    teams: [{ id: "team-1", name: "Starcoder", key: "STA" }],
    statesByTeam: { "team-1": standardStates() },
    projects: [{ id: "proj-1", name: "igniter", slugId: "igniter", teamIds: ["team-1"] }],
    issues: [],
    labels: [],
  };
}

let labelCounter = 0;

let issueCounter = 0;
let commentCounter = 0;
let clock = 0;

function nextUpdatedAt(): string {
  clock += 1;
  return `2026-09-04T00:00:${String(clock).padStart(2, "0")}.000Z`;
}

export function addIssue(
  world: FakeLinearWorld,
  issue: Partial<FakeIssue> & { identifier: string; stateId: string },
): FakeIssue {
  issueCounter += 1;
  const full: FakeIssue = {
    id: issue.id ?? `issue-${issueCounter}`,
    identifier: issue.identifier,
    title: issue.title ?? issue.identifier,
    description: issue.description ?? null,
    priority: issue.priority ?? 0,
    updatedAt: issue.updatedAt ?? nextUpdatedAt(),
    stateId: issue.stateId,
    projectId: issue.projectId ?? "proj-1",
    labelIds: issue.labelIds ?? [],
    comments: issue.comments ?? [],
  };
  world.issues.push(full);
  return full;
}

function stateName(world: FakeLinearWorld, teamId: string, stateId: string): string {
  return world.statesByTeam[teamId]?.find((s) => s.id === stateId)?.name ?? stateId;
}

function stateType(world: FakeLinearWorld, teamId: string, stateId: string): string {
  return world.statesByTeam[teamId]?.find((s) => s.id === stateId)?.type ?? "unstarted";
}

/**
 * The fake validates variable declarations the way a GraphQL server does:
 * a String! where the schema wants ID! is rejected before execution. This
 * keeps client queries honest about Linear's published types.
 */
const EXPECTED_VARIABLES: { match: string; vars: Record<string, string>; absent?: string[] }[] = [
  { match: "commentCreate", vars: { issueId: "String!", body: "String!" } },
  { match: "labelIds", vars: { id: "String!", labelIds: "[String!]!" } },
  { match: "issueUpdate", vars: { id: "String!", stateId: "String!" } },
  { match: "issueLabelCreate", vars: { name: "String!", teamId: "String!" } },
  // The real issueLabels filter takes a name, not a team id: a $teamId here
  // is rejected the way Linear rejects it.
  { match: "issueLabels", vars: { name: "String!" }, absent: ["teamId"] },
  { match: "team(id:", vars: { teamId: "String!" } },
  { match: "issues(", vars: { projectId: "ID!", stateId: "ID!", first: "Int!" } },
  { match: "issue(", vars: { id: "String!" } },
  { match: "projects", vars: {} },
  { match: "teams", vars: {} },
];

function variableMismatch(query: string): string | null {
  const rule = EXPECTED_VARIABLES.find((r) => query.includes(r.match));
  if (!rule) return "unknown operation";
  const declared: Record<string, string> = {};
  const head = /^(?:query|mutation)\s*\(([^)]*)\)/.exec(query)?.[1] ?? "";
  for (const [, name, type] of head.matchAll(/\$(\w+)\s*:\s*(\[[A-Za-z0-9_!]+\]!?|[A-Za-z0-9_!]+)/g)) {
    declared[name as string] = type as string;
  }
  for (const [name, type] of Object.entries(rule.vars)) {
    if (declared[name] !== type) {
      return `Variable $${name} of type ${declared[name] ?? "unknown"} used in position expecting type ${type}`;
    }
  }
  for (const name of rule.absent ?? []) {
    if (name in declared) {
      return `Variable $${name} must not be declared for this operation`;
    }
  }
  return null;
}

export function startFakeLinear(world: FakeLinearWorld): FakeLinearHandle {
  let requests = 0;
  let inFlight = 0;
  let maxConcurrent = 0;
  let sawKeyOutsideHeader = false;
  let failuresLeft = world.failFirst ?? 0;
  let stalledLeft = world.stallBodyFirst ?? 0;

  const server = Bun.serve({
    port: 0,
    fetch: async (req: Request): Promise<Response> => {
      requests += 1;
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      try {
        if (world.delayMs) await Bun.sleep(world.delayMs);
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          return new Response("boom", { status: 500 });
        }
        if ((world.failRateLimitFirst ?? 0) > 0) {
          world.failRateLimitFirst = (world.failRateLimitFirst ?? 0) - 1;
          return new Response("rate limited", { status: 429 });
        }
        if (stalledLeft > 0) {
          stalledLeft -= 1;
          return new Response(
            new ReadableStream({ start() {} }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        const auth = req.headers.get("authorization");
        if (auth !== world.apiKey) {
          return new Response("unauthorized", { status: 401 });
        }
        const rawBody = await req.text();
        if (rawBody.includes(world.apiKey)) sawKeyOutsideHeader = true;
        const { query, variables } = JSON.parse(rawBody) as {
          query: string;
          variables: Record<string, string | number>;
        };
        const mismatch = variableMismatch(query);
        if (mismatch) return Response.json({ errors: [{ message: mismatch }] });

        if (query.includes("commentCreate")) {
          if (world.failNextComment) {
            world.failNextComment = false;
            return Response.json({ errors: [{ message: "rate limited" }] });
          }
          const issue = world.issues.find((i) => i.id === variables["issueId"]);
          if (!issue) return Response.json({ errors: [{ message: "issue not found" }] });
          commentCounter += 1;
          const comment = { id: `comment-${commentCounter}`, body: String(variables["body"]) };
          issue.comments.push(comment);
          return Response.json({ data: { commentCreate: { success: true, comment } } });
        }

        if (query.includes("issueUpdate")) {
          const issue = world.issues.find((i) => i.id === variables["id"]);
          if (!issue) return Response.json({ errors: [{ message: "issue not found" }] });
          if (query.includes("labelIds")) {
            // Label writes replace the whole set, like the real API.
            const ids = variables["labelIds"];
            if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
              return Response.json({ errors: [{ message: "labelIds must be a string array" }] });
            }
            issue.labelIds = [...(ids as string[])];
            return Response.json({ data: { issueUpdate: { success: true, issue: shape(issue, world) } } });
          }
          // Exactly like the real Linear mutation: unconditional. Writing
          // the state the issue already has succeeds and changes nothing.
          issue.stateId = String(variables["stateId"]);
          issue.updatedAt = nextUpdatedAt();
          return Response.json({
            data: { issueUpdate: { success: true, issue: shape(issue, world) } },
          });
        }

        if (query.includes("issueLabelCreate")) {
          const name = String(variables["name"]);
          const teamId = String(variables["teamId"]);
          labelCounter += 1;
          const label = { id: `label-${labelCounter}`, name, teamId };
          world.labels.push(label);
          return Response.json({ data: { issueLabelCreate: { success: true, issueLabel: label } } });
        }

        if (query.includes("issueLabels")) {
          const name = String(variables["name"]);
          const nodes = world.labels
            .filter((l) => l.name === name)
            .slice(0, 1)
            .map((l) => ({ id: l.id, name: l.name }));
          return Response.json({ data: { issueLabels: { nodes } } });
        }

        if (query.includes("issue(")) {
          const byId = world.issues.find((i) => i.id === variables["id"]);
          const issue = byId ?? world.issues.find((i) => i.identifier === variables["id"]);
          if (!issue) return Response.json({ data: { issue: null } });
          const first = Number(/comments\(first:\s*(\d+)/.exec(query)?.[1] ?? 100);
          const after = variables["after"];
          const start = typeof after === "string" && after !== "" ? Number(after) + 1 : 0;
          const nodes = issue.comments.slice(start, start + first);
          const end = start + nodes.length;
          return Response.json({
            data: {
              issue: {
                ...shape(issue, world),
                project: { id: issue.projectId },
                labels: {
                  nodes: issue.labelIds
                    .map((id) => world.labels.find((l) => l.id === id))
                    .filter((l) => l !== undefined)
                    .map((l) => ({ id: l.id, name: l.name })),
                },
                comments: {
                  nodes,
                  pageInfo: {
                    hasNextPage: end < issue.comments.length,
                    endCursor: end > start ? String(end - 1) : null,
                  },
                },
              },
            },
          });
        }

        if (query.includes("issues(")) {
          const nodes = world.issues
            .filter((i) => i.projectId === variables["projectId"] && i.stateId === variables["stateId"])
            .map((i) => shape(i, world));
          return Response.json({ data: { issues: { nodes } } });
        }

        if (query.includes("team(id:")) {
          const teamId = String(variables["teamId"]);
          const states = world.statesByTeam[teamId];
          if (!states) return Response.json({ data: { team: null } });
          return Response.json({ data: { team: { id: teamId, states: { nodes: states } } } });
        }

        if (query.includes("projects")) {
          return Response.json({
            data: {
              projects: {
                nodes: world.projects.map((p) => ({
                  id: p.id,
                  name: p.name,
                  slugId: p.slugId,
                  teams: { nodes: p.teamIds.map((id) => ({ id })) },
                })),
              },
            },
          });
        }

        if (query.includes("teams")) {
          return Response.json({ data: { teams: { nodes: world.teams } } });
        }

        return Response.json({ errors: [{ message: "unknown operation" }] });
      } finally {
        inFlight -= 1;
      }
    },
  });

  return {
    url: `http://localhost:${server.port}/graphql`,
    world,
    get requests() {
      return requests;
    },
    get maxConcurrent() {
      return maxConcurrent;
    },
    get sawKeyOutsideHeader() {
      return sawKeyOutsideHeader;
    },
    stop: () => server.stop(),
  };
}

function shape(issue: FakeIssue, world: FakeLinearWorld) {
  const project = world.projects.find((p) => p.id === issue.projectId);
  const teamId = project?.teamIds[0] ?? "team-1";
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    updatedAt: issue.updatedAt,
    state: { id: issue.stateId, name: stateName(world, teamId, issue.stateId), type: stateType(world, teamId, issue.stateId) },
  };
}
