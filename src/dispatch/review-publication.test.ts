// Review publication: one owner grant per ticket lifecycle, host-side publish.
//
// Deterministic integration coverage over consent, refusals, success,
// lifecycle/checkpoint drift, and retry idempotency with a fake publisher,
// an in-memory Linear client, and fake Herdr. No network, no real
// credentials, no real project, no Diffwalk endpoint.

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspaceSink,
  runCommand,
  type CommandContext,
} from "./commands";
import { validateStartup, type ResolvedDispatch } from "./claims";
import { parseDispatchConfig } from "./config";
import {
  MemoryLinearClient,
  memoryAddIssue,
  standardMemoryWorld,
  type MemoryWorld,
} from "./fake-memory-linear";
import { FakeGit } from "./fake-git";
import { FakeWorkspaces } from "./fake-workspaces";
import { FakeReviewPublisher } from "./fake-review-publisher";
import {
  createBuildPublicationGate,
  DiffwalkReviewPublisher,
  grantPublicationConsent,
  MemoryPublicationConsents,
  REVIEW_PUBLICATION_DESTINATION,
  readCurrentCaptureId,
  reviewLinkOfPublishOutput,
  reviewUrlOfReceipt,
  PUBLISH_DESTINATION_TOKEN,
  PUBLISH_LIFECYCLE_TOKEN,
} from "./review-publication";
import { buildStageWorkOrder } from "./stage-start";
import { AGENT_SECRET_NAMES } from "./workspaces";
import {
  buildReceiptBody,
  parseAcceptanceCriteria,
  parseReceiptBlock,
  parseReviewArtifact,
} from "./protocol";

const CRITERIA = "## 驗收條件\n- [ ] works\n";
const HEAD = "deadbeefcafe0001";
const CAPTURE = "20260908t000000z-abcdef12";
/** Fast deterministic prompt budget: no clock, two sends, two read-backs each. */
const FAST = { maxAttempts: 2, pollAttempts: 2, pollIntervalMs: 0, sleep: async () => {} };

interface Harness {
  ctx: CommandContext;
  lines: string[];
  client: MemoryLinearClient;
  world: MemoryWorld;
  workspaces: FakeWorkspaces;
  git: FakeGit;
  repoRoot: string;
  consents: MemoryPublicationConsents;
  publisher: FakeReviewPublisher;
}

async function harness(): Promise<Harness> {
  const world = standardMemoryWorld();
  const client = new MemoryLinearClient(world);
  const resolved: ResolvedDispatch = await validateStartup(
    client,
    parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: 3 }),
  );
  const lines: string[] = [];
  const workspaces = new FakeWorkspaces();
  const git = new FakeGit();
  git.head = HEAD;
  const repoRoot = join(mkdtempSync(join(tmpdir(), "igniter-pub-")), "repo");
  const consents = new MemoryPublicationConsents();
  const publisher = new FakeReviewPublisher();
  const sink = createWorkspaceSink({ workspaces, config: resolved.config, repoRoot, runGit: git });
  const ctx: CommandContext = {
    client,
    resolved,
    host: "h",
    decisions: {
      record: async (ticket, message) => {
        lines.push(`${ticket} ${message}`);
      },
    },
    workspaces,
    sink,
    repoRoot,
    git,
    lastPollAt: () => null,
    promptDelivery: FAST,
    publication: { consents, publisher },
  };
  return { ctx, lines, client, world, workspaces, git, repoRoot, consents, publisher };
}

function addTicket(h: Harness, identifier: string): void {
  memoryAddIssue(h.world, {
    identifier,
    stateId: "st-todo",
    description: CRITERIA,
    labelIds: ["label-pending"],
  });
}

function issueOf(h: Harness, identifier: string) {
  const issue = h.world.issues.find((i) => i.identifier === identifier);
  if (!issue) throw new Error(`no such issue ${identifier}`);
  return issue;
}

