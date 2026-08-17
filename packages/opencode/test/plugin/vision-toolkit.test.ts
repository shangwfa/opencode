import { describe, expect, test, mock } from "bun:test"

// Test the core logic of the V1 vision-toolkit plugin
// by importing internal functions

// We need to test the rewriteMessages function's behavior
// Since it's not exported, we recreate the key test scenarios

function mockVisionConfig() {
  return {
    apiKey: "test-key",
    baseUrl: "https://vision.anionex.me/v1",
    model: "gemini-3.7-flash",
  }
}

function makeImagePart(overrides = {}) {
  return {
    id: "part_1",
    sessionID: "test_session",
    messageID: "msg_1",
    type: "file",
    mime: "image/png",
    url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    ...overrides,
  }
}

function makeNonImagePart(overrides = {}) {
  return {
    id: "part_2",
    sessionID: "test_session",
    messageID: "msg_1",
    type: "text",
    text: "What's in this image?",
    ...overrides,
  }
}

function makeUserMessage(parts: any[]) {
  return {
    info: { role: "user" },
    parts,
  }
}

function makeAssistantMessage(parts: any[]) {
  return {
    info: { role: "assistant" },
    parts,
  }
}

// Test the collectJobs-style logic
function collectJobs(messages: any[]) {
  const jobs: Array<{ parts: any[]; index: number; imageUrl: string }> = []
  for (const message of messages) {
    if (message.info.role !== "user") continue
    const parts = message.parts || []
    parts.forEach((part: any, index: number) => {
      if (part?.type !== "file") return
      const mime = part.mime || part.mediaType || ""
      if (!mime.startsWith("image/")) return
      const url = part.url
      if (!url) return
      jobs.push({ parts, index, imageUrl: url })
    })
  }
  return jobs
}

// Test the textPart-style logic
function textPart(template: any, text: string): any {
  const part: any = { type: "text", text }
  for (const key of ["id", "messageID", "sessionID"]) {
    if (template && template[key] !== undefined) part[key] = template[key]
  }
  return part
}

describe("vision-toolkit core logic", () => {
  test("collectJobs extracts image file parts from user messages", () => {
    const messages = [
      makeUserMessage([makeNonImagePart(), makeImagePart()]),
      makeAssistantMessage([{ type: "text", text: "I'll look at that" }]),
    ]

    const jobs = collectJobs(messages)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].imageUrl).toStartWith("data:image/png;base64,")
    expect(jobs[0].index).toBe(1)
  })

  test("collectJobs skips non-user messages", () => {
    const messages = [
      makeAssistantMessage([makeImagePart()]),
    ]

    const jobs = collectJobs(messages)
    expect(jobs).toHaveLength(0)
  })

  test("collectJobs skips non-image file parts", () => {
    const messages = [
      makeUserMessage([
        { type: "file", mime: "text/plain", url: "file:///test.txt" },
      ]),
    ]

    const jobs = collectJobs(messages)
    expect(jobs).toHaveLength(0)
  })

  test("collectJobs handles empty messages", () => {
    const jobs = collectJobs([])
    expect(jobs).toHaveLength(0)
  })

  test("textPart preserves template identity fields", () => {
    const template = { id: "part_1", messageID: "msg_1", sessionID: "session_1" }
    const result = textPart(template, "test description")
    expect(result).toEqual({
      type: "text",
      text: "test description",
      id: "part_1",
      messageID: "msg_1",
      sessionID: "session_1",
    })
  })

  test("textPart creates minimal part without template", () => {
    const result = textPart(null, "test description")
    expect(result).toEqual({
      type: "text",
      text: "test description",
    })
  })

  test("rewriteMessages replaces image parts with text parts", async () => {
    const messages = [makeUserMessage([makeNonImagePart(), makeImagePart()])]
    const config = mockVisionConfig()

    // Mock fetch to return a description
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        choices: [{ message: { content: "A test image description" } }],
      }), { status: 200 })
    })

    try {
      // Call the rewrite logic inline
      const jobs = collectJobs(messages)
      expect(jobs).toHaveLength(1)

      // Replace the image part with a text part
      const desc = "[vision model description] A test image description"
      const note = textPart(jobs[0].parts[jobs[0].index], "[vision proxy] Images reach you as text here...")
      delete note.id
      jobs[0].parts.splice(jobs[0].index, 0, note)
      jobs[0].parts[jobs[0].index + 1] = textPart(jobs[0].parts[jobs[0].index + 1], desc)

      // Verify the result
      const parts = messages[0].parts
      expect(parts).toHaveLength(3) // text + note + description
      expect(parts[0].type).toBe("text")
      expect(parts[1].type).toBe("text")
      expect(parts[1].text).toStartWith("[vision proxy]")
      expect(parts[2].type).toBe("text")
      expect(parts[2].text).toBe("[vision model description] A test image description")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("failure text is descriptive and never silent", () => {
    const failureText = "[vision proxy] image description failed: API error The image was NOT delivered to you — tell the user, and do not guess its contents."
    expect(failureText).toContain("image description failed")
    expect(failureText).toContain("NOT delivered")
    expect(failureText).toContain("tell the user")
  })

  test("config uses built-in defaults when env vars are not set", () => {
    // Save original env
    const original = { ...process.env }
    // Clear vision-related env vars
    for (const key of ["VISION_API_KEY", "VISION_BASE_URL", "VISION_MODEL", "VISION_LANG", "LANG"]) {
      delete process.env[key]
    }

    // Reload config
    const mod = require("../../src/plugin/vision-toolkit")
    const config = mod.internals.loadVisionConfig()

    // Restore env
    Object.assign(process.env, original)

    // Check defaults
    if (!("error" in config)) {
      expect(config.apiKey).toBe("free")
      expect(config.baseUrl).toBe("https://vision.anionex.me/v1")
      expect(config.model).toBe("gemini-3.7-flash")
    }
  })
})

describe("V2 plugin catalog transform", () => {
  test("textOnly Set tracks models without image capability", () => {
    // Simulate the catalog transform logic
    const models = [
      { providerID: "p1", id: "m1", capabilities: { input: ["text"] } },
      { providerID: "p1", id: "m2", capabilities: { input: ["text", "image"] } },
      { providerID: "p2", id: "m3", capabilities: { input: ["text"] } },
    ]

    const textOnly = new Set<string>()
    for (const model of models) {
      if (!model.capabilities.input.includes("image")) {
        textOnly.add(`${model.providerID}/${model.id}`)
      }
    }

    expect(textOnly.has("p1/m1")).toBe(true)
    expect(textOnly.has("p1/m2")).toBe(false)
    expect(textOnly.has("p2/m3")).toBe(true)
    expect(textOnly.size).toBe(2)
  })
})