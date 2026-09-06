import commanderDefaultsYaml from "../commander/config.yaml";

// Dispatch settings from `.igniter/config.yaml`. Commander defaults come from
// `src/commander/config.yaml`; repositories may override agent profiles.
// File-level loading and validation only; Linear-backed checks (status names,
// project existence) live in claims.ts so they can fail startup with context.

export interface CommanderAgentConfig {
  harness: string;
  model: string;
}

export type CommanderStage = "build" | "review" | "deliver";
export type CommanderAgent = "builder" | "reviewer";

export interface CommanderBuilderConfig extends CommanderAgentConfig {
  fallback: CommanderAgentConfig;
}

export interface CommanderStageConfig {
  prompt: string;
  agent: CommanderAgent;
}

export interface CommanderConfig {
  agents: {
    builder: CommanderBuilderConfig;
    reviewer: CommanderAgentConfig;
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
  listenHost: string;
  listenPort: number;
  states: DispatchStates;
  progress: DispatchProgress;
  herdrRemote?: string;
  commander: CommanderConfig;
  /** Delivery document path relative to the repo root, naming the file the
   *  Commander reads as its project settings. Absent means the Commander
   *  searches the repository for the document itself. */
  delivery?: string;
}

export const DEFAULT_MAX_RUNNING = 3;
export const DEFAULT_LINEAR_ORG = "starcoder";
export const DEFAULT_LISTEN_HOST = "127.0.0.1";
export const DEFAULT_LISTEN_PORT = 4180;
export const DEFAULT_STATES: DispatchStates = {
  backlog: "Backlog",
  todo: "Todo",
  build: "Build",
  review: "Review",
  deliver: "Deliver",
  done: "Done",
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

function parseListen(raw: unknown): { host: string; port: number } {
  if (raw === undefined || raw === null) {
    return { host: DEFAULT_LISTEN_HOST, port: DEFAULT_LISTEN_PORT };
  }
  if (typeof raw !== "string" || raw.trim() === "") {
    fail(`"listen" must look like "host:port" (default "${DEFAULT_LISTEN_HOST}:${DEFAULT_LISTEN_PORT}")`);
  }
  const text = raw.trim();
  const colon = text.lastIndexOf(":");
  if (colon <= 0 || colon === text.length - 1) {
    fail(`"listen" must look like "host:port" (got "${text}")`);
  }
  const host = text.slice(0, colon).trim();
  const port = Number(text.slice(colon + 1).trim());
  if (host === "" || !Number.isInteger(port) || port <= 0 || port > 65535) {
    fail(`"listen" must look like "host:port" (got "${text}")`);
  }
  if (host === "0.0.0.0") {
    fail(`"listen" must not bind 0.0.0.0; use 127.0.0.1 or a Tailscale IP`);
  }
  return { host, port };
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
      key !== "done"
    ) {
      fail(`unknown states role "${key}" (known: backlog, todo, build, review, deliver, done)`);
    }
    if (typeof value !== "string" || value.trim() === "") {
      fail(`states."${key}" must be a non-empty status name`);
    }
    states[key] = value.trim();
  }
  const names = Object.values(states);
  if (new Set(names).size !== names.length) {
    fail(`"states" must name six distinct Linear statuses (got ${JSON.stringify(names)})`);
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
  const rawBuilder = rawAgents["builder"];
  const rawReviewer = rawAgents["reviewer"];
  if (!isRecord(rawBuilder) || !isRecord(rawBuilder["fallback"]) || !isRecord(rawReviewer)) {
    fail(`bundled Commander agents require builder, builder.fallback, and reviewer maps`);
  }
  const agent = (value: Record<string, unknown>, path: string): CommanderAgentConfig => {
    const harness = optionalText(value, "harness");
    const model = optionalText(value, "model");
    if (!harness || !model) fail(`bundled Commander agent "${path}" requires harness and model`);
    return { harness, model };
  };
  const agents = {
    builder: {
      ...agent(rawBuilder, "builder"),
      fallback: agent(rawBuilder["fallback"] as Record<string, unknown>, "builder.fallback"),
    },
    reviewer: agent(rawReviewer, "reviewer"),
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
    if (agentName !== "builder" && agentName !== "reviewer") {
      fail(`bundled Commander stage "${stage}" has unknown agent "${agentName}"`);
    }
    stages[stage] = { prompt, agent: agentName };
  }
  return { agents, stages };
}

export const DEFAULT_COMMANDER_CONFIG = parseBundledCommanderConfig(commanderDefaultsYaml);

function parseAgents(raw: unknown): CommanderConfig {
  const agents = {
    builder: {
      ...DEFAULT_COMMANDER_CONFIG.agents.builder,
      fallback: { ...DEFAULT_COMMANDER_CONFIG.agents.builder.fallback },
    },
    reviewer: { ...DEFAULT_COMMANDER_CONFIG.agents.reviewer },
  };
  const stages = Object.fromEntries(
    COMMANDER_STAGES.map((stage) => [stage, { ...DEFAULT_COMMANDER_CONFIG.stages[stage] }]),
  ) as Record<CommanderStage, CommanderStageConfig>;
  if (raw === undefined || raw === null) return { agents, stages };
  if (!isRecord(raw)) fail(`"agents" must be a map`);
  for (const [name, value] of Object.entries(raw)) {
    if (name !== "builder" && name !== "reviewer") {
      fail(`unknown agent "${name}" (known: builder, reviewer)`);
    }
    if (!isRecord(value)) fail(`agents."${name}" must be a map`);
    for (const key of Object.keys(value)) {
      if (key !== "harness" && key !== "model" && !(name === "builder" && key === "fallback")) {
        fail(`unknown agents."${name}" setting "${key}"`);
      }
    }
    const harness = optionalText(value, "harness");
    const model = optionalText(value, "model");
    if (harness !== undefined) agents[name].harness = harness;
    if (model !== undefined) agents[name].model = model;
    if (name === "builder" && value["fallback"] !== undefined) {
      const fallback = value["fallback"];
      if (!isRecord(fallback)) fail(`agents."builder"."fallback" must be a map`);
      for (const key of Object.keys(fallback)) {
        if (key !== "harness" && key !== "model") {
          fail(`unknown agents."builder"."fallback" setting "${key}"`);
        }
      }
      const fallbackHarness = optionalText(fallback, "harness");
      const fallbackModel = optionalText(fallback, "model");
      if (fallbackHarness !== undefined) agents.builder.fallback.harness = fallbackHarness;
      if (fallbackModel !== undefined) agents.builder.fallback.model = fallbackModel;
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
  if (raw["stages"] !== undefined) {
    fail(`"stages" is bundled with Igniter and cannot be overridden; bundled prompt paths always win`);
  }
  const project = requiredText(raw, "project");
  const maxRunning = parseMaxRunning(raw["max_running"]);
  const { host, port } = parseListen(raw["listen"]);
  const states = parseStates(raw["states"]);
  const progress = parseProgress(raw["progress"]);
  return {
    project,
    team: optionalText(raw, "team"),
    maxRunning,
    linearOrg: optionalText(raw, "linear_org") ?? DEFAULT_LINEAR_ORG,
    listenHost: host,
    listenPort: port,
    states,
    progress,
    herdrRemote: optionalText(raw, "herdr_remote"),
    commander: parseAgents(raw["agents"]),
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
  if (config.delivery !== undefined) {
    const candidate = `${repoRoot.replace(/\/+$/, "")}/${config.delivery}`;
    if (!(await Bun.file(candidate).exists())) {
      fail(`"delivery" names "${config.delivery}" which does not exist under ${repoRoot}`);
    }
  }
  return config;
}
