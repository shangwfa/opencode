import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ReadTool } from "../../src/tool/read"
import { SandboxProvider } from "@/tool/sandbox-provider"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import { Instruction } from "../../src/session/instruction"
import { SessionID, MessageID } from "../../src/session/schema"
import type { Sandbox, FileInfo, Execution, OutputMessage } from "@alibaba-group/opensandbox"
import { provideInstance, testInstanceStoreLayer } from "../fixture/fixture"

const S_IFDIR = 0o040000
const S_IFREG = 0o100000

function makeFileInfo(path: string, opts: Partial<FileInfo> = {}): FileInfo {
  return { path, mode: opts.mode ?? S_IFREG, size: opts.size ?? 0, ...opts }
}

function makeExecution(stdout: string[], exitCode = 0): Execution {
  const logs: OutputMessage[] = stdout.map((text) => ({ text, timestamp: 0 }))
  return { logs: { stdout: logs, stderr: [] }, result: [], exitCode }
}

// In-memory sandbox: files stored as Map, directories inferred from paths.
function makeSandbox(files: Map<string, Uint8Array | string>): Sandbox {
  const fileMap = new Map<string, Uint8Array>()
  for (const [k, v] of files) fileMap.set(k, typeof v === "string" ? new TextEncoder().encode(v) : v)

  const sb: Sandbox = {
    files: {
      getFileInfo: async (paths: string[]) => {
        const result: Record<string, FileInfo> = {}
        for (const p of paths) {
          const data = fileMap.get(p)
          if (data) result[p] = makeFileInfo(p, { mode: S_IFREG, size: data.length })
          else {
            // Check if it's a directory (any file starts with p + "/")
            const isDir = [...fileMap.keys()].some((k) => k.startsWith(p + "/"))
            if (isDir) result[p] = makeFileInfo(p, { mode: S_IFDIR, size: 4096 })
          }
        }
        return result
      },
      readBytes: async (p: string, opts?: { range?: string }) => {
        const data = fileMap.get(p)
        if (!data) throw new Error(`File not found: ${p}`)
        if (opts?.range) {
          const m = opts.range.match(/bytes=(\d+)-(\d*)/)
          if (m) {
            const start = Number(m[1])
            const end = m[2] ? Number(m[2]) + 1 : data.length
            return data.subarray(start, end)
          }
        }
        return data
      },
      readBytesStream: async function* (p: string) {
        const data = fileMap.get(p)
        if (!data) throw new Error(`File not found: ${p}`)
        const chunkSize = 4096
        for (let i = 0; i < data.length; i += chunkSize) yield data.subarray(i, Math.min(i + chunkSize, data.length))
      },
      createDirectories: async () => {},
      deleteFiles: async (paths: string[]) => {
        paths.forEach((p) => fileMap.delete(p))
      },
      writeFiles: async (entries) => {
        for (const entry of entries) {
          if (typeof entry.data === "string") fileMap.set(entry.path, new TextEncoder().encode(entry.data))
          else if (entry.data instanceof Uint8Array) fileMap.set(entry.path, entry.data)
          else if (entry.data instanceof ArrayBuffer) fileMap.set(entry.path, new Uint8Array(entry.data))
          else if (entry.data instanceof Blob) {
            const buf = new Uint8Array(await entry.data.arrayBuffer())
            fileMap.set(entry.path, buf)
          } else if (Symbol.asyncIterator in (entry.data as any)) {
            const chunks: Uint8Array[] = []
            for await (const chunk of entry.data as AsyncIterable<Uint8Array>) chunks.push(chunk)
            fileMap.set(entry.path, Buffer.concat(chunks))
          }
        }
      },
    },
    commands: {
      run: async (cmd: string) => {
        // Simple ls simulation
        if (cmd.includes("ls -1")) {
          const dirMatch = cmd.match(/ls -1 '([^']+)'/)
          if (!dirMatch) return makeExecution([], 1)
          const dir = dirMatch[1]
          const entries = new Set<string>()
          for (const k of fileMap.keys()) {
            if (k.startsWith(dir + "/")) {
              const rest = k.slice(dir.length + 1)
              const name = rest.split("/")[0]
              if (name) entries.add(rest.includes("/") ? name + "/" : name)
            }
          }
          return makeExecution([...entries].sort())
        }
        if (cmd.includes("[ -d ")) {
          const quotedMatch = cmd.match(/\[ -d '([^']+)' \]/)
          if (!quotedMatch) return makeExecution([], 1)
          const dir = quotedMatch[1]
          const isDir = [...fileMap.keys()].some((k) => k.startsWith(dir + "/"))
          if (!isDir) return makeExecution([], 2)
          const entries = new Set<string>()
          for (const k of fileMap.keys()) {
            if (k.startsWith(dir + "/")) {
              const rest = k.slice(dir.length + 1)
              const name = rest.split("/")[0]
              if (name && !rest.includes("/")) entries.add(name)
              else if (name && rest.includes("/")) entries.add(name + "/")
            }
          }
          return makeExecution([...entries].sort())
        }
        return makeExecution([], 1)
      },
    },
  } as unknown as Sandbox
  return sb
}