function buildPayload(head = HEAD, diffwalk?: { capture: string; check: string; destination: string }) {
  return {
    v: 1,
    kind: "build",
    checkpoint: head,
    checks: ["bun run check"],
    results: [{ criterion: "works", ok: true }],
    reproduction: "run bun run check",
    ...(diffwalk ? { diffwalk } : {}),
  };
}

function artifact() {
  return { capture: CAPTURE, check: "pass", destination: REVIEW_PUBLICATION_DESTINATION };
}

/** Owner grant plus worker launch: the commander's normal path to submit. */
async function consentedBegin(h: Harness, identifier: string) {
  const started = await runCommand(["start", identifier, "--publish-review"], h.ctx, { directStart: true });
  expect(started.ok).toBe(true);
  expect((await runCommand(["worker", "start", identifier], h.ctx)).ok).toBe(true);
  const begun = await runCommand(["begin", identifier], h.ctx);
  expect(begun.ok).toBe(true);
  return begun;
}

async function submitBuild(h: Harness, identifier: string, payload: unknown) {
  return runCommand(["submit", identifier, "--input", "-"], h.ctx, { input: JSON.stringify(payload) });
}

describe("consent", () => {
  test("start --publish-review records a grant scoped to ticket, repository, destination, and lifecycle", async () => {
    const h = await harness();
    addTicket(h, "STA-1");
    const out = await runCommand(["start", "STA-1", "--publish-review"], h.ctx, { directStart: true });
    expect(out.ok).toBe(true);
    expect(out.text).toContain("review publication consented for STA-1 → review.diffwalk.dev");
    const consent = h.consents.consentFor("STA-1", h.repoRoot);
    expect(consent).toMatchObject({
      ticket: "STA-1",
      repository: h.repoRoot,
      destination: REVIEW_PUBLICATION_DESTINATION,
    });
    expect(consent?.lifecycle).toMatch(/^[0-9a-f]{16}$/);
    // Any other ticket or repository sees no grant.
    expect(h.consents.consentFor("STA-2", h.repoRoot)).toBeNull();
    expect(h.consents.consentFor("STA-1", join(h.repoRoot, "..", "other"))).toBeNull();
    expect(h.lines.some((line) => line.includes("recorded review publication consent for STA-1"))).toBe(true);
  });

  test("the flag needs a ticket and never leaks into other start forms", async () => {
    const h = await harness();
    addTicket(h, "STA-1");
    const bare = await runCommand(["start", "--publish-review"], h.ctx, { directStart: true });
    expect(bare.ok).toBe(false);
    expect(bare.text).toContain("`--publish-review` needs a ticket");
    const bogus = await runCommand(["start", "STA-1", "--bogus"], h.ctx, { directStart: true });
    expect(bogus.ok).toBe(false);
    expect(bogus.text).toContain("usage: igniter start");
    const plain = await runCommand(["start", "STA-1"], h.ctx, { directStart: true });
    expect(plain.ok).toBe(true);
    expect(plain.text).not.toContain("review publication consented");
    expect(h.consents.consentFor("STA-1", h.repoRoot)).toBeNull();
  });

  test("repository config can never grant publication consent", () => {
    for (const key of ["publish_review", "publish-review", "publishReview", "publication", "publications"]) {
      expect(() => parseDispatchConfig({ project: "igniter", team: "Starcoder", [key]: true })).toThrow(
        "never from repository config",
      );
    }
  });

  test("worker start stamps the granted lifecycle into the ticket workspace", async () => {
    const h = await harness();
    addTicket(h, "STA-1");
    await consentedBegin(h, "STA-1");
    const consent = h.consents.consentFor("STA-1", h.repoRoot);
    expect(h.workspaces.tokensFor("STA-1")).toMatchObject({
      [PUBLISH_LIFECYCLE_TOKEN]: consent?.lifecycle,
      [PUBLISH_DESTINATION_TOKEN]: REVIEW_PUBLICATION_DESTINATION,
    });
  });

  test("a late grant stamps the live workspace, so submit still verifies", async () => {
    const h = await harness();
    addTicket(h, "STA-1");
    expect((await runCommand(["worker", "start", "STA-1"], h.ctx)).ok).toBe(true);
    expect((await runCommand(["begin", "STA-1"], h.ctx)).ok).toBe(true);
    const started = await runCommand(["start", "STA-1", "--publish-review"], h.ctx, { directStart: true });
    expect(started.ok).toBe(true);
    const out = await submitBuild(h, "STA-1", buildPayload(HEAD, artifact()));
    expect(out.ok).toBe(true);
    expect(out.text).toContain("review https://review.diffwalk.dev/");
  });

  test("two grants in the same millisecond still rotate the lifecycle", async () => {
    const h = await harness();
    const fixed = () => 1_786_000_000_000;
    const first = grantPublicationConsent(h.consents, { ticket: "STA-1", repository: h.repoRoot, now: fixed });
    const second = grantPublicationConsent(h.consents, { ticket: "STA-1", repository: h.repoRoot, now: fixed });
    expect(second.lifecycle).not.toBe(first.lifecycle);
    expect(h.consents.consentFor("sta-1", `${h.repoRoot}/`)).toMatchObject({ lifecycle: second.lifecycle });
  });
});

