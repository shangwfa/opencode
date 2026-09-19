export * as LocalPtyRuntime from "./local-runtime"

import * as InstanceState from "@/effect/instance-state"
import { registerDisposer } from "@/effect/instance-registry"
import { PtyPreparation } from "@/pty-preparation"
import { Pty } from "@opencode-ai/core/pty"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { PtyRuntime } from "@opencode-ai/server/pty-runtime"
import { PtyEnvironment } from "@opencode-ai/server/pty-environment"
import { Effect, Layer, Option } from "effect"

export const layer = Layer.effect(
  PtyRuntime.Service,
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const runPromise = Effect.runPromiseWith(yield* Effect.context())
    const unregister = registerDisposer((directory) =>
      runPromise(locations.invalidate(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
    )
    yield* Effect.addFinalizer(() => Effect.sync(unregister))
    const run = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      const direct = yield* Effect.serviceOption(Pty.Service)
      if (Option.isSome(direct)) return yield* effect.pipe(Effect.provideService(Pty.Service, direct.value))
      return yield* effect.pipe(
        Effect.provide(
          locations.get(Location.Ref.make({ directory: AbsolutePath.make((yield* InstanceState.context).directory) })),
        ),
      )
    })
    const createLegacy: PtyRuntime.Interface["create"] = (_, input) =>
      run(
        Pty.Service.use((service) =>
          PtyPreparation.prepareCreate({
            ...input,
            args: input.args ? [...input.args] : undefined,
            env: input.env ? { ...input.env } : undefined,
          }).pipe(Effect.flatMap(service.create)),
        ),
      ) as ReturnType<PtyRuntime.Interface["create"]>
    return PtyRuntime.Service.of({
      requiresTicket: false,
      requiresSession: false,
      list: () => run(Pty.Service.use((service) => service.list())),
      get: (_, id) => run(Pty.Service.use((service) => service.get(id))),
      create: (_, input) =>
        Effect.gen(function* () {
          const direct = yield* Effect.serviceOption(Pty.Service)
          if (Option.isSome(direct)) {
            const location = yield* Effect.serviceOption(Location.Service)
            const environment = yield* Effect.serviceOption(PtyEnvironment.Service)
            if (Option.isNone(location) || Option.isNone(environment)) return yield* Effect.die("PTY location unavailable")
            const cwd = input.cwd || location.value.directory
            const env = yield* environment.value.get({ directory: location.value.directory, cwd })
            return yield* direct.value.create({ ...input, cwd, env: { ...input.env, ...env } })
          }
          return yield* createLegacy("", input)
        }),
      update: (_, id, input) => run(Pty.Service.use((service) => service.update(id, input))),
      remove: (_, id) => run(Pty.Service.use((service) => service.remove(id))),
      attach: (_, id, input) => run(Pty.Service.use((service) => service.attach(id, input))),
    })
  }),
)
