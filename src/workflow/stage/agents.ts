// Agent profiles: one shape for every worker, and the launch translation
// of the cross-harness `effort` field into each harness's native
// reasoning/thinking launch option.
//
// Every profile — commander, builder, reviewer, deliverer, and the builder
// fallback — is `harness` + `model` + optional `effort`. `effort` may be
// omitted to keep the harness default; once set it must become a real
// launch argument or fail explicitly before launch, never silently dropped.
//
// Native options, read off the installed CLIs (never guessed):
// - codex 0.153.4: `-m/--model <MODEL>` selects the model; there is no
//   `--effort` flag, so reasoning effort is the `model_reasoning_effort`
//   config key, settable per launch with `-c model_reasoning_effort="<effort>"`
//   (the key is in live use in `~/.codex/config.toml`). Accepted values are
//   the documented Codex reasoning levels: minimal, low, medium, high, xhigh.
// - claude 2.1.263: `--model <model>` selects the model and
//   `--effort <level>` the effort (low, medium, high, xhigh, max).
// - opencode 1.18.29: `-m/--model provider/model` selects the model on the
//   interactive TUI Herdr launches (`opencode [project]`), which documents
//   no effort flag — only `opencode run` has `--variant` — so a configured
//   effort for the opencode harness fails instead of being dropped.
// Any other harness fails too: without a known model flag the profile's
// model could not reach the launch, and dispatch never drops it silently.

import type { CommanderAgentConfig, CommanderConfig, DispatchConfig } from "../config/config.ts";

export type { CommanderAgentConfig };

const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * Native Herdr `agent.start` args carrying a profile's model and effort:
 * the model always rides along, the effort only when configured. Throws
 * naming the harness and the value when either has no way to reach the
 * launch — the caller fails before launch, never drops silently.
 */
export function launchArgsFor(profile: Pick<CommanderAgentConfig, "harness" | "model" | "effort">): string[] {
  const effort = profile.effort;
  switch (profile.harness) {
    case "codex":
      if (profile.model.includes("/")) {
        throw new Error(
          `unsupported model "${profile.model}" for harness "codex": ` +
            `Codex expects a bare model id such as "gpt-5.6-sol"; provider/model ids belong to OpenCode`,
        );
      }
      return ["-m", profile.model, ...codexEffortArgs(effort)];
    case "claude":
      return ["--model", profile.model, ...claudeEffortArgs(effort)];
    case "opencode":
      if (!profile.model.includes("/")) {
        throw new Error(
          `unsupported model "${profile.model}" for harness "opencode": ` +
            `OpenCode expects a provider/model id`,
        );
      }
      if (effort !== undefined) {
        throw new Error(
          `unsupported effort "${effort}" for harness "opencode": ` +
            `the opencode TUI has no reasoning-effort launch option; omit effort to keep the harness default`,
        );
      }
      return ["-m", profile.model];
    default:
      throw new Error(
        `unsupported harness "${profile.harness}": ` +
          `no known model launch option, so the configured model "${profile.model}" could not reach the launch`,
      );
  }
}

