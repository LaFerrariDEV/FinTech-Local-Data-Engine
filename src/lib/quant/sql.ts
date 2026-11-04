/**
 * SQL text helpers. Every identifier or literal that originates from user input
 * (file names, column names, symbols) must pass through these functions before
 * being interpolated into SQL.
 */

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Validates that a value is a finite integer within bounds; used for window sizes etc. */
export function assertInt(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer between ${min} and ${max} (got ${String(value)})`);
  }
  return value;
}

export function assertFinite(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${label} must be a number between ${min} and ${max} (got ${String(value)})`);
  }
  return value;
}

/** SQL numeric literal that is always parsed as DOUBLE. */
export function num(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`Non-finite numeric literal: ${value}`);
  const text = String(value);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

const RESERVED = new Set([
  "select", "from", "where", "table", "order", "group", "by", "limit", "join", "union",
  "create", "drop", "insert", "update", "delete", "with", "as", "on", "and", "or", "not",
  "null", "true", "false", "case", "when", "then", "else", "end", "view", "index", "values",
]);

/**
 * Turns an arbitrary file name into a safe, readable SQL table name:
 * "SPY Daily (2020).csv" -> "spy_daily_2020".
 */
export function toTableName(fileName: string, taken: Iterable<string> = []): string {
  const base = fileName.replace(/\.[^.]+$/, "");
  let name = base
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  if (!name) name = "dataset";
  if (/^[0-9]/.test(name)) name = `t_${name}`;
  if (RESERVED.has(name) || name.endsWith("_raw") || name.startsWith("__")) name = `${name}_ds`;
  const takenSet = new Set(Array.from(taken, (t) => t.toLowerCase()));
  if (!takenSet.has(name)) return name;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${name}_${i}`;
    if (!takenSet.has(candidate)) return candidate;
  }
  throw new Error("Unable to allocate a unique table name");
}

/**
 * Splits a SQL script into individual statements, respecting quoted strings,
 * quoted identifiers, line comments, block comments and dollar-quoted strings.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      current += sql.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (ch === "$") {
      const tagMatch = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        current += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === ";") {
      if (current.trim()) out.push(current.trim());
      current = "";
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (stripComments(current).trim()) out.push(current.trim());
  return out.filter((s) => stripComments(s).trim().length > 0);
}

/** Removes comments and replaces string literals / quoted identifiers with placeholders. */
export function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

export function maskLiterals(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end;
      out += " ";
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      out += " ";
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += ch === "'" ? "''" : '"x"';
      i = j + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
