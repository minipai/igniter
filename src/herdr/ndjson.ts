// Newline-delimited JSON, the format the Herdr unix socket speaks in both
// directions: one JSON value per line. JSON escapes a literal newline inside
// a string, so a raw "\n" byte only ever falls on a value boundary and
// splitting on it is safe. A single socket read can carry half a line or
// several, so callers buffer through splitLines.

// Largest line a caller buffers before giving up on the connection. Real
// ones are small (a full session snapshot is tens of kilobytes), so anything
// past this is a wedged peer, not a slow one.
export const MAX_LINE_BYTES = 1024 * 1024;

export interface SplitLinesResult {
  /** Complete lines (without the trailing newline). May include empty lines. */
  lines: string[];
  /** Trailing bytes after the last newline: the start of the next frame. */
  rest: string;
}

export function splitLines(buffer: string): SplitLinesResult {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === "\n") {
      lines.push(buffer.slice(start, i));
      start = i + 1;
    }
  }
  return { lines, rest: buffer.slice(start) };
}

export function encodeLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