describe("worker boundary", () => {
  test("stage work orders forbid publish, Linear, submit, localhost, and credentials", () => {
    const order = buildStageWorkOrder({
      identifier: "STA-1",
      title: "t",
      description: null,
      criteria: ["works"],
      worktreePath: "/wt",
      branch: "feature/sta-1",
      checkpoint: HEAD,
      resultPath: "/scratch/builder/result.md",
      stage: "build",
      promptPath: "/assets/stages/build.md",
      harness: "opencode",
      model: "org/model",
    });
    expect(order).toContain("Do not run `diffwalk publish`");
    expect(order).toContain("never from this worker");
    expect(order).toContain("localhost");
    expect(order).not.toContain("--publish-review");
    expect(order).not.toContain("LINEAR_API_KEY");
  });

  test("stage workers never inherit provider credentials", () => {
    expect([...AGENT_SECRET_NAMES]).toEqual(["LINEAR_API_KEY", "RESEND_API_KEY", "FAL_API_KEY"]);
  });

  test("artifact parsing is pure and offline: no client, no network, no credentials", () => {
    expect(parseReviewArtifact(artifact())).toEqual({
      capture: CAPTURE,
      check: "pass",
      destination: REVIEW_PUBLICATION_DESTINATION,
    });
    expect(parseAcceptanceCriteria(CRITERIA)).toEqual(["works"]);
  });
});

