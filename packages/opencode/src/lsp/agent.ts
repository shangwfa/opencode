/**
 * LSP Agent — main-process adapter for the sandbox LSP daemon.
 *
 * Manages communication with an HTTP daemon running inside sandbox containers.
 * The daemon manages LSP server processes locally inside the container (where
 * they have direct filesystem access) and exposes a JSON-over-HTTP API. This
 * module is the main-process side that starts the daemon and proxies requests.
 */

import { Context, Duration, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { SandboxProvider } from "@/tool/sandbox-provider"
import { toSandboxPath } from "@/tool/sandbox-path"
import type { SessionID } from "@/session/schema"

const DAEMON_PORT = 20877
const HTTP_TIMEOUT = Duration.seconds(30)
const PROBE_TIMEOUT = Duration.seconds(5)
const STARTUP_WAIT_ATTEMPTS = 15

type DaemonState = "starting" | "running" | "error"

const BodySchema = Schema.Struct({ path: Schema.String })

export interface Diagnostic {
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  severity?: number
  code?: string | number
  source?: string
  message: string
}

export interface HoverContent {
  language?: string
  value: string
}

export interface Location {
  uri: string
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
}

export interface TouchResponse {
  version: number
}

export interface DiagnosticsResponse {
  diagnostics: Record<string, Diagnostic[]>
}

export interface HoverResponse {
  contents: HoverContent[] | null
}

export interface LocationResponse {
  locations: Location[]
}

export interface DocumentSymbol {
  name: string
  detail?: string
  kind: number
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  selectionRange: { start: { line: number; character: number }; end: { line: number; character: number } }
  children?: DocumentSymbol[]
}

export interface WorkspaceSymbol {
  name: string
  kind: number
  location: {
    uri: string
    range: { start: { line: number; character: number }; end: { line: number; character: number } }
  }
}

export interface DocumentSymbolResponse {
  symbols: DocumentSymbol[]
}

export interface WorkspaceSymbolResponse {
  symbols: WorkspaceSymbol[]
}

export interface CallHierarchyItem {
  name: string
  kind: number
  detail?: string
  uri: string
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  selectionRange: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
}

export interface CallHierarchyIncomingCall {
  from: CallHierarchyItem
  fromRanges: Array<{
    start: { line: number; character: number }
    end: { line: number; character: number }
  }>
}

export interface CallHierarchyOutgoingCall {
  to: CallHierarchyItem
  fromRanges: Array<{
    start: { line: number; character: number }
    end: { line: number; character: number }
  }>
}

export interface PrepareCallHierarchyResponse {
  items: CallHierarchyItem[]
}

export interface IncomingCallsResponse {
  calls: CallHierarchyIncomingCall[]
}

export interface OutgoingCallsResponse {
  calls: CallHierarchyOutgoingCall[]
}

export interface StatusResponse {
  servers: ReadonlyArray<{ readonly id: string; readonly status: "running" | "starting" | "error" }>
}

const DiagnosticsResponseSchema = Schema.Struct({
  diagnostics: Schema.Record(Schema.String, Schema.Array(Schema.Unknown)),
})

const StatusResponseSchema = Schema.Struct({
  servers: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.Literals(["running", "starting", "error"]),
    }),
  ),
})

const TouchResponseSchema = Schema.Struct({
  version: Schema.Number,
})

const PositionBodySchema = Schema.Struct({
  path: Schema.String,
  line: Schema.Number,
  character: Schema.Number,
})

const HoverResponseSchema = Schema.Struct({
  contents: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        language: Schema.optional(Schema.String),
        value: Schema.String,
      }),
    ),
  ),
})

const LocationSchema = Schema.Struct({
  uri: Schema.String,
  range: Schema.Struct({
    start: Schema.Struct({ line: Schema.Number, character: Schema.Number }),
    end: Schema.Struct({ line: Schema.Number, character: Schema.Number }),
  }),
})

const LocationResponseSchema = Schema.Struct({
  locations: Schema.Array(LocationSchema),
})

const DocumentSymbolResponseSchema = Schema.Struct({
  symbols: Schema.Array(Schema.Unknown),
})

const WorkspaceSymbolBodySchema = Schema.Struct({
  query: Schema.String,
})

const WorkspaceSymbolResponseSchema = Schema.Struct({
  symbols: Schema.Array(Schema.Unknown),
})

const PrepareCallHierarchyResponseSchema = Schema.Struct({
  items: Schema.Array(Schema.Unknown),
})

const IncomingCallsResponseSchema = Schema.Struct({
  calls: Schema.Array(Schema.Unknown),
})

