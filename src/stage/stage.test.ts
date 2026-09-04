import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultStageDeps,
  runStage as runCommand,
  type StageDeps,
  type StageSocket,
} from "./stage";

interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
}

class FakeSocket implements StageSocket {
  calls: RecordedCall[] = [];
  closed = false;
  failOn: string | null = null;

  constructor(public tokens: Record<string, string> = {}) {}

  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    if (this.failOn === method) throw new Error(`${method} exploded`);
    if (method === "session.snapshot") {
      return {
        type: "session_snapshot",
        snapshot: {
          workspaces: [{ workspace_id: "w1", tokens: { ...this.tokens } }],
        },
      };
    }
    if (method === "workspace.report_metadata") {
      // Merge semantics like the server: values overwrite, null clears.
      const reported = params["tokens"] as Record<string, string | null>;
      for (const [key, value] of Object.entries(reported)) {
        if (value === null) delete this.tokens[key];
        else this.tokens[key] = value;
      }
      return { type: "ok" };
    }
    throw new Error(`unexpected method ${method}`);
  }

  close(): void {
    this.closed = true;
  }
}

interface Harness {
  socket: FakeSocket;
  opened: string[];
  logs: string[];
  deps: StageDeps;
}

function harness(
  env: Record<string, string | undefined>,
  tokens: Record<string, string> = {},
  usage: string | undefined = undefined,
): Harness {
  const socket = new FakeSocket({ ...tokens });
  const opened: string[] = [];
  const logs: string[] = [];
  const deps: StageDeps = {
    env: { ...env },
    cwd: "/repo",
    lookupSocketPath: async () => "/tmp/fake.sock",
    openSocket: (path) => {
      opened.push(path);
      return socket;
    },
    readUsage: async () => usage,
    reportTimeoutMs: 3000,
    log: (message) => {
      logs.push(message);
    },
  };
  return { socket, opened, logs, deps };
}