describe("submit gate", () => {
  test("without consent the submit refuses, publishes nothing, and records no receipt", async () => {
    const h = await harness();
    addTicket(h, "STA-1");
    expect((await runCommand(["worker", "start", "STA-1"], h.ctx)).ok).toBe(true);
    expect((await runCommand(["begin", "STA-1"], h.ctx)).ok).toBe(true);
    const out = await submitBuild(h, "STA-1", buildPayload(HEAD, artifact()));
    expect(out.ok).toBe(false);
    expect(out.text).toContain("no review publication consent");
    expect(out.text).toContain("`igniter start STA-1 --publish-review`");
    expect(out.text).toContain("no receipt was recorded");
    expect(h.publisher.publications).toHaveLength(0);
    expect(h.publisher.publishCalls).toHaveLength(0);
    expect(issueOf(h, "STA-1").comments.filter(comment => parseReceiptBlock(comment.body))).toHaveLength(0);
    expect(issueOf(h, "STA-1").stateId).toBe("st-build");
  });

  test("a plain build submit without an artifact still lands with no publication", async () => {
    const h = await harness();
    addTicket(h, "STA-1");
    expect((await runCommand(["worker", "start", "STA-1"], h.ctx)).ok).toBe(true);
    expect((await runCommand(["begin", "STA-1"], h.ctx)).ok).toBe(true);
    const out = await submitBuild(h, "STA-1", buildPayload());
    expect(out.ok).toBe(true);
    expect(out.text).toContain("→ Build+Complete");
    expect(out.text).not.toContain("review https://");
    expect(h.publisher.publications).toHaveLength(0);
    expect(issueOf(h, "STA-1").stateId).toBe("st-build");
    expect(issueOf(h, "STA-1").labelIds).toEqual(["label-complete"]);
  });

  test("consented submit publishes from the host and writes the review URL into the receipt", async () => {
    const h = await harness();
    addTicket(h, "STA-1");
    await consentedBegin(h, "STA-1");
    const out = await submitBuild(h, "STA-1", buildPayload(HEAD, artifact()));
    expect(out.ok).toBe(true);
    expect(out.text).toContain("→ Build+Complete");
    expect(out.text).toContain("review https://review.diffwalk.dev/");
    expect(h.publisher.publications).toHaveLength(1);
    expect(h.publisher.publishCalls).toHaveLength(1);
    expect(h.publisher.publications[0]).toMatchObject({
      ticket: "STA-1",
      checkpoint: HEAD,
      capture: CAPTURE,
    });
    const comments = issueOf(h, "STA-1").comments.filter(comment => parseReceiptBlock(comment.body));
    expect(comments).toHaveLength(1);
    const body = comments[0]?.body ?? "";
    expect(body).toContain(`Review: ${h.publisher.publications[0]?.url}`);
    expect(parseReceiptBlock(body)).toMatchObject({ kind: "build", checkpoint: HEAD });
    expect(reviewUrlOfReceipt(body)).toBe(h.publisher.publications[0]?.url ?? null);
    expect(issueOf(h, "STA-1").stateId).toBe("st-build");
    expect(issueOf(h, "STA-1").labelIds).toEqual(["label-complete"]);
  });

  test("destination drift refuses with no publish and no receipt", async () => {
    const h = await harness();
    addTicket(h, "STA-1");
    await consentedBegin(h, "STA-1");
    const out = await submitBuild(
      h,
      "STA-1",
      buildPayload(HEAD, { capture: CAPTURE, check: "pass", destination: "https://evil.test" }),
    );
    expect(out.ok).toBe(false);
    expect(out.text).toContain("fixed destination is review.diffwalk.dev");
    expect(h.publisher.publications).toHaveLength(0);
    expect(issueOf(h, "STA-1").comments.filter(comment => parseReceiptBlock(comment.body))).toHaveLength(0);
  });

  test("checkpoint drift refuses with no publish and no receipt", async () => {
    const h = await harness();
    addTicket(h, "STA-1");
    await consentedBegin(h, "STA-1");
    const out = await submitBuild(h, "STA-1", buildPayload("aaaabbbbccccdddd", artifact()));
    expect(out.ok).toBe(false);
    expect(out.text).toContain("worktree HEAD");
    expect(h.publisher.publications).toHaveLength(0);
    expect(issueOf(h, "STA-1").comments.filter(comment => parseReceiptBlock(comment.body))).toHaveLength(0);
  });

  test("a failed diffwalk check refuses with no publish and no receipt", async () => {
    const h = await harness();
    addTicket(h, "STA-1");
    await consentedBegin(h, "STA-1");
    const out = await submitBuild(
      h,
      "STA-1",
      buildPayload(HEAD, { capture: CAPTURE, check: "fail", destination: REVIEW_PUBLICATION_DESTINATION }),
    );
    expect(out.ok).toBe(false);
    expect(out.text).toContain("diffwalk check did not pass");
    expect(h.publisher.publications).toHaveLength(0);
    expect(issueOf(h, "STA-1").comments.filter(comment => parseReceiptBlock(comment.body))).toHaveLength(0);
  });

  test("lifecycle drift refuses with the exact recovery command", async () => {
    const h = await harness();
    addTicket(h, "STA-1");
    await consentedBegin(h, "STA-1");
    const ws = h.workspaces.workspaces.find((w) => w.label === "STA-1");
    await h.workspaces.reportMetadata(ws?.workspaceId ?? "", { [PUBLISH_LIFECYCLE_TOKEN]: "tampered" });
    const out = await submitBuild(h, "STA-1", buildPayload(HEAD, artifact()));
    expect(out.ok).toBe(false);
    expect(out.text).toContain("publication lifecycle changed");
    expect(out.text).toContain("`igniter start STA-1 --publish-review`");
    expect(h.publisher.publications).toHaveLength(0);
    expect(issueOf(h, "STA-1").comments.filter(comment => parseReceiptBlock(comment.body))).toHaveLength(0);
  });

  test("a tampered destination stamp refuses the same way", async () => {
    const h = await harness();
    addTicket(h, "STA-1");
    await consentedBegin(h, "STA-1");
    const ws = h.workspaces.workspaces.find((w) => w.label === "STA-1");
    await h.workspaces.reportMetadata(ws?.workspaceId ?? "", { [PUBLISH_DESTINATION_TOKEN]: "https://evil.test" });
    const out = await submitBuild(h, "STA-1", buildPayload(HEAD, artifact()));
    expect(out.ok).toBe(false);
    expect(out.text).toContain("publication lifecycle changed");
    expect(h.publisher.publications).toHaveLength(0);
    expect(issueOf(h, "STA-1").comments.filter(comment => parseReceiptBlock(comment.body))).toHaveLength(0);
  });

  test("the gate refuses a drifted destination even when called directly", async () => {
    const consents = new MemoryPublicationConsents();
    const publisher = new FakeReviewPublisher();
    const consent = grantPublicationConsent(consents, { ticket: "STA-1", repository: "/repo" });
    const gate = createBuildPublicationGate({ consents, publisher, repoRoot: "/repo" });
    await expect(
      gate.publish({
        ticket: "STA-1",
        checkpoint: HEAD,
        capture: CAPTURE,
        destination: "https://drifted.test",
        head: HEAD,
        workspaceTokens: {
          [PUBLISH_LIFECYCLE_TOKEN]: consent.lifecycle,
          [PUBLISH_DESTINATION_TOKEN]: REVIEW_PUBLICATION_DESTINATION,
        },
        comments: [],
        submission: "abc123abc123abc1",
      }),
    ).rejects.toThrow("destination drift");
    expect(publisher.publications).toHaveLength(0);
  });

  test("the gate refuses a miswired publisher before any consent check", async () => {
    const consents = new MemoryPublicationConsents();
    const offDestination = new FakeReviewPublisher();
    Object.defineProperty(offDestination, "destination", { value: "https://elsewhere.test" });
    const gate = createBuildPublicationGate({ consents, publisher: offDestination, repoRoot: "/repo" });
    await expect(
      gate.publish({
        ticket: "STA-1",
        checkpoint: HEAD,
        capture: CAPTURE,
        destination: REVIEW_PUBLICATION_DESTINATION,
        head: HEAD,
        workspaceTokens: {},
        comments: [],
        submission: "abc123abc123abc1",
      }),
    ).rejects.toThrow("miswired on the host");
  });

  test("a receipt line pointing off-destination is never trusted", async () => {
    const consents = new MemoryPublicationConsents();
    const publisher = new FakeReviewPublisher();
    grantPublicationConsent(consents, { ticket: "STA-1", repository: "/repo" });
    const consent = consents.consentFor("STA-1", "/repo");
    const gate = createBuildPublicationGate({ consents, publisher, repoRoot: "/repo" });
    const { receiptBlock } = await import("./protocol");
    const tampered = `note\n\nReview: https://evil.test/r/x\n\n${receiptBlock("build", HEAD, "abc123abc123abc1")}\n`;
    const out = await gate.publish({
      ticket: "STA-1",
      checkpoint: HEAD,
      capture: CAPTURE,
      destination: REVIEW_PUBLICATION_DESTINATION,
      head: HEAD,
      workspaceTokens: {
        [PUBLISH_LIFECYCLE_TOKEN]: consent?.lifecycle ?? "",
        [PUBLISH_DESTINATION_TOKEN]: REVIEW_PUBLICATION_DESTINATION,
      },
      comments: [{ id: "c1", body: tampered }],
      submission: "abc123abc123abc1",
    });
    expect(out.url).toContain("https://review.diffwalk.dev/");
    expect(out.reused).toBe(false);
    expect(publisher.publications).toHaveLength(1);
  });
});

