const FENCE = /^```(yaml|yml)[ \t]*\n([\s\S]*?)^```[ \t]*$/gm;
const FIELD = /^  ([A-Za-z_]+)[ \t]*:[ \t]*(\S+)[ \t]*$/;
const RECORDS = ["igniter_receipt", "igniter_event"] as const;

export type RecordValue = string | null;

export class RecordParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordParseError";
  }
}

/** Write the small YAML subset used by Igniter's Linear records. */
export function recordBlock(
  name: (typeof RECORDS)[number],
  fields: readonly (readonly [string, RecordValue])[],
): string {
  const lines = ["```yaml", `${name}:`, "  version: 1"];
  const seen = new Set(["version"]);
  for (const [key, value] of fields) {
    if (!/^[A-Za-z_]+$/.test(key) || seen.has(key)) {
      throw new Error(`refused: invalid or duplicate ${name} field "${key}"`);
    }
    if (value === undefined || (value !== null && !/^\S+$/.test(value))) {
      throw new Error(`refused: ${name} field "${key}" must be a whitespace-free scalar token or null`);
    }
    seen.add(key);
    lines.push(`  ${key}: ${value === null ? "null" : value}`);
  }
  return [...lines, "```"].join("\n");
}

/** Read one fenced Igniter record, rejecting duplicate, mixed, or malformed blocks. */
export function parseRecord(body: string, name: (typeof RECORDS)[number]): Map<string, string> | null {
  const records: { name: string; content: string }[] = [];
  for (const match of body.matchAll(FENCE)) {
    const content = match[2] ?? "";
    for (const candidate of RECORDS) {
      if (content.split("\n").some((line) => new RegExp(`^\\s*${candidate}\\b`).test(line))) {
        records.push({ name: candidate, content });
      }
    }
  }

  const matches = records.filter((record) => record.name === name);
  if (matches.length === 0) return null;
  const other = records.find((record) => record.name !== name)?.name;
  if (other) {
    throw new RecordParseError(
      `refused: comment holds both an ${name} and an ${other} block; one lifecycle record needs exactly one machine block`,
    );
  }
  if (matches.length > 1) {
    throw new RecordParseError(`refused: comment holds ${matches.length} ${name} blocks; one record needs exactly one`);
  }

  const label = name.replace("igniter_", "");
  const lines = matches[0]!.content.split("\n").map((line) => line.replace(/\r$/, ""));
  const head = lines.findIndex((line) => line.trim() !== "");
  if (head < 0 || lines[head] !== `${name}:`) {
    throw new RecordParseError(`refused: ${label} block must start with "${name}:"`);
  }

  const fields = new Map<string, string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "" || index === head) continue;
    if (line.trimStart().startsWith("#")) {
      throw new RecordParseError(`refused: ${label} block holds a comment line; one record needs plain fields only`);
    }
    const field = FIELD.exec(line);
    if (!field) {
      throw new RecordParseError(
        `refused: malformed ${label} line ${JSON.stringify(line)}; fields need two-space "key: value" scalars`,
      );
    }
    const key = field[1]!;
    if (fields.has(key)) throw new RecordParseError(`refused: duplicate ${label} field "${key}"`);
    fields.set(key, field[2]!);
  }

  if (!fields.has("version")) throw new RecordParseError(`refused: ${label} block misses "version"`);
  const version = fields.get("version");
  if (version !== "1") {
    throw new RecordParseError(`refused: unknown ${label} version ${JSON.stringify(version)}; this dispatch reads version 1`);
  }
  fields.delete("version");
  return fields;
}

/** Enforce the exact field set for a parsed record kind. */
export function strictFields(
  fields: Map<string, string>,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): Record<string, string> {
  for (const key of fields.keys()) {
    if (!allowed.includes(key)) throw new RecordParseError(`refused: unknown ${label} field "${key}"`);
  }
  for (const key of required) {
    if (!fields.has(key)) throw new RecordParseError(`refused: ${label} misses required field "${key}"`);
  }
  return Object.fromEntries(fields);
}
