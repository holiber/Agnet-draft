/**
 * Minimal command-line tokenizer for interactive CLI mode.
 *
 * Supports:
 * - whitespace separation
 * - single quotes: '...'
 * - double quotes: "..." with backslash escapes
 * - backslash escapes outside quotes
 *
 * This intentionally does not implement full shell parsing (env expansion, globbing, etc).
 */

export function tokenizeCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;

  type Mode = "normal" | "single" | "double";
  let mode: Mode = "normal";

  const flush = () => {
    if (cur.length > 0) out.push(cur);
    cur = "";
  };

  const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";

  while (i < line.length) {
    const ch = line[i];

    if (mode === "normal") {
      if (isWs(ch)) {
        // Consume contiguous whitespace.
        flush();
        while (i < line.length && isWs(line[i])) i++;
        continue;
      }
      if (ch === "'") {
        mode = "single";
        i++;
        continue;
      }
      if (ch === '"') {
        mode = "double";
        i++;
        continue;
      }
      if (ch === "\\") {
        // Escape next character if present.
        const next = line[i + 1];
        if (next !== undefined) {
          cur += next;
          i += 2;
          continue;
        }
        // Trailing backslash - treat as literal.
        cur += "\\";
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }

    if (mode === "single") {
      if (ch === "'") {
        mode = "normal";
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }

    // mode === "double"
    if (ch === '"') {
      mode = "normal";
      i++;
      continue;
    }
    if (ch === "\\") {
      const next = line[i + 1];
      if (next !== undefined) {
        // Common escapes; otherwise keep the char as-is.
        if (next === "n") cur += "\n";
        else if (next === "r") cur += "\r";
        else if (next === "t") cur += "\t";
        else cur += next;
        i += 2;
        continue;
      }
      cur += "\\";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }

  if (mode !== "normal") {
    throw new Error(`Unterminated ${mode === "single" ? "single" : "double"} quote`);
  }

  flush();
  return out;
}

