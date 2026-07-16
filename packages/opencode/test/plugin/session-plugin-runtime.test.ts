import { describe, expect, test } from "bun:test"
import { importPluginCode } from "../../src/plugin/session-plugin-runtime"

const CODE = `export default async () => ({
  "chat.params": async (_input, output) => {
    output.temperature = 0
  },
  config: async () => {
    throw new Error("must be filtered")
  },
})`

describe("importPluginCode", () => {
  test("loads a default-exported plugin function", async () => {
    const plugin = await importPluginCode(CODE)
    const hooks = await plugin({} as never)
    expect(typeof plugin).toBe("function")
    expect(typeof hooks["chat.params"]).toBe("function")
  })

  test("caches modules by code", async () => {
    expect(await importPluginCode(CODE)).toBe(await importPluginCode(CODE))
  })

  test("rejects a plugin without a default function export", async () => {
    await expect(importPluginCode("export default {}"))
      .rejects.toThrow("Session plugin must default-export a function")
  })
})
