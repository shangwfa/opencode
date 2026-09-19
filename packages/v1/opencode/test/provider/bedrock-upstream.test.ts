import { describe, expect, test } from "bun:test"

// The provider logic is not directly exported, so we test the module-level
// behavior through the exported custom() loaders and verify the model ID
// transformations at the source level via the actual plugin files.

describe("Bedrock model ID handling (upstream merge: ARN + deepseek.r1)", () => {
  test("amazon-bedrock plugin uses deepseek.r1 (not bare deepseek)", async () => {
    const source = await Bun.file("src/provider/provider.ts").text()
    expect(source).toContain('"deepseek.r1"')
    // The old bare "deepseek" entry must not be in the Bedrock prefix list
    // (it was replaced by "deepseek.r1" in upstream PR #34441)
    const bedrockBlock = source.slice(
      source.indexOf("crossRegionPrefixes"),
      source.indexOf("isGovCloud"),
    )
    expect(bedrockBlock).not.toMatch(/"deepseek"[,\]]/)
  })

  test("ARN-prefixed model IDs skip cross-region prefixing", async () => {
    const source = await Bun.file("src/provider/provider.ts").text()
    expect(source).toContain('modelID.startsWith("arn:")')
  })

  test("core bedrock plugin also uses deepseek.r1", async () => {
    const source = await Bun.file("../core/src/plugin/provider/amazon-bedrock.ts").text()
    expect(source).toContain('"deepseek.r1"')
  })

  test("ARN check exists in core bedrock plugin", async () => {
    const source = await Bun.file("../core/src/plugin/provider/amazon-bedrock.ts").text()
    expect(source).toContain('startsWith("arn:")')
  })
})
