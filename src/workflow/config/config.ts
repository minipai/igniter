import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";
import commanderDefaultsYaml from "../../commander/config.yaml";

// Dispatch settings from `.igniter/config.yaml`. Commander defaults come from
// `src/commander/config.yaml`; repositories may override agent profiles and
// supply optional per-stage runbooks.
// File-level loading and validation only; Linear-backed checks (canonical
// status names, project existence) live in claims.ts so they can fail
// startup with context.
//
// The lifecycle and Progress vocabulary are Igniter protocol constants, not
// project options: the six statuses are Backlog, Todo, Build, Acceptance,
// Deliver, Done (workflow types backlog, unstarted, three started,
// completed), and the Progress group is "Progress" with Pending, In
// progress, Complete, Blocked. The stage -> primary agent mapping is fixed
// too: Build -> builder, Acceptance -> acceptance, Deliver -> deliverer.
// Projects choose agent profiles and optional runbooks, never the lifecycle
// names or the bundled stage protocol.

export interface CommanderAgentConfig {
  harness: string;
  model: string;
  /** Cross-harness reasoning/thinking effort. Omitted keeps the harness
   *  default; once set the launch layer translates it into the harness's
   *  native option or refuses to launch. Never silently ignored. */
  effort?: string;
}

export type CommanderStage = "build" | "acceptance" | "deliver";
export type CommanderAgent = "builder" | "acceptance" | "deliverer";

/** Stage mapping is fixed: Build runs on builder, Acceptance on acceptance,
 *  Deliver on deliverer. Never configurable. */
export const STAGE_AGENTS: Record<CommanderStage, CommanderAgent> = {
  build: "builder",
  acceptance: "acceptance",
  deliver: "deliverer",
};

export interface CommanderBuilderConfig extends CommanderAgentConfig {
  fallback: CommanderAgentConfig;
}

export interface CommanderConfig {
  agents: {
    commander: CommanderAgentConfig;
    builder: CommanderBuilderConfig;
    acceptance: CommanderAgentConfig;
    deliverer: CommanderAgentConfig;
  };
}

export interface DispatchStates {
  backlog: string;
  todo: string;
  build: string;
  acceptance: string;
  deliver: string;
  done: string;
  canceled: string;
}

export interface DispatchProgress {
  group: string;
  pending: string;
  in_progress: string;
  complete: string;
  blocked: string;
}

/** Optional per-stage project runbook paths, resolved absolute under the
 *  repo root. An entry may be set for one stage alone; absent entries fall
 *  back to the bundled protocol prompt and repository instructions. */
export interface DispatchRunbooks {
  build?: string;
  acceptance?: string;
  deliver?: string;
}

export interface DispatchConfig {
  project: string;
  team?: string;
  maxRunning: number;
  linearOrg: string;
  /** Canonical lifecycle status names, fixed by Igniter. */
  states: DispatchStates;
  /** Canonical Progress group and label names, fixed by Igniter. */
  progress: DispatchProgress;
  /**
   * Branch a delivery lands on. Done-ticket cleanup only removes the
   * ticket worktree and its local feature branch once the delivered
   * checkpoint reads back from here. Defaults to "main".
   */
  targetBranch: string;
  herdrRemote?: string;
  commander: CommanderConfig;
  /** Delivery document path relative to the repo root, naming the file the
   *  Commander reads as its project settings. Absent means the Commander
   *  searches the repository for the document itself. */
  delivery?: string;
  /** Optional per-stage project runbooks; absolute resolved paths. */
  runbooks: DispatchRunbooks;
}

export const DEFAULT_MAX_RUNNING = 3;
export const DEFAULT_LINEAR_ORG = "starcoder";
/** Branch deliveries land on when `target_branch` is absent. */
export const DEFAULT_TARGET_BRANCH = "main";

