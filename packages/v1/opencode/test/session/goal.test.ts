import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Goal } from "../../src/session/goal"
import { Provider } from "@/provider/provider"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const mockProvider = Layer.mock(Provider.Service, {})
const mockAuth = Layer.mock(Auth.Service, {})
const mockConfig = Layer.mock(Config.Service, {
  get: () => Effect.succeed({ experimental: {} }) as any,
})

const testLayer = Goal.layer.pipe(
  Layer.provide(mockProvider),
  Layer.provide(mockAuth),
  Layer.provide(mockConfig),
)

const it = testEffect(testLayer)

const ses = SessionID.make("ses_goal_test")

describe("Goal state machine", () => {
  it.instance("set then get returns the condition with react=0", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* goal.set(ses, "tests pass")
      const got = yield* goal.get(ses)
      expect(got?.condition).toBe("tests pass")
      expect(got?.react).toBe(0)
    }),
  )

  it.instance("get with no goal returns undefined", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const got = yield* goal.get(ses)
      expect(got).toBeUndefined()
    }),
  )

  it.instance("clear removes the goal", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* goal.set(ses, "build green")
      yield* goal.clear(ses)
      const got = yield* goal.get(ses)
      expect(got).toBeUndefined()
    }),
  )

  it.instance("bumpReact increments and is reflected in get", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* goal.set(ses, "x")
      const first = yield* goal.bumpReact(ses)
      const second = yield* goal.bumpReact(ses)
      const current = yield* goal.get(ses)
      expect(first).toBe(1)
      expect(second).toBe(2)
      expect(current?.react).toBe(2)
    }),
  )

  it.instance("bumpReact with no active goal returns 0", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const n = yield* goal.bumpReact(ses)
      expect(n).toBe(0)
    }),
  )

  it.instance("set resets react back to 0", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* goal.set(ses, "a")
      yield* goal.bumpReact(ses)
      yield* goal.set(ses, "b")
      const got = yield* goal.get(ses)
      expect(got?.condition).toBe("b")
      expect(got?.react).toBe(0)
    }),
  )

  it.instance("multiple sessions have independent goals", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const ses2 = SessionID.make("ses_goal_test_2")
      yield* goal.set(ses, "goal A")
      yield* goal.set(ses2, "goal B")
      const a = yield* goal.get(ses)
      const b = yield* goal.get(ses2)
      expect(a?.condition).toBe("goal A")
      expect(b?.condition).toBe("goal B")
      yield* goal.clear(ses)
      const aAfter = yield* goal.get(ses)
      const bAfter = yield* goal.get(ses2)
      expect(aAfter).toBeUndefined()
      expect(bAfter?.condition).toBe("goal B")
    }),
  )
})
