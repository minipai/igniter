// Acceptance submit with Markdown evidence (STA-268).
//
// Acceptance evidence travels as one free-form Markdown string per criterion:
// fenced command transcripts, images, video or ordinary links, or a
// combination. Igniter renders it verbatim, never parses it for the verdict,
// and never treats it as an attachment URL. Offline against the fake Linear
// endpoint: no real credentials, no real provider, no real project.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, type CommandContext } from "../../run";
import { validateStartup, type ResolvedDispatch } from "../../config/claims";
import { parseDispatchConfig } from "../../config/config";
import { LinearClient } from "../../service/linear/linear";
import { addIssue, standardWorld, startFakeLinear } from "../../service/linear/fake-linear";
import { FakeGit } from "../../testing/fake-git";
import { FakeWorkspaces } from "../../testing/fake-workspaces";

const TODO = "st-todo";
const BUILD = "st-build";
const ACCEPTANCE = "st-acceptance";
const PENDING = "label-pending";
const IN_PROGRESS = "label-in-progress";
const COMPLETE = "label-complete";
const CRITERIA = "## 驗收條件\n- [ ] works\n- [ ] shines\n";
const HEAD = "deadbeefcafe0001";

interface Harness {
  ctx: CommandContext;
  workspaces: FakeWorkspaces;
  git: FakeGit;
  client: LinearClient;
  resolved: ResolvedDispatch;
  world: ReturnType<typeof standardWorld>;
  stop: () => void;
}

async function harness(): Promise<Harness> {
  const world = standardWorld("test-key");
  const fake = startFakeLinear(world);
  const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url, fetchImpl: fake.fetchImpl });
  const resolved = await validateStartup(
    client,
    parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: 3 }),
  );
  const workspaces = new FakeWorkspaces();
  const git = new FakeGit();
  git.head = HEAD;
  const repoRoot = join(mkdtempSync(join(tmpdir(), "igniter-evidence-root-")), "repo");
  const ctx: CommandContext = {
    client,
    resolved,
    decisions: { record: async () => {} },
    workspaces,
    repoRoot,
    git,
  };
  return { ctx, workspaces, git, client, resolved, world, stop: () => fake.stop() };
}

function issueOf(h: Harness, identifier: string) {
  const issue = h.world.issues.find((i) => i.identifier === identifier);
  if (!issue) throw new Error(`no such issue ${identifier}`);
  return issue;
}

async function ticketCommand(
  h: Harness,
  identifier: string,
  action: "begin" | "submit" | "status" | "block" | "unblock",
  value?: string,
) {
  if (action === "begin") {
    const started = await runCommand({ command: "worker.start", ticket: identifier }, h.ctx);
    if (!started.ok) return started;
  }
  if (action === "submit") return runCommand({ command: "submit", ticket: identifier, payload: JSON.parse(value!) }, h.ctx);
  if (action === "status") return runCommand({ command: "status", ticket: identifier, json: true }, h.ctx);
  if (action === "block") return runCommand({ command: "block", ticket: identifier, reason: value! }, h.ctx);
  if (action === "unblock") return runCommand({ command: "unblock", ticket: identifier }, h.ctx);
  return runCommand({ command: "begin", ticket: identifier }, h.ctx);
}

function transcript(command: string, exitCode: number, output: string) {
  return ["```text", `$ ${command}`, output, `Exit code: ${exitCode}`, "```"].join("\n");
}

function buildPayload() {
  return {
    v: 1,
    kind: "build",
    checkpoint: HEAD,
    checks: ["bun run check"],
    results: [
      { criterion: "works", ok: true },
      { criterion: "shines", ok: true },
    ],
    reproduction: "run bun run check",
  };
}

