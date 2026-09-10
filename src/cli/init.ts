import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { findProjectRoot } from "../workflow/config/config.ts";

export interface ProjectInitInput {
  interactive: boolean;
  read(question: string): Promise<string>;
}

export interface ProjectInitResult {
  root: string;
  created: boolean;
}

export async function ensureProjectConfig(
  startDir: string,
  input: ProjectInitInput,
): Promise<ProjectInitResult> {
  try {
    return { root: await findProjectRoot(startDir), created: false };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(".igniter/config.yaml not found")) throw error;
  }

  const root = await findGitRoot(startDir);
  const project = basename(root);
  if (!input.interactive) {
    throw new Error(
      `No .igniter/config.yaml found in ${root}. ` +
        "Run `igniter start` in an interactive terminal to initialize this project.",
    );
  }

  const answer = await input.read(
    `No .igniter/config.yaml found in ${root}. Initialize Igniter for "${project}"? [y/N] `,
  );
  if (!/^(?:y|yes)$/i.test(answer.trim())) {
    throw new Error("Igniter initialization cancelled; no files changed.");
  }

  const configDir = join(root, ".igniter");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.yaml"), `project: ${JSON.stringify(project)}\n`, { flag: "wx" });
  return { root, created: true };
}

async function findGitRoot(startDir: string): Promise<string> {
  const start = resolve(startDir);
  const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
    cwd: start,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`Igniter initialization requires a Git repository: ${(stderr || stdout).trim()}`);
  }
  return stdout.trim();
}
