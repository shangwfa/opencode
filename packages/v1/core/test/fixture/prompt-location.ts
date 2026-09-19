import { Bus } from "@ocv1/core/bus"
import { Image } from "@ocv1/core/image"
import { LocationServiceMap } from "@ocv1/core/location-service-map"
import type { LocationServices } from "@ocv1/core/location-services"
import { Plugin } from "@ocv1/core/plugin"
import { PluginHooks } from "@ocv1/core/plugin/hooks"
import { Skill } from "@ocv1/core/skill"
import type { Location } from "@ocv1/schema/location"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Layer, LayerMap } from "effect"

// Plain-prompt unit fixtures use virtual directories.
export const promptLocationNode = makeGlobalNode({
  service: LocationServiceMap.Service,
  layer: Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      return yield* LayerMap.make(
        (_ref: Location.Ref) =>
          LayerNode.compile(LayerNode.group([PluginHooks.node, Image.node, Skill.node, Plugin.node]), {
            replacements: [
              Bus.node.replace(Layer.succeed(Bus.Service, bus)),
              Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
            ],
          }) as Layer.Layer<LocationServices>,
      )
    }),
  ),
  deps: [Bus.node],
})
