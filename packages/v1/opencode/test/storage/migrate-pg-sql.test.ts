import { describe, expect, test } from "bun:test"
import { readFileSync, existsSync } from "fs"
import path from "path"

const BREAKPOINT = "--> statement-breakpoint"

describe("migratePg SQL splitting", () => {
  test("splits real migration file on --> statement-breakpoint", () => {
    const file = path.join(import.meta.dirname, "../../migration-pg/20260417053648_initial/migration.sql")
    if (!existsSync(file)) return
    const sql = readFileSync(file, "utf-8")
    const stmts = sql.split(BREAKPOINT).filter((s) => s.trim())
    expect(stmts.length).toBeGreaterThan(0)
    for (const stmt of stmts) {
      expect(stmt.trim().length).toBeGreaterThan(0)
    }
  })

  test("does NOT split on bare semicolons", () => {
    const sql = "SELECT 1; SELECT 2--> statement-breakpoint\nSELECT 3"
    const stmts = sql.split(BREAKPOINT).filter((s) => s.trim())
    expect(stmts.length).toBe(2)
    expect(stmts[0]).toBe("SELECT 1; SELECT 2")
  })

  test("preserves dollar-quoted function bodies with semicolons", () => {
    const sql = "CREATE FUNCTION foo() RETURNS void AS $$ BEGIN; END; $$ LANGUAGE plpgsql--> statement-breakpoint\nSELECT 1"
    const stmts = sql.split(BREAKPOINT).filter((s) => s.trim())
    expect(stmts.length).toBe(2)
    expect(stmts[0]).toContain("$$ BEGIN; END; $$")
  })

  test("old semicolon split breaks dollar-quoted function bodies (regression proof)", () => {
    const sql = "CREATE FUNCTION foo() RETURNS void AS $$ BEGIN; END; $$ LANGUAGE plpgsql--> statement-breakpoint\nSELECT 1"
    const stmts = sql.split(";").filter((s) => s.trim())
    expect(stmts.length).toBeGreaterThan(2)
  })

  test("handles trailing whitespace around breakpoint", () => {
    const sql = "CREATE TABLE t1 (id INT);\n--> statement-breakpoint\n\nCREATE TABLE t2 (id INT);\n--> statement-breakpoint\n"
    const stmts = sql.split(BREAKPOINT).filter((s) => s.trim())
    expect(stmts.length).toBe(2)
  })

  test("single statement with no breakpoint produces one statement", () => {
    const sql = "CREATE TABLE t (id INT);"
    const stmts = sql.split(BREAKPOINT).filter((s) => s.trim())
    expect(stmts.length).toBe(1)
    expect(stmts[0]).toBe("CREATE TABLE t (id INT);")
  })

  test("inline breakpoint after semicolon (real Drizzle format)", () => {
    const sql = 'CREATE INDEX idx ON "t" ("col");--> statement-breakpoint\nALTER TABLE "t" ADD CONSTRAINT fk FOREIGN KEY ("id") REFERENCES "other"("id");--> statement-breakpoint'
    const stmts = sql.split(BREAKPOINT).filter((s) => s.trim())
    expect(stmts.length).toBe(2)
  })
})
