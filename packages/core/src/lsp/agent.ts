export * as LspAgent from "./agent.js"

import { ChildProcess } from "effect/unstable/process"
import { Context, Duration, Effect, Layer, Schema, Scope } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Environment } from "../environment/index.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { httpClient } from "@opencode/util/effect/app-node-platform"

const DAEMON_PORT = 20877
const HTTP_TIMEOUT = Duration.seconds(30)
const PROBE_TIMEOUT = Duration.seconds(5)
const STARTUP_WAIT_ATTEMPTS = 15

type DaemonState = "starting" | "running" | "error"

const StatusResponseSchema = Schema.Struct({
  servers: Schema.Array(
    Schema.Struct({ id: Schema.String, status: Schema.Literals(["running", "starting", "error"]) }),
  ),
})

export interface Interface {
  readonly touch: (sandboxPath: string) => Effect.Effect<{ version: number }>
  readonly diagnostics: (sandboxPath: string) => Effect.Effect<{ diagnostics: Record<string, unknown[]> }>
  readonly hover: (sandboxPath: string, line: number, character: number) => Effect.Effect<unknown>
  readonly definition: (sandboxPath: string, line: number, character: number) => Effect.Effect<unknown>
  readonly references: (sandboxPath: string, line: number, character: number) => Effect.Effect<unknown>
  readonly implementation: (sandboxPath: string, line: number, character: number) => Effect.Effect<unknown>
  readonly documentSymbol: (sandboxPath: string) => Effect.Effect<unknown>
  readonly workspaceSymbol: (query: string) => Effect.Effect<unknown>
  readonly prepareCallHierarchy: (sandboxPath: string, line: number, character: number) => Effect.Effect<unknown>
  readonly incomingCalls: (sandboxPath: string, line: number, character: number) => Effect.Effect<unknown>
  readonly outgoingCalls: (sandboxPath: string, line: number, character: number) => Effect.Effect<unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LspAgent") {}

const doRequest = (http: HttpClient.HttpClient, url: string, body: unknown) =>
  HttpClientRequest.post(url).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.bodyText(JSON.stringify(body), "application/json"),
    (req) => http.execute(req).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Unknown))),
  )

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const environment = yield* Environment.Service
    const scope = yield* Scope.Scope
    let state: DaemonState | undefined

    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)

    const baseUrl = (): Effect.Effect<string, Error> =>
      environment.endpoint === undefined
        ? Effect.fail(new Error("LSP requires a sandbox environment"))
        : environment.endpoint(DAEMON_PORT)

    const probe = (): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const base = yield* baseUrl().pipe(Effect.orElseSucceed(() => ""))
        if (!base) return false
        const req = HttpClientRequest.get(`${base}/lsp/status`).pipe(HttpClientRequest.acceptJson)
        const result = yield* http.execute(req).pipe(
          Effect.timeout(PROBE_TIMEOUT),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(StatusResponseSchema)),
          Effect.as(true as const),
          Effect.catch(() => Effect.succeed(false as const)),
        )
        return result
      })

    const ensureDaemon = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (state === "running" || state === "starting") return
        state = "starting"

        yield* environment.spawner
          .spawn(
            ChildProcess.make("sh", [
              "-c",
              "nohup node /opt/opencode-lsp-daemon/index.js </dev/null > /tmp/opencode-lsp-daemon.log 2>&1 &",
            ]),
          )
          .pipe(Effect.provideService(Scope.Scope, scope), Effect.forkIn(scope), Effect.orDie)

        const ready = yield* Effect.gen(function* () {
          for (let i = 0; i < STARTUP_WAIT_ATTEMPTS; i++) {
            yield* Effect.sleep(Duration.seconds(1))
            if (yield* probe()) return true
          }
          return false
        })

        state = ready ? "running" : "error"
        if (!ready) yield* Effect.logWarning("LSP daemon failed to start")
      })

    const post = (path: string, body: unknown): Effect.Effect<unknown, Error> =>
      Effect.gen(function* () {
        if (state !== "running") {
          const ok = yield* probe()
          if (!ok) {
            state = "error"
            yield* ensureDaemon()
          }
        }
        yield* ensureDaemon()
        if (state !== "running") return yield* Effect.fail(new Error("LSP daemon is not available"))
        const base = yield* baseUrl()
        return yield* doRequest(http, `${base}${path}`, body).pipe(
          Effect.timeout(HTTP_TIMEOUT),
          Effect.catch((e) => Effect.fail(new Error(`LSP ${path} failed: ${String(e)}`))),
        )
      })

    return Service.of({
      touch: (sandboxPath) =>
        post("/lsp/touch", { path: sandboxPath }).pipe(
          Effect.map((res) => ({ version: (res as any).version ?? 0 })),
          Effect.catch(() => Effect.succeed({ version: 0 })),
        ),
      diagnostics: (sandboxPath) =>
        post("/lsp/diagnostics", { path: sandboxPath }).pipe(
          Effect.map((res) => ({ diagnostics: (res as any).diagnostics ?? {} })),
          Effect.catch(() => Effect.succeed({ diagnostics: {} })),
        ),
      hover: (sandboxPath, line, character) =>
        post("/lsp/hover", { path: sandboxPath, line, character }).pipe(Effect.catch(() => Effect.succeed(null))),
      definition: (sandboxPath, line, character) =>
        post("/lsp/definition", { path: sandboxPath, line, character }).pipe(Effect.catch(() => Effect.succeed(null))),
      references: (sandboxPath, line, character) =>
        post("/lsp/references", { path: sandboxPath, line, character }).pipe(Effect.catch(() => Effect.succeed(null))),
      implementation: (sandboxPath, line, character) =>
        post("/lsp/implementation", { path: sandboxPath, line, character }).pipe(Effect.catch(() => Effect.succeed(null))),
      documentSymbol: (sandboxPath) =>
        post("/lsp/documentSymbol", { path: sandboxPath }).pipe(Effect.catch(() => Effect.succeed(null))),
      workspaceSymbol: (query) =>
        post("/lsp/workspaceSymbol", { query }).pipe(Effect.catch(() => Effect.succeed(null))),
      prepareCallHierarchy: (sandboxPath, line, character) =>
        post("/lsp/prepareCallHierarchy", { path: sandboxPath, line, character }).pipe(Effect.catch(() => Effect.succeed(null))),
      incomingCalls: (sandboxPath, line, character) =>
        post("/lsp/incomingCalls", { path: sandboxPath, line, character }).pipe(Effect.catch(() => Effect.succeed(null))),
      outgoingCalls: (sandboxPath, line, character) =>
        post("/lsp/outgoingCalls", { path: sandboxPath, line, character }).pipe(Effect.catch(() => Effect.succeed(null))),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Environment.node, httpClient] })