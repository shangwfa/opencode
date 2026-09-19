import { describe, expect, test } from "bun:test"
import { packageName } from "../../docker/opt/sandbox-plugin-npm"

describe("sandbox plugin npm spec", () => {
  test("extracts package names from supported specs", () => {
    expect(packageName("example")).toBe("example")
    expect(packageName("example@latest")).toBe("example")
    expect(packageName("example@1.2.3")).toBe("example")
    expect(packageName("@scope/example")).toBe("@scope/example")
    expect(packageName("@scope/example@1.2.3")).toBe("@scope/example")
  })

  test("rejects non-registry specs", () => {
    expect(() => packageName("https://example.com/plugin.tgz")).toThrow("Unsupported npm plugin spec")
    expect(() => packageName("../plugin")).toThrow("Unsupported npm plugin spec")
    expect(() => packageName("file:../plugin")).toThrow("Unsupported npm plugin spec")
  })
})
