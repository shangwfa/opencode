export * as ConnectorNode from "./node.js"

import { Context, Effect, Layer, Schedule, Stream } from "effect"
import { Connector, ConnectorEngine } from "@opencode/connector/adapter"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Bus } from "../bus.js"
import { SessionEvent } from "../session/event.js"
import { ConnectorStore } from "./store.js"
import { ConnectorTriggerStore } from "./trigger-store.js"

const env = (name: string) => {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

const engineLayer = ConnectorEngine.layer({
  enabled: env("OPENCODE_CONNECTOR_ENABLED") === "true",
  dataDir: env("OPENCODE_CONNECTOR_DATA_DIR") ?? "/tmp/opencode-connector",
  publicOrigin: env("OPENCODE_CONNECTOR_PUBLIC_ORIGIN") ?? "http://127.0.0.1/connector",
  encryptionKey: env("OPENCODE_CONNECTOR_ENCRYPTION_KEY") ?? "",
  adminToken: env("OPENCODE_CONNECTOR_ADMIN_TOKEN") ?? "",
  postgres: env("OPENCODE_CONNECTOR_PG_URL")
    ? { connectionString: env("OPENCODE_CONNECTOR_PG_URL")!, poolMax: Number(env("OPENCODE_CONNECTOR_POOL_MAX") ?? 10) }
    : undefined,
})

/** Engine must be its own application node: the MCP passthrough handler resolves it directly. */
export const engineNode = makeGlobalNode({ service: ConnectorEngine.Service, layer: engineLayer, deps: [] })

// TODO(trigger delivery): poll/listener events stay in connector_trigger_event undelivered. Wire
// `deliverEvent` to Session.Service.prompt (its `id` reconciles idempotently) once the payload-to-prompt
// mapping and turn semantics are decided; until then no session input is admitted.
const layer = Connector.layer({
  mcpUrl: env("OPENCODE_CONNECTOR_MCP_URL"),
  mcpName: env("OPENCODE_CONNECTOR_MCP_NAME") ?? "connector",
  webhookUrl: env("OPENCODE_CONNECTOR_WEBHOOK_URL"),
  fileUrlBase: env("OPENCODE_CONNECTOR_FILE_URL_BASE") ?? env("OPENCODE_CONNECTOR_MCP_URL")?.replace(/\/api\/connector\/mcp$/, ""),
})

export const node = makeGlobalNode({ service: Connector.Service, layer, deps: [ConnectorStore.node, ConnectorTriggerStore.node, engineNode] })

/** Emptied on session deletion: engine connections and session-scoped tokens follow their session. */
export class Cleanup extends Context.Service<Cleanup, { readonly done: true }>()("@opencode/ConnectorCleanup") {}

const cleanupLayer = Layer.effect(
  Cleanup,
  Effect.gen(function* () {
    const connector = yield* Connector.Service
    const bus = yield* Bus.Service
    yield* bus
      .subscribe(SessionEvent.Deleted)
      .pipe(
        Stream.runForEach((event) =>
          connector.cleanupSession(event.data.sessionID).pipe(
            Effect.catchCause((cause) => Effect.logWarning("connector session cleanup failed", { sessionID: event.data.sessionID, cause })),
          ),
        ),
        Effect.forkScoped,
      )
    return Cleanup.of({ done: true })
  }),
)

export const cleanupNode = makeGlobalNode({ service: Cleanup, layer: cleanupLayer, deps: [Bus.node, node] })

/**
 * Periodic trigger poller (protocol doc §5 simplified): every pod runs the loop, but a row is only
 * read by the pod whose lease CAS claim won; multi-pod safety is the lease, not leader election.
 */
export class TriggerScheduler extends Context.Service<TriggerScheduler, { readonly started: true }>()(
  "@opencode/ConnectorTriggerScheduler",
) {}

const schedulerLayer = Layer.effect(
  TriggerScheduler,
  Effect.gen(function* () {
    const connector = yield* Connector.Service
    yield* connector
      .pollDueTriggers()
      .pipe(
        Effect.catchCause((cause) => Effect.logWarning("connector trigger scheduler pass failed", { cause })),
        Effect.repeat(Schedule.spaced("60 seconds")),
        Effect.forkScoped,
      )
    return TriggerScheduler.of({ started: true })
  }),
)

export const schedulerNode = makeGlobalNode({ service: TriggerScheduler, layer: schedulerLayer, deps: [node] })