function makeProvider(sandbox: Sandbox): SandboxProvider.Interface {
  return {
    getOrCreate: () => Effect.succeed(sandbox),
    get: () => Effect.succeed(sandbox),
    destroy: () => Effect.void,
    destroyById: () => Effect.void,
    destroyAll: () => Effect.void,
    cleanupSessionVolume: () => Effect.void,
    keepAlive: () => Effect.void,
    release: () => Effect.void,
    isKeepAlive: () => Effect.succeed(false),
    runInSession: (sessionID: string, command: string) =>
      Effect.tryPromise({
        try: async () => (await sandbox.commands.run(command)) as Execution,
        catch: (e) => new Error(`runInSession failed: ${e}`),
      }),
    runDetached: () => Effect.succeed(makeExecution([], 0)),
    interrupt: () => Effect.void,
    register: () => Effect.void,
    getEndpoint: () => Effect.succeed("http://localhost:0"),
  } as unknown as SandboxProvider.Interface
}

const baseCtx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "call_test",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
  sandbox: Promise.resolve(null) as any,
  sandboxSessionID: undefined as string | undefined,
  extra: {},
}

function makeCtx(sandbox: Sandbox) {
  return { ...baseCtx, sandbox: Promise.resolve(sandbox) }
}

function makeLayers(sandbox: Sandbox) {
  const provider = makeProvider(sandbox)
  return Layer.mergeAll(
    LayerNode.compile(FSUtil.node),
    Layer.succeed(SandboxProvider.Service, provider),
    Layer.succeed(Instruction.Service, { resolve: () => Effect.succeed([]) } as any),
    Layer.succeed(Truncate.Service, {
      output: (text: string) => Effect.succeed({ content: text, truncated: false }),
      limits: () => Effect.succeed({ maxBytes: 50000, maxLines: 2000 }),
    } as any),
    Layer.succeed(Agent.Service, {
      get: () => Effect.succeed({ model: undefined, permission: [], tools: [] } as any),
    } as any),
  )
}

async function execRead(
  sandbox: Sandbox,
  filePath: string,
  opts?: { offset?: number; limit?: number },
) {
  const layers = makeLayers(sandbox)
  const init = await Effect.runPromise(Effect.scoped(ReadTool.pipe(Effect.provide(layers), Effect.provide(testInstanceStoreLayer))))
  const tool = await Effect.runPromise(
    Effect.scoped(
      init
        .init()
        .pipe(Effect.provide(layers), provideInstance("/workspace"), Effect.provide(testInstanceStoreLayer)),
    ),
  )
  const result = await Effect.runPromise(
    Effect.scoped(
      tool
        .execute({ filePath, ...opts }, makeCtx(sandbox))
        .pipe(Effect.provide(layers), provideInstance("/workspace"), Effect.provide(testInstanceStoreLayer)),
    ),
  )
  return result
}

async function execReadError(sandbox: Sandbox, filePath: string, opts?: { offset?: number; limit?: number }) {
  try {
    await execRead(sandbox, filePath, opts)
    throw new Error("expected read to fail")
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e))
  }
}

const text = (s: string) => new TextEncoder().encode(s)

