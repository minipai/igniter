// Where the Herdr server listens: HERDR_SOCKET_PATH when set, otherwise the
// `server.socket` value reported by `herdr status`.

/** A one-shot lookup must not stall its caller past this. */
const STATUS_TIMEOUT_MS = 10_000;

export interface SocketPathDeps {
  env?: Record<string, string | undefined>;
  runStatus?: () => Promise<string>;
}

function defaultRunStatus(): Promise<string> {
  return new Promise((resolve, reject) => {
    let proc: ReturnType<typeof Bun.spawn> | undefined;
    try {
      proc = Bun.spawn(["herdr", "status"], { stdout: "pipe", stderr: "pipe" });
    } catch (error) {
      reject(error);
      return;
    }
    // A child that traps the signal must not stall the caller: on expiry
    // the wait is abandoned and the call rejects. The kill is best-effort
    // and reaping is never awaited, so a wedged child cannot hang us.
    const timer = setTimeout(() => {
      try {
        proc?.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      reject(new Error(`herdr status did not answer within ${STATUS_TIMEOUT_MS}ms`));
    }, STATUS_TIMEOUT_MS);
    const read = async (stream: unknown): Promise<string> =>
      stream instanceof ReadableStream ? new Response(stream).text() : "";
    (async () => {
      try {
        const [stdout, stderr] = await Promise.all([read(proc?.stdout), read(proc?.stderr)]);
        await proc?.exited;
        return { code: proc?.exitCode, stdout, stderr };
      } finally {
        clearTimeout(timer);
      }
    })().then(
      ({ code, stdout, stderr }) => {
        if (code !== 0) {
          reject(new Error(`herdr status exited with ${code}: ${stderr}`));
          return;
        }
        resolve(stdout);
      },
      (error: unknown) => {
        reject(error);
      },
    );
  });
}

export function parseSocketPath(statusOutput: string): string | undefined {
  let inServer = false;
  for (const line of statusOutput.split("\n")) {
    if (/^server:\s*$/.test(line)) {
      inServer = true;
      continue;
    }
    // A new top-level key ends the server block; only server.socket counts.
    if (/^[A-Za-z]/.test(line)) {
      inServer = false;
      continue;
    }
    if (!inServer) continue;
    const match = line.match(/^\s*socket:\s*(\S+)\s*$/);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export async function lookupSocketPath(deps: SocketPathDeps = {}): Promise<string> {
  const env = deps.env ?? process.env;
  const fromEnv = env["HERDR_SOCKET_PATH"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const output = await (deps.runStatus ? deps.runStatus() : defaultRunStatus());
  const parsed = parseSocketPath(output);
  if (!parsed) {
    throw new Error("could not find server.socket in `herdr status` output");
  }
  return parsed;
}