const OutgoingCallsResponseSchema = Schema.Struct({
  calls: Schema.Array(Schema.Unknown),
})

export interface Interface {
  readonly touch: (
    sessionID: SessionID,
    hostPath: string,
    hostWorkdir: string,
  ) => Effect.Effect<TouchResponse, Error>

  readonly diagnostics: (
    sessionID: SessionID,
    hostPath: string,
    hostWorkdir: string,
  ) => Effect.Effect<DiagnosticsResponse, Error>

  readonly status: (
    sessionID: SessionID,
  ) => Effect.Effect<StatusResponse, Error>

  readonly shutdown: (
    sessionID: SessionID,
  ) => Effect.Effect<void, Error>

  readonly hover: (
    sessionID: SessionID,
    hostPath: string,
    hostWorkdir: string,
    line: number,
    character: number,
  ) => Effect.Effect<HoverResponse, Error>

  readonly definition: (
    sessionID: SessionID,
    hostPath: string,
    hostWorkdir: string,
    line: number,
    character: number,
  ) => Effect.Effect<LocationResponse, Error>

  readonly references: (
    sessionID: SessionID,
    hostPath: string,
    hostWorkdir: string,
    line: number,
    character: number,
  ) => Effect.Effect<LocationResponse, Error>

  readonly implementation: (
    sessionID: SessionID,
    hostPath: string,
    hostWorkdir: string,
    line: number,
    character: number,
  ) => Effect.Effect<LocationResponse, Error>

  readonly documentSymbol: (
    sessionID: SessionID,
    hostPath: string,
    hostWorkdir: string,
  ) => Effect.Effect<DocumentSymbolResponse, Error>

  readonly workspaceSymbol: (
    sessionID: SessionID,
    query: string,
  ) => Effect.Effect<WorkspaceSymbolResponse, Error>

  readonly prepareCallHierarchy: (
    sessionID: SessionID,
    hostPath: string,
    hostWorkdir: string,
    line: number,
    character: number,
  ) => Effect.Effect<PrepareCallHierarchyResponse, Error>

  readonly incomingCalls: (
    sessionID: SessionID,
    hostPath: string,
    hostWorkdir: string,
    line: number,
    character: number,
  ) => Effect.Effect<IncomingCallsResponse, Error>

  readonly outgoingCalls: (
    sessionID: SessionID,
    hostPath: string,
    hostWorkdir: string,
    line: number,
    character: number,
  ) => Effect.Effect<OutgoingCallsResponse, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LspAgent") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sandbox = yield* SandboxProvider.Service
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const daemonStates = new Map<SessionID, DaemonState>()

    const probe = Effect.fn("LspAgent.probe")(function* (sessionID: SessionID) {
      const base = yield* sandbox.getEndpoint(sessionID, DAEMON_PORT).pipe(
        Effect.orElseSucceed(() => ""),
      )
      if (!base) return false
      const req = HttpClientRequest.get(`${base}/lsp/status`).pipe(
        HttpClientRequest.acceptJson,
      )
      return yield* http.execute(req).pipe(
        Effect.timeout(PROBE_TIMEOUT),
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      )
    })

    const ensureDaemon = Effect.fn("LspAgent.ensureDaemon")(function* (sessionID: SessionID) {
      const state = daemonStates.get(sessionID)
      if (state === "running" || state === "starting") return

      daemonStates.set(sessionID, "starting")

      yield* sandbox.runDetached(sessionID, "opencode-lsp-agent", {
        workingDirectory: "/workspace",
      })

      const ready = yield* Effect.gen(function* () {
        for (let i = 0; i < STARTUP_WAIT_ATTEMPTS; i++) {
          yield* Effect.sleep(Duration.seconds(1))
          if (yield* probe(sessionID)) return true
        }
        return false
      })

      if (ready) {
        daemonStates.set(sessionID, "running")
        yield* Effect.logDebug("LSP daemon ready", { sessionID })
      } else {
        daemonStates.set(sessionID, "error")
        yield* Effect.logWarning("LSP daemon failed to start", { sessionID })
      }
    })

    const getBaseUrl = Effect.fn("LspAgent.getBaseUrl")(function* (sessionID: SessionID) {
      const state = daemonStates.get(sessionID)
      if (state === "running") {
        const ok = yield* probe(sessionID)
        if (!ok) {
          daemonStates.set(sessionID, "error")
          yield* Effect.logWarning("LSP daemon unresponsive, restarting", { sessionID })
        }
      }

      yield* ensureDaemon(sessionID)

      const finalState = daemonStates.get(sessionID)
      if (finalState !== "running") {
        return yield* Effect.fail(new Error("LSP daemon is not available"))
      }

      return yield* sandbox.getEndpoint(sessionID, DAEMON_PORT)
    })

