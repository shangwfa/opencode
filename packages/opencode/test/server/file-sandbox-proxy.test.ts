import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SandboxProvider } from "../../src/tool/sandbox-provider"
import { Instance } from "../../src/project/instance"
import { toSandboxPath } from "../../src/tool/sandbox-path"
import path from "path"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

function mockProvider(runInSessionFn: (sessionID: string, command: string) => Effect.Effect<any, Error>) {
  return Layer.succeed(
    SandboxProvider.Service,
    SandboxProvider.Service.of({
      getOrCreate: () => Effect.succeed({ files: { readFile: () => Promise.resolve("") } } as any),
      get: () => Effect.succeed(null),
      destroy: () => Effect.void,
      destroyAll: () => Effect.void,
      runInSession: runInSessionFn,
      register: () => Effect.void,
      keepAlive: () => Effect.void,
      release: () => Effect.void,
      isKeepAlive: () => Effect.succeed(false),
      getEndpoint: () => Effect.die(new Error("not implemented")),
      cleanupSessionVolume: () => Effect.void,
    }),
  )
}

const it = testEffect(Layer.empty)

describe("file sandbox proxy - list directory", () => {
  it.live("parses ls output into structured entries", () => {
    const provider = mockProvider((_sid: string, command: string) =>
      Effect.gen(function* () {
        if (command.includes("while read")) {
          return {
            logs: {
              stdout: [
                { text: "D src" },
                { text: "F package.json" },
                { text: "D node_modules" },
                { text: "F README.md" },
              ],
              stderr: [],
            },
            exitCode: 0,
          }
        }
        return { logs: { stdout: [], stderr: [] }, exitCode: 0 }
      }),
    )
    return Effect.gen(function* () {
      const sp = yield* SandboxProvider.Service
      const sb = yield* sp.getOrCreate("ses_test")
      const sandboxPath = toSandboxPath("/workspace", "/workspace")
      const lsResult = yield* sp.runInSession(
        "ses_test",
        `ls -1a --color=never "${sandboxPath}" | while read f; do if [ -d "${sandboxPath}/$f" ]; then echo "D $f"; else echo "F $f"; fi; done`,
        { timeoutSeconds: 10 },
      ).pipe(
        Effect.catch(() => Effect.succeed({ logs: { stdout: [], stderr: [] }, exitCode: 1 } as any)),
      )
      const items = lsResult.logs.stdout
        .map((l: { text: string }) => l.text.trim())
        .filter((t: string) => t && !t.startsWith("total "))
        .filter((t: string) => {
          const name = t.substring(2)
          return name !== "." && name !== ".."
        })
        .sort((a: string, b: string) => a.localeCompare(b))
      const result = items.map((entry: string) => {
        const isDir = entry.startsWith("D ")
        const name = entry.substring(2)
        return { name, type: isDir ? "directory" : "file" }
      })
      expect(result.length).toBe(4)
      expect(result.find((d: any) => d.name === "src")?.type).toBe("directory")
      expect(result.find((d: any) => d.name === "package.json")?.type).toBe("file")
    }).pipe(Effect.provide(provider))
  })

  it.live("filters . and .. entries", () => {
    const provider = mockProvider((_sid: string, command: string) =>
      Effect.gen(function* () {
        if (command.includes("while read")) {
          return {
            logs: {
              stdout: [{ text: "D ." }, { text: "D .." }, { text: "F file.txt" }],
              stderr: [],
            },
            exitCode: 0,
          }
        }
        return { logs: { stdout: [], stderr: [] }, exitCode: 0 }
      }),
    )
    return Effect.gen(function* () {
      const sp = yield* SandboxProvider.Service
      const sb = yield* sp.getOrCreate("ses_test")
      const sandboxPath = toSandboxPath("/workspace", "/workspace")
      const lsResult = yield* sp.runInSession(
        "ses_test",
        `ls -1a --color=never "${sandboxPath}" | while read f; do if [ -d "${sandboxPath}/$f" ]; then echo "D $f"; else echo "F $f"; fi; done`,
        { timeoutSeconds: 10 },
      ).pipe(
        Effect.catch(() => Effect.succeed({ logs: { stdout: [], stderr: [] }, exitCode: 1 } as any)),
      )
      const items = lsResult.logs.stdout
        .map((l: { text: string }) => l.text.trim())
        .filter((t: string) => t && !t.startsWith("total "))
        .filter((t: string) => {
          const name = t.substring(2)
          return name !== "." && name !== ".."
        })
      expect(items.length).toBe(1)
      expect(items[0]).toBe("F file.txt")
    }).pipe(Effect.provide(provider))
  })

  it.live("returns empty array on ls failure", () => {
    const failProvider = mockProvider(() => Effect.fail(new Error("sandbox not found")))
    return Effect.gen(function* () {
      const sp = yield* SandboxProvider.Service
      const lsResult = yield* sp.runInSession("ses_test", "ls", { timeoutSeconds: 10 }).pipe(
        Effect.catch(() => Effect.succeed({ logs: { stdout: [], stderr: [] }, exitCode: 1 } as any)),
      )
      const items = lsResult.logs.stdout
        .map((l: { text: string }) => l.text.trim())
        .filter(Boolean)
      expect(items).toEqual([])
    }).pipe(Effect.provide(failProvider))
  })
})

describe("file sandbox proxy - read file", () => {
  it.live("reads file content via sandbox files API", () => {
    const provider = Layer.succeed(
      SandboxProvider.Service,
      SandboxProvider.Service.of({
        getOrCreate: () =>
          Effect.succeed({
            files: { readFile: () => Promise.resolve("hello from sandbox") },
          } as any),
        get: () => Effect.succeed(null),
        destroy: () => Effect.void,
        destroyAll: () => Effect.void,
        runInSession: () => Effect.succeed({ logs: { stdout: [], stderr: [] }, exitCode: 0 }),
        register: () => Effect.void,
        keepAlive: () => Effect.void,
        release: () => Effect.void,
        isKeepAlive: () => Effect.succeed(false),
        getEndpoint: () => Effect.die(new Error("not implemented")),
        cleanupSessionVolume: () => Effect.void,
      }),
    )
    return Effect.gen(function* () {
      const sp = yield* SandboxProvider.Service
      const sb = yield* sp.getOrCreate("ses_test")
      const content = yield* Effect.tryPromise({
        try: () => sb.files.readFile("/workspace/test.txt"),
        catch: () => "",
      })
      expect(content).toBe("hello from sandbox")
    }).pipe(Effect.provide(provider))
  })
})