/** The one canonical lifecycle, validated against Linear at startup. */
export const CANONICAL_STATES: DispatchStates = {
  backlog: "Backlog",
  todo: "Todo",
  build: "Build",
  acceptance: "Acceptance",
  deliver: "Deliver",
  done: "Done",
  canceled: "Canceled",
};
/** The one canonical Progress protocol, validated against Linear at startup. */
export const CANONICAL_PROGRESS: DispatchProgress = {
  group: "Progress",
  pending: "Pending",
  in_progress: "In progress",
  complete: "Complete",
  blocked: "Blocked",
};
export const DEFAULT_STATES: DispatchStates = { ...CANONICAL_STATES };
export const DEFAULT_PROGRESS: DispatchProgress = { ...CANONICAL_PROGRESS };

const COMMANDER_STAGES = ["build", "acceptance", "deliver"] as const;

function fail(message: string): never {
  throw new Error(`config error: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    fail(`"${key}" must be a non-empty string`);
  }
  return (value as string).trim();
}

function requiredText(raw: Record<string, unknown>, key: string): string {
  const value = optionalText(raw, key);
  if (value === undefined) fail(`"${key}" is required in .igniter/config.yaml`);
  return value as string;
}

function parseMaxRunning(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_MAX_RUNNING;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    fail(`"max_running" must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  return raw;
}

function rejectMigrated(raw: Record<string, unknown>): void {
  if (raw["states"] !== undefined) {
    fail(
      `"states" is no longer configurable: the lifecycle statuses are Igniter protocol constants ` +
        `(Backlog, Todo, Build, Acceptance, Deliver, Done). Remove "states" from .igniter/config.yaml ` +
        `and rename the Linear "Review" status to "Acceptance" on the team's workflow.`,
    );
  }
  if (raw["progress"] !== undefined) {
    fail(
      `"progress" is no longer configurable: the Progress group and labels are Igniter protocol constants ` +
        `(group "Progress" with Pending, In progress, Complete, Blocked). Remove "progress" from .igniter/config.yaml.`,
    );
  }
  if (raw["stages"] !== undefined) {
    fail(
      `"stages" is no longer configurable: Igniter always supplies the bundled Build, Acceptance, and Deliver ` +
        `stage prompts. Remove "stages" from .igniter/config.yaml; add optional project runbooks under ` +
        `"runbooks" (runbooks.build, runbooks.acceptance, runbooks.deliver) instead.`,
    );
  }
}

function parseRunbooks(raw: unknown): DispatchRunbooks {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) fail(`"runbooks" must be a map of stage to a repo-relative runbook path`);
  const runbooks: DispatchRunbooks = {};
  for (const [stage, value] of Object.entries(raw)) {
    if (!(COMMANDER_STAGES as readonly string[]).includes(stage)) {
      fail(`unknown runbook stage "${stage}" (known: build, acceptance, deliver)`);
    }
    if (typeof value !== "string" || value.trim() === "") {
      fail(`runbooks."${stage}" must be a non-empty repo-relative runbook path`);
    }
    runbooks[stage as keyof DispatchRunbooks] = value.trim();
  }
  return runbooks;
}

function parseBundledCommanderConfig(raw: unknown): CommanderConfig {
  if (!isRecord(raw) || !isRecord(raw["agents"])) {
    fail(`bundled Commander config must contain an "agents" map`);
  }
  const rawAgents = raw["agents"] as Record<string, unknown>;
  const rawCommander = rawAgents["commander"];
  const rawBuilder = rawAgents["builder"];
  const rawAcceptance = rawAgents["acceptance"];
  const rawDeliverer = rawAgents["deliverer"];
  if (
    !isRecord(rawCommander) ||
    !isRecord(rawBuilder) ||
    !isRecord(rawBuilder["fallback"]) ||
    !isRecord(rawAcceptance) ||
    !isRecord(rawDeliverer)
  ) {
    fail(`bundled Commander agents require commander, builder, builder.fallback, acceptance, and deliverer maps`);
  }
  const agent = (value: Record<string, unknown>, path: string): CommanderAgentConfig => {
    const harness = optionalText(value, "harness");
    const model = optionalText(value, "model");
    if (!harness || !model) fail(`bundled Commander agent "${path}" requires harness and model`);
    const effort = optionalText(value, "effort");
    return effort === undefined ? { harness, model } : { harness, model, effort };
  };
  return {
    agents: {
      commander: agent(rawCommander, "commander"),
      builder: {
        ...agent(rawBuilder, "builder"),
        fallback: agent(rawBuilder["fallback"] as Record<string, unknown>, "builder.fallback"),
      },
      acceptance: agent(rawAcceptance, "acceptance"),
      deliverer: agent(rawDeliverer, "deliverer"),
    },
  };
}

