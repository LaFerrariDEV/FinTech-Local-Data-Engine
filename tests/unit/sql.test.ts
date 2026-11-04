import { describe, expect, it } from "vitest";
import { assertInt, maskLiterals, num, quoteIdent, quoteLiteral, splitStatements, toTableName } from "../../src/lib/quant/sql";
import { checkReadOnlySql } from "../../src/lib/quant/sql-guard";

describe("quoting", () => {
  it("escapes identifiers and literals", () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    expect(quoteLiteral("it's")).toBe("'it''s'");
  });

  it("formats doubles and validates integers", () => {
    expect(num(2)).toBe("2.0");
    expect(num(2.5)).toBe("2.5");
    expect(() => num(Number.NaN)).toThrow();
    expect(assertInt(5, "x", 1, 10)).toBe(5);
    expect(() => assertInt(5.5, "x", 1, 10)).toThrow(/integer/);
    expect(() => assertInt("5" as unknown as number, "x", 1, 10)).toThrow();
  });
});

describe("toTableName", () => {
  it("produces safe, unique names", () => {
    expect(toTableName("SPY Daily (2020).csv")).toBe("spy_daily_2020");
    expect(toTableName("2024 ticks.parquet")).toBe("t_2024_ticks");
    expect(toTableName("select.csv")).toBe("select_ds");
    expect(toTableName("prices_raw.csv")).toBe("prices_raw_ds");
    expect(toTableName("Ünïcödé.csv")).toBe("unicode");
    expect(toTableName("!!!.csv")).toBe("dataset");
    expect(toTableName("spy.csv", ["spy", "spy_2"])).toBe("spy_3");
  });
});

describe("splitStatements", () => {
  it("respects strings, identifiers and comments", () => {
    const sql = `SELECT ';' AS a; -- comment; here\nSELECT "x;y" FROM t /* ; */; SELECT $$a;b$$;`;
    expect(splitStatements(sql)).toEqual([`SELECT ';' AS a`, `-- comment; here\nSELECT "x;y" FROM t /* ; */`, "SELECT $$a;b$$"]);
  });
  it("drops comment-only fragments", () => {
    expect(splitStatements("SELECT 1; -- trailing")).toEqual(["SELECT 1"]);
    expect(splitStatements("   ;;  ")).toEqual([]);
  });
  it("masks literals", () => {
    expect(maskLiterals("SELECT 'DROP TABLE x' -- DELETE\n")).not.toMatch(/DROP|DELETE/);
  });
});

describe("read-only guard", () => {
  it.each([
    "SELECT * FROM t",
    "with a as (select 1) select * from a",
    "FROM t LIMIT 5",
    "DESCRIBE t",
    "SUMMARIZE t",
    "SELECT 'drop table x' AS note",
    "SELECT replace(name, 'a', 'b') FROM t",
    "  (SELECT 1)",
  ])("allows %s", (sql) => {
    expect(checkReadOnlySql(sql).ok).toBe(true);
  });

  it.each([
    ["DROP TABLE t", /DROP/],
    ["DELETE FROM t", /DELETE/],
    ["SELECT 1; DROP TABLE t", /single statement/],
    ["WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x", /INSERT/],
    ["CREATE TABLE x AS SELECT 1", /CREATE/],
    ["COPY t TO 'x.csv'", /COPY/],
    ["SELECT * FROM read_text('/etc/passwd')", /read_text/],
    ["ATTACH 'x.db'", /ATTACH/],
    ["SET threads = 1", /SET/],
    ["", /Empty/],
  ])("rejects %s", (sql, reason) => {
    const r = checkReadOnlySql(sql);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(reason);
  });
});
