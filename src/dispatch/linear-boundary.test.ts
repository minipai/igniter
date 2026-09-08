// LinearClient request/response contract at the fetch boundary only.
// Every test injects a `fetchImpl` stub: no fake Linear server is opened,
// no real provider is touched, and the API key below is fake.
// Mock boundary: these tests prove what the client sends and how it reads
// answers; they do not prove compatibility with the real Linear API.

import { describe, expect, test } from "bun:test";
import { LinearClient, LinearError, requireLinearApiKey, LINEAR_API_URL } from "./linear";

const FAKE_KEY = "fake-test-key";

interface SeenRequest {
  url: string | URL | Request;
  init?: RequestInit;
  body: { query: string; variables: Record<string, unknown> };
}

function stubFetch(
  respond: (seen: SeenRequest) => Response | Promise<Response>,
  seen: SeenRequest[] = [],
): { fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>; seen: SeenRequest[] } {
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const entry: SeenRequest = {
      url: input,
      init,
      body: JSON.parse((init?.body as string) ?? "{}") as SeenRequest["body"],
    };
    seen.push(entry);
    return respond(entry);
  };
  return { fetchImpl, seen };
}

const ok = (data: unknown): Response => Response.json({ data });

describe("linear request contract", () => {
  test("posts JSON to the Linear endpoint with the key in the Authorization header only", async () => {
    const { fetchImpl, seen } = stubFetch(() => ok({ teams: { nodes: [] } }));
    const client = new LinearClient({ apiKey: FAKE_KEY, fetchImpl, timeoutMs: 1_000 });

    await client.listTeams();

    expect(seen).toHaveLength(1);
    expect(String(seen[0]?.url)).toBe(LINEAR_API_URL);
    expect(seen[0]?.init?.method).toBe("POST");
    const headers = seen[0]?.init?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["Authorization"]).toBe(FAKE_KEY);
    // The key travels in the header only, never in the URL or the body.
    expect(String(seen[0]?.url)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(seen[0]?.body)).not.toContain(FAKE_KEY);
  });

  test("sends the query with its variables and defaults to the Linear endpoint", async () => {
    const { fetchImpl, seen } = stubFetch(() => ok({ team: { states: { nodes: [] } } }));
    const client = new LinearClient({ apiKey: FAKE_KEY, fetchImpl, timeoutMs: 1_000 });

    await client.teamStates("team-1");

    expect(seen).toHaveLength(1);
    expect(seen[0]?.body.query).toContain("team(id:");
    expect(seen[0]?.body.variables).toEqual({ teamId: "team-1" });
  });

  test("a custom endpoint override is used verbatim", async () => {
    const { fetchImpl, seen } = stubFetch(() => ok({ teams: { nodes: [] } }));
    const client = new LinearClient({ apiKey: FAKE_KEY, endpoint: "http://stub.invalid/gql", fetchImpl, timeoutMs: 1_000 });

    await client.listTeams();

    expect(String(seen[0]?.url)).toBe("http://stub.invalid/gql");
  });
});

