import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { buildLocationServiceMap } from "@opencode-ai/core/location-services"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { Location } from "@opencode-ai/core/location"
import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "@/lsp/lsp"
import { Snapshot } from "../snapshot"
import * as Project from "./project"
import * as Vcs from "./vcs"
import { InstanceState } from "@/effect/instance-state"
import { ShareNext } from "@/share/share-next"
import { Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { Service } from "./bootstrap-service"

export { Service } from "./bootstrap-service"
export type { Interface } from "./bootstrap-service"

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Yield each bootstrap dep at layer init so `run` itself has R = never.
    // InstanceStore imports only the lightweight tag from bootstrap-service.ts,
    // so it can depend on bootstrap without importing this implementation graph.
    const config = yield* Config.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const plugin = yield* Plugin.Service
    const project = yield* Project.Service
    const shareNext = yield* ShareNext.Service
    const snapshot = yield* Snapshot.Service
    const vcs = yield* Vcs.Service

    const run = Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      yield* Effect.logInfo("bootstrapping", { directory: ctx.directory })
      // everything depends on config so eager load it for nice traces
      yield* config.get()
      // Plugin can mutate config so it has to be initialized before anything else.
      yield* plugin.init()
      // Each service self-manages its own slow work via Effect.forkScoped against
      // its per-instance state scope. We just await materialization here.
      yield* Effect.forEach(
        [lsp, shareNext, format, vcs, snapshot, project],
        (s) => s.init().pipe(Effect.catchCause((cause) => Effect.logWarning("init failed", { cause }))),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.withSpan("InstanceBootstrap.init"))
    }).pipe(Effect.withSpan("InstanceBootstrap"))

    return Service.of({ run })
  }),
)

const defaultLocationRef = { directory: "/workspace" } as Location.Ref
const locationReplacements: LayerNode.Replacements = [
  [LocationServiceMap.node, makeGlobalNode({ service: LocationServiceMap.Service, layer: buildLocationServiceMap(), deps: [] })],
  [Location.node, Location.boundNode(defaultLocationRef)],
]

export const defaultLayer: Layer.Layer<Service> = (layer.pipe(
  Layer.provide([
    LayerNode.compile(Config.node, locationReplacements),
    LayerNode.compile(Format.node, locationReplacements),
    LayerNode.compile(LSP.node, locationReplacements),
    LayerNode.compile(Plugin.node, locationReplacements),
    Project.defaultLayer,
    LayerNode.compile(ShareNext.node, locationReplacements),
    LayerNode.compile(Snapshot.node, locationReplacements),
    LayerNode.compile(Vcs.node, locationReplacements),
  ]),
) as any)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [Config.node, Format.node, LSP.node, Plugin.node, Project.node, ShareNext.node, Snapshot.node, Vcs.node],
})

export * as InstanceBootstrap from "./bootstrap"
