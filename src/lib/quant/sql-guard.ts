import { maskLiterals, splitStatements } from "./sql";

/**
 * Read-only SQL validation used for statements produced by AI agents and custom
 * strategy signals. The user's own SQL console is intentionally unrestricted.
 */

const ALLOWED_LEADING = new Set(["SELECT", "WITH", "FROM", "DESCRIBE", "SUMMARIZE", "SHOW", "EXPLAIN", "VALUES", "TABLE"]);

const FORBIDDEN = [
  "INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER", "ATTACH", "DETACH", "COPY", "EXPORT",
  "IMPORT", "INSTALL", "LOAD", "SET", "RESET", "CALL", "CHECKPOINT", "VACUUM", "TRUNCATE", "MERGE",
  "GRANT", "REVOKE", "PRAGMA", "USE", "BEGIN", "COMMIT", "ROLLBACK", "UPSERT",
];

/** Table functions that would let a statement reach outside the loaded datasets. */
const FORBIDDEN_FUNCTIONS = ["READ_TEXT", "READ_BLOB", "GLOB", "HTTPFS", "S3"];

export interface GuardResult {
  ok: boolean;
  reason?: string;
  statement?: string;
}

export function checkReadOnlySql(sql: string): GuardResult {
  const statements = splitStatements(sql);
  if (statements.length === 0) return { ok: false, reason: "Empty statement" };
  if (statements.length > 1) return { ok: false, reason: "Only a single statement is allowed" };
  const statement = statements[0];
  const masked = maskLiterals(statement).toUpperCase();
  const firstWord = /^[\s(]*([A-Z_]+)/.exec(masked)?.[1];
  if (!firstWord || !ALLOWED_LEADING.has(firstWord)) {
    return { ok: false, reason: `Statements must start with SELECT/WITH/FROM/DESCRIBE/SUMMARIZE (got ${firstWord ?? "nothing"})` };
  }
  const words = new Set(masked.match(/[A-Z_][A-Z0-9_]*/g) ?? []);
  for (const keyword of FORBIDDEN) {
    if (words.has(keyword)) return { ok: false, reason: `Keyword ${keyword} is not allowed in read-only mode` };
  }
  for (const fn of FORBIDDEN_FUNCTIONS) {
    if (new RegExp(`\\b${fn}\\s*\\(`).test(masked)) return { ok: false, reason: `Function ${fn.toLowerCase()} is not allowed` };
  }
  return { ok: true, statement };
}

export function assertReadOnlySql(sql: string): string {
  const result = checkReadOnlySql(sql);
  if (!result.ok || !result.statement) throw new Error(`Rejected SQL: ${result.reason}`);
  return result.statement;
}
