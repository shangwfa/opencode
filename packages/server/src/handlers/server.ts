import { Bus } from "@opencode/core/bus"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { ServerEvent } from "@opencode/schema/server-event"
import { ServiceUnavailableError } from "@opencode/protocol/errors"
import { Cause, Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { ServerInfo } from "../server-info"

export const ServerHandler = HttpApiBuilder.group(Api, "server.server", (handlers) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const bus = yield* Bus.Service
    return handlers
      .handle("server.info", () =>
        Effect.gen(function* () {
          const info = yield* ServerInfo.Service
          return {
            version: info.app.version ?? "unknown",
            pid: process.pid ?? 0,
            urls: info.urls(),
            paths: info.paths,
          }
        }),
      )
      .handle("server.dispose", () =>
        Effect.gen(function* () {
          yield* LocationServiceMap.dispose().pipe(
            Effect.provideService(LocationServiceMap.Service, locations),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.fail(new ServiceUnavailableError({ message: Cause.pretty(cause), service: "global" })),
            ),
          )
          yield* bus.publish(ServerEvent.Disposed, {}, { global: true })
          return { disposed: true as boolean }
        }),
      )
  }),
)
