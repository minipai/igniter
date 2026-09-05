import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../../scripts/opencode-session-usage.sh");

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runScript(args: string[], dbPath?: string): Promise<RunResult> {
  const proc = Bun.spawn([SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, OPENCODE_DB: dbPath ?? join(tmpdir(), "igniter-no-such-db.db") },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Fixture with the real OpenCode `session`/`message`/`part` shapes. */
function fixtureDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "igniter-usage-"));
  const path = join(dir, "opencode.db");
  const db = new Database(path);
  db.exec(
    `CREATE TABLE session (id text PRIMARY KEY, directory text NOT NULL,
      tokens_input integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL,
      time_updated integer NOT NULL, time_compacting integer, parent_id text);
     CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
     CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);`,
  );
  const session = db.prepare(
    "INSERT INTO session (id, directory, tokens_input, tokens_cache_read, time_updated, parent_id) VALUES (?, ?, ?, ?, ?, ?)",
  );
  // In-repo session, a subagent session below it (parent_id set), a stale
  // in-repo session, and a sibling-prefix session that must not match.
  session.run("s1", "/repo/wt/a", 100, 9999, 2000, null);
  session.run("s2", "/repo/wt/a/sub", 50, 0, 3000, "s1");
  session.run("s3", "/repo/wt/ab", 70, 0, 3000, null);
  session.run("s4", "/repo/wt/a", 30, 0, 500, null);
  const message = db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
  );
  message.run("m1", "s1", 2000, 2000, "{}");
  message.run("m2", "s2", 3000, 3000, "{}");
  const part = db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
  );
  part.run("p1", "m1", "s1", 2000, 2000, '{"type":"compaction","auto":true}');
  part.run("p2", "m2", "s2", 3000, 3000, '{"type":"tool","tool":"read"}');
  db.close();
  return path;
}

describe("opencode-session-usage.sh", () => {
  test("two-argument form prints input tokens then the compaction count", async () => {
    const dbPath = fixtureDb();
    const result = await runScript(["/repo/wt/a", "1000"], dbPath);
    expect(result.exitCode).toBe(0);
    // 100 (s1) + 50 (s2 subagent); cache-read tokens, the stale s4, and
    // the sibling-prefix s3 are excluded. One compaction part (p1).
    expect(result.stdout).toBe("150\n1\n");
  });

  test("the since bound filters both tokens and compactions", async () => {
    const dbPath = fixtureDb();
    const result = await runScript(["/repo/wt/a", "2500"], dbPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("50\n0\n");
  });

  test("a trailing slash on the repo path changes nothing", async () => {
    const dbPath = fixtureDb();
    const result = await runScript(["/repo/wt/a/", "1000"], dbPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("150\n1\n");
  });

  test("underscores in the repo path do not act as LIKE wildcards", async () => {
    const dbPath = fixtureDb();
    const db = new Database(dbPath);
    db.exec(
      `INSERT INTO session (id, directory, tokens_input, tokens_cache_read, time_updated, parent_id) VALUES
        ('s5', '/repo/my_project', 111, 0, 4000, NULL),
        ('s6', '/repo/myXproject/sub', 222, 0, 4000, NULL);`,
    );
    db.close();
    const exact = await runScript(["/repo/my_project", "0"], dbPath);
    expect(exact.exitCode).toBe(0);
    expect(exact.stdout).toBe("111\n0\n");
    const sibling = await runScript(["/repo/myXproject", "0"], dbPath);
    expect(sibling.exitCode).toBe(0);
    expect(sibling.stdout).toBe("222\n0\n");
  });

  test("no-argument form prints the single integer igniter stage accepts", async () => {
    const dbPath = fixtureDb();
    const result = await runScript([], dbPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+$/);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
  });

  test("a missing database exits non-zero with a stderr message", async () => {
    const result = await runScript(["/repo", "0"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("database not found");
    expect(result.stdout).toBe("");
  });

  test("a non-numeric since exits non-zero", async () => {
    const dbPath = fixtureDb();
    const result = await runScript(["/repo/wt/a", "yesterday"], dbPath);
    expect(result.exitCode).not.toBe(0);
  });

  test("the database is only read, never written", async () => {
    const dbPath = fixtureDb();
    const dir = dbPath.slice(0, dbPath.lastIndexOf("/"));
    const before = readdirSync(dir).sort();
    const result = await runScript(["/repo/wt/a", "1000"], dbPath);
    expect(result.exitCode).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(before);
    const db = new Database(dbPath, { readonly: true });
    expect(db.query("SELECT COUNT(*) AS n FROM session").get()).toEqual({ n: 4 });
    db.close();
  });
});
