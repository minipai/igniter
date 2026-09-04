#!/usr/bin/env bun
// Generates src/herdr/herdr-api.d.ts from `herdr api schema --json`.
// Re-running on an unchanged schema produces a byte-identical file.
// Usage: bun src/herdr/generate-types.ts [--check]

import { spawnSync } from "node:child_process";

interface MethodEntry {
  method: string;
  /** Discriminator of the matching success_response variant. Verified live or asserted present. */
  result: string;
}

// Every method the generated file must cover, with the result variant the
// server answers with. Pong, session_snapshot, pane_read, subscription_started
// and ok (for workspace.report_metadata) were verified against the local
// server; the rest assert that the variant exists in the schema.
const METHODS: MethodEntry[] = [
  { method: "ping", result: "pong" },
  { method: "session.snapshot", result: "session_snapshot" },
  { method: "workspace.create", result: "workspace_created" },
  { method: "workspace.report_metadata", result: "ok" },
  { method: "agent.start", result: "agent_started" },
  { method: "agent.prompt", result: "agent_prompted" },
  { method: "agent.read", result: "pane_read" },
  { method: "pane.read", result: "pane_read" },
  { method: "pane.send_input", result: "ok" },
  { method: "pane.send_keys", result: "ok" },
  { method: "events.subscribe", result: "subscription_started" },
];

type JsonSchema = Record<string, unknown>;

function loadSchema(): JsonSchema {
  const child = spawnSync("herdr", ["api", "schema", "--json"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(`herdr api schema --json exited with ${child.status}: ${child.stderr}`);
  }
  return JSON.parse(child.stdout) as JsonSchema;
}

function schemasOf(root: JsonSchema, name: string): Record<string, JsonSchema> {
  const schemas = root["schemas"] as Record<string, JsonSchema>;
  const section = schemas[name] as JsonSchema;
  return (section["$defs"] as Record<string, JsonSchema>) ?? {};
}

function collectRefs(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, into);
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node as JsonSchema)) {
      if (key === "$ref" && typeof value === "string") into.add(value);
      else collectRefs(value, into);
    }
  }
}

function transitiveClosure(
  defs: Record<string, JsonSchema>,
  namespace: string,
  starts: string[],
): Map<string, JsonSchema> {
  const found = new Map<string, JsonSchema>();
  const queue = [...starts];
  while (queue.length > 0) {
    const ref = queue.pop() as string;
    const prefix = `#/schemas/${namespace}/$defs/`;
    if (!ref.startsWith(prefix)) {
      throw new Error(`unsupported $ref outside ${namespace}: ${ref}`);
    }
    const name = ref.slice(prefix.length);
    if (found.has(name)) continue;
    const def = defs[name];
    if (!def) throw new Error(`$ref points at unknown def: ${ref}`);
    if ("$defs" in def) throw new Error(`nested $defs not supported: ${ref}`);
    found.set(name, def);
    const nested = new Set<string>();
    collectRefs(def, nested);
    queue.push(...nested);
  }
  return found;
}

function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function docComment(description: unknown): string {
  if (typeof description !== "string" || description.length === 0) return "";
  const flat = description.replace(/\s+/g, " ").replace(/\*\//g, "*/ ");
  return `/** ${flat} */ `;
}

interface EmitContext {
  namespace: string;
}

function typeOf(schema: JsonSchema, ctx: EmitContext): string {
  if ("$ref" in schema) {
    const ref = schema["$ref"] as string;
    const prefix = `#/schemas/${ctx.namespace}/$defs/`;
    if (!ref.startsWith(prefix)) throw new Error(`unsupported $ref: ${ref}`);
    return `${namespaceType(ctx.namespace)}.${ref.slice(prefix.length)}`;
  }
  if ("const" in schema) return JSON.stringify(schema["const"]);
  if ("enum" in schema) {
    return (schema["enum"] as unknown[]).map((v) => JSON.stringify(v)).join(" | ");
  }
  const union = unionOf(schema, ctx);
  if (union) return union;
  const type = schema["type"];
  if (Array.isArray(type)) {
    return type.map((t) => typeOf({ ...schema, type: t }, ctx)).join(" | ");
  }
  switch (type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const items = (schema["items"] as JsonSchema | undefined) ?? {};
      return `${typeOf(items, ctx)}[]`;
    }
    case "object":
      return objectType(schema, ctx);
    default:
      return "unknown";
  }
}