describe("retry idempotency", () => {
  test("a failed publish retries into exactly one review and one receipt", async () => {
    const h = await harness();
    addTicket(h, "STA-1");
    await consentedBegin(h, "STA-1");
    h.publisher.failNext = 1;
    const payload = buildPayload(HEAD, artifact());
    const first = await submitBuild(h, "STA-1", payload);
    expect(first.ok).toBe(false);
    expect(first.text).toContain("retry the identical submit");
    expect(h.publisher.publications).toHaveLength(0);
    expect(issueOf(h, "STA-1").comments.filter(comment => parseReceiptBlock(comment.body))).toHaveLength(0);
    const retry = await submitBuild(h, "STA-1", payload);
    expect(retry.ok).toBe(true);
    expect(h.publisher.publications).toHaveLength(1);
    expect(h.publisher.publishCalls).toHaveLength(2);
    expect(issueOf(h, "STA-1").comments.filter(comment => parseReceiptBlock(comment.body))).toHaveLength(1);
  });

  test("a lost publish response is read back and reused on retry", async () => {
    const h = await harness();
    addTicket(h, "STA-1");
    await consentedBegin(h, "STA-1");
    h.publisher.loseNextResponses = 1;
    const out = await submitBuild(h, "STA-1", buildPayload(HEAD, artifact()));
    expect(out.ok).toBe(true);
    expect(h.publisher.publications).toHaveLength(1);
    expect(h.publisher.publishCalls).toHaveLength(1);
    expect(issueOf(h, "STA-1").comments.filter(comment => parseReceiptBlock(comment.body))).toHaveLength(1);
  });

  test("a lost receipt response retries into the same receipt, never a second review", async () => {
    const h = await harness();
    addTicket(h, "STA-1");
    await consentedBegin(h, "STA-1");
    h.client.failNext("addComment", { status: 502, message: "bad gateway", afterWrite: true });
    const payload = buildPayload(HEAD, artifact());
    // The receipt write absorbs one lost response internally and still lands once.
    const out = await submitBuild(h, "STA-1", payload);
    expect(out.ok).toBe(true);
    expect(h.publisher.publications).toHaveLength(1);
    expect(issueOf(h, "STA-1").comments.filter(comment => parseReceiptBlock(comment.body))).toHaveLength(1);
    // A duplicate submit after success acknowledges without new writes.
    const again = await submitBuild(h, "STA-1", payload);
    expect(again.ok).toBe(true);
    expect(again.text).toContain("already submitted build");
    expect(h.publisher.publications).toHaveLength(1);
    expect(issueOf(h, "STA-1").comments.filter(comment => parseReceiptBlock(comment.body))).toHaveLength(1);
  });

  test("one grant covers the lifecycle: no re-consent across begin and submit", async () => {
    const h = await harness();
    addTicket(h, "STA-1");
    await consentedBegin(h, "STA-1");
    const payload = buildPayload(HEAD, artifact());
    expect((await submitBuild(h, "STA-1", payload)).ok).toBe(true);
    expect((await submitBuild(h, "STA-1", payload)).ok).toBe(true);
    const grants = h.lines.filter((line) => line.includes("recorded review publication consent"));
    expect(grants).toHaveLength(1);
    expect(h.publisher.publications).toHaveLength(1);
    expect(issueOf(h, "STA-1").comments.filter(comment => parseReceiptBlock(comment.body))).toHaveLength(1);
  });
});