describe("read tool (sandbox mode)", () => {
  test("[fix 1] error message preserved (not 'undefined')", async () => {
    const sb = makeSandbox(new Map())
    const err = await execReadError(sb, "/workspace/nonexistent.txt")
    expect(err.message).toContain("File not found")
    expect(err.message).not.toBe("undefined")
  })

  test("[fix 2] directory detected via getFileInfo, not readBytes", async () => {
    const files = new Map<string, Uint8Array>([
      ["/workspace/dir/file1.txt", text("content1")],
      ["/workspace/dir/file2.txt", text("content2")],
    ])
    const sb = makeSandbox(files)
    const result = await execRead(sb, "/workspace/dir")
    expect(result.output).toContain("<type>directory</type>")
    expect(result.output).toContain("file1.txt")
    expect(result.output).toContain("file2.txt")
    expect(result.metadata.count).toBe(2)
  })

  test("[fix 3] miss suggests similar filenames", async () => {
    const files = new Map<string, Uint8Array>([
      ["/workspace/config.json", text("{}")],
      ["/workspace/config.yaml", text("a: 1")],
    ])
    const sb = makeSandbox(files)
    const err = await execReadError(sb, "/workspace/config.jso")
    expect(err.message).toContain("Did you mean")
    expect(err.message).toContain("config.json")
  })

  test("[fix 3] miss without similar files gives plain not found", async () => {
    const files = new Map<string, Uint8Array>([["/workspace/abc.txt", text("x")]])
    const sb = makeSandbox(files)
    const err = await execReadError(sb, "/workspace/completely-different.txt")
    expect(err.message).toContain("File not found")
    expect(err.message).not.toContain("Did you mean")
  })

  test("[fix 4] directory listing paginates with offset/limit", async () => {
    const files = new Map<string, Uint8Array>()
    for (let i = 0; i < 10; i++) files.set(`/workspace/dir/file${i}.txt`, text(`content${i}`))
    const sb = makeSandbox(files)
    const result = await execRead(sb, "/workspace/dir", { offset: 3, limit: 4 })
    expect(result.output).toContain("file2.txt")
    expect(result.output).toContain("file5.txt")
    expect(result.output).not.toContain("file1.txt")
    expect(result.output).not.toContain("file6.txt")
    expect(result.output).toContain("Showing 4 of 10 entries")
    expect(result.metadata.truncated).toBe(true)
  })

  test("[fix 4] directory listing not truncated when all entries fit", async () => {
    const files = new Map<string, Uint8Array>([
      ["/workspace/dir/a.txt", text("a")],
      ["/workspace/dir/b.txt", text("b")],
    ])
    const sb = makeSandbox(files)
    const result = await execRead(sb, "/workspace/dir")
    expect(result.metadata.truncated).toBe(false)
    expect(result.output).toContain("2 entries")
  })

  test("[fix 5] non-fatal TextDecoder tolerates bad bytes", async () => {
    // File with a bad UTF-8 byte (0xFF) mixed with valid text
    const badContent = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0xff, 0x77, 0x6f, 0x72, 0x6c, 0x64])
    const files = new Map<string, Uint8Array>([["/workspace/bad.txt", badContent]])
    const sb = makeSandbox(files)
    const result = await execRead(sb, "/workspace/bad.txt")
    // Should succeed (not throw TypeError) and contain the valid parts
    expect(result.output).toContain("hello")
    expect(result.output).toContain("world")
  })

  test("[fix 5] null bytes still rejected as binary", async () => {
    const nullContent = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x77, 0x6f, 0x72, 0x6c, 0x64])
    const files = new Map<string, Uint8Array>([["/workspace/null.txt", nullContent]])
    const sb = makeSandbox(files)
    const err = await execReadError(sb, "/workspace/null.txt")
    expect(err.message).toContain("Cannot read binary file")
  })

  test("[fix 6] byte cap shows 'Output capped' message", async () => {
    // Create a file larger than MAX_READ_BYTES (50KB)
    const bigLine = "x".repeat(100) + "\n"
    const bigContent = text(bigLine.repeat(1000)) // ~101KB
    const files = new Map<string, Uint8Array>([["/workspace/big.txt", bigContent]])
    const sb = makeSandbox(files)
    const result = await execRead(sb, "/workspace/big.txt")
    expect(result.output).toContain("Output capped at")
    expect(result.metadata.truncated).toBe(true)
  })

  test("[fix 6] line-count truncation shows 'Showing lines' message", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n")
    const files = new Map<string, Uint8Array>([["/workspace/lines.txt", text(lines)]])
    const sb = makeSandbox(files)
    const result = await execRead(sb, "/workspace/lines.txt", { limit: 10 })
    expect(result.output).toContain("Showing lines 1-10 of 50")
    expect(result.output).toContain("Use offset=11")
  })

  test("[fix 6] non-truncated file shows 'End of file' message", async () => {
    const files = new Map<string, Uint8Array>([["/workspace/small.txt", text("hello\nworld")]])
    const sb = makeSandbox(files)
    const result = await execRead(sb, "/workspace/small.txt")
    expect(result.output).toContain("End of file - total 2 lines")
  })

  test("permission pattern uses directory-relative path", async () => {
    const files = new Map<string, Uint8Array>([["/workspace/test.txt", text("hello")]])
    const sb = makeSandbox(files)
    const askPatterns: string[] = []
    const ctx = {
      ...makeCtx(sb),
      ask: (req: { permission: string; patterns: string[] }) =>
        Effect.sync(() => {
          if (req.permission === "read") askPatterns.push(...req.patterns)
        }),
    }
    const provider = makeProvider(sb)
    const layers = makeLayers(sb)
    const init = await Effect.runPromise(Effect.scoped(ReadTool.pipe(Effect.provide(layers), Effect.provide(testInstanceStoreLayer))))
    const tool = await Effect.runPromise(
      Effect.scoped(
        init.init().pipe(Effect.provide(layers), provideInstance("/workspace"), Effect.provide(testInstanceStoreLayer)),
      ),
    )
    await Effect.runPromise(
      Effect.scoped(
        tool
          .execute({ filePath: "/workspace/test.txt" }, ctx)
          .pipe(Effect.provide(layers), provideInstance("/workspace"), Effect.provide(testInstanceStoreLayer)),
      ),
    )
    expect(askPatterns.length).toBeGreaterThan(0)
    expect(askPatterns[0]).not.toContain("/workspace")
  })

  test("text file reads with line numbers", async () => {
    const files = new Map<string, Uint8Array>([["/workspace/code.ts", text("const a = 1\nconst b = 2\nconst c = 3")]])
    const sb = makeSandbox(files)
    const result = await execRead(sb, "/workspace/code.ts")
    expect(result.output).toContain("1: const a = 1")
    expect(result.output).toContain("2: const b = 2")
    expect(result.output).toContain("3: const c = 3")
  })

  test("offset parameter works", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n")
    const files = new Map<string, Uint8Array>([["/workspace/many.txt", text(lines)]])
    const sb = makeSandbox(files)
    const result = await execRead(sb, "/workspace/many.txt", { offset: 10, limit: 5 })
    expect(result.output).toContain("10: line10")
    expect(result.output).toContain("14: line14")
    expect(result.output).not.toContain("9: line10")
    expect(result.output).not.toContain("15: line15")
  })

  test("PNG classified as image and stored as attachment", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x0a])
    const files = new Map<string, Uint8Array>([["/workspace/img.png", png]])
    const sb = makeSandbox(files)
    const result = await execRead(sb, "/workspace/img.png")
    expect(result.output).toContain("Image read successfully")
    expect(result.attachments).toBeDefined()
    expect(result.attachments?.[0].mime).toBe("image/png")
    expect(result.attachments?.[0].url).toContain("/session/ses_test/attachment/")
  })

  test("binary file rejected", async () => {
    const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00])
    const files = new Map<string, Uint8Array>([["/workspace/program", elf]])
    const sb = makeSandbox(files)
    const err = await execReadError(sb, "/workspace/program")
    expect(err.message).toContain("Cannot read binary file")
  })

  test("empty file reads successfully", async () => {
    const files = new Map<string, Uint8Array>([["/workspace/empty.txt", new Uint8Array()]])
    const sb = makeSandbox(files)
    const result = await execRead(sb, "/workspace/empty.txt")
    expect(result.output).toContain("End of file - total 0 lines")
  })

  test("SVG read as text (not attachment)", async () => {
    const svg = text('<?xml version="1.0"?><svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>')
    const files = new Map<string, Uint8Array>([["/workspace/diagram.svg", svg]])
    const sb = makeSandbox(files)
    const result = await execRead(sb, "/workspace/diagram.svg")
    expect(result.metadata.kind).toBe("svg")
    expect(result.attachments).toBeUndefined()
  })
})