function unionOf(schema: JsonSchema, ctx: EmitContext): string | undefined {
  for (const key of ["oneOf", "anyOf"]) {
    const variants = schema[key] as JsonSchema[] | undefined;
    if (variants) return variants.map((v) => typeOf(v, ctx)).join(" | ");
  }
  return undefined;
}

function objectType(schema: JsonSchema, ctx: EmitContext): string {
  const properties = schema["properties"] as Record<string, JsonSchema> | undefined;
  const additional = schema["additionalProperties"] as JsonSchema | boolean | undefined;
  if (!properties) {
    if (additional !== undefined && additional !== true) {
      return `Record<string, ${typeOf(additional as JsonSchema, ctx)}>`;
    }
    return "Record<string, unknown>";
  }
  const required = new Set((schema["required"] as string[] | undefined) ?? []);
  const members = Object.entries(properties).map(([name, prop]) => {
    const optional = required.has(name) ? "" : "?";
    const key = isIdentifier(name) ? name : JSON.stringify(name);
    return `${docComment(prop["description"])}${key}${optional}: ${typeOf(prop, ctx)};`;
  });
  if (additional !== undefined && additional !== true) {
    members.push(`[key: string]: ${typeOf(additional as JsonSchema, ctx)};`);
  }
  if (members.length === 0) return "Record<string, unknown>";
  return `{ ${members.join(" ")} }`;
}

function namespaceType(namespace: string): string {
  if (namespace === "request") return "HerdrParams";
  if (namespace === "success_response") return "HerdrResults";
  throw new Error(`no type namespace for schema section: ${namespace}`);
}

function emitNamespace(namespace: string, defs: Map<string, JsonSchema>): string {
  const out: string[] = [`export namespace ${namespaceType(namespace)} {`];
  for (const name of [...defs.keys()].sort()) {
    const def = defs.get(name) as JsonSchema;
    const ctx: EmitContext = { namespace };
    const comment = docComment(def["description"]);
    const hasProperties = (def["properties"] as object | undefined) !== undefined;
    if (hasProperties) {
      out.push(`  ${comment}export interface ${name} ${objectType(def, ctx)}`);
    } else if (def["type"] === "object") {
      out.push(`  ${comment}export type ${name} = ${objectType(def, ctx)};`);
    } else {
      out.push(`  ${comment}export type ${name} = ${typeOf(def, ctx)};`);
    }
  }
  out.push("}");
  return out.join("\n");
}

function snakeToPascal(value: string): string {
  return value
    .split("_")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join("");
}

