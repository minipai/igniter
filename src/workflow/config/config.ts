import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";
import commanderDefaultsYaml from "../../commander/config.yaml";

// Dispatch settings from `.igniter/config.yaml`. Commander defaults come from
// `src/commander/config.yaml`; repositories may override agent profiles and
// replace the complete stage prompt map.
// File-level loading and validation only; Linear-backed checks (status names,
// project existence) live in claims.ts so they can fail startup with context.

export interface CommanderAgentConfig {
  harness: string;
  model: string;
  /** Cross-harness reasoning/thinking effort. Omitted keeps the harness
   *  default; once set the launch layer translates it into the harness's
   *  native option or refuses to launch. Never silently ignored. */
  effort?: string;
}

export type CommanderStage = "build" | "review" | "deliver";
export type CommanderAgent = "builder" | "reviewer" | "deliverer";

/** Stage mapping is fixed: Build runs on builder, Acceptance on reviewer,
 *  Deliver on deliverer. */
export const STAGE_AGENTS: Record<CommanderStage, CommanderAgent> = {
  build: "builder",
  review: "reviewer",
  deliver: "deliverer",
};

export interface CommanderBuilderConfig extends CommanderAgentConfig {
  fallback: CommanderAgentConfig;
}

export interface CommanderStageConfig {
  prompt: string;
  agent: CommanderAgent;
}

export interface CommanderConfig {
  agents: {
    commander: CommanderAgentConfig;
    builder: CommanderBuilderConfig;
    reviewer: CommanderAgentConfig;
    deliverer: CommanderAgentConfig;
  };
  stages: Record<CommanderStage, CommanderStageConfig>;
}