/** Reach Acceptance+In progress, ready for an acceptance submit: first Build, owner handoff, begin. */
async function toAcceptance(h: Harness, identifier: string): Promise<void> {
  addIssue(h.world, { identifier, stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
  expect((await runCommand({ command: "worker.start", ticket: identifier }, h.ctx)).ok).toBe(true);
  expect((await runCommand({ command: "begin", ticket: identifier }, h.ctx)).ok).toBe(true);
  expect((await ticketCommand(h, identifier, "submit", JSON.stringify(buildPayload()))).ok).toBe(true);
  expect(issueOf(h, identifier).stateId).toBe(BUILD);
  h.git.ancestors.add(`${HEAD} feature/${identifier.toLowerCase()}`);
  await h.client.setIssueState(issueOf(h, identifier).id, ACCEPTANCE);
  expect((await runCommand({ command: "reconcile", ticket: identifier }, h.ctx)).ok).toBe(true);
  expect((await ticketCommand(h, identifier, "begin")).ok).toBe(true);
}

describe("Markdown acceptance evidence", () => {
  test("a fenced command transcript PASS lands in Acceptance+Complete with no attachment", async () => {
    const h = await harness();
    try {
      await toAcceptance(h, "STA-1");
      const payload = {
        v: 1,
        kind: "acceptance",
        verdict: "pass",
        checkpoint: HEAD,
        results: [
          { criterion: "works", expected: "cli prints ok", actual: "cli printed ok", evidence: transcript("mycli run", 0, "ok"), ok: true },
          { criterion: "shines", expected: "exit 0", actual: "exit 0", evidence: transcript("mycli shine", 0, "shining"), ok: true },
        ],
        environment: "test lab, 5s timeout",
        reproduction: "run mycli run",
      };
      const out = await ticketCommand(h, "STA-1", "submit", JSON.stringify(payload));
      expect(out.ok).toBe(true);
      const issue = issueOf(h, "STA-1");
      expect(issue.stateId).toBe(ACCEPTANCE);
      expect(issue.labelIds).toEqual([COMPLETE]);
      const receipt = issue.comments.at(-1)!;
      expect(receipt.body).toContain("Agent acceptance: PASS");
      expect(receipt.body).toContain("mycli run");
      expect(receipt.body).toContain("ok");
      // Markdown evidence is not an attachment.
      expect(issue.attachments).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("images and ordinary links are accepted without any kind taxonomy", async () => {
    const h = await harness();
    try {
      await toAcceptance(h, "STA-1");
      const mixed = [
        transcript("mycli run", 0, "ok"),
        "",
        "![Relevant screenshot](https://example.test/evidence.png)",
        "",
        "[Recording](https://example.test/recording)",
      ].join("\n");
      const payload = {
        v: 1,
        kind: "acceptance",
        verdict: "pass",
        checkpoint: HEAD,
        results: [
          { criterion: "works", expected: "cli prints ok", actual: "cli printed ok", evidence: mixed, ok: true },
          { criterion: "shines", expected: "shines", actual: "shines", evidence: "[details](https://example.test/shines)", ok: true },
        ],
        environment: "test lab",
        reproduction: "run mycli run",
      };
      expect((await ticketCommand(h, "STA-1", "submit", JSON.stringify(payload))).ok).toBe(true);
      const issue = issueOf(h, "STA-1");
      expect(issue.attachments).toHaveLength(0);
      const receipt = issue.comments.at(-1)!.body;
      expect(receipt).toContain("https://example.test/evidence.png");
      expect(receipt).toContain("https://example.test/recording");
    } finally {
      h.stop();
    }
  });

  test("the agent verdict stands; Markdown and exit codes never flip it", async () => {
    const h = await harness();
    try {
      // A failing criterion whose transcript says Exit code: 0 is still FAIL.
      await toAcceptance(h, "STA-1");
      const failing = {
        v: 1,
        kind: "acceptance",
        verdict: "fail",
        checkpoint: HEAD,
        results: [
          { criterion: "works", expected: "cli prints ok", actual: "cli printed nope", evidence: transcript("mycli run", 0, "nope"), ok: false },
          { criterion: "shines", expected: "shines", actual: "shines", evidence: "[ok](https://example.test/shines)", ok: true },
        ],
        environment: "test lab",
        reproduction: "run mycli run",
      };
      const out = await ticketCommand(h, "STA-1", "submit", JSON.stringify(failing));
      expect(out.ok).toBe(true);
      expect(issueOf(h, "STA-1").stateId).toBe(BUILD);
      expect(issueOf(h, "STA-1").comments.at(-1)!.body).toContain("Agent acceptance: FAIL");

      // A passing criterion whose transcript says Exit code: 1 is still PASS.
      await toAcceptance(h, "STA-2");
      const passing = {
        v: 1,
        kind: "acceptance",
        verdict: "pass",
        checkpoint: HEAD,
        results: [
          { criterion: "works", expected: "recovers", actual: "recovered", evidence: transcript("mycli retry", 1, "recovered after retry"), ok: true },
          { criterion: "shines", expected: "shines", actual: "shines", evidence: transcript("mycli shine", 0, "shining"), ok: true },
        ],
        environment: "test lab",
        reproduction: "run mycli retry",
      };
      const pass = await ticketCommand(h, "STA-2", "submit", JSON.stringify(passing));
      expect(pass.ok).toBe(true);
      expect(issueOf(h, "STA-2").labelIds).toEqual([COMPLETE]);
    } finally {
      h.stop();
    }
  });

  test("schema errors name the fault and write nothing to Linear", async () => {
    const h = await harness();
    try {
      await toAcceptance(h, "STA-1");
      const cases: { name: string; evidence: unknown; result?: boolean; ok: boolean; message: string }[] = [
        {
          name: "non-string evidence",
          evidence: 42,
          ok: false,
          message: "must be a Markdown string",
        },
        {
          name: "command object taxonomy",
          evidence: { kind: "command", command: "mycli run", exitCode: 0, stdout: "out", stderr: "" },
          ok: false,
          message: "must be a Markdown string",
        },
        {
          name: "missing evidence key",
          evidence: undefined,
          result: true,
          ok: false,
          message: 'every acceptance result needs {"criterion", "expected", "actual", "evidence", "ok"}',
        },
        {
          // Isolates the evidence-presence half of the PASS gate: the result
          // is ok, only its evidence is empty.
          name: "empty evidence on a PASS",
          evidence: "",
          ok: true,
          message: "PASS verdict needs every criterion ok with evidence",
        },
      ];
      for (const c of cases) {
        const result: Record<string, unknown> = {
          criterion: "works",
          expected: "ok",
          actual: "broken",
          evidence: c.evidence,
          ok: c.ok,
        };
        if (c.result) delete result["evidence"];
        const payload = {
          v: 1,
          kind: "acceptance",
          verdict: "pass",
          checkpoint: HEAD,
          results: [
            result,
            { criterion: "shines", expected: "shines", actual: "shines", evidence: "shines", ok: true },
          ],
          environment: "test lab",
          reproduction: "run mycli run",
        };
        const before = JSON.stringify({
          comments: issueOf(h, "STA-1").comments.length,
          attachments: issueOf(h, "STA-1").attachments.length,
          state: issueOf(h, "STA-1").stateId,
          labels: issueOf(h, "STA-1").labelIds,
        });
        const out = await ticketCommand(h, "STA-1", "submit", JSON.stringify(payload));
        expect(out.ok).toBe(false);
        expect(out.text).toContain(c.message);
        expect(JSON.stringify({
          comments: issueOf(h, "STA-1").comments.length,
          attachments: issueOf(h, "STA-1").attachments.length,
          state: issueOf(h, "STA-1").stateId,
          labels: issueOf(h, "STA-1").labelIds,
        })).toBe(before);
      }
      expect(issueOf(h, "STA-1").labelIds).toEqual([IN_PROGRESS]);
    } finally {
      h.stop();
    }
  });

  test("a failing criterion with empty evidence is refused", async () => {
    const h = await harness();
    try {
      await toAcceptance(h, "STA-1");
      const payload = {
        v: 1,
        kind: "acceptance",
        verdict: "fail",
        checkpoint: HEAD,
        results: [
          { criterion: "works", expected: "ok", actual: "broken", evidence: "   ", ok: false },
          { criterion: "shines", expected: "shines", actual: "shines", evidence: "shines", ok: true },
        ],
        environment: "test lab",
        reproduction: "run mycli run",
      };
      const out = await ticketCommand(h, "STA-1", "submit", JSON.stringify(payload));
      expect(out.ok).toBe(false);
      expect(out.text).toContain("every failing criterion needs reproducible");
      expect(issueOf(h, "STA-1").labelIds).toEqual([IN_PROGRESS]);
    } finally {
      h.stop();
    }
  });

  test("published receipt renders separate English headings and preserves nested Markdown", async () => {
    const h = await harness();
    try {
      await toAcceptance(h, "STA-1");
      const evidence = [
        "```text",
        "$ mycli run --check",
        "all green",
        "Exit code: 0",
        "```",
        "",
        "![Relevant screenshot](https://example.com/evidence.png)",
        "",
        "[Recording](https://example.com/recording)",
      ].join("\n");
      const payload = {
        v: 1,
        kind: "acceptance",
        verdict: "pass",
        checkpoint: HEAD,
        results: [
          { criterion: "works", expected: "cli prints ok", actual: "cli printed ok", evidence, ok: true },
          { criterion: "shines", expected: "bright", actual: "bright", evidence: "shone with warnings", ok: true },
        ],
        environment: "test lab",
        reproduction: "run mycli run --check",
      };
      expect((await ticketCommand(h, "STA-1", "submit", JSON.stringify(payload))).ok).toBe(true);
      const read = await h.client.fetchIssue(issueOf(h, "STA-1").id);
      const receipt = read!.comments.at(-1)!.body;
      for (const needle of [
        "**Expected**",
        "**Actual**",
        "**Evidence**",
        "cli prints ok",
        "cli printed ok",
        "shone with warnings",
        "  ```text",
        "  $ mycli run --check",
        "  ![Relevant screenshot](https://example.com/evidence.png)",
        "  [Recording](https://example.com/recording)",
      ]) {
        expect(receipt).toContain(needle);
      }
      expect(receipt).not.toContain("Command:");
      expect(receipt).not.toContain("Command ");
    } finally {
      h.stop();
    }
  });

  test("same submission retry creates no second comment", async () => {
    const h = await harness();
    try {
      await toAcceptance(h, "STA-1");
      const payload = {
        v: 1,
        kind: "acceptance",
        verdict: "pass",
        checkpoint: HEAD,
        results: [
          { criterion: "works", expected: "cli prints ok", actual: "cli printed ok", evidence: transcript("mycli run", 0, "ok"), ok: true },
          { criterion: "shines", expected: "shines", actual: "shines", evidence: transcript("mycli shine", 0, "shining"), ok: true },
        ],
        environment: "test lab",
        reproduction: "run mycli run",
      };
      const body = JSON.stringify(payload);
      expect((await ticketCommand(h, "STA-1", "submit", body)).ok).toBe(true);
      const count = issueOf(h, "STA-1").comments.length;
      // Retry the identical submission from Acceptance+In progress: it converges.
      issueOf(h, "STA-1").stateId = ACCEPTANCE;
      issueOf(h, "STA-1").labelIds = [IN_PROGRESS];
      expect((await ticketCommand(h, "STA-1", "submit", body)).ok).toBe(true);
      expect(issueOf(h, "STA-1").comments.length).toBe(count);
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
    } finally {
      h.stop();
    }
  });
});
