import { readFile } from "node:fs/promises";

const LINEAR_API = "https://api.linear.app/graphql";

const DELIVERY_STATE = `query DeliveryState($id: String!) {
  issue(id: $id) {
    id identifier
    state { id name type }
    team {
      id key
      states { nodes { id name type } }
      labels(first: 250) { nodes { id name parent { id name } } }
    }
    labels { nodes { id name parent { id name } } }
  }
}`;

const MARK_DONE = `mutation MarkDone($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
  }
}`;

export interface PullRequest {
  merged: boolean;
  base: { ref: string; repo: { full_name: string } };
  head: { ref: string; repo: { full_name: string } | null };
}

interface Label {
  id: string;
  name: string;
  parent: { id: string; name: string } | null;
}

interface State {
  id: string;
  name: string;
  type: string;
}

export interface DeliverySnapshot {
  issue: {
    id: string;
    identifier: string;
    state: State;
    team: {
      id: string;
      key: string;
      states: { nodes: State[] };
      labels: { nodes: Label[] };
    };
    labels: { nodes: Label[] };
  } | null;
}

export type DonePlan =
  | { kind: "wait" }
  | { kind: "move"; issueId: string; stateId: string }
  | { kind: "done" };

type Graphql = <T>(query: string, variables: Record<string, string>) => Promise<T>;

export function ticketFromPullRequest(pr: PullRequest): string {
  if (!pr.merged) throw new Error("pull request is not merged");
  if (pr.base.ref !== "main") throw new Error(`pull request targets ${pr.base.ref}, not main`);
  if (!pr.head.repo || pr.head.repo.full_name !== pr.base.repo.full_name) {
    throw new Error("pull request does not come from this repository");
  }
  const match = /^feature\/(STA-\d+)$/i.exec(pr.head.ref);
  if (!match?.[1]) throw new Error(`branch ${pr.head.ref} does not identify one STA ticket`);
  return match[1].toUpperCase();
}

export function planDone(snapshot: DeliverySnapshot, ticket: string): DonePlan {
  const issue = snapshot.issue;
  if (!issue) throw new Error(`Linear issue ${ticket} was not found`);
  if (issue.identifier !== ticket) throw new Error(`Linear returned ${issue.identifier} for ${ticket}`);
  if (issue.team.key !== "STA") throw new Error(`${ticket} belongs to team ${issue.team.key}, not STA`);

  const done = issue.team.states.nodes.filter((state) => state.name === "Done" && state.type === "completed");
  if (done.length !== 1) throw new Error(`team STA has ${done.length} completed Done states`);

  const groupIds = new Set(
    issue.team.labels.nodes
      .map((label) => label.parent)
      .filter((parent): parent is NonNullable<Label["parent"]> => parent?.name === "Progress")
      .map((parent) => parent.id),
  );
  if (groupIds.size !== 1) throw new Error(`team STA has ${groupIds.size} Progress label groups`);
  const groupId = [...groupIds][0] as string;
  const progress = issue.labels.nodes.filter((label) => label.parent?.id === groupId);
  if (progress.length > 1) throw new Error(`${ticket} has conflicting Progress labels`);

  if (issue.state.id === done[0]!.id) {
    if (progress.length === 0 || progress[0]!.name === "Complete") return { kind: "done" };
    throw new Error(`${ticket} is Done with Progress ${progress[0]!.name}`);
  }
  if (issue.state.name !== "Deliver") {
    throw new Error(`${ticket} is ${issue.state.name}, not Deliver or Done`);
  }
  if (progress[0]?.name === "Complete") {
    return { kind: "move", issueId: issue.id, stateId: done[0]!.id };
  }
  return { kind: "wait" };
}

export async function markDoneAfterReceipt(
  ticket: string,
  graphql: Graphql,
  options: { attempts?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const attempts = options.attempts ?? 120;
  const intervalMs = options.intervalMs ?? 5_000;
  const sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const plan = planDone(await graphql<DeliverySnapshot>(DELIVERY_STATE, { id: ticket }), ticket);
    if (plan.kind === "done") return;
    if (plan.kind === "move") {
      const result = await graphql<{ issueUpdate: { success: boolean } }>(MARK_DONE, {
        id: plan.issueId,
        stateId: plan.stateId,
      });
      if (!result.issueUpdate.success) throw new Error(`Linear refused to move ${ticket} to Done`);
      const readback = planDone(await graphql<DeliverySnapshot>(DELIVERY_STATE, { id: ticket }), ticket);
      if (readback.kind !== "done") throw new Error(`${ticket} did not read back as Done`);
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${ticket} did not reach Deliver + Complete before the post-merge deadline`);
}

export function linearGraphql(apiKey: string, fetchImpl: typeof fetch = fetch): Graphql {
  if (!apiKey) throw new Error("LINEAR_API_KEY is not set");
  return async <T>(query: string, variables: Record<string, string>): Promise<T> => {
    const response = await fetchImpl(LINEAR_API, {
      method: "POST",
      headers: { Authorization: apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Linear HTTP ${response.status}`);
    const body = await response.json() as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) throw new Error(`Linear GraphQL: ${body.errors.map((error) => error.message).join("; ")}`);
    if (!body.data) throw new Error("Linear response has no data");
    return body.data;
  };
}

if (import.meta.main) {
  const eventPath = process.argv[2];
  if (!eventPath) throw new Error("usage: bun src/github/linear-done.ts <merged-pr.json>");
  const pr = JSON.parse(await readFile(eventPath, "utf8")) as PullRequest;
  const ticket = ticketFromPullRequest(pr);
  await markDoneAfterReceipt(ticket, linearGraphql(process.env["LINEAR_API_KEY"] ?? ""));
  console.log(`moved ${ticket} to Done after its delivery receipt`);
}
