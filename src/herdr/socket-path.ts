import { spawnSync } from "node:child_process";

// Where the Herdr server listens: HERDR_SOCKET_PATH when set, otherwise the
// `server.socket` value reported by `herdr status`.

export interface SocketPathDeps {
  env?: Record<string, string | undefined>;
  runStatus?: () => Promise<string>;
}

function defaultRunStatus(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnSync("herdr", ["status"], { encoding: "utf8" });
    if (child.error) {
      reject(child.error);
      return;
    }
    if (child.status !== 0) {
      reject(new Error(`herdr status exited with ${child.status}: ${child.stderr}`));
      return;
    }
    resolve(child.stdout);
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
