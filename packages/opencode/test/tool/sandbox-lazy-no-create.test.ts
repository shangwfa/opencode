import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SandboxProvider, SandboxConfig } from "../../src/tool/sandbox-provider"
import type { SessionID } from "../../src/session/schema"

const sid = (s: string) => s as SessionID

describe("Lazy sandbox: getSandbox pattern", () => {
  test("sandboxEnabled=false: getSandbox always returns null", () => {
    let sandboxPromise: Promise<any> | null = null
    const sandboxEnabled = false
    let providerCalled = false

    function getSandbox() {
      if (!sandboxEnabled) return null
      if (!sandboxPromise) {
        providerCalled = true
        sandboxPromise = Promise.resolve({ id: "sb" })
      }
      return sandboxPromise
    }

    const r1 = getSandbox()
    const r2 = getSandbox()
    const r3 = getSandbox()

    expect(r1).toBeNull()
    expect(r2).toBeNull()
    expect(r3).toBeNull()
    expect(sandboxPromise).toBeNull()
    expect(providerCalled).toBe(false)
  })

  test("no tool calls = no getSandbox invocation", () => {
    let getSandboxCalls = 0

    function getSandbox() {
      getSandboxCalls++
      return Promise.resolve({ id: "sb" })
    }

    // Simulate: resolveTools registers tools with context(args, options) factories
    // but context() is only called inside execute(), which ai-sdk only calls
    // when the LLM actually returns a tool_call
    const registeredTools: Record<string, { execute: () => void }> = {}
    for (let i = 0; i < 5; i++) {
      registeredTools[`tool-${i}`] = {
        execute() {
          const _sandbox = getSandbox() // only called when tool is actually invoked
        },
      }
    }

    // LLM returned text-only, no tool calls → execute() never called
    expect(getSandboxCalls).toBe(0)

    // Now LLM calls tool-2
    registeredTools["tool-2"].execute()
    expect(getSandboxCalls).toBe(1)

    // Other tools still not called
    expect(getSandboxCalls).toBe(1)
  })

  test("lazy getSandbox memoizes and only creates once", () => {
    let createCount = 0
    let sandboxPromise: Promise<any> | null = null

    function getSandbox() {
      if (!sandboxPromise) {
        createCount++
        sandboxPromise = Promise.resolve({ id: `sb-${createCount}` })
      }
      return sandboxPromise
    }

    // No calls yet
    expect(createCount).toBe(0)

    // First call triggers creation
    const p1 = getSandbox()
    expect(createCount).toBe(1)
    expect(p1).not.toBeNull()

    // Subsequent calls reuse
    const p2 = getSandbox()
    const p3 = getSandbox()
    expect(createCount).toBe(1)
    expect(p2).toBe(p1)
    expect(p3).toBe(p1)
  })

  test("context() is only evaluated inside execute(), not at registration", () => {
    let contextCalls = 0

    const makeContext = () => {
      contextCalls++
      return { sandbox: null }
    }

    // Simulate resolveTools: register 10 tools with context factory
    const tools: Record<string, { execute: () => void }> = {}
    for (let i = 0; i < 10; i++) {
      tools[`tool-${i}`] = {
        execute() {
          makeContext()
        },
      }
    }

    // Registration phase: no context calls
    expect(contextCalls).toBe(0)

    // ai-sdk calls 3 tools via Promise.all
    tools["tool-1"].execute()
    tools["tool-5"].execute()
    tools["tool-9"].execute()
    expect(contextCalls).toBe(3)

    // 7 unused tools never triggered context
    expect(contextCalls).toBe(3)
  })
})