export interface DispatchStates {
  backlog: string;
  todo: string;
  build: string;
  review: string;
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

export interface DispatchConfig {
  project: string;
  team?: string;
  maxRunning: number;
  linearOrg: string;
  states: DispatchStates;
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
}

export const DEFAULT_MAX_RUNNING = 3;
export const DEFAULT_LINEAR_ORG = "starcoder";
/** Branch deliveries land on when `target_branch` is absent. */
export const DEFAULT_TARGET_BRANCH = "main";
export const DEFAULT_STATES: DispatchStates = {
  backlog: "Backlog",
  todo: "Todo",
  build: "Build",
  review: "Review",
  deliver: "Deliver",
  done: "Done",
  canceled: "Canceled",
};
export const DEFAULT_PROGRESS: DispatchProgress = {
  group: "Progress",
  pending: "Pending",
  in_progress: "In progress",
  complete: "Complete",
  blocked: "Blocked",
};
const COMMANDER_STAGES = ["build", "review", "deliver"] as const;

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

function parseStates(raw: unknown): DispatchStates {
  if (raw === undefined || raw === null) return { ...DEFAULT_STATES };
  if (!isRecord(raw)) fail(`"states" must be a map of stage to Linear status name`);
  const states: DispatchStates = { ...DEFAULT_STATES };
  for (const [key, value] of Object.entries(raw)) {
    if (
      key !== "backlog" &&
      key !== "todo" &&
      key !== "build" &&
      key !== "review" &&
      key !== "deliver" &&
      key !== "done" &&
      key !== "canceled"
    ) {
      fail(`unknown states role "${key}" (known: backlog, todo, build, review, deliver, done, canceled)`);
    }
    if (typeof value !== "string" || value.trim() === "") {
      fail(`states."${key}" must be a non-empty status name`);
    }
    states[key] = value.trim();
  }
  const names = Object.values(states);
  if (new Set(names).size !== names.length) {
    fail(`"states" must name seven distinct Linear statuses (got ${JSON.stringify(names)})`);
  }
  return states;
}

function parseProgress(raw: unknown): DispatchProgress {
  if (raw === undefined || raw === null) return { ...DEFAULT_PROGRESS };
  if (!isRecord(raw)) fail(`"progress" must be a map of progress role to Linear label name`);
  const progress: DispatchProgress = { ...DEFAULT_PROGRESS };
  for (const [key, value] of Object.entries(raw)) {
    if (
      key !== "group" &&
      key !== "pending" &&
      key !== "in_progress" &&
      key !== "complete" &&
      key !== "blocked"
    ) {
      fail(`unknown progress role "${key}" (known: group, pending, in_progress, complete, blocked)`);
    }
    if (typeof value !== "string" || value.trim() === "") {
      fail(`progress."${key}" must be a non-empty label name`);
    }
    progress[key] = value.trim();
  }
  const labels = [progress.pending, progress.in_progress, progress.complete, progress.blocked];
  if (new Set(labels).size !== labels.length) {
    fail(`"progress" must name four distinct Linear labels (got ${JSON.stringify(labels)})`);
  }
  return progress;
}

function parseBundledCommanderConfig(raw: unknown): CommanderConfig {
  if (!isRecord(raw) || !isRecord(raw["agents"]) || !isRecord(raw["stages"])) {
    fail(`bundled Commander config must contain "agents" and "stages" maps`);
  }
  const rawAgents = raw["agents"] as Record<string, unknown>;
  const rawCommander = rawAgents["commander"];
  const rawBuilder = rawAgents["builder"];
  const rawReviewer = rawAgents["reviewer"];
  const rawDeliverer = rawAgents["deliverer"];
  if (
    !isRecord(rawCommander) ||
    !isRecord(rawBuilder) ||
    !isRecord(rawBuilder["fallback"]) ||
    !isRecord(rawReviewer) ||
    !isRecord(rawDeliverer)
  ) {
    fail(`bundled Commander agents require commander, builder, builder.fallback, reviewer, and deliverer maps`);
  }
  const agent = (value: Record<string, unknown>, path: string): CommanderAgentConfig => {
    const harness = optionalText(value, "harness");
    const model = optionalText(value, "model");
    if (!harness || !model) fail(`bundled Commander agent "${path}" requires harness and model`);
    const effort = optionalText(value, "effort");
    return effort === undefined ? { harness, model } : { harness, model, effort };
  };
  const agents = {
    commander: agent(rawCommander, "commander"),
    builder: {
      ...agent(rawBuilder, "builder"),
      fallback: agent(rawBuilder["fallback"] as Record<string, unknown>, "builder.fallback"),
    },
    reviewer: agent(rawReviewer, "reviewer"),
    deliverer: agent(rawDeliverer, "deliverer"),
  };
  const rawStages = raw["stages"] as Record<string, unknown>;
  const stages = {} as Record<CommanderStage, CommanderStageConfig>;
  for (const stage of COMMANDER_STAGES) {
    const value = rawStages[stage];
    if (!isRecord(value)) fail(`bundled Commander stage "${stage}" must be a map`);
    const prompt = optionalText(value, "prompt");
    const agentName = optionalText(value, "agent");
    if (!prompt || !agentName) {
      fail(`bundled Commander stage "${stage}" requires prompt and agent`);
    }
    if (agentName !== STAGE_AGENTS[stage]) {
      fail(`bundled Commander stage "${stage}" must run on "${STAGE_AGENTS[stage]}" (got "${agentName}")`);
    }
    stages[stage] = { prompt, agent: agentName };
  }
  return { agents, stages };
}

export const DEFAULT_COMMANDER_CONFIG = parseBundledCommanderConfig(commanderDefaultsYaml);

const AGENT_NAMES = ["commander", "builder", "reviewer", "deliverer"] as const;
type AgentName = (typeof AGENT_NAMES)[number];

function parseStages(raw: unknown): Record<CommanderStage, CommanderStageConfig> {
  if (raw === undefined || raw === null) {
    return Object.fromEntries(
      COMMANDER_STAGES.map((stage) => [stage, { ...DEFAULT_COMMANDER_CONFIG.stages[stage] }]),
    ) as Record<CommanderStage, CommanderStageConfig>;
  }
  if (!isRecord(raw)) fail(`"stages" must be a map`);
  for (const name of Object.keys(raw)) {
    if (!(COMMANDER_STAGES as readonly string[]).includes(name)) {
      fail(`unknown stage "${name}" (known: build, review, deliver)`);
    }
  }
  const stages = {} as Record<CommanderStage, CommanderStageConfig>;
  for (const stage of COMMANDER_STAGES) {
    const value = raw[stage];
    if (!isRecord(value)) {
      fail(`stages."${stage}" is required when "stages" overrides the bundled workflow`);
    }
    for (const key of Object.keys(value)) {
      if (key !== "prompt" && key !== "agent") {
        fail(`unknown stages."${stage}" setting "${key}"`);
      }
    }
    const prompt = requiredText(value, "prompt");
    const agent = requiredText(value, "agent");
    if (agent !== STAGE_AGENTS[stage]) {
      fail(`stages."${stage}" must run on "${STAGE_AGENTS[stage]}" (got "${agent}")`);
    }
    stages[stage] = { prompt, agent };
  }
  return stages;
}

function parseCommander(agentsRaw: unknown, stagesRaw: unknown): CommanderConfig {
  const agents: CommanderConfig["agents"] = {
    commander: { ...DEFAULT_COMMANDER_CONFIG.agents.commander },
    builder: {
      ...DEFAULT_COMMANDER_CONFIG.agents.builder,
      fallback: { ...DEFAULT_COMMANDER_CONFIG.agents.builder.fallback },
    },
    reviewer: { ...DEFAULT_COMMANDER_CONFIG.agents.reviewer },
    deliverer: { ...DEFAULT_COMMANDER_CONFIG.agents.deliverer },
  };
  const stages = parseStages(stagesRaw);
  if (agentsRaw === undefined || agentsRaw === null) return { agents, stages };
  if (!isRecord(agentsRaw)) fail(`"agents" must be a map`);
  for (const [name, value] of Object.entries(agentsRaw)) {
    if (!(AGENT_NAMES as readonly string[]).includes(name)) {
      fail(`unknown agent "${name}" (known: commander, builder, reviewer, deliverer)`);
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
  return { agents, stages };
}

/** Validate raw parsed YAML into a DispatchConfig. Unknown keys are ignored. */
export function parseDispatchConfig(raw: unknown): DispatchConfig {
  if (!isRecord(raw)) fail(`expected a YAML map at the top level`);
  if (raw["models"] !== undefined) {
    fail(`"models" was replaced by "agents"; move each model under its agent profile`);
  }
  const project = requiredText(raw, "project");
  const maxRunning = parseMaxRunning(raw["max_running"]);
  const states = parseStates(raw["states"]);
  const progress = parseProgress(raw["progress"]);
  return {
    project,
    team: optionalText(raw, "team"),
    maxRunning,
    linearOrg: optionalText(raw, "linear_org") ?? DEFAULT_LINEAR_ORG,
    states,
    progress,
    targetBranch: optionalText(raw, "target_branch") ?? DEFAULT_TARGET_BRANCH,
    herdrRemote: optionalText(raw, "herdr_remote"),
    commander: parseCommander(raw["agents"], raw["stages"]),
    delivery: optionalText(raw, "delivery"),
  };
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
  if (isRecord(raw) && raw["stages"] !== undefined) {
    const physicalRoot = await realpath(repoRoot);
    for (const stage of COMMANDER_STAGES) {
      const configured = config.commander.stages[stage].prompt;
      if (isAbsolute(configured)) {
        fail(`stages."${stage}"."prompt" must be relative to the repo root`);
      }
      const candidate = resolve(repoRoot, configured);
      const fromRoot = relative(resolve(repoRoot), candidate);
      if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
        fail(`stages."${stage}"."prompt" names "${configured}" outside ${repoRoot}`);
      }
      let physicalPrompt: string;
      try {
        physicalPrompt = await realpath(candidate);
      } catch {
        fail(`stages."${stage}"."prompt" names "${configured}" which is missing or empty under ${repoRoot}`);
      }
      const fromPhysicalRoot = relative(physicalRoot, physicalPrompt);
      if (fromPhysicalRoot === ".." || fromPhysicalRoot.startsWith(`..${sep}`)) {
        fail(`stages."${stage}"."prompt" names "${configured}" outside ${repoRoot} through a symbolic link`);
      }
      const info = await stat(physicalPrompt);
      if (!info.isFile() || (await Bun.file(physicalPrompt).text()).trim() === "") {
        fail(`stages."${stage}"."prompt" names "${configured}" which is missing or empty under ${repoRoot}`);
      }
      config.commander.stages[stage].prompt = physicalPrompt;
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