export const DEFAULT_COMMANDER_CONFIG = parseBundledCommanderConfig(commanderDefaultsYaml);

const AGENT_NAMES = ["commander", "builder", "acceptance", "deliverer"] as const;
type AgentName = (typeof AGENT_NAMES)[number];

function parseCommander(agentsRaw: unknown): CommanderConfig {
  const agents: CommanderConfig["agents"] = {
    commander: { ...DEFAULT_COMMANDER_CONFIG.agents.commander },
    builder: {
      ...DEFAULT_COMMANDER_CONFIG.agents.builder,
      fallback: { ...DEFAULT_COMMANDER_CONFIG.agents.builder.fallback },
    },
    acceptance: { ...DEFAULT_COMMANDER_CONFIG.agents.acceptance },
    deliverer: { ...DEFAULT_COMMANDER_CONFIG.agents.deliverer },
  };
  if (agentsRaw === undefined || agentsRaw === null) return { agents };
  if (!isRecord(agentsRaw)) fail(`"agents" must be a map`);
  for (const [name, value] of Object.entries(agentsRaw)) {
    if (!(AGENT_NAMES as readonly string[]).includes(name)) {
      fail(`unknown agent "${name}" (known: commander, builder, acceptance, deliverer)`);
    }
    const profile = name as AgentName;
    if (!isRecord(value)) fail(`agents."${name}" must be a map`);
    for (const key of Object.keys(value)) {
      if (key !== "harness" && key !== "model" && key !== "effort" && !(name === "builder" && key === "fallback")) {
        fail(`unknown agents."${name}" setting "${key}"`);
      }
    }
    const harness = optionalText(value, "harness");
    const model = optionalText(value, "model");
    const effort = optionalText(value, "effort");
    if (harness !== undefined) agents[profile].harness = harness;
    if (model !== undefined) agents[profile].model = model;
    if (effort !== undefined) agents[profile].effort = effort;
    if (name === "builder" && value["fallback"] !== undefined) {
      const fallback = value["fallback"];
      if (!isRecord(fallback)) fail(`agents."builder"."fallback" must be a map`);
      for (const key of Object.keys(fallback)) {
        if (key !== "harness" && key !== "model" && key !== "effort") {
          fail(`unknown agents."builder"."fallback" setting "${key}"`);
        }
      }
      const fallbackHarness = optionalText(fallback, "harness");
      const fallbackModel = optionalText(fallback, "model");
      const fallbackEffort = optionalText(fallback, "effort");
      if (fallbackHarness !== undefined) agents.builder.fallback.harness = fallbackHarness;
      if (fallbackModel !== undefined) agents.builder.fallback.model = fallbackModel;
      if (fallbackEffort !== undefined) agents.builder.fallback.effort = fallbackEffort;
    }
  }
  return { agents };
}