describe("linear issue, label, comment, and attachment contract", () => {
  test("lists issues by state with labels mapped from nodes", async () => {
    const { fetchImpl, seen } = stubFetch(() => ok({
      issues: {
        nodes: [{
          id: "i-1",
          identifier: "STA-1",
          title: "t",
          description: "d",
          priority: 2,
          updatedAt: "2024-01-01",
          state: { id: "s", name: "Todo" },
          labels: { nodes: [{ id: "l", name: "Pending" }] },
        }],
      },
    }));
    const client = new LinearClient({ apiKey: FAKE_KEY, fetchImpl, timeoutMs: 1_000 });

    const issues = await client.listIssuesByState("p-1", "s-todo", 10);

    expect(issues).toEqual([{
      id: "i-1",
      identifier: "STA-1",
      title: "t",
      description: "d",
      priority: 2,
      updatedAt: "2024-01-01",
      state: { id: "s", name: "Todo" },
      labels: [{ id: "l", name: "Pending" }],
    }]);
    expect(seen[0]?.body.variables).toEqual({ projectId: "p-1", stateId: "s-todo", first: 10 });
  });

  test("fetches an issue across comment pages and sorts oldest-first", async () => {
    const pages = [
      {
        issue: {
          id: "i-1",
          identifier: "STA-1",
          title: "t",
          description: null,
          priority: 1,
          updatedAt: "2024-01-01",
          state: { id: "s", name: "Build" },
          project: { id: "p-1" },
          labels: { nodes: [{ id: "l", name: "In progress" }] },
          comments: {
            nodes: [
              { id: "c-b", body: "second", createdAt: "2024-02-01T00:00:00Z" },
              { id: "c-a", body: "first", createdAt: "2024-01-01T00:00:00Z" },
            ],
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          },
        },
      },
      {
        issue: {
          id: "i-1",
          identifier: "STA-1",
          title: "t",
          description: null,
          priority: 1,
          updatedAt: "2024-01-01",
          state: { id: "s", name: "Build" },
          project: { id: "p-1" },
          labels: { nodes: [{ id: "l", name: "In progress" }] },
          comments: {
            nodes: [{ id: "c-c", body: "third", createdAt: "2024-03-01T00:00:00Z" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ];
    let call = 0;
    const { fetchImpl, seen } = stubFetch(() => ok(pages[call++]));
    const client = new LinearClient({ apiKey: FAKE_KEY, fetchImpl, timeoutMs: 1_000 });

    const issue = await client.fetchIssue("STA-1");

    expect(seen).toHaveLength(2);
    expect(seen[0]?.body.variables).toMatchObject({ id: "STA-1" });
    expect(seen[1]?.body.variables).toMatchObject({ id: "STA-1", after: "cursor-1" });
    expect(issue?.projectId).toBe("p-1");
    expect(issue?.labels).toEqual([{ id: "l", name: "In progress" }]);
    expect(issue?.comments.map((comment) => comment.id)).toEqual(["c-a", "c-b", "c-c"]);
  });

  test("returns null for an unknown issue", async () => {
    const { fetchImpl } = stubFetch(() => ok({ issue: null }));
    const client = new LinearClient({ apiKey: FAKE_KEY, fetchImpl, timeoutMs: 1_000 });

    expect(await client.fetchIssue("STA-9")).toBeNull();
  });

  test("moves an issue to a new state and refuses a failed update", async () => {
    const move = stubFetch(() => ok({ issueUpdate: { success: true, issue: { id: "i-1", state: { id: "s-b" } } } }));
    await new LinearClient({ apiKey: FAKE_KEY, fetchImpl: move.fetchImpl, timeoutMs: 1_000 })
      .setIssueState("i-1", "s-b");
    expect(move.seen[0]?.body.variables).toEqual({ id: "i-1", stateId: "s-b" });

    const refused = stubFetch(() => ok({ issueUpdate: { success: false } }));
    await expect(new LinearClient({ apiKey: FAKE_KEY, fetchImpl: refused.fetchImpl, timeoutMs: 1_000 })
      .setIssueState("i-1", "s-b")).rejects.toThrow("refused the state change");
  });

  test("creates a comment and returns its id", async () => {
    const { fetchImpl, seen } = stubFetch(() => ok({ commentCreate: { success: true, comment: { id: "c-new" } } }));
    const client = new LinearClient({ apiKey: FAKE_KEY, fetchImpl, timeoutMs: 1_000 });

    expect(await client.addComment("i-1", "hello")).toBe("c-new");
    expect(seen[0]?.body.variables).toEqual({ issueId: "i-1", body: "hello" });

    const refused = stubFetch(() => ok({ commentCreate: { success: false } }));
    await expect(new LinearClient({ apiKey: FAKE_KEY, fetchImpl: refused.fetchImpl, timeoutMs: 1_000 })
      .addComment("i-1", "hello")).rejects.toThrow("refused the comment");
  });

  test("lists attachments with metadata and maps create input", async () => {
    const list = stubFetch(() => ok({
      issue: {
        id: "i-1",
        attachments: {
          nodes: [{ id: "a-1", title: "evidence", subtitle: "build", url: "https://x/1", metadata: { checkpoint: "abc" } }],
        },
      },
    }));
    const listClient = new LinearClient({ apiKey: FAKE_KEY, fetchImpl: list.fetchImpl, timeoutMs: 1_000 });
    expect(await listClient.listAttachments("STA-1")).toEqual([
      { id: "a-1", title: "evidence", subtitle: "build", url: "https://x/1", metadata: { checkpoint: "abc" } },
    ]);

    const missing = stubFetch(() => ok({ issue: null }));
    expect(await new LinearClient({ apiKey: FAKE_KEY, fetchImpl: missing.fetchImpl, timeoutMs: 1_000 })
      .listAttachments("STA-9")).toEqual([]);

    const { fetchImpl, seen } = stubFetch(() => ok({ attachmentCreate: { success: true, attachment: { id: "a-2" } } }));
    const createClient = new LinearClient({ apiKey: FAKE_KEY, fetchImpl, timeoutMs: 1_000 });
    await expect(createClient.createAttachment({
      issueId: "i-1",
      url: "https://x/2",
      title: "t",
      subtitle: "s",
      metadata: { k: 1 },
    })).resolves.toBe("a-2");
    expect(seen[0]?.body.variables).toEqual({
      input: { issueId: "i-1", url: "https://x/2", title: "t", subtitle: "s", metadata: { k: 1 } },
    });

    const bare = stubFetch(() => ok({ attachmentCreate: { success: true, attachment: { id: "a-3" } } }));
    await new LinearClient({ apiKey: FAKE_KEY, fetchImpl: bare.fetchImpl, timeoutMs: 1_000 })
      .createAttachment({ issueId: "i-1", url: "https://x/3", title: "t" });
    expect(bare.seen[0]?.body.variables).toEqual({ input: { issueId: "i-1", url: "https://x/3", title: "t" } });

    const refused = stubFetch(() => ok({ attachmentCreate: { success: false } }));
    await expect(new LinearClient({ apiKey: FAKE_KEY, fetchImpl: refused.fetchImpl, timeoutMs: 1_000 })
      .createAttachment({ issueId: "i-1", url: "https://x/4", title: "t" }))
      .rejects.toThrow("refused the attachment");
  });

  test("looks up, creates, and replaces labels", async () => {
    const found = stubFetch(() => ok({ issueLabels: { nodes: [{ id: "l-1", name: "Pending" }] } }));
    expect(await new LinearClient({ apiKey: FAKE_KEY, fetchImpl: found.fetchImpl, timeoutMs: 1_000 })
      .lookupIssueLabel("Pending")).toEqual({ id: "l-1", name: "Pending" });
    expect(found.seen[0]?.body.variables).toEqual({ name: "Pending" });

    const absent = stubFetch(() => ok({ issueLabels: { nodes: [] } }));
    expect(await new LinearClient({ apiKey: FAKE_KEY, fetchImpl: absent.fetchImpl, timeoutMs: 1_000 })
      .lookupIssueLabel("Missing")).toBeNull();

    const { fetchImpl, seen } = stubFetch(() => ok({
      issueLabelCreate: { success: true, issueLabel: { id: "l-2", name: "New" } },
    }));
    expect(await new LinearClient({ apiKey: FAKE_KEY, fetchImpl, timeoutMs: 1_000 })
      .createIssueLabel("t-1", "New")).toEqual({ id: "l-2", name: "New" });
    expect(seen[0]?.body.variables).toEqual({ name: "New", teamId: "t-1" });

    const set = stubFetch(() => ok({ issueUpdate: { success: true } }));
    await new LinearClient({ apiKey: FAKE_KEY, fetchImpl: set.fetchImpl, timeoutMs: 1_000 })
      .setIssueLabels("i-1", ["l-1", "l-2"]);
    expect(set.seen[0]?.body.variables).toEqual({ id: "i-1", labelIds: ["l-1", "l-2"] });

    const refused = stubFetch(() => ok({ issueUpdate: { success: false } }));
    await expect(new LinearClient({ apiKey: FAKE_KEY, fetchImpl: refused.fetchImpl, timeoutMs: 1_000 })
      .setIssueLabels("i-1", ["l-1"])).rejects.toThrow("refused the label update");
  });

  test("reads teams, states, projects, and team labels", async () => {
    const teams = stubFetch(() => ok({ teams: { nodes: [{ id: "t", name: "Starcoder", key: "STA" }] } }));
    expect(await new LinearClient({ apiKey: FAKE_KEY, fetchImpl: teams.fetchImpl, timeoutMs: 1_000 }).listTeams())
      .toEqual([{ id: "t", name: "Starcoder", key: "STA" }]);

    const states = stubFetch(() => ok({ team: { states: { nodes: [{ id: "s", name: "Todo", type: "unstarted" }] } } }));
    expect(await new LinearClient({ apiKey: FAKE_KEY, fetchImpl: states.fetchImpl, timeoutMs: 1_000 }).teamStates("t"))
      .toEqual([{ id: "s", name: "Todo", type: "unstarted" }]);

    const noTeam = stubFetch(() => ok({ team: null }));
    await expect(new LinearClient({ apiKey: FAKE_KEY, fetchImpl: noTeam.fetchImpl, timeoutMs: 1_000 }).teamStates("t"))
      .rejects.toThrow("team lookup returned nothing");

    const projects = stubFetch(() => ok({
      projects: { nodes: [{ id: "p", name: "igniter", slugId: "igniter", teams: { nodes: [{ id: "t" }] } }] },
    }));
    expect(await new LinearClient({ apiKey: FAKE_KEY, fetchImpl: projects.fetchImpl, timeoutMs: 1_000 }).listProjects())
      .toEqual([{ id: "p", name: "igniter", slugId: "igniter", teamIds: ["t"] }]);

    const labels = stubFetch(() => ok({
      team: { labels: { nodes: [{ id: "l", name: "Pending", parent: { id: "g", name: "Progress" } }] } },
    }));
    expect(await new LinearClient({ apiKey: FAKE_KEY, fetchImpl: labels.fetchImpl, timeoutMs: 1_000 }).teamLabels("t"))
      .toEqual([{ id: "l", name: "Pending", parent: { id: "g", name: "Progress" } }]);
  });
});

describe("linear transport and payload failures", () => {
  test("HTTP 429 and 500 keep their status and redact the key from body hints", async () => {
    const limited = stubFetch(() => new Response(`rate limited for ${FAKE_KEY}`, { status: 429 }));
    const limitedError = await new LinearClient({ apiKey: FAKE_KEY, fetchImpl: limited.fetchImpl, timeoutMs: 1_000 })
      .listTeams().catch((error: unknown) => error as LinearError);
    expect(limitedError).toBeInstanceOf(LinearError);
    expect((limitedError as LinearError).status).toBe(429);
    expect((limitedError as LinearError).message).toContain("HTTP 429");
    expect((limitedError as LinearError).message).toContain("rate limited for [redacted]");
    expect((limitedError as LinearError).message).not.toContain(FAKE_KEY);

    const broken = stubFetch(() => new Response("upstream blew up", { status: 500 }));
    const brokenError = await new LinearClient({ apiKey: FAKE_KEY, fetchImpl: broken.fetchImpl, timeoutMs: 1_000 })
      .listTeams().catch((error: unknown) => error as LinearError);
    expect((brokenError as LinearError).status).toBe(500);
    expect((brokenError as LinearError).message).toContain("HTTP 500");
  });

  test("GraphQL errors and missing data fail with status 200", async () => {
    const gql = stubFetch(() => Response.json({ errors: [{ message: "bad query" }, { message: "again" }] }));
    await expect(new LinearClient({ apiKey: FAKE_KEY, fetchImpl: gql.fetchImpl, timeoutMs: 1_000 }).listTeams())
      .rejects.toThrow("Linear GraphQL error: bad query; again");

    const empty = stubFetch(() => Response.json({}));
    await expect(new LinearClient({ apiKey: FAKE_KEY, fetchImpl: empty.fetchImpl, timeoutMs: 1_000 }).listTeams())
      .rejects.toThrow("Linear returned no data");
  });

  test("an invalid JSON body fails without the key", async () => {
    const bad = stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError("Unexpected token <"); },
    }) as unknown as Response);
    const error = await new LinearClient({ apiKey: FAKE_KEY, fetchImpl: bad.fetchImpl, timeoutMs: 1_000 })
      .listTeams().catch((error: unknown) => error as LinearError);
    expect((error as LinearError).status).toBe(0);
    expect((error as LinearError).message).toContain("response body failed");
    expect((error as LinearError).message).not.toContain(FAKE_KEY);
  });

  test("a refused connection fails with its message but redacts the key", async () => {
    const down = stubFetch(() => { throw new Error(`connection refused for ${FAKE_KEY}`); });
    const error = await new LinearClient({ apiKey: FAKE_KEY, fetchImpl: down.fetchImpl, timeoutMs: 1_000 })
      .listTeams().catch((error: unknown) => error as LinearError);
    expect((error as LinearError).status).toBe(0);
    expect((error as LinearError).message).toContain("unreachable");
    expect((error as LinearError).message).toContain("connection refused for [redacted]");
    expect((error as LinearError).message).not.toContain(FAKE_KEY);
  });

  test("a hung request times out and aborts", async () => {
    let seenSignal: AbortSignal | undefined;
    const hung = stubFetch((_seen) => new Promise<Response>(() => {}));
    const hangingFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      seenSignal = init?.signal as AbortSignal | undefined;
      return hung.fetchImpl(input, init);
    };
    const error = await new LinearClient({ apiKey: FAKE_KEY, fetchImpl: hangingFetch, timeoutMs: 20 })
      .listTeams().catch((error: unknown) => error as LinearError);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect((error as LinearError).status).toBe(0);
    expect((error as LinearError).message).toContain("timed out after 20ms");
    expect((error as LinearError).message).not.toContain(FAKE_KEY);
  });

  test("a body reader that ignores abort still times out", async () => {
    const stuckBody = async (): Promise<Response> => {
      return {
        ok: true,
        status: 200,
        json: () => new Promise<unknown>(() => {}),
      } as unknown as Response;
    };
    const error = await new LinearClient({ apiKey: FAKE_KEY, fetchImpl: stuckBody, timeoutMs: 20 })
      .listTeams().catch((error: unknown) => error as LinearError);
    expect((error as LinearError).status).toBe(0);
    expect((error as LinearError).message).toContain("timed out after 20ms");
  });

  test("a missing key is refused before any request", () => {
    expect(() => new LinearClient({ apiKey: "", timeoutMs: 1_000 })).toThrow("LINEAR_API_KEY is not set");
    expect(() => requireLinearApiKey({})).toThrow("LINEAR_API_KEY is not set");
    expect(requireLinearApiKey({ LINEAR_API_KEY: FAKE_KEY })).toBe(FAKE_KEY);
  });
});