function generate(root: JsonSchema): string {
  const protocol = root["protocol"];
  const schemaVersion = root["schema_version"];
  const sections = root["schemas"] as Record<string, JsonSchema>;
  const requestSection = sections["request"] as JsonSchema;
  const requestVariants = requestSection["oneOf"] as JsonSchema[];
  const requestDefs = schemasOf(root, "request");
  const successDefs = schemasOf(root, "success_response");
  const eventSection = (sections["event"] as JsonSchema)["$defs"] as Record<string, JsonSchema>;
  const subscriptionEventSection = (sections["subscription_event"] as JsonSchema)[
    "$defs"
  ] as Record<string, JsonSchema>;

  const paramStarts: string[] = [];
  const paramNames = new Map<string, string>();
  for (const { method } of METHODS) {
    const variant = requestVariants.find(
      (v) =>
        ((v["properties"] as JsonSchema)["method"] as JsonSchema)["const"] === method,
    );
    if (!variant) throw new Error(`method missing from schema: ${method}`);
    const ref = ((variant["properties"] as JsonSchema)["params"] as JsonSchema)[
      "$ref"
    ] as string;
    paramStarts.push(ref);
    paramNames.set(method, ref.split("/").at(-1) as string);
  }

  const successSection = (sections["success_response"] as JsonSchema)["$defs"] as Record<
    string,
    JsonSchema
  >;
  const responseResult = successSection["ResponseResult"];
  if (!responseResult) throw new Error("ResponseResult missing from schema");
  const resultVariants = responseResult["oneOf"] as JsonSchema[];
  const resultStarts: string[] = [];
  const resultNames = new Map<string, string>();
  for (const { method, result } of METHODS) {
    const variant = resultVariants.find(
      (v) => ((v["properties"] as JsonSchema)["type"] as JsonSchema)["const"] === result,
    );
    if (!variant) throw new Error(`result variant missing from schema: ${result}`);
    resultNames.set(method, snakeToPascal(result));
    const nested = new Set<string>();
    collectRefs(variant, nested);
    resultStarts.push(...nested);
  }

  const params = transitiveClosure(requestDefs, "request", paramStarts);
  const results = transitiveClosure(successDefs, "success_response", resultStarts);

  const eventKind = eventSection["EventKind"];
  const subscriptionEventKind = subscriptionEventSection["SubscriptionEventKind"];
  if (!eventKind || !subscriptionEventKind) throw new Error("event kind enums missing");
  const kindCtx: EmitContext = { namespace: "request" };

  const table = METHODS.map(({ method }) => {
    const paramsName = paramNames.get(method) as string;
    const resultName = resultNames.get(method) as string;
    return `  "${method}": { params: HerdrParams.${paramsName}; result: HerdrResults.${resultName}; };`;
  });

  // Result variants are oneOf members without their own $def names, so they
  // are emitted as named interfaces derived from their discriminator.
  const resultDecls: string[] = [];
  for (const { result } of METHODS) {
    const variant = resultVariants.find(
      (v) => ((v["properties"] as JsonSchema)["type"] as JsonSchema)["const"] === result,
    ) as JsonSchema;
    const ctx: EmitContext = { namespace: "success_response" };
    const body = objectType(variant, ctx);
    resultDecls.push(`  export interface ${snakeToPascal(result)} ${body}`);
  }
  const uniqueResultDecls = [...new Set(resultDecls)].sort();

  // The error envelope is fixed-shape; ErrorBody comes from the schema.
  const errorDefs = schemasOf(root, "error_response");
  const errorBody = errorDefs["ErrorBody"];
  if (!errorBody) throw new Error("ErrorBody missing from schema");
  const errorCtx: EmitContext = { namespace: "error_response" };
  const errorBodyType = objectType(errorBody, errorCtx);

  const lines = [
    `// Code generated by src/herdr/generate-types.ts from \`herdr api schema --json\`.`,
    `// DO NOT EDIT. Protocol ${protocol}, schema version ${schemaVersion}.`,
    ``,
    emitNamespace("request", params),
    ``,
    `export namespace HerdrResults {`,
    ...uniqueResultDecls,
    ...emitNamespace("success_response", results).split("\n").slice(1, -1),
    `}`,
    ``,
    `/** Methods covered by the generated table, with their params and result payloads. */`,
    `export interface HerdrMethodTable {`,
    ...table,
    `}`,
    ``,
    `export type HerdrMethod = keyof HerdrMethodTable;`,
    ``,
    `/** Success envelope: every response with an \`id\` carries one of these. */`,
    `export interface HerdrSuccessResponse {`,
    `  id: string;`,
    `  result: HerdrMethodTable[HerdrMethod]["result"];`,
    `}`,
    ``,
    `/** Error envelope. Malformed requests are answered with an empty \`id\`. */`,
    `export interface HerdrErrorBody ${errorBodyType}`,
    `export interface HerdrErrorResponse {`,
    `  id: string;`,
    `  error: HerdrErrorBody;`,
    `}`,
    ``,
    `/** Dotted subscription kinds accepted by \`events.subscribe\` (from the schema). */`,
    `export type HerdrSubscriptionEventKind = ${typeOf(subscriptionEventKind, kindCtx)};`,
    `/** Underscored broadcast event kinds (from the schema). */`,
    `export type HerdrEventKind = ${typeOf(eventKind, kindCtx)};`,
    `/**`,
    ` * One streamed frame on a subscribed connection. Narrow \`data\` by \`event\`.`,
    ` * \`pane.agent_status_changed\` (the ticket's acceptance event) carries`,
    ` * \`{ pane_id, workspace_id, agent_status }\` plus nullable agent/title fields.`,
    ` */`,
    `export interface HerdrStreamEvent {`,
    `  event: string;`,
    `  data: unknown;`,
    `}`,
    ``,
  ];
  return `${lines.join("\n")}\n`;
}

const outPath = new URL("./herdr-api.d.ts", import.meta.url);
const generated = generate(loadSchema());

if (process.argv.includes("--check")) {
  const current = await Bun.file(outPath).text().catch(() => "");
  if (current !== generated) {
    console.error("herdr-api.d.ts is stale: run bun src/herdr/generate-types.ts");
    process.exit(1);
  }
  console.log("herdr-api.d.ts is up to date");
} else {
  await Bun.write(outPath, generated);
  console.log(`wrote ${outPath.pathname}`);
}
