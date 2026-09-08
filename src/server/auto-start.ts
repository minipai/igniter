interface BackgroundProcess {
  exited: Promise<number>;
  unref(): void;
}

interface SpawnOptions {
  cwd: string;
  detached: true;
  stdin: "ignore";
  stdout: "ignore";
  stderr: "ignore";
}

export interface AutoStartDeps {
  spawn(command: string[], options: SpawnOptions): BackgroundProcess;
  fetch(url: string, init: RequestInit): Promise<Response>;
  sleep(ms: number): Promise<unknown>;
  now(): number;
}

export interface AutoStartInput {
  base: string;
  repoRoot: string;
  bunPath: string;
  cliPath: string;
  timeoutMs?: number;
  pollMs?: number;
}

const defaults: AutoStartDeps = {
  spawn: (command, options) => Bun.spawn(command, options),
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => Bun.sleep(ms),
  now: () => Date.now(),
};

/** Start `igniter serve` detached from the caller and wait until its health endpoint answers. */
export async function autoStartServe(
  input: AutoStartInput,
  deps: AutoStartDeps = defaults,
): Promise<void> {
  let child: BackgroundProcess;
  try {
    child = deps.spawn(
      [input.bunPath, input.cliPath, "serve"],
      {
        cwd: input.repoRoot,
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    );
  } catch (error) {
    throw new Error(`could not start dispatch server at ${input.base}: ${(error as Error).message}`);
  }
  child.unref();

  const timeoutMs = input.timeoutMs ?? 60_000;
  const pollMs = input.pollMs ?? 100;
  const deadline = deps.now() + timeoutMs;
  let exitCode: number | undefined;
  void child.exited.then((code) => { exitCode = code; });
  while (deps.now() < deadline) {
    if (exitCode !== undefined) {
      throw new Error(`automatic \`igniter serve\` exited with code ${exitCode}`);
    }
    try {
      const response = await deps.fetch(`${input.base}/api/health`, {
        signal: AbortSignal.timeout(Math.min(1_000, Math.max(1, deadline - deps.now()))),
      });
      if (response.ok) return;
    } catch {
      // The detached server is still starting.
    }
    await deps.sleep(pollMs);
  }
  throw new Error(
    `dispatch server at ${input.base} did not become ready after automatic \`igniter serve\` startup`,
  );
}
