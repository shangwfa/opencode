import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Session } from "@/session/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Session.node, EventV2Bridge.node, SessionProjector.node, CrossSpawnSpawner.node, InstanceStore.node]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
      [InstanceBootstrap.node, Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))],
    ],
  ),
)

const model = {
  id: ModelV2.ID.make("test-model"),
  providerID: ProviderV2.ID.make("test"),
  variant: "default",
}

it.instance("setAgentModel persists agent switch and is immediately readable", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const chat = yield* session.create({})

    expect((yield* session.get(chat.id)).agent).toBeUndefined()

    yield* session.setAgentModel({ sessionID: chat.id, agent: "build", model, time: Date.now() })
    expect((yield* session.get(chat.id)).agent).toBe("build")

    yield* session.setAgentModel({ sessionID: chat.id, agent: "plan", model, time: Date.now() })
    expect((yield* session.get(chat.id)).agent).toBe("plan")

    yield* session.setAgentModel({ sessionID: chat.id, agent: "build", model, time: Date.now() })
    expect((yield* session.get(chat.id)).agent).toBe("build")
  }),
)

it.instance("agent switch survives session reload (durable)", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const chat = yield* session.create({})
    yield* session.setAgentModel({ sessionID: chat.id, agent: "plan", model, time: Date.now() })

    const reloaded = yield* session.get(chat.id)
    expect(reloaded.agent).toBe("plan")
    expect(reloaded.model?.id).toBe("test-model")
  }),
)