    const touch = Effect.fn("LspAgent.touch")(function* (
      sessionID: SessionID,
      hostPath: string,
      hostWorkdir: string,
    ) {
      const base = yield* getBaseUrl(sessionID)
      const sandboxPath = toSandboxPath(hostPath, hostWorkdir)
      const req = yield* HttpClientRequest.post(`${base}/lsp/touch`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.schemaBodyJson(BodySchema)({ path: sandboxPath }),
      )
      const response = yield* http.execute(req).pipe(
        Effect.timeout(HTTP_TIMEOUT),
        Effect.catch((e) =>
          Effect.fail(new Error(`LSP agent touch failed: ${String(e)}`)),
        ),
      )
      return yield* HttpClientResponse.schemaBodyJson(TouchResponseSchema)(response).pipe(
        Effect.catch((e) =>
          Effect.fail(new Error(`LSP agent touch decode failed: ${String(e)}`)),
        ),
      )
    })

    const diagnostics = Effect.fn("LspAgent.diagnostics")(function* (
      sessionID: SessionID,
      hostPath: string,
      hostWorkdir: string,
    ) {
      const base = yield* getBaseUrl(sessionID)
      const sandboxPath = toSandboxPath(hostPath, hostWorkdir)
      const req = yield* HttpClientRequest.post(`${base}/lsp/diagnostics`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.schemaBodyJson(BodySchema)({ path: sandboxPath }),
      )
      const response = yield* http.execute(req).pipe(
        Effect.timeout(HTTP_TIMEOUT),
        Effect.catch((e) =>
          Effect.fail(new Error(`LSP agent diagnostics failed: ${String(e)}`)),
        ),
      )
      return yield* HttpClientResponse.schemaBodyJson(DiagnosticsResponseSchema)(response).pipe(
        Effect.catch((e) =>
          Effect.fail(new Error(`LSP agent diagnostics decode failed: ${String(e)}`)),
        ),
      ) as Effect.Effect<DiagnosticsResponse, Error>
    })

    const status = Effect.fn("LspAgent.status")(function* (sessionID: SessionID) {
      const base = yield* getBaseUrl(sessionID)
      const req = HttpClientRequest.get(`${base}/lsp/status`).pipe(
        HttpClientRequest.acceptJson,
      )
      const response = yield* http.execute(req).pipe(
        Effect.timeout(HTTP_TIMEOUT),
        Effect.catch((e) =>
          Effect.fail(new Error(`LSP agent status failed: ${String(e)}`)),
        ),
      )
      return yield* HttpClientResponse.schemaBodyJson(StatusResponseSchema)(response).pipe(
        Effect.catch((e) =>
          Effect.fail(new Error(`LSP agent status decode failed: ${String(e)}`)),
        ),
      )
    })

    const shutdown = Effect.fn("LspAgent.shutdown")(function* (sessionID: SessionID) {
      const state = daemonStates.get(sessionID)
      if (!state) return
      const base = yield* sandbox.getEndpoint(sessionID, DAEMON_PORT).pipe(
        Effect.orElseSucceed(() => ""),
      )
      if (!base) return
      const req = HttpClientRequest.post(`${base}/lsp/shutdown`)
      yield* http.execute(req).pipe(
        Effect.timeout(HTTP_TIMEOUT),
        Effect.catch((e) =>
          Effect.logWarning("LSP agent shutdown request failed", { error: String(e) }),
        ),
      )
      daemonStates.delete(sessionID)
    })

    const hover = Effect.fn("LspAgent.hover")(function* (
      sessionID: SessionID,
      hostPath: string,
      hostWorkdir: string,
      line: number,
      character: number,
    ) {
      const base = yield* getBaseUrl(sessionID)
      const sandboxPath = toSandboxPath(hostPath, hostWorkdir)
      const req = yield* HttpClientRequest.post(`${base}/lsp/hover`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.schemaBodyJson(PositionBodySchema)({ path: sandboxPath, line, character }),
      )
      const response = yield* http.execute(req).pipe(
        Effect.timeout(HTTP_TIMEOUT),
        Effect.catch((e) =>
          Effect.fail(new Error(`LSP agent hover failed: ${String(e)}`)),
        ),
      )
      return yield* HttpClientResponse.schemaBodyJson(HoverResponseSchema)(response).pipe(
        Effect.catch((e) =>
          Effect.fail(new Error(`LSP agent hover decode failed: ${String(e)}`)),
        ),
      ) as Effect.Effect<HoverResponse, Error>
    })

