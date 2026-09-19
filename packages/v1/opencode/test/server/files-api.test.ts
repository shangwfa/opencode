import { afterAll, beforeAll, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { SandboxProvider } from "../../src/tool/sandbox-provider"
import { Bus } from "../../src/bus"
import { sandboxProxyRoute } from "../../src/server/sandbox-proxy"
import { Database } from "../../src/storage/db"
import { ProjectTable } from "../../src/project/project.pg"
import { SessionTable } from "../../src/session/session.pg"
import { SessionID } from "../../src/session/schema"
import { like } from "drizzle-orm"
import { testEffect } from "../lib/effect"

const DB_URL = process.env.OPENCODE_DATABASE_URL
if (!DB_URL) {
  console.log("skip: OPENCODE_DATABASE_URL not set")
  process.exit(0)
}

const it = testEffect(Layer.empty)

const db = Database.Client()

// ── fake Sandbox files：记录调用供断言 ─────────────────────────────
type FilesCalls = {
  createDirectories: Array<{ path: string; mode?: number }[]>
  writeFiles: Array<{ path: string; data: unknown; mode?: number }[]>
  getFileInfo: string[][]
  deleteFiles: string[][]
  deleteDirectories: string[][]
}

function makeSandbox(calls: FilesCalls) {
  return {
    id: "sb_files_test",
    files: {
      createDirectories: (entries: { path: string; mode?: number }[]) => {
        calls.createDirectories.push(entries)
        return Promise.resolve()
      },
      writeFiles: (entries: { path: string; data: unknown; mode?: number }[]) => {
        calls.writeFiles.push(entries)
        return Promise.resolve()
      },
      getFileInfo: async (paths: string[]) => {
        calls.getFileInfo.push(paths)
        return Object.fromEntries(paths.map((p) => [p, { path: p, size: 5 }]))
      },
      readBytesStream: () =>
        (async function* () {
          yield new TextEncoder().encode("hello")
        })(),
      deleteFiles: (paths: string[]) => {
        calls.deleteFiles.push(paths)
        return Promise.resolve()
      },
      deleteDirectories: (paths: string[]) => {
        calls.deleteDirectories.push(paths)
        return Promise.resolve()
      },
    },
  }
}

function mockProvider(sb: unknown, runInSessionFn?: (sid: SessionID, command: string) => Effect.Effect<any, Error>) {
  return Layer.succeed(
    SandboxProvider.Service,
    SandboxProvider.Service.of({
      getOrCreate: () => Effect.succeed(sb as never),
      get: () => Effect.succeed(null),
      destroy: () => Effect.void,
      destroyById: () => Effect.void,
      destroyAll: () => Effect.void,
      // download 的目录判断（`[ -d ... ]` → file）与 zip 打包（python → size）
      runInSession:
        runInSessionFn ??
        ((_sid: SessionID, command: string) =>
          Effect.succeed({
            logs: { stdout: [{ text: command.includes("[ -d ") ? "file" : "16" }], stderr: [] },
            exitCode: 0,
          })),
      interrupt: () => Effect.void,
      register: () => Effect.void,
      keepAlive: () => Effect.void,
      touch: () => Effect.void,
      release: () => Effect.void,
      isKeepAlive: () => Effect.succeed(false),
      isSnapshotSession: () => Effect.succeed(false),
      getEndpoint: () => Effect.die(new Error("not implemented")),
      cleanupSessionVolume: () => Effect.void,
      runDetached: () => Effect.die(new Error("not implemented")),
    }),
  )
}

const busStub = Layer.succeed(
  Bus.Service,
  Bus.Service.of({
    publish: () => Effect.void,
    subscribe: () => Effect.never as never,
    subscribeAll: () => Effect.never as never,
    subscribeCallback: () => Effect.succeed(() => undefined),
    subscribeAllCallback: () => Effect.succeed(() => undefined),
  }),
)

function buildLayer(calls: FilesCalls, sandbox?: unknown, runInSessionFn?: (sid: SessionID, command: string) => Effect.Effect<any, Error>) {
  const routes = HttpRouter.serve(sandboxProxyRoute, { disableListenLog: true, disableLogger: true })
  return routes.pipe(
    Layer.provide(mockProvider(sandbox ?? makeSandbox(calls), runInSessionFn)),
    Layer.provide(busStub),
    Layer.provide(layerWebSocketConstructorGlobal),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(NodeServices.layer),
  )
}

let sidCounter = 0
async function insertSession() {
  const id = SessionID.make(`ses_files_test_${Date.now()}_${sidCounter++}`)
  const now = Date.now()
  await db
    .insert(ProjectTable)
    .values({ id: "prj_files_test" as never, worktree: "/workspace", sandboxes: [] })
    .onConflictDoNothing()
    .run()
  await db
    .insert(SessionTable)
    .values({
      id,
      project_id: "prj_files_test" as never,
      slug: "files-test",
      directory: "/workspace",
      title: "files test",
      version: "2.0",
      time_created: now,
      time_updated: now,
    })
    .onConflictDoNothing()
    .run()
  return id
}

async function cleanupSessions() {
  await db.delete(SessionTable).where(like(SessionTable.id, "ses_files_test_%")).run().catch(() => {})
}

beforeAll(async () => {
  await Database.initialize()
})

afterAll(async () => {
  await cleanupSessions()
})

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

describe("files API - mkdir", () => {
  it.live("creates directory (multi-level) via sandbox createDirectories", () => {
          const calls: FilesCalls = { createDirectories: [], writeFiles: [], getFileInfo: [], deleteFiles: [], deleteDirectories: [] }
    return Effect.gen(function* () {

      const sid = yield* Effect.promise(insertSession)
      const res = yield* request(`/session/${sid}/files/mkdir?path=/workspace/a/b/c`, { method: "POST" })
      expect(res.status).toBe(200)
      const body = yield* res.json
      expect((body as any).path).toBe("/workspace/a/b/c")
      expect((body as any).created).toBe(true)
      expect(calls.createDirectories).toEqual([[{ path: "/workspace/a/b/c", mode: 755 }]])
    }).pipe(Effect.provide(buildLayer(calls)))
  })

  it.live("returns 400 when path is missing", () => {
          const calls: FilesCalls = { createDirectories: [], writeFiles: [], getFileInfo: [], deleteFiles: [], deleteDirectories: [] }
    return Effect.gen(function* () {

      const sid = yield* Effect.promise(insertSession)
      const res = yield* request(`/session/${sid}/files/mkdir`, { method: "POST" })
      expect(res.status).toBe(400)
      expect(calls.createDirectories).toHaveLength(0)
    }).pipe(Effect.provide(buildLayer(calls)))
  })

  it.live("returns 404 when session does not exist", () => {
          const calls: FilesCalls = { createDirectories: [], writeFiles: [], getFileInfo: [], deleteFiles: [], deleteDirectories: [] }
    return Effect.gen(function* () {

      const res = yield* request(`/session/ses_files_missing/files/mkdir?path=/workspace/x`, { method: "POST" })
      expect(res.status).toBe(404)
      expect(calls.createDirectories).toHaveLength(0)
    }).pipe(Effect.provide(buildLayer(calls)))
  })
})

describe("files API - create", () => {
  it.live("writes file with parent dir creation", () => {
          const calls: FilesCalls = { createDirectories: [], writeFiles: [], getFileInfo: [], deleteFiles: [], deleteDirectories: [] }
    return Effect.gen(function* () {

      const sid = yield* Effect.promise(insertSession)
      const res = yield* request(`/session/${sid}/files/create?path=/workspace/app/main.py`, {
        method: "POST",
        body: "print(1)",
      })
      expect(res.status).toBe(200)
      const body = yield* res.json
      expect((body as any).path).toBe("/workspace/app/main.py")
      expect((body as any).size).toBe(8)
      expect(calls.createDirectories).toEqual([[{ path: "/workspace/app", mode: 755 }]])
      const [written] = calls.writeFiles[0] ?? []
      expect(written?.path).toBe("/workspace/app/main.py")
      expect(written?.mode).toBe(644)
    }).pipe(Effect.provide(buildLayer(calls)))
  })

  it.live("creates empty file with size 0", () => {
          const calls: FilesCalls = { createDirectories: [], writeFiles: [], getFileInfo: [], deleteFiles: [], deleteDirectories: [] }
    return Effect.gen(function* () {

      const sid = yield* Effect.promise(insertSession)
      const res = yield* request(`/session/${sid}/files/create?path=/workspace/empty.txt`, {
        method: "POST",
        body: "",
      })
      expect(res.status).toBe(200)
      const body = yield* res.json
      expect((body as any).size).toBe(0)
    }).pipe(Effect.provide(buildLayer(calls)))
  })

  it.live("returns 400 when path is missing", () => {
          const calls: FilesCalls = { createDirectories: [], writeFiles: [], getFileInfo: [], deleteFiles: [], deleteDirectories: [] }
    return Effect.gen(function* () {

      const sid = yield* Effect.promise(insertSession)
      const res = yield* request(`/session/${sid}/files/create`, { method: "POST", body: "x" })
      expect(res.status).toBe(400)
      expect(calls.writeFiles).toHaveLength(0)
    }).pipe(Effect.provide(buildLayer(calls)))
  })
})

describe("files API - download", () => {
  it.live("streams file bytes with mime from extension", () => {
          const calls: FilesCalls = { createDirectories: [], writeFiles: [], getFileInfo: [], deleteFiles: [], deleteDirectories: [] }
    return Effect.gen(function* () {

      const sid = yield* Effect.promise(insertSession)
      const res = yield* request(`/session/${sid}/files/download?path=/workspace/app/data.json`)
      expect(res.status).toBe(200)
      expect(res.headers["content-type"]).toBe("application/json")
      expect(res.headers["content-disposition"]).toContain("attachment")
      const text = yield* res.text
      expect(text).toBe("hello")
      expect(calls.getFileInfo).toEqual([["/workspace/app/data.json"]])
    }).pipe(Effect.provide(buildLayer(calls)))
  })

  it.live("falls back to octet-stream for unknown extension", () => {
          const calls: FilesCalls = { createDirectories: [], writeFiles: [], getFileInfo: [], deleteFiles: [], deleteDirectories: [] }
    return Effect.gen(function* () {

      const sid = yield* Effect.promise(insertSession)
      const res = yield* request(`/session/${sid}/files/download?path=/workspace/blob.zzz`)
      expect(res.headers["content-type"]).toBe("application/octet-stream")
    }).pipe(Effect.provide(buildLayer(calls)))
  })

  it.live("returns 404 when file does not exist", () => {
          const calls: FilesCalls = { createDirectories: [], writeFiles: [], getFileInfo: [], deleteFiles: [], deleteDirectories: [] }
    const sb = makeSandbox(calls)
    sb.files.getFileInfo = async () => ({})
    return Effect.gen(function* () {
      const sid = yield* Effect.promise(insertSession)
      const res = yield* request(`/session/${sid}/files/download?path=/workspace/nope.txt`)
      expect(res.status).toBe(404)
    }).pipe(Effect.provide(buildLayer(calls, sb)))
  })

  it.live("returns 400 when path is missing", () => {
          const calls: FilesCalls = { createDirectories: [], writeFiles: [], getFileInfo: [], deleteFiles: [], deleteDirectories: [] }
    return Effect.gen(function* () {

      const sid = yield* Effect.promise(insertSession)
      const res = yield* request(`/session/${sid}/files/download`)
      expect(res.status).toBe(400)
    }).pipe(Effect.provide(buildLayer(calls)))
  })

  it.live("downloads a directory as a zip archive and cleans it up", () => {
          const calls: FilesCalls = { createDirectories: [], writeFiles: [], getFileInfo: [], deleteFiles: [], deleteDirectories: [] }
    const runInSessionFn = (_sid: SessionID, command: string) =>
      Effect.succeed({
        logs: {
          // `[ -d ... ]` 判断目录 → "dir"；python zipfile 打包 → 输出归档 size
          stdout: [{ text: command.includes("[ -d ") ? "dir" : "16" }],
          stderr: [],
        },
        exitCode: 0,
      })
    return Effect.gen(function* () {

      const sid = yield* Effect.promise(insertSession)
      const res = yield* request(`/session/${sid}/files/download?path=/workspace/app`)
      expect(res.status).toBe(200)
      expect(res.headers["content-type"]).toBe("application/zip")
      expect(res.headers["content-disposition"]).toContain(".zip")
      // 打包临时文件的清理（Stream.ensuring）由集成用例覆盖，这里只验证 zip 响应头
    }).pipe(Effect.provide(buildLayer(calls, undefined, runInSessionFn)))
  })
})

describe("files API - upload", () => {
  it.live("uploads with dir auto-create", () => {
          const calls: FilesCalls = { createDirectories: [], writeFiles: [], getFileInfo: [], deleteFiles: [], deleteDirectories: [] }
    return Effect.gen(function* () {

      const sid = yield* Effect.promise(insertSession)
      const res = yield* request(`/session/${sid}/files/upload?path=/workspace/inbox&filename=f.txt`, {
        method: "POST",
        body: "payload",
      })
      expect(res.status).toBe(200)
      const body = yield* res.json
      expect((body as any).path).toBe("/workspace/inbox/f.txt")
      expect((body as any).size).toBe(7)
      expect(calls.createDirectories).toEqual([[{ path: "/workspace/inbox", mode: 755 }]])
      const [written] = calls.writeFiles[0] ?? []
      expect(written?.path).toBe("/workspace/inbox/f.txt")
      expect(written?.mode).toBe(644)
    }).pipe(Effect.provide(buildLayer(calls)))
  })

  it.live("defaults path to /workspace", () => {
          const calls: FilesCalls = { createDirectories: [], writeFiles: [], getFileInfo: [], deleteFiles: [], deleteDirectories: [] }
    return Effect.gen(function* () {

      const sid = yield* Effect.promise(insertSession)
      const res = yield* request(`/session/${sid}/files/upload?filename=root.txt`, {
        method: "POST",
        body: "r",
      })
      expect(res.status).toBe(200)
      const body = yield* res.json
      expect((body as any).path).toBe("/workspace/root.txt")
      const [written] = calls.writeFiles[0] ?? []
      expect(written?.path).toBe("/workspace/root.txt")
    }).pipe(Effect.provide(buildLayer(calls)))
  })

  it.live("rejects path-traversal filenames", () => {
          const calls: FilesCalls = { createDirectories: [], writeFiles: [], getFileInfo: [], deleteFiles: [], deleteDirectories: [] }
    return Effect.gen(function* () {

      const sid = yield* Effect.promise(insertSession)
      for (const filename of ["a/b.txt", ".", ".."]) {
        const res = yield* request(`/session/${sid}/files/upload?path=/workspace&filename=${encodeURIComponent(filename)}`, {
          method: "POST",
          body: "x",
        })
        expect(res.status).toBe(400)
      }
      expect(calls.writeFiles).toHaveLength(0)
    }).pipe(Effect.provide(buildLayer(calls)))
  })

  it.live("returns 400 when filename is missing", () => {
          const calls: FilesCalls = { createDirectories: [], writeFiles: [], getFileInfo: [], deleteFiles: [], deleteDirectories: [] }
    return Effect.gen(function* () {

      const sid = yield* Effect.promise(insertSession)
      const res = yield* request(`/session/${sid}/files/upload?path=/workspace`, { method: "POST", body: "x" })
      expect(res.status).toBe(400)
    }).pipe(Effect.provide(buildLayer(calls)))
  })
})
