// Dispatch settings from `.igniter/config.yaml`. Commander run settings
// live in the delivery document named by the `delivery` field; this file
// never carries them.
// File-level loading and validation only; Linear-backed checks (status names,
// project existence) live in claims.ts so they can fail startup with context.

export interface DispatchModels {
  builder: string;
  reviewer: string;
  escalate: string;
}

export interface DispatchStates {
  queued: string;
  building: string;
  review: string;
  failed: string;
  merge: string;
}

export interface DispatchConfig {
  project: string;
  team?: string;
  maxRunning: number;
  maxHours: number;
  blockedMinutes: number;
  linearOrg: string;
  listenHost: string;
  listenPort: number;
  states: DispatchStates;
  herdrRemote?: string;
  models: DispatchModels;
  /** Delivery document path relative to the repo root, naming the file the
   *  Commander reads as its project settings. Absent means the Commander
   *  searches the repository for the document itself. */
  delivery?: string;
}

export const DEFAULT_MAX_RUNNING = 3;
export const DEFAULT_MAX_HOURS = 4;
export const DEFAULT_BLOCKED_MINUTES = 20;
export const DEFAULT_LINEAR_ORG = "starcoder";
export const DEFAULT_LISTEN_HOST = "127.0.0.1";
export const DEFAULT_LISTEN_PORT = 4180;
export const DEFAULT_STATES: DispatchStates = {
  queued: "Ready to build",
  building: "Building",
  review: "Ready to review",
  failed: "Todo",
  merge: "Ready to merge",
};
export const DEFAULT_MODELS: DispatchModels = {
  builder: "opencode/muse-spark-1.3-contributor-free",
  reviewer: "claude-sonnet-5",
  escalate: "openai/gpt-5.6-terra",
};

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

function parseMaxHours(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_MAX_HOURS;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    fail(`"max_hours" must be a positive number (got ${JSON.stringify(raw)})`);
  }
  return raw;
}

function parseBlockedMinutes(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_BLOCKED_MINUTES;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    fail(`"blocked_minutes" must be a positive number (got ${JSON.stringify(raw)})`);
  }
  return raw;
}

function parseStates(raw: unknown): DispatchStates {
  if (raw === undefined || raw === null) return { ...DEFAULT_STATES };
  if (!isRecord(raw)) fail(`"states" must be a map of role to Linear status name`);
  const states: DispatchStates = { ...DEFAULT_STATES };
  for (const [key, value] of Object.entries(raw)) {
    if (key !== "queued" && key !== "building" && key !== "review" && key !== "failed" && key !== "merge") {
      fail(`unknown states role "${key}" (known: queued, building, review, failed, merge)`);
    }
    if (typeof value !== "string" || value.trim() === "") {
      fail(`states."${key}" must be a non-empty status name`);
    }
    states[key] = value.trim();
  }
  return states;
}

function parseModels(raw: unknown): DispatchModels {
  if (raw === undefined || raw === null) return { ...DEFAULT_MODELS };
  if (!isRecord(raw)) fail(`"models" must be a map of role to model id`);
  const models: DispatchModels = { ...DEFAULT_MODELS };
  for (const [key, value] of Object.entries(raw)) {
    if (key !== "builder" && key !== "reviewer" && key !== "escalate") {
      fail(`unknown models role "${key}" (known: builder, reviewer, escalate)`);
    }
    if (typeof value !== "string" || value.trim() === "") {
      fail(`models."${key}" must be a non-empty model id`);
    }
    models[key] = value.trim();
  }
  return models;
}

/** Validate raw parsed YAML into a DispatchConfig. Unknown keys are ignored. */
export function parseDispatchConfig(raw: unknown): DispatchConfig {
  if (!isRecord(raw)) fail(`expected a YAML map at the top level`);
  const project = requiredText(raw, "project");
  const maxRunning = parseMaxRunning(raw["max_running"]);
  const maxHours = parseMaxHours(raw["max_hours"]);
  const blockedMinutes = parseBlockedMinutes(raw["blocked_minutes"]);
  const { host, port } = parseListen(raw["listen"]);
  const states = parseStates(raw["states"]);
  if (states.failed === states.queued) {
    fail(
      `"states.failed" ("${states.failed}") must not equal "states.queued": a failed ticket dropped back into the queue state would be re-claimed forever`,
    );
  }
  if (states.merge === states.building || states.merge === states.review) {
    fail(
      `"states.merge" ("${states.merge}") must not equal "states.building" or "states.review": the merge state marks owner acceptance, not active work`,
    );
  }
  return {
    project,
    team: optionalText(raw, "team"),
    maxRunning,
    maxHours,
    blockedMinutes,
    linearOrg: optionalText(raw, "linear_org") ?? DEFAULT_LINEAR_ORG,
    listenHost: host,
    listenPort: port,
    states,
    herdrRemote: optionalText(raw, "herdr_remote"),
    models: parseModels(raw["models"]),
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