describe("fixed destination", () => {
  test("every layer names review.diffwalk.dev and nothing else", () => {
    expect(REVIEW_PUBLICATION_DESTINATION).toBe("review.diffwalk.dev");
    expect(new FakeReviewPublisher().destination).toBe(REVIEW_PUBLICATION_DESTINATION);
    expect(new DiffwalkReviewPublisher("/repo").destination).toBe(REVIEW_PUBLICATION_DESTINATION);
    const body = buildReceiptBody(
      {
        v: 1,
        kind: "build",
        checkpoint: HEAD,
        checks: ["bun run check"],
        results: [{ criterion: "works", ok: true }],
        reproduction: "run bun run check",
      },
      "abc123abc123abc1",
      "https://review.diffwalk.dev/r/sta-1-1",
    );
    expect(reviewUrlOfReceipt(body)).toBe("https://review.diffwalk.dev/r/sta-1-1");
    expect(reviewUrlOfReceipt(buildReceiptBody(buildPayload() as never, "abc123abc123abc1"))).toBeNull();
  });

  test("only links on the fixed destination count as published", () => {
    expect(reviewLinkOfPublishOutput("done\nhttps://review.diffwalk.dev/r/abc\nrevocation: t\n")).toBe(
      "https://review.diffwalk.dev/r/abc",
    );
    for (const bad of [
      "done\nhttps://evil.test/r/abc\n",
      "done\nhttp://localhost:9999/r/abc\n",
      "done, no link here\n",
      "",
    ]) {
      expect(() => reviewLinkOfPublishOutput(bad)).toThrow("unexpected link");
    }
  });

  test("the current walk capture reads back from machine-owned files only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "igniter-walk-"));
    expect(await readCurrentCaptureId(dir)).toBeNull();
    mkdirSync(join(dir, ".diffwalk", "walk1"), { recursive: true });
    writeFileSync(join(dir, ".diffwalk", "current"), "walk1\n");
    writeFileSync(join(dir, ".diffwalk", "walk1", "capture.json"), JSON.stringify({ captureId: CAPTURE }));
    expect(await readCurrentCaptureId(dir)).toBe(CAPTURE);
    writeFileSync(join(dir, ".diffwalk", "current"), "..\n");
    expect(await readCurrentCaptureId(dir)).toBeNull();
  });

  test("the host publisher verifies the capture, persists the ledger, and survives restarts", async () => {
    const root = mkdtempSync(join(tmpdir(), "igniter-hostpub-"));
    const worktree = join(root, ".igniter", "runtime", "worktrees", "sta-1");
    mkdirSync(join(worktree, ".diffwalk", "walk1"), { recursive: true });
    writeFileSync(join(worktree, ".diffwalk", "current"), "walk1\n");
    writeFileSync(join(worktree, ".diffwalk", "walk1", "capture.json"), JSON.stringify({ captureId: CAPTURE }));
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const shim = join(bin, "diffwalk");
    writeFileSync(shim, `#!/bin/sh\necho "https://review.diffwalk.dev/r/real-1"\necho "revocation: tok"\n`);
    chmodSync(shim, 0o755);
    const ledger = join(root, "ledger.json");
    const first = new DiffwalkReviewPublisher(root, ledger, shim);
    const input = { ticket: "STA-1", checkpoint: HEAD, capture: CAPTURE };
    const publication = await first.publish(input);
    expect(publication.url).toBe("https://review.diffwalk.dev/r/real-1");
    // A rotated walk cannot swap the artifact under a verified submit:
    // the stale capture no longer matches the current walk.
    writeFileSync(join(worktree, ".diffwalk", "walk1", "capture.json"), JSON.stringify({ captureId: "other" }));
    await expect(
      first.publish({ ticket: "STA-1", checkpoint: "head2head2head2head2", capture: CAPTURE }),
    ).rejects.toThrow("current walk carries capture other but the submit names");
    // A restarted process reuses the landed publication from the ledger file.
    const restarted = new DiffwalkReviewPublisher(root, ledger, shim);
    expect(await restarted.published(input)).toMatchObject({ url: "https://review.diffwalk.dev/r/real-1" });
    expect((await restarted.publish(input)).url).toBe("https://review.diffwalk.dev/r/real-1");
  });
});
