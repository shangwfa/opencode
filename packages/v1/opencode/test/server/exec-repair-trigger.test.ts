import { beforeAll, afterAll, describe, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Log } from "@opencode-ai/core/util/log"
import { Database } from "../../src/storage/db"
import { SessionTable } from "../../src/session/session.pg"
import { ProjectTable } from "../../src/project/project.pg"
import { SandboxProvider } from "../../src/tool/sandbox-provider"
import { Bus } from "../../src/bus"
import { sandboxProxyRoute } from "../../src/server/sandbox-proxy"
import { ExecFailed } from "../../src/sandbox/exec-failed"
import { GlobalBus } from "../../src/bus/global"
import type { GlobalEvent } from "../../src/bus/global"
import { eq } from "drizzle-orm"

Log.init({ print: false })

const DB_URL = process.env.OPENCODE_DATABASE_URL
if (!DB_URL) {
  console.log("skip: OPENCODE_DATABASE_URL not set (needs PG mode)")
  process.exit(0)
}

// Failed exec result shared by sync/async mocks: non-zero exit + error pattern
const FAILED_RESULT = {
  logs: { stdout: [] as { text: string }[], stderr: [{ text: "Error: boom trigger test" }] },
  exitCode: 1,
}

const failingProvider = Layer.succeed(
  SandboxProvider.Service,
  SandboxProvider.Service.of({
    getOrCreate: () => Effect.succeed({ id: "sb-test", files: {} } as any),
    get: () => Effect.succeed(null),
    destroy: () => Effect.void,
    destroyById: () => Effect.void,
    destroyAll: () => Effect.void,
    runInSession: () => Effect.succeed(FAILED_RESULT as any),
    runDetached: () => Effect.succeed(FAILED_RESULT as any),
    interrupt: () => Effect.void,
    register: () => Effect.void,
    keepAlive: () => Effect.void,
    touch: () => Effect.void,
    release: () => Effect.void,
    isKeepAlive: () => Effect.succeed(false),
    isSnapshotSession: () => Effect.succeed(false),
    getEndpoint: () => Effect.die(new Error("not implemented")),
    cleanupSessionVolume: () => Effect.void,
  }),
)

// The route yields Bus.Service but never calls it on the exec paths.
const busMock = Layer.mock(Bus.Service, {} as any)

const handler = HttpRouter.toWebHandler(
  sandboxProxyRoute.pipe(Layer.provide(failingProvider), Layer.provide(busMock)),
  { disableLogger: true },
).handler

// The route mounts a websocket-capable proxy, so the web handler needs a
// WebSocketConstructor in context even though the exec tests never upgrade.
import * as Socket from "effect/unstable/socket/Socket"

function request(path: string, body: unknown) {
  return Effect.promise(() =>
    Promise.resolve(
      handler(
        new Request(new URL(path, "http://localhost"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        Context.make(Socket.WebSocketConstructor, WebSocket as any),
      ),
    ),
  )
}

const isExecFailedEvent = (event: GlobalEvent) => event.payload?.type === ExecFailed.EVENT_TYPE

// Returns a Promise resolving to the first exec.failed event within the window, or null on timeout.
function eventFired(windowMs: number) {
  return new Promise<GlobalEvent | null>((resolve) => {
    const timer = setTimeout(() => {
      GlobalBus.off("event", onEvent)
      resolve(null)
    }, windowMs)
    const onEvent = (event: GlobalEvent) => {
      if (!isExecFailedEvent(event)) return
      clearTimeout(timer)
      GlobalBus.off("event", onEvent)
      resolve(event)
    }
    GlobalBus.on("event", onEvent)
  })
}

const SID = "ses_exec_repair_trigger_test" as any
const PROJECT_ID = "prj_exec_repair_trigger_test" as any

beforeAll(async () => {
  await Database.initialize()
  const db = Database.Client()
  await db
    .insert(ProjectTable)
    .values({
      id: PROJECT_ID,
      worktree: "/tmp/exec-repair-trigger-test",
      sandboxes: [],
      time_created: Date.now(),
      time_updated: Date.now(),
    })
    .onConflictDoNothing()
    .run()
  await db
    .insert(SessionTable)
    .values({
      id: SID,
      project_id: PROJECT_ID,
      slug: "exec-repair-trigger",
      directory: "/tmp/exec-repair-trigger-test",
      title: "exec-repair-trigger-test",
      version: "test",
      time_created: Date.now(),
      time_updated: Date.now(),
    })
    .onConflictDoUpdate({ target: SessionTable.id, set: { title: "exec-repair-trigger-test" } })
    .run()
})

afterAll(async () => {
  const db = Database.Client()
  await db.delete(SessionTable).where(eq(SessionTable.id, SID)).run().catch(() => {})
  await db.delete(ProjectTable).where(eq(ProjectTable.id, PROJECT_ID)).run().catch(() => {})
})

describe("exec repair trigger routing (sync/async + repairOnFailure)", () => {
  test("sync exec failure does NOT publish exec.failed", async () => {
    const watcher = eventFired(1500)
    const res = (await Effect.runPromise(request(`/session/${SID}/exec`, { command: "node -e boom" }))) as any
    const body = await res.json()
    expect(body.exitCode).toBe(1)
    expect(await watcher).toBeNull()
  })

  test("async exec failure without repairOnFailure does NOT publish exec.failed", async () => {
    const watcher = eventFired(1500)
    const res = (await Effect.runPromise(request(`/session/${SID}/exec/async`, { command: "node -e boom" }))) as any
    const body = await res.json()
    expect(body.execId).toBeDefined()
    expect(await watcher).toBeNull()
  })

  test("async exec failure WITH repairOnFailure publishes exec.failed", async () => {
    const watcher = eventFired(10_000)
    const res = (await Effect.runPromise(
      request(`/session/${SID}/exec/async`, { command: "node -e boom", repairOnFailure: true }),
    )) as any
    const body = await res.json()
    expect(body.execId).toBeDefined()
    const event = await watcher
    expect(event).not.toBeNull()
    const props = (event as any).payload.properties
    expect(props.command).toBe("node -e boom")
    expect(props.exitCode).toBe(1)
    expect(props.errorSummary).toContain("boom trigger test")
  })
})