function codexEffortArgs(effort: string | undefined): string[] {
  if (effort === undefined) return [];
  if (!(CODEX_EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(
      `unsupported effort "${effort}" for harness "codex" ` +
        `(known: ${CODEX_EFFORTS.join(", ")}); omit effort to keep the harness default`,
    );
  }
  return ["-c", `model_reasoning_effort="${effort}"`];
}

function claudeEffortArgs(effort: string | undefined): string[] {
  if (effort === undefined) return [];
  if (!(CLAUDE_EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(
      `unsupported effort "${effort}" for harness "claude" ` +
        `(known: ${CLAUDE_EFFORTS.join(", ")}); omit effort to keep the harness default`,
    );
  }
  return ["--effort", effort];
}

/** The Herdr `agent.start` identity behind one agent profile. */
export function launchFor(profile: CommanderAgentConfig): { kind: string; args: string[] } {
  return { kind: profile.harness, args: launchArgsFor(profile) };
}

/** Interactive Commander command with its first work order supplied at launch. */
export function foregroundCommandFor(profile: CommanderAgentConfig, workOrder: string): string[] {
  const { kind, args } = launchFor(profile);
  if (kind === "opencode") return [kind, ...args, "--prompt", workOrder];
  return [kind, ...args, workOrder];
}

// ---------------------------------------------------------------------------
// Run record: the resolved stage-agent profiles frozen into workspace
// metadata at worker start, so retries and recovery reuse the run's own
// profiles instead of re-reading a possibly edited configuration.
//
// Herdr caps one metadata report at 16 tokens. Stage profiles use three
// JSON tokens, with the builder fallback nested inside the builder blob.
// ---------------------------------------------------------------------------

/** Workspace metadata keys carrying the worker-start stage-agent profiles. */
export const PROFILE_TOKENS = [
  "profile_builder",
  "profile_reviewer",
  "profile_deliverer",
] as const;

interface FrozenProfile {
  harness?: unknown;
  model?: unknown;
  effort?: unknown;
  fallback?: FrozenProfile;
}

function freezeProfile(profile: CommanderAgentConfig): string {
  return JSON.stringify(profile);
}

/** The worker-start snapshot of every stage-agent profile for the run: three tokens. */
export function recordStageProfiles(config: DispatchConfig): Record<string, string> {
  const agents = config.commander.agents;
  return {
    profile_builder: freezeProfile(agents.builder),
    profile_reviewer: freezeProfile(agents.reviewer),
    profile_deliverer: freezeProfile(agents.deliverer),
  };
}

/** The run-recorded profile tokens already on a workspace. A rebuild
 *  merges these over fresh defaults so it never downgrades the run record
 *  with a possibly edited configuration. */
export function keptStageProfiles(tokens: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const key of PROFILE_TOKENS) {
    const value = tokens[key];
    if (value !== undefined) kept[key] = value;
  }
  return kept;
}

/**
 * Every profile effort dispatch cannot translate, named concretely. The
 * worker start refuses on these before any workspace opens, so a
 * configured effort is either a real launch option or an explicit error —
 * for stage profiles too, not just the Commander.
 */
export function launchProblems(config: DispatchConfig): string[] {
  const agents = config.commander.agents;
  const profiles: [string, CommanderAgentConfig][] = [
    ["commander", agents.commander],
    ["builder", agents.builder],
    ["builder.fallback", agents.builder.fallback],
    ["reviewer", agents.reviewer],
    ["deliverer", agents.deliverer],
  ];
  const problems: string[] = [];
  for (const [name, profile] of profiles) {
    try {
      launchArgsFor(profile);
    } catch (error) {
      problems.push(`agents."${name}": ${(error as Error).message}`);
    }
  }
  return problems;
}
function isFrozen(value: unknown): value is FrozenProfile {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function thawField(frozen: FrozenProfile, key: "harness" | "model" | "effort"): string | undefined {
  const value = frozen[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function parseFrozen(raw: string | undefined): FrozenProfile | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isFrozen(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function thawBase(frozen: FrozenProfile | undefined, fallback: CommanderAgentConfig): CommanderAgentConfig {
  if (frozen === undefined) return { ...fallback };
  const harness = thawField(frozen, "harness") ?? fallback.harness;
  const model = thawField(frozen, "model") ?? fallback.model;
  const effort = thawField(frozen, "effort");
  return effort === undefined ? { harness, model } : { harness, model, effort };
}

/**
 * A frozen profile wins field by field; anything missing or malformed
 * falls back to the live configuration. An effort frozen as absent stays
 * absent even when the live configuration now sets one — only a run that
 * never recorded the profile inherits the live value.
 */
function thawProfile(raw: string | undefined, fallback: CommanderAgentConfig): CommanderAgentConfig {
  return thawBase(parseFrozen(raw), fallback);
}

/**
 * The Commander work-order config for a resumed or recovered run: recorded
 * profile tokens win, the live configuration fills whatever the run never
 * recorded (older runs). The effective builder model
 * override (`builder` token, from `worker restart --builder`) still
 * wins for the Build stage only.
 */
export function commanderConfigForRun(
  commander: CommanderConfig,
  tokens: Record<string, string>,
): CommanderConfig {
  const frozenBuilder = parseFrozen(tokens["profile_builder"]);
  const builder = thawBase(frozenBuilder, commander.agents.builder);
  if (tokens["builder"] !== undefined) builder.model = tokens["builder"];
  const builderFallback = thawBase(
    frozenBuilder?.fallback !== undefined && isFrozen(frozenBuilder.fallback)
      ? frozenBuilder.fallback
      : undefined,
    commander.agents.builder.fallback,
  );
  return {
    agents: {
      commander: commander.agents.commander,
      builder: { ...builder, fallback: builderFallback },
      reviewer: thawProfile(tokens["profile_reviewer"], commander.agents.reviewer),
      deliverer: thawProfile(tokens["profile_deliverer"], commander.agents.deliverer),
    },
    stages: commander.stages,
  };
}