/** Validate raw parsed YAML into a DispatchConfig. Unknown keys are ignored. */
export function parseDispatchConfig(raw: unknown): DispatchConfig {
  if (!isRecord(raw)) fail(`expected a YAML map at the top level`);
  if (raw["models"] !== undefined) {
    fail(`"models" was replaced by "agents"; move each model under its agent profile`);
  }
  rejectMigrated(raw);
  const project = requiredText(raw, "project");
  const maxRunning = parseMaxRunning(raw["max_running"]);
  return {
    project,
    team: optionalText(raw, "team"),
    maxRunning,
    linearOrg: optionalText(raw, "linear_org") ?? DEFAULT_LINEAR_ORG,
    states: { ...CANONICAL_STATES },
    progress: { ...CANONICAL_PROGRESS },
    targetBranch: optionalText(raw, "target_branch") ?? DEFAULT_TARGET_BRANCH,
    herdrRemote: optionalText(raw, "herdr_remote"),
    commander: parseCommander(raw["agents"]),
    delivery: optionalText(raw, "delivery"),
    runbooks: parseRunbooks(raw["runbooks"]),
  };
}

/** Resolve one configured runbook to its absolute physical path, rejecting
 *  anything repo-relative that escapes the repository, does not exist, or
 *  is empty. Zero side effects beyond reads; fails before any worker or
 *  workspace is created. */
async function resolveRunbook(repoRoot: string, stage: string, configured: string): Promise<string> {
  if (isAbsolute(configured)) {
    fail(`runbooks."${stage}" must be relative to the repo root`);
  }
  const candidate = resolve(repoRoot, configured);
  const fromRoot = relative(resolve(repoRoot), candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    fail(`runbooks."${stage}" names "${configured}" outside ${repoRoot}`);
  }
  let physical: string;
  try {
    physical = await realpath(candidate);
  } catch {
    fail(`runbooks."${stage}" names "${configured}" which is missing or empty under ${repoRoot}`);
  }
  const physicalRoot = await realpath(repoRoot);
  const fromPhysicalRoot = relative(physicalRoot, physical);
  if (fromPhysicalRoot === ".." || fromPhysicalRoot.startsWith(`..${sep}`)) {
    fail(`runbooks."${stage}" names "${configured}" outside ${repoRoot} through a symbolic link`);
  }
  const info = await stat(physical);
  if (!info.isFile() || (await Bun.file(physical).text()).trim() === "") {
    fail(`runbooks."${stage}" names "${configured}" which is missing or empty under ${repoRoot}`);
  }
  return physical;
}

/** Read and validate `.igniter/config.yaml` under repoRoot (usually cwd). */
export async function loadDispatchConfig(repoRoot: string): Promise<DispatchConfig> {
  const path = `${repoRoot.replace(/\/+$/, "")}/.igniter/config.yaml`;
  const file = Bun.file(path);
  if (!(await file.exists())) {
    fail(`.igniter/config.yaml not found under ${repoRoot} (dispatch needs "project" at minimum)`);
  }
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(await file.text());
  } catch (error) {
    fail(`.igniter/config.yaml is not valid YAML: ${(error as Error).message}`);
  }
  const config = parseDispatchConfig(raw);
  if (isRecord(raw) && isRecord(raw["runbooks"])) {
    for (const stage of COMMANDER_STAGES) {
      const configured = config.runbooks[stage];
      if (configured !== undefined) {
        config.runbooks[stage] = await resolveRunbook(repoRoot, stage, configured);
      }
    }
  }
  if (config.delivery !== undefined) {
    const candidate = `${repoRoot.replace(/\/+$/, "")}/${config.delivery}`;
    if (!(await Bun.file(candidate).exists())) {
      fail(`"delivery" names "${config.delivery}" which does not exist under ${repoRoot}`);
    }
  }
  return config;
}

/**
 * Walk from startDir upward to the nearest directory holding
 * `.igniter/config.yaml`. Returns that project root. Throws a clear error
 * naming the search start when no ancestor (up to the filesystem root)
 * holds a config. `igniter start` uses this so a subdirectory launch selects
 * the enclosing project.
 */
export async function findProjectRoot(startDir: string): Promise<string> {
  const start = resolve(startDir);
  let dir = start;
  while (true) {
    if (await Bun.file(join(dir, ".igniter", "config.yaml")).exists()) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      fail(
        `.igniter/config.yaml not found from ${start} up to the filesystem root ` +
          `(run \`igniter start\` from inside a configured project)`,
      );
    }
    dir = parent;
  }
}