    const definition = Effect.fn("LspAgent.definition")(function* (
      sessionID: SessionID,
      hostPath: string,
      hostWorkdir: string,
      line: number,
      character: number,
    ) {
      const base = yield* getBaseUrl(sessionID)
      const sandboxPath = toSandboxPath(hostPath, hostWorkdir)
      const req = yield* HttpClientRequest.post(`${base}/lsp/definition`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.schemaBodyJson(PositionBodySchema)({ path: sandboxPath, line, character }),
      )
      const response = yield* http.execute(req).pipe(
        Effect.timeout(HTTP_TIMEOUT),
        Effect.catch((e) =>
          Effect.fail(new Error(`LSP agent definition failed: ${String(e)}`)),
        ),
      )
      return yield* HttpClientResponse.schemaBodyJson(LocationResponseSchema)(response).pipe(
        Effect.catch((e) =>
          Effect.fail(new Error(`LSP agent definition decode failed: ${String(e)}`)),
        ),
      ) as Effect.Effect<LocationResponse, Error>
    })

    const references = Effect.fn("LspAgent.references")(function* (
      sessionID: SessionID,
      hostPath: string,
      hostWorkdir: string,
      line: number,
      character: number,
    ) {
      const base = yield* getBaseUrl(sessionID)
      const sandboxPath = toSandboxPath(hostPath, hostWorkdir)
      const req = yield* HttpClientRequest.post(`${base}/lsp/references`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.schemaBodyJson(PositionBodySchema)({ path: sandboxPath, line, character }),
      )
      const response = yield* http.execute(req).pipe(
        Effect.timeout(HTTP_TIMEOUT),
        Effect.catch((e) =>
          Effect.fail(new Error(`LSP agent references failed: ${String(e)}`)),
        ),
      )
      return yield* HttpClientResponse.schemaBodyJson(LocationResponseSchema)(response).pipe(
        Effect.catch((e) =>
          Effect.fail(new Error(`LSP agent references decode failed: ${String(e)}`)),
        ),
      ) as Effect.Effect<LocationResponse, Error>
    })

    const implementation = Effect.fn("LspAgent.implementation")(function* (
      sessionID: SessionID,
      hostPath: string,
      hostWorkdir: string,
      line: number,
      character: number,
    ) {
      const base = yield* getBaseUrl(sessionID)
      const sandboxPath = toSandboxPath(hostPath, hostWorkdir)
      const req = yield* HttpClientRequest.post(`${base}/lsp/implementation`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.schemaBodyJson(PositionBodySchema)({ path: sandboxPath, line, character }),
      )
      const response = yield* http.execute(req).pipe(
        Effect.timeout(HTTP_TIMEOUT),
        Effect.catch((e) =>
          Effect.fail(new Error(`LSP agent implementation failed: ${String(e)}`)),
        ),
      )
      return yield* HttpClientResponse.schemaBodyJson(LocationResponseSchema)(response).pipe(
        Effect.catch((e) =>
          Effect.fail(new Error(`LSP agent implementation decode failed: ${String(e)}`)),
        ),
      ) as Effect.Effect<LocationResponse, Error>
    })

    const documentSymbol = Effect.fn("LspAgent.documentSymbol")(function* (
      sessionID: SessionID,
      hostPath: string,
      hostWorkdir: string,
    ) {
      const base = yield* getBaseUrl(sessionID)
      const sandboxPath = toSandboxPath(hostPath, hostWorkdir)
      const req = yield* HttpClientRequest.post(`${base}/lsp/documentSymbol`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.schemaBodyJson(BodySchema)({ path: sandboxPath }),
      )
      const response = yield* http.execute(req).pipe(
        Effect.timeout(HTTP_TIMEOUT),
        Effect.catch((e) =>
          Effect.fail(new Error(`LSP agent documentSymbol failed: ${String(e)}`)),
        ),
      )
      return yield* HttpClientResponse.schemaBodyJson(DocumentSymbolResponseSchema)(response).pipe(
        Effect.catch((e) =>
          Effect.fail(new Error(`LSP agent documentSymbol decode failed: ${String(e)}`)),
        ),
      ) as Effect.Effect<DocumentSymbolResponse, Error>
    })

