import { describe, expect, it, spyOn } from "bun:test"
import { Sandbox } from "@vercel/sandbox"
import { readFile } from "node:fs/promises"
import { run } from "../script/vercel-sandbox-spike"
import { tmpdir } from "./fixture/tmpdir"

describe("Vercel P0 live probe admission", () => {
  for (const [name, args, env] of [
    ["no explicit live consent", [], { VERCEL_TOKEN: "do-not-log", VERCEL_TEAM_ID: "team", VERCEL_PROJECT_ID: "prj" }],
    ["missing output", ["--live", "--project", "prj"], { VERCEL_TOKEN: "do-not-log", VERCEL_TEAM_ID: "team", VERCEL_PROJECT_ID: "prj" }],
    ["missing project", ["--live"], {}],
  ] as const) {
    it(`does not create resources with ${name}`, async () => {
      const create = spyOn(Sandbox, "create").mockImplementation(async () => { throw new Error("Unexpected creation") })
      const log = spyOn(console, "log").mockImplementation(() => {})
      try {
        const result = await run([...args], env)
        expect(result.status).toBe("blocked")
        expect(result.cleanup).toBe("not-created")
        expect(result.steps).toEqual([])
        expect(JSON.stringify(result)).not.toContain("do-not-log")
        expect(create).not.toHaveBeenCalled()
      } finally {
        create.mockRestore()
        log.mockRestore()
      }
    })
  }

  for (const mismatch of [false, true]) {
    it(`saves a redacted blocked result for ${mismatch ? "a different project" : "missing credentials"}`, async () => {
      await using dir = await tmpdir("vercel-p0-")
      const output = `${dir.path}/result.json`
      const create = spyOn(Sandbox, "create").mockImplementation(async () => { throw new Error("Unexpected creation") })
      const log = spyOn(console, "log").mockImplementation(() => {})
      try {
        const result = await run(["--live", "--project", mismatch ? "other" : "prj", "--output", output], {
          VERCEL_PROJECT_ID: "prj", VERCEL_TEAM_ID: "team",
          ...(mismatch ? { VERCEL_TOKEN: "do-not-log" } : {}),
        })
        expect(result.status).toBe("blocked")
        expect(result.reason).toContain(mismatch ? "matching VERCEL_PROJECT_ID" : "Missing VERCEL_TOKEN")
        const saved = await readFile(output, "utf8")
        expect(JSON.parse(saved)).toEqual(result)
        expect(saved).not.toContain("do-not-log")
        expect(create).not.toHaveBeenCalled()
      } finally {
        create.mockRestore()
        log.mockRestore()
      }
    })
  }
})
