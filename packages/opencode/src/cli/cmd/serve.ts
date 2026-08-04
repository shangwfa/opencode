import { Effect, Duration } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs: any) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    const { Scheduler } = yield* Effect.promise(() => import("@/scheduler"))
    const scheduler = yield* Scheduler.Service
    scheduler.register("task", (taskId, payload) =>
      Effect.gen(function* () {
        const p = (payload ?? {}) as { prompt?: string }
        const base = `http://127.0.0.1:${server.port}`
        const sessionResponse = yield* Effect.tryPromise({
          try: async () => {
            const response = await fetch(`${base}/session`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ taskId, title: `Scheduled: ${taskId}` }),
            })
            if (!response.ok) throw new Error(`Failed to create session: ${response.status}`)
            return response.json() as Promise<unknown>
          },
          catch: () => new Error("Failed to create session"),
        })
        if (
          typeof sessionResponse !== "object" ||
          sessionResponse === null ||
          !("id" in sessionResponse) ||
          typeof sessionResponse.id !== "string"
        ) {
          return yield* Effect.fail(new Error("Session response did not include an id"))
        }
        yield* Effect.tryPromise({
          try: async () => {
            const response = await fetch(`${base}/session/${sessionResponse.id}/message`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                parts: [{ type: "text", text: p.prompt ?? "Execute scheduled task" }],
              }),
            })
            if (!response.ok) throw new Error(`Failed to send message: ${response.status}`)
          },
          catch: () => new Error("Failed to send message"),
        })
      }),
    )
    while (true) {
      yield* scheduler
        .tick()
        .pipe(Effect.catchCause((cause) => Effect.logError("scheduler tick failed", { cause: String(cause) })))
      yield* Effect.sleep(Duration.seconds(30))
    }
  }),
} as any)
