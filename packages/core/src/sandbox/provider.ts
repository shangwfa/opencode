export * as SandboxProvider from "./provider.js"

import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { SessionTable } from "../session/sql.js"
import { SessionSchema } from "../session/schema.js"
import { SandboxConfig } from "./config.js"
import { SandboxTable } from "./sql.js"
import { Service, rootSessionID, type Interface } from "./contract.js"
import * as OpenSandbox from "./opensandbox/provider.js"

export { Service, rootSessionID } from "./contract.js"
export type { ExecutionResult, RunInput, EndpointResolution, Interface } from "./contract.js"
// Preserve existing public helper imports while the implementation lives with its backend.
export {
  assembleStreamText,
  resolveSessionImage,
  refuseCreate,
  shouldRetryCreate,
  SandboxFilesTimeoutError,
  withSandboxFilesTimeout,
  sandboxFilesRequest,
  remoteSandboxGone,
  withOperationTimeout,
  withSemaphoreWaitTimeout,
  isSandboxGone,
  isCommandSessionGone,
  CommandSessionUnavailable,
  withCommandSessionRecovery,
} from "./opensandbox/provider.js"
export type { CommandSessionRecoveryHooks } from "./opensandbox/provider.js"

const layer = Layer.effect(Service, Effect.gen(function* () {
  const config = SandboxConfig.load()
  const opensandbox = yield* OpenSandbox.make(SandboxConfig.forOpenSandbox(config))
  if (!config.enabled) return opensandbox
  const { db } = yield* Database.Service
  const vercel = config.vercel ? yield* (yield* Effect.promise(() => import("./vercel/provider.js"))).make(config) : undefined
  const aliyun = config.aliyun ? yield* (yield* Effect.promise(() => import("./aliyun/provider.js"))).make(config) : undefined
  const e2b = config.e2b ? yield* (yield* Effect.promise(() => import("./e2b/provider.js"))).make(config) : undefined
  const route = <A, E, R>(sessionID: string, call: (provider: Interface) => Effect.Effect<A, E, R>) => Effect.gen(function* () {
    const root = yield* rootSessionID(sessionID, (id) => db.select({ parentID: SessionTable.parent_id }).from(SessionTable)
      .where(eq(SessionTable.id, SessionSchema.ID.make(id))).get().pipe(Effect.orDie))
    const row = yield* db.select({ provider: SandboxTable.provider }).from(SandboxTable)
      .where(eq(SandboxTable.session_id, root)).get().pipe(Effect.orDie)
    if (row?.provider === "opensandbox" && config.provider !== "opensandbox" && !config.domain) {
      return yield* Effect.die(new Error("Existing OpenSandbox bindings require their original control-plane configuration"))
    }
    const name = row?.provider ?? config.provider
    const selected = name === "vercel" ? vercel : name === "aliyun" ? aliyun : name === "e2b" ? e2b : name === "opensandbox" ? opensandbox : undefined
    if (!selected) return yield* Effect.die(new Error(`${name} credentials for this persisted binding are not configured`))
    return yield* call(selected)
  })
  return {
    enabled: true,
    run: (input) => route(input.sessionID, (p) => p.run(input)),
    interrupt: (id, op) => route(id, (p) => p.interrupt(id, op)),
    boot: (id) => route(id, (p) => p.boot(id)),
    destroy: (id) => route(id, (p) => p.destroy(id)),
    purge: (id) => route(id, (p) => p.purge?.(id) ?? Effect.void),
    keepAlive: (id) => route(id, (p) => p.keepAlive(id)),
    release: (id) => route(id, (p) => p.release(id)),
    activity: (id) => route(id, (p) => p.activity(id)),
    isKeepAlive: (id) => route(id, (p) => p.isKeepAlive(id)),
    sandboxId: (id) => route(id, (p) => p.sandboxId(id)),
    lifecycle: (id) => route(id, (p) => p.lifecycle(id)),
    isReady: (id) => route(id, (p) => p.isReady(id)),
    endpoint: (id, port, proxy) => route(id, (p) => p.endpoint(id, port, proxy)),
    snapshot: (id) => route(id, (p) => p.snapshot(id)),
    latestSnapshot: (id) => route(id, (p) => p.latestSnapshot(id)),
    deleteSnapshots: (id) => route(id, (p) => p.deleteSnapshots(id)),
    snapshotStats: (id) => route(id, (p) => p.snapshotStats(id)),
    fileStat: (id, target) => route(id, (p) => p.fileStat(id, target)),
    fileRead: (id, target) => route(id, (p) => p.fileRead(id, target)),
    fileReadBytes: (id, target, options) => route(id, (p) => p.fileReadBytes(id, target, options)),
    fileWrite: (id, target, data) => route(id, (p) => p.fileWrite(id, target, data)),
    fileDelete: (id, target) => route(id, (p) => p.fileDelete(id, target)),
    fileList: (id, target) => route(id, (p) => p.fileList(id, target)),
    fileFind: (id, target, query) => route(id, (p) => p.fileFind(id, target, query)),
  } satisfies Interface
}))

export const node = makeLocationNode({ service: Service, layer, deps: [Database.node, Bus.node] })
