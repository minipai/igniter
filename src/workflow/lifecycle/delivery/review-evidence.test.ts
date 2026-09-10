// Review submit with inline command transcripts (STA-195).
//
// Acceptance evidence for CLI/API behavior travels as a structured
// transcript — command, exit code, stdout/stderr excerpts — instead of a
// URL. The verdict always comes from the Acceptance agent; igniter never
// derives it from an exit code. Offline against the fake Linear endpoint:
// no real credentials, no real provider, no real project.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, type CommandContext } from "../../run";
import { validateStartup, type ResolvedDispatch } from "../../config/claims";
import { parseDispatchConfig } from "../../config/config";
import { LinearClient } from "../../service/linear/linear";
import { MAX_COMMAND_EVIDENCE_CHARS } from "../ticket/protocol";
import { addIssue, standardWorld, startFakeLinear } from "../../service/linear/fake-linear";
import { FakeGit } from "../../testing/fake-git";
import { FakeWorkspaces } from "../../testing/fake-workspaces";

const TODO = "st-todo";
const BUILD = "st-build";
const REVIEW = "st-review";
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

function transcript(command: string, exitCode: number, stdout: string, stderr = "") {
  return { kind: "command", command, exitCode, stdout, stderr };
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

/** Reach Review+In progress, ready for a review submit: first Build, owner handoff, begin. */
async function toReview(h: Harness, identifier: string): Promise<void> {
  addIssue(h.world, { identifier, stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
  expect((await runCommand({ command: "worker.start", ticket: identifier }, h.ctx)).ok).toBe(true);
  expect((await runCommand({ command: "begin", ticket: identifier }, h.ctx)).ok).toBe(true);
  expect((await ticketCommand(h, identifier, "submit", JSON.stringify(buildPayload()))).ok).toBe(true);
  expect(issueOf(h, identifier).stateId).toBe(BUILD);
  h.git.ancestors.add(`${HEAD} feature/${identifier.toLowerCase()}`);
  await h.client.setIssueState(issueOf(h, identifier).id, REVIEW);
  expect((await runCommand({ command: "reconcile", ticket: identifier }, h.ctx)).ok).toBe(true);
  expect((await ticketCommand(h, identifier, "begin")).ok).toBe(true);
}

describe("inline command evidence", () => {
  test("command PASS without any URL lands in Review+Complete", async () => {
    const h = await harness();
    try {
      await toReview(h, "STA-1");
      const payload = {
        v: 1,
        kind: "review",
        verdict: "pass",
        checkpoint: HEAD,
        results: [
          { criterion: "works", expected: "cli prints ok", actual: "cli printed ok", evidence: transcript("mycli run", 0, "ok"), ok: true },
          { criterion: "shines", expected: "exit 0", actual: "exit 0", evidence: transcript("mycli shine", 0, "shining", "warn once"), ok: true },
        ],
        environment: "test lab, 5s timeout",
        reproduction: "run mycli run",
      };
      const out = await ticketCommand(h, "STA-1", "submit", JSON.stringify(payload));
      expect(out.ok).toBe(true);
      const issue = issueOf(h, "STA-1");
      expect(issue.stateId).toBe(REVIEW);
      expect(issue.labelIds).toEqual([COMPLETE]);
      const receipt = issue.comments.at(-1)!;
      expect(receipt.body).toContain("Agent acceptance: PASS");
      expect(receipt.body).toContain("mycli run");
      expect(receipt.body).toContain("ok");
      // Transcripts need no attachment: URL media is untouched.
      expect(issue.attachments).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("command FAIL keeps the agent verdict; exit codes never flip it", async () => {
    const h = await harness();
    try {
      // A failing criterion with exit 0 is still FAIL.
      await toReview(h, "STA-1");
      const failing = {
        v: 1,
        kind: "review",
        verdict: "fail",
        checkpoint: HEAD,
        results: [
          { criterion: "works", expected: "cli prints ok", actual: "cli printed nope", evidence: transcript("mycli run", 0, "nope"), ok: false },
          { criterion: "shines", expected: "shines", actual: "shines", evidence: "https://example.test/shines", ok: true },
        ],
        environment: "test lab",
        reproduction: "run mycli run",
      };
      const out = await ticketCommand(h, "STA-1", "submit", JSON.stringify(failing));
      expect(out.ok).toBe(true);
      expect(issueOf(h, "STA-1").stateId).toBe(BUILD);
      expect(issueOf(h, "STA-1").comments.at(-1)!.body).toContain("Agent acceptance: FAIL");

      // A passing criterion with a nonzero exit is still PASS.
      await toReview(h, "STA-2");
      const passing = {
        v: 1,
        kind: "review",
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

  test("mixed URL and transcript evidence publishes both", async () => {
    const h = await harness();
    try {
      await toReview(h, "STA-1");
      const payload = {
        v: 1,
        kind: "review",
        verdict: "pass",
        checkpoint: HEAD,
        results: [
          { criterion: "works", expected: "cli prints ok", actual: "cli printed ok", evidence: transcript("mycli run", 0, "ok"), ok: true },
          { criterion: "shines", expected: "shines", actual: "shines", evidence: "https://example.test/shines", ok: true },
        ],
        environment: "test lab",
        reproduction: "run mycli run",
      };
      expect((await ticketCommand(h, "STA-1", "submit", JSON.stringify(payload))).ok).toBe(true);
      const issue = issueOf(h, "STA-1");
      expect(issue.attachments.map((a) => a.url)).toEqual(["https://example.test/shines"]);
      const receipt = issue.comments.at(-1)!.body;
      expect(receipt).toContain("mycli run");
      expect(receipt).toContain("https://example.test/shines");
    } finally {
      h.stop();
    }
  });

  test("schema errors name the fault and write nothing to Linear", async () => {
    const h = await harness();
    try {
      await toReview(h, "STA-1");
      const cases: { name: string; evidence: unknown; message: string }[] = [
        {
          name: "missing command",
          evidence: { kind: "command", exitCode: 0, stdout: "out", stderr: "" },
          message: 'needs a non-empty "command"',
        },
        {
          name: "missing exit code",
          evidence: { kind: "command", command: "mycli run", stdout: "out", stderr: "" },
          message: 'needs an integer "exitCode"',
        },
        {
          name: "empty output",
          evidence: transcript("mycli run", 1, "  ", ""),
          message: 'needs non-empty "stdout" or "stderr"',
        },
        {
          name: "oversize transcript",
          evidence: transcript("mycli run", 1, "x".repeat(MAX_COMMAND_EVIDENCE_CHARS + 1)),
          message: `exceeds ${MAX_COMMAND_EVIDENCE_CHARS} chars`,
        },
        {
          name: "non-URL string",
          evidence: "Command output: everything passed",
          message: "absolute http or https URL or a command transcript",
        },
        {
          name: "non-string evidence",
          evidence: 42,
          message: 'must be an absolute http or https URL or a command transcript',
        },
        {
          name: "non-integer exit code",
          evidence: { kind: "command", command: "mycli run", exitCode: 1.5, stdout: "out", stderr: "" },
          message: 'needs an integer "exitCode"',
        },
        {
          name: "non-string output",
          evidence: { kind: "command", command: "mycli run", exitCode: 1, stdout: 123, stderr: "" },
          message: 'needs "stdout" and "stderr" strings',
        },
      ];
      for (const c of cases) {
        const payload = {
          v: 1,
          kind: "review",
          verdict: "fail",
          checkpoint: HEAD,
          results: [
            { criterion: "works", expected: "ok", actual: "broken", evidence: c.evidence, ok: false },
            { criterion: "shines", expected: "shines", actual: "shines", evidence: "https://example.test/shines", ok: true },
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

  test("published receipt reads back with expected, actual, and transcript", async () => {
    const h = await harness();
    try {
      await toReview(h, "STA-1");
      const payload = {
        v: 1,
        kind: "review",
        verdict: "pass",
        checkpoint: HEAD,
        results: [
          { criterion: "works", expected: "cli prints ok", actual: "cli printed ok", evidence: transcript("mycli run --check", 0, "all green"), ok: true },
          { criterion: "shines", expected: "bright", actual: "bright", evidence: transcript("mycli shine", 0, "", "shone with warnings"), ok: true },
        ],
        environment: "test lab",
        reproduction: "run mycli run --check",
      };
      expect((await ticketCommand(h, "STA-1", "submit", JSON.stringify(payload))).ok).toBe(true);
      const read = await h.client.fetchIssue(issueOf(h, "STA-1").id);
      const receipt = read!.comments.at(-1)!.body;
      for (const needle of [
        "cli prints ok",
        "cli printed ok",
        "mycli run --check",
        "all green",
        "bright",
        "shone with warnings",
      ]) {
        expect(receipt).toContain(needle);
      }
    } finally {
      h.stop();
    }
  });

  test("same submission retry creates no second comment", async () => {
    const h = await harness();
    try {
      await toReview(h, "STA-1");
      const payload = {
        v: 1,
        kind: "review",
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
      // Retry the identical submission from Review+In progress: it converges.
      issueOf(h, "STA-1").stateId = REVIEW;
      issueOf(h, "STA-1").labelIds = [IN_PROGRESS];
      expect((await ticketCommand(h, "STA-1", "submit", body)).ok).toBe(true);
      expect(issueOf(h, "STA-1").comments.length).toBe(count);
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
    } finally {
      h.stop();
    }
  });
});