const INSIDE = { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" };

function runStage(argv: string[], deps: StageDeps): Promise<number> {
  return runCommand(["stage", ...argv], deps);
}

function reportedParams(socket: FakeSocket): Record<string, unknown> {
  const call = socket.calls.find((entry) => entry.method === "workspace.report_metadata");
  if (!call) throw new Error("expected a workspace.report_metadata call");
  return call.params;
}

describe("outside Herdr", () => {
  test("no HERDR_ENV is a silent no-op with exit 0", async () => {
    const h = harness({ HERDR_WORKSPACE_ID: "w1" });
    await expect(runStage(["build"], h.deps)).resolves.toBe(0);
    expect(h.opened).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  test("no workspace id is a silent no-op with exit 0", async () => {
    const h = harness({ HERDR_ENV: "1" });
    await expect(runStage(["build"], h.deps)).resolves.toBe(0);
    expect(h.opened).toEqual([]);
    expect(h.logs).toEqual([]);
  });
});

describe("ticket", () => {
  test("plan establishes the ticket from the runner env", async () => {
    const h = harness({ ...INSIDE, IGNITER_TICKET: "STA-7" });
    await expect(runStage(["plan"], h.deps)).resolves.toBe(0);
    const params = reportedParams(h.socket);
    expect(params["source"]).toBe("igniter");
    expect(params["workspace_id"]).toBe("w1");
    expect(params["tokens"]).toMatchObject({ ticket: "STA-7", stage: "plan" });
    expect(params).not.toHaveProperty("seq");
    expect(h.socket.closed).toBe(true);
  });

  test("later calls reuse the metadata ticket and cannot change it", async () => {
    const h = harness({ ...INSIDE, IGNITER_TICKET: "STA-OTHER" }, { ticket: "STA-7" });
    await expect(runStage(["build"], h.deps)).resolves.toBe(0);
    expect(reportedParams(h.socket)["tokens"]).toMatchObject({ ticket: "STA-7" });
  });

  test("missing ticket everywhere exits 1 without reporting", async () => {
    const h = harness({ ...INSIDE });
    await expect(runStage(["plan"], h.deps)).resolves.toBe(1);
    expect(h.socket.calls.map((entry) => entry.method)).toEqual(["session.snapshot"]);
    expect(h.logs).toHaveLength(1);
    expect(h.socket.closed).toBe(true);
  });
});

describe("stages and counters", () => {
  test("build derives review rounds: first call is 0, repeats give 1 then 2", async () => {
    const h = harness({ ...INSIDE, IGNITER_TICKET: "STA-7" });
    await expect(runStage(["build"], h.deps)).resolves.toBe(0);
    await expect(runStage(["build"], h.deps)).resolves.toBe(0);
    await expect(runStage(["build"], h.deps)).resolves.toBe(0);
    const reports = h.socket.calls.filter((entry) => entry.method === "workspace.report_metadata");
    expect(reports).toHaveLength(3);
    expect(reports[0]?.params["tokens"]).toMatchObject({ stage: "build", review_count: "0" });
    expect(reports[1]?.params["tokens"]).toMatchObject({ stage: "build", review_count: "1" });
    expect(reports[2]?.params["tokens"]).toMatchObject({ stage: "build", review_count: "2" });
  });

  test("verify counts verification rounds, including repeated calls", async () => {
    const h = harness({ ...INSIDE, IGNITER_TICKET: "STA-7" });
    await expect(runStage(["verify"], h.deps)).resolves.toBe(0);
    await expect(runStage(["verify"], h.deps)).resolves.toBe(0);
    await expect(runStage(["verify"], h.deps)).resolves.toBe(0);
    const reports = h.socket.calls.filter((entry) => entry.method === "workspace.report_metadata");
    expect(reports[0]?.params["tokens"]).toMatchObject({ stage: "verify", verify_count: "1" });
    expect(reports[2]?.params["tokens"]).toMatchObject({ stage: "verify", verify_count: "3" });
  });

  test("no subcommand reports delivered", async () => {
    for (const args of [
      ["plan"],
      ["build"],
      ["verify"],
      ["acceptance"],
      ["failed", "--reason", "x"],
    ]) {
      const h = harness({ ...INSIDE, IGNITER_TICKET: "STA-7" }, { ticket: "STA-7" });
      await expect(runStage(args, h.deps)).resolves.toBe(0);
      const tokens = reportedParams(h.socket)["tokens"] as Record<string, string>;
      expect(tokens["stage"] === undefined || tokens["stage"] !== "delivered").toBe(true);
    }
  });

  test("accept closes with acceptance and owner pending", async () => {
    const h = harness({ ...INSIDE }, { ticket: "STA-7" });
    await expect(runStage(["acceptance"], h.deps)).resolves.toBe(0);
    expect(reportedParams(h.socket)["tokens"]).toMatchObject({
      stage: "acceptance",
      owner_pending: "1",
    });
  });

  test("every stage write carries a fresh stage_at timestamp", async () => {
    const h = harness({ ...INSIDE, IGNITER_TICKET: "STA-7" });
    const before = new Date().toISOString();
    await expect(runStage(["build"], h.deps)).resolves.toBe(0);
    const tokens = reportedParams(h.socket)["tokens"] as Record<string, string>;
    const stageAt = tokens["stage_at"] as string;
    expect(stageAt).toBeDefined();
    expect(stageAt >= before).toBe(true);
    expect(stageAt <= new Date().toISOString()).toBe(true);
  });

  test("existing tokens owned by others are neither sent nor disturbed", async () => {
    const h = harness({ ...INSIDE }, { ticket: "STA-7", builder: "b-1", commander: "c-1" });
    await expect(runStage(["build"], h.deps)).resolves.toBe(0);
    // The write carries igniter's keys only; the runner's keys survive
    // server-side through merge semantics instead of being re-stamped.
    expect(reportedParams(h.socket)["tokens"]).toEqual({
      ticket: "STA-7",
      stage: "build",
      stage_at: expect.any(String),
      review_count: "0",
      owner_pending: null,
      reason: null,
    });
    expect(h.socket.tokens).toMatchObject({ builder: "b-1", commander: "c-1" });
  });

  test("entering build clears a stale park", async () => {
    const h = harness(
      { ...INSIDE },
      { ticket: "STA-7", stage: "build", owner_pending: "1", reason: "risk path auth/" },
    );
    await expect(runStage(["build"], h.deps)).resolves.toBe(0);
    expect(reportedParams(h.socket)["tokens"]).toEqual({
      ticket: "STA-7",
      stage: "build",
      stage_at: expect.any(String),
      review_count: "0",
      owner_pending: null,
      reason: null,
    });
    expect(h.socket.tokens).not.toHaveProperty("owner_pending");
    expect(h.socket.tokens).not.toHaveProperty("reason");
  });

  test("accept starts a fresh pending without a stale reason", async () => {
    const h = harness({ ...INSIDE }, { ticket: "STA-7", stage: "failed", reason: "budget spent" });
    await expect(runStage(["acceptance"], h.deps)).resolves.toBe(0);
    expect(reportedParams(h.socket)["tokens"]).toEqual({
      ticket: "STA-7",
      stage: "acceptance",
      stage_at: expect.any(String),
      owner_pending: "1",
      reason: null,
    });
  });
});

describe("pause and resume", () => {
  test("stage pause names the decision without touching the stage", async () => {
    const h = harness({ ...INSIDE }, { ticket: "STA-7", stage: "build" });
    await expect(runCommand(["stage", "pause", "--reason", "risk path auth/"], h.deps)).resolves.toBe(0);
    // No stage key is sent; merge semantics leave the current stage alone.
    expect(reportedParams(h.socket)["tokens"]).toEqual({
      ticket: "STA-7",
      owner_pending: "1",
      reason: "risk path auth/",
    });
    expect(h.socket.tokens["stage"]).toBe("build");
  });

  test("stage pause accepts the --reason=value form", async () => {
    const h = harness({ ...INSIDE }, { ticket: "STA-7" });
    await expect(runCommand(["stage", "pause", "--reason=risk path auth/"], h.deps)).resolves.toBe(0);
    expect(reportedParams(h.socket)["tokens"]).toMatchObject({ reason: "risk path auth/" });
  });

  test("stage resume clears the pause tokens and leaves the stage", async () => {
    const h = harness(
      { ...INSIDE },
      { ticket: "STA-7", stage: "build", owner_pending: "1", reason: "risk path auth/" },
    );
    await expect(runCommand(["stage", "resume"], h.deps)).resolves.toBe(0);
    const params = reportedParams(h.socket);
    expect(params["tokens"]).toMatchObject({ owner_pending: null, reason: null });
    expect(h.socket.tokens).toMatchObject({ ticket: "STA-7", stage: "build" });
    expect(h.socket.tokens).not.toHaveProperty("owner_pending");
    expect(h.socket.tokens).not.toHaveProperty("reason");
  });

  test("top-level pause and resume now belong to dispatch, not to stage", async () => {
    for (const argv of [["pause", "--reason", "x"], ["resume"]]) {
      const h = harness({ ...INSIDE }, { ticket: "STA-7" });
      await expect(runCommand(argv, h.deps)).resolves.toBe(1);
      expect(h.opened).toEqual([]);
      expect(h.logs).toEqual([expect.stringContaining("usage: igniter <stage>")]);
    }
  });
});

describe("stop", () => {
  test("fail reports failed with a non-empty reason", async () => {
    const h = harness({ ...INSIDE }, { ticket: "STA-7", stage: "build" });
    await expect(runStage(["failed", "--reason", "blocked past budget"], h.deps)).resolves.toBe(0);
    expect(reportedParams(h.socket)["tokens"]).toMatchObject({
      stage: "failed",
      reason: "blocked past budget",
    });
  });

  test("fail clears owner_pending from an earlier acceptance", async () => {
    const h = harness(
      { ...INSIDE },
      { ticket: "STA-7", stage: "acceptance", owner_pending: "1" },
    );
    await expect(runStage(["failed", "--reason", "budget exhausted"], h.deps)).resolves.toBe(0);
    expect(reportedParams(h.socket)["tokens"]).toEqual({
      ticket: "STA-7",
      stage: "failed",
      stage_at: expect.any(String),
      owner_pending: null,
      reason: "budget exhausted",
    });
    expect(h.socket.tokens).not.toHaveProperty("owner_pending");
  });

  test("fail without a reason exits 1 without touching the socket", async () => {
    const h = harness({ ...INSIDE }, { ticket: "STA-7" });
    await expect(runStage(["failed"], h.deps)).resolves.toBe(1);
    expect(h.opened).toEqual([]);
  });

  test("stage pause without a reason exits 1 without touching the socket", async () => {
    const h = harness({ ...INSIDE }, { ticket: "STA-7" });
    await expect(runCommand(["stage", "pause", "--reason", ""], h.deps)).resolves.toBe(1);
    expect(h.opened).toEqual([]);
  });

  test("a blank reason would clear the key server-side, so it is rejected", async () => {
    const h = harness({ ...INSIDE }, { ticket: "STA-7" });
    await expect(runStage(["failed", "--reason", "   "], h.deps)).resolves.toBe(1);
    expect(h.opened).toEqual([]);
  });

  test("removed and runner-owned stage values exit 1", async () => {
    for (const step of ["reviewed", "verified", "accept", "fail", "delivered"]) {
      const h = harness({ ...INSIDE }, { ticket: "STA-7" });
      await expect(runStage([step], h.deps)).resolves.toBe(1);
      expect(h.opened).toEqual([]);
    }
  });
});

describe("usage tokens", () => {
  test("a usage figure is attached when the script reports one", async () => {
    const h = harness({ ...INSIDE }, { ticket: "STA-7" }, "1234");
    await expect(runStage(["build"], h.deps)).resolves.toBe(0);
    expect(reportedParams(h.socket)["tokens"]).toMatchObject({ tokens: "1234" });
  });

  test("a missing script means no usage token, not an error", async () => {
    const h = harness({ ...INSIDE }, { ticket: "STA-7" }, undefined);
    await expect(runStage(["build"], h.deps)).resolves.toBe(0);
    const tokens = reportedParams(h.socket)["tokens"] as Record<string, string>;
    expect(tokens).not.toHaveProperty("tokens");
  });
});

describe("failures", () => {
  test("an unknown workspace exits 1 and still closes the socket", async () => {
    const h = harness({ ...INSIDE, HERDR_WORKSPACE_ID: "w9" }, { ticket: "STA-7" });
    await expect(runStage(["build"], h.deps)).resolves.toBe(1);
    expect(h.logs).toHaveLength(1);
    expect(h.socket.closed).toBe(true);
  });

  test("a socket error exits 1 and still closes the socket", async () => {
    const h = harness({ ...INSIDE }, { ticket: "STA-7" });
    h.socket.failOn = "session.snapshot";
    await expect(runStage(["build"], h.deps)).resolves.toBe(1);
    expect(h.logs).toHaveLength(1);
    expect(h.socket.closed).toBe(true);
  });
});

describe("deadline", () => {
  test("a silent server trips the deadline and the socket is closed", async () => {
    const calls: string[] = [];
    let closed = false;
    const h = harness({ ...INSIDE }, { ticket: "STA-7" });
    h.deps.reportTimeoutMs = 50;
    h.deps.openSocket = () => {
      const hanging: StageSocket = {
        call: (method) => {
          calls.push(method);
          return new Promise<unknown>(() => {});
        },
        close: () => {
          closed = true;
        },
      };
      return hanging;
    };
    await expect(runStage(["build"], h.deps)).resolves.toBe(1);
    expect(calls).toEqual(["session.snapshot"]);
    expect(closed).toBe(true);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain("did not answer");
  });

  test("a hanging lookup trips the same deadline", async () => {
    const h = harness({ ...INSIDE }, { ticket: "STA-7" });
    h.deps.lookupSocketPath = () => new Promise<string>(() => {});
    h.deps.reportTimeoutMs = 50;
    const start = Date.now();
    await expect(runStage(["build"], h.deps)).resolves.toBe(1);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(h.opened).toEqual([]);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain("did not answer");
  });

  test("a dead socket path fails fast with the real client instead of hanging", async () => {
    const h = harness({ ...INSIDE }, { ticket: "STA-7" });
    h.deps.lookupSocketPath = async () =>
      join(tmpdir(), `igniter-stage-dead-${Date.now()}.sock`);
    h.deps.openSocket = defaultStageDeps().openSocket;
    h.deps.reportTimeoutMs = 300;
    const start = Date.now();
    await expect(runStage(["build"], h.deps)).resolves.toBe(1);
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(h.logs).toHaveLength(1);
  }, 15_000);
});
