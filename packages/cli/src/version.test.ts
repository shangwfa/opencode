import { afterEach, describe, expect, test } from "bun:test"

// `version.ts` resolves its exports at module-eval time. Import it through a
// unique query string per case so each evaluation observes a fresh environment.
async function loadVersionModule() {
  return import(`./version.ts?case=${crypto.randomUUID()}`)
}

afterEach(() => {
  delete process.env.OPENCODE_APP_VERSION
})

describe("version", () => {
  test("falls back to \"local\" when no define was injected and no env override is set", async () => {
    const mod = await loadVersionModule()
    expect(mod.OPENCODE_VERSION).toBe("local")
  })

  test("OPENCODE_APP_VERSION overrides the missing build-time define", async () => {
    process.env.OPENCODE_APP_VERSION = "2.0.5"
    const mod = await loadVersionModule()
    expect(mod.OPENCODE_VERSION).toBe("2.0.5")
  })

  test("OPENCODE_LOCAL stays consistent with the channel fallback", async () => {
    process.env.OPENCODE_APP_VERSION = "2.0.5"
    const mod = await loadVersionModule()
    expect(mod.OPENCODE_LOCAL).toBe(true)
  })
})
