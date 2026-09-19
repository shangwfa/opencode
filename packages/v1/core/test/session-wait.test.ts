import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@ocv1/core/database/database"
import { AppNodeBuilder } from "@ocv1/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@ocv1/core/bus"
import { Location } from "@ocv1/core/location"
import { Project } from "@ocv1/core/project"
import { AbsolutePath } from "@ocv1/core/schema"
import { Session } from "@ocv1/core/session"
import { SessionProjector } from "@ocv1/core/session/projector"
import { SessionExecution } from "@ocv1/core/session/execution"
import { SessionStore } from "@ocv1/core/session/store"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const awaited: Session.ID[] = []
const execution = Layer.mock(SessionExecution.Service, {
  awaitIdle: (sessionID) => Effect.sync(() => awaited.push(sessionID)),
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node]),
    [Project.node.replace(globalProjectNode), SessionExecution.node.replace(execution)],
  ),
)

describe("Session.wait", () => {
  it.effect("delegates to SessionExecution.awaitIdle", () =>
    Effect.gen(function* () {
      awaited.length = 0
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ location })

      yield* sessions.wait(session.id)

      expect(awaited).toEqual([session.id])
    }),
  )
})