    const workspaceSymbol = Effect.fn("LspAgent.workspaceSymbol")(function* (
      sessionID: SessionID,
      query: string,
    ) {
      const base = yield* getBaseUrl(sessionID)
      const req = yield* HttpClientRequest.post(`${base}/lsp/workspaceSymbol`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.schemaBodyJson(WorkspaceSymbolBodySchema)({ query }),
      )
      const response = yield* http.execute(req).pipe(
        Effect.timeout(HTTP_TIMEOUT),
        Effect.catch((e) =>
          Effect.fail(new Error(`LSP agent workspaceSymbol failed: ${String(e)}`)),
        ),
      )
      return yield* HttpClientResponse.schemaBodyJson(WorkspaceSymbolResponseSchema)(response).pipe(
        Effect.catch((e) =>
          Effect.fail(new Error(`LSP agent workspaceSymbol decode failed: ${String(e)}`)),
        ),
      ) as Effect.Effect<WorkspaceSymbolResponse, Error>
    })

    const prepareCallHierarchy = Effect.fn("LspAgent.prepareCallHierarchy")(function* (
      sessionID: SessionID,
      hostPath: string,
      hostWorkdir: string,
      line: number,
      character: number,
    ) {
      const base = yield* getBaseUrl(sessionID)
      const sandboxPath = toSandboxPath(hostPath, hostWorkdir)
      const req = yield* HttpClientRequest.post(`${base}/lsp/prepareCallHierarchy`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.schemaBodyJson(PositionBodySchema)({ path: sandboxPath, line, character }),
      )
      const response = yield* http.execute(req).pipe(
        Effect.timeout(HTTP_TIMEOUT),
        Effect.catch((e) =>
          Effect.fail(new Error(`LSP agent prepareCallHierarchy failed: ${String(e)}`)),
        ),
      )
      return yield* HttpClientResponse.schemaBodyJson(PrepareCallHierarchyResponseSchema)(response).pipe(
        Effect.catch((e) =>
          Effect.fail(new Error(`LSP agent prepareCallHierarchy decode failed: ${String(e)}`)),
        ),
      ) as Effect.Effect<PrepareCallHierarchyResponse, Error>
    })

    const incomingCalls = Effect.fn("LspAgent.incomingCalls")(function* (
      sessionID: SessionID,
      hostPath: string,
      hostWorkdir: string,
      line: number,
      character: number,
    ) {
      const base = yield* getBaseUrl(sessionID)
      const sandboxPath = toSandboxPath(hostPath, hostWorkdir)
      const req = yield* HttpClientRequest.post(`${base}/lsp/incomingCalls`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.schemaBodyJson(PositionBodySchema)({ path: sandboxPath, line, character }),
      )
      const response = yield* http.execute(req).pipe(
        Effect.timeout(HTTP_TIMEOUT),
        Effect.catch((e) =>
          Effect.fail(new Error(`LSP agent incomingCalls failed: ${String(e)}`)),
        ),
      )
      return yield* HttpClientResponse.schemaBodyJson(IncomingCallsResponseSchema)(response).pipe(
        Effect.catch((e) =>
          Effect.fail(new Error(`LSP agent incomingCalls decode failed: ${String(e)}`)),
        ),
      ) as Effect.Effect<IncomingCallsResponse, Error>
    })

    const outgoingCalls = Effect.fn("LspAgent.outgoingCalls")(function* (
      sessionID: SessionID,
      hostPath: string,
      hostWorkdir: string,
      line: number,
      character: number,
    ) {
      const base = yield* getBaseUrl(sessionID)
      const sandboxPath = toSandboxPath(hostPath, hostWorkdir)
      const req = yield* HttpClientRequest.post(`${base}/lsp/outgoingCalls`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.schemaBodyJson(PositionBodySchema)({ path: sandboxPath, line, character }),
      )
      const response = yield* http.execute(req).pipe(
        Effect.timeout(HTTP_TIMEOUT),
        Effect.catch((e) =>
          Effect.fail(new Error(`LSP agent outgoingCalls failed: ${String(e)}`)),
        ),
      )
      return yield* HttpClientResponse.schemaBodyJson(OutgoingCallsResponseSchema)(response).pipe(
        Effect.catch((e) =>
          Effect.fail(new Error(`LSP agent outgoingCalls decode failed: ${String(e)}`)),
        ),
      ) as Effect.Effect<OutgoingCallsResponse, Error>
    })

    return Service.of({ touch, diagnostics, status, shutdown, hover, definition, references, implementation, documentSymbol, workspaceSymbol, prepareCallHierarchy, incomingCalls, outgoingCalls })
  }),
)

export * as Agent from "./agent"
