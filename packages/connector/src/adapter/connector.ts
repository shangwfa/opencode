export * as Connector from "./connector.js"

import { createHash } from "node:crypto"
import { Cause, Context, Effect, Exit, Layer, Option, Schema } from "effect"
import { ConnectorConnection } from "@opencode/schema/connector-connection"
import { SessionMcp } from "@opencode/schema/session-mcp"
import { backoffDelayMs } from "./crypto.js"
import { ConnectorEngine, EngineError } from "./engine.js"
import { collectCategories, filterByCategory } from "../categories.js"

export interface Row {
  readonly id: ConnectorConnection.ID
  readonly session_id: string
  readonly engine_connection_id: string
  readonly engine_connection_name: string
  readonly service: string
  readonly alias: string
  readonly auth_type: ConnectorConnection.AuthType
  readonly status: ConnectorConnection.Status
  readonly time_created: number
  readonly time_updated: number
}

/** Persistence port; the drizzle implementation lives beside the core database. */
export interface StoreInterface {
  /** Resolves the session resource owner (root session) for a calling session. */
  readonly resolveOwner: (sessionID: string) => Effect.Effect<string>
  readonly insert: (row: Row) => Effect.Effect<void>
  readonly listBySession: (sessionID: string) => Effect.Effect<ReadonlyArray<Row>>
  readonly delete: (id: ConnectorConnection.ID) => Effect.Effect<void>
  readonly deleteBySession: (sessionID: string) => Effect.Effect<void>
  /** Every engine connection id referenced by a SaaS row (all sessions). */
  readonly listAllEngineConnectionIds: () => Effect.Effect<ReadonlyArray<string>>
  /** OAuth request ledger (SaaS self-accounting; the engine has no list route). */
  readonly insertOAuthRequest: (row: OAuthRequestRow) => Effect.Effect<boolean>
  readonly updateOAuthRequestState: (connectionRequestId: string, state: string) => Effect.Effect<void>
  readonly listOAuthRequestsBySession: (sessionID: string) => Effect.Effect<ReadonlyArray<OAuthRequestRow>>
}

export class Store extends Context.Service<Store, StoreInterface>()("@opencode/ConnectorStore") {}

/** Simplified trigger schedule row; JSON columns are stored as serialized text. */
export interface TriggerRow {
  readonly id: ConnectorConnection.TriggerID
  readonly session_id: string
  readonly service: string
  readonly trigger_id: string
  readonly engine_connection_id: string
  readonly endpoint_url: string
  readonly engine_subscription_id: string | null
  readonly engine_token_id: string | null
  /** Logical (decrypted) engine token; the drizzle store transparently encrypts at rest. */
  readonly engine_token: string | null
  /** active | retiring | revoked (adapter-spec §2 simplified lifecycle). */
  readonly token_state: string
  readonly config: string
  readonly checkpoint: string | null
  readonly checkpoint_revision: number
  readonly next_run_at: number
  readonly lease_epoch: number
  readonly lease_until: number
  /** active | suspended | cancelled */
  readonly status: string
  readonly wake_seq: number
  /** Consecutive transient read failures driving exponential backoff; reset on success. */
  readonly poll_attempts: number
  /** Latest engine read/receive outcome (simplified audit). */
  readonly last_result: string | null
  readonly time_created: number
  readonly time_updated: number
}

/** Durable webhook receipt (protocol doc §1/§2 SaaS side). */
export interface TriggerReceiptRow {
  readonly id: string
  readonly schedule_id: string
  readonly received_at: number
  readonly dedup_key: string
  readonly body_base64: string
  /** Full ingress descriptor `{method, query, headers}` so replay repeats the exact request. */
  readonly headers: string
  /** received | processed | failed */
  readonly state: string
  readonly engine_result: string | null
  readonly checkpoint: string | null
  readonly attempts: number
  readonly next_retry_at: number
  readonly time_created: number
  readonly time_updated: number
}

/** Page-level poll/listener event awaiting session delivery (protocol doc §5/§6). */
export interface TriggerEventRow {
  readonly id: string
  readonly schedule_id: string
  readonly delivery_key: string
  readonly payload: string
  readonly delivered_at: number | null
  readonly time_created: number
  readonly time_updated: number
}

/** SaaS-side OAuth request ledger row (the engine exposes no list route). */
export interface OAuthRequestRow {
  readonly connection_request_id: string
  readonly session_id: string
  readonly service: string
  /** initiated | connected | failed | expired */
  readonly state: string
  readonly alias: string | null
  readonly time_created: number
  readonly time_updated: number
}

/** Persistence port for trigger schedules, receipts, and events; the drizzle implementation lives beside the core database. */
export interface TriggerStoreInterface {
  readonly insert: (row: TriggerRow) => Effect.Effect<void>
  readonly get: (id: string) => Effect.Effect<TriggerRow | undefined>
  readonly listBySession: (sessionID: string) => Effect.Effect<ReadonlyArray<TriggerRow>>
  /** Deletes a row that never reached a usable engine subscription (create compensation). */
  readonly delete: (id: string) => Effect.Effect<void>
  /** Marks a row active | suspended | cancelled (cancel/suspend paths). */
  readonly updateStatus: (id: string, status: string) => Effect.Effect<void>
  /** Claims every active row whose next_run_at is due and whose lease expired; bumps the lease epoch. */
  readonly claimDue: (now: number, leaseMs: number) => Effect.Effect<ReadonlyArray<TriggerRow>>
  /** Claims one active row regardless of next_run_at when its lease is free; undefined when busy or missing. */
  readonly claim: (id: string, now: number, leaseMs: number) => Effect.Effect<TriggerRow | undefined>
  /**
   * One transaction (protocol doc §5 step 4): the lease epoch CAS runs first, so a stale owner writes
   * nothing; then the page events insert with delivery-key dedupe and the checkpoint advances with
   * poll_attempts reset. Returns false when the epoch CAS failed.
   */
  readonly savePollPage: (input: {
    readonly id: string
    readonly expectedEpoch: number
    readonly checkpoint: string | null
    readonly lastResult: string | null
    readonly nextRunAt: number
    readonly events: ReadonlyArray<{ readonly deliveryKey: string; readonly payload: string }>
  }) => Effect.Effect<boolean>
  /** Records a failed read pass under the lease epoch: bumps poll_attempts, stores the error, optionally suspends. */
  readonly recordPollFailure: (input: {
    readonly id: string
    readonly expectedEpoch: number
    readonly lastResult: string
    readonly nextRunAt: number
    readonly suspend: boolean
  }) => Effect.Effect<boolean>
  /** Receipt journal (protocol doc §1/§2): false when the (schedule, dedupKey) receipt already exists. */
  readonly insertReceipt: (row: TriggerReceiptRow) => Effect.Effect<boolean>
  readonly findReceipt: (scheduleId: string, dedupKey: string) => Effect.Effect<TriggerReceiptRow | undefined>
  /**
   * Replay claim for still-`received` receipts due for retry. Receipts that already spent `maxAttempts`
   * are parked as failed; the rest get attempts + 1 and a re-claim guard of `reclaimMs`, so a replay
   * that crashes mid-flight still consumes an attempt.
   */
  readonly claimStaleReceipts: (now: number, maxAttempts: number, reclaimMs: number) => Effect.Effect<ReadonlyArray<TriggerReceiptRow>>
  /**
   * One transaction: the schedule checkpoint mirror (guarded by checkpoint_revision, revision + 1) and
   * the receipt transition received -> processed with the engine result. Returns false when the revision
   * moved or the receipt already settled; nothing is written then.
   */
  readonly completeReceipt: (input: {
    readonly id: string
    readonly scheduleId: string
    readonly expectedRevision: number
    readonly engineResult: string
    readonly checkpoint: string | null
  }) => Effect.Effect<boolean>
  /** Records one failed attempt: stores the error and reschedules, parking as failed when `failed` is set. */
  readonly recordReceiptFailure: (input: {
    readonly id: string
    readonly nextRetryAt: number
    readonly failed: boolean
    readonly engineResult: string
  }) => Effect.Effect<void>
  /** Undelivered events for one schedule, oldest first. */
  readonly listUndeliveredEvents: (scheduleId: string) => Effect.Effect<ReadonlyArray<TriggerEventRow>>
  readonly markDelivered: (ids: ReadonlyArray<string>) => Effect.Effect<void>
  /** Token lifecycle: active | retiring | revoked; 404 on revoke counts as already revoked. */
  readonly updateTokenState: (id: string, state: string) => Effect.Effect<void>
}

export class TriggerStore extends Context.Service<TriggerStore, TriggerStoreInterface>()("@opencode/ConnectorTriggerStore") {}

export class NotFoundError {
  readonly _tag = "NotFoundError"
  constructor(readonly connectionID: string) {}
}

export class ConflictError {
  readonly _tag = "ConflictError"
  constructor(
    readonly code: string,
    readonly message: string,
  ) {}
}

export interface Interface {
  readonly associate: (
    sessionID: string,
    input: ConnectorConnection.CreatePayload,
  ) => Effect.Effect<ConnectorConnection.Info, EngineError | ConflictError>
  readonly list: (sessionID: string) => Effect.Effect<ReadonlyArray<ConnectorConnection.Info>>
  readonly remove: (
    sessionID: string,
    connectionID: ConnectorConnection.ID,
  ) => Effect.Effect<void, NotFoundError | EngineError>
  /** Session teardown: removes engine connections and session-scoped tokens for the resource owner. */
  readonly cleanupSession: (sessionID: string) => Effect.Effect<void>
  /** Builds (and rotates) the session-scoped MCP registration for this session's connections. */
  readonly attachMcp: (sessionID: string) => Effect.Effect<SessionMcp.Payload, EngineError | ConflictError>
  /** Catalog discovery scoped to the session's connections; a zero-connection session falls back to the no-auth sentinel token. */
  readonly apps: (sessionID: string) => Effect.Effect<unknown, EngineError | ConflictError>
  readonly searchActions: (
    sessionID: string,
    input: { readonly query?: string; readonly service?: string; readonly limit?: number },
  ) => Effect.Effect<unknown, EngineError | ConflictError>
  readonly actionGuide: (
    sessionID: string,
    actionId: string,
  ) => Effect.Effect<unknown, EngineError | ConflictError>
  /** Executes one action with a token scoped to the session's (or one chosen) connection. */
  readonly executeAction: (
    sessionID: string,
    input: {
      readonly actionId: string
      readonly connectionID?: ConnectorConnection.ID
      readonly actionInput?: unknown
      /** Forwarded as the engine `idempotency-key` header so retries deduplicate upstream. */
      readonly idempotencyKey?: string
    },
  ) => Effect.Effect<unknown, EngineError | ConflictError | NotFoundError>
  /** Starts an OAuth connection request for the session's resource domain. */
  readonly startOAuth: (
    sessionID: string,
    input: { readonly service: string; readonly alias?: string; readonly authorizationOptionIds?: ReadonlyArray<string> },
  ) => Effect.Effect<ConnectorConnection.OAuthStart, EngineError>
  /** Restarts authorization for one of the session's oauth2 connections; complete via the OAuth complete flow. */
  readonly reconnectOAuth: (
    sessionID: string,
    connectionID: ConnectorConnection.ID,
  ) => Effect.Effect<ConnectorConnection.ReconnectStart, EngineError | NotFoundError>
  /** Lists recent engine action runs (admin plane passthrough). */
  readonly runs: (input: {
    readonly cursor?: string
    readonly limit?: number
  }) => Effect.Effect<ConnectorEngine.EngineRunsPage, EngineError>
  /**
   * Lists connectable providers (the engine's provider directory). Not session-bound; optional
   * `service`/`authType`/`category` filters narrow the returned entries.
   */
  readonly catalog: (input?: {
    readonly service?: string
    readonly authType?: ConnectorConnection.ProviderAuthType
    readonly category?: string
  }) => Effect.Effect<ConnectorConnection.ProviderCatalog, EngineError>
  /**
   * Aggregated category taxonomy of the engine's provider directory (not session-bound).
   * Labels are deduplicated case-insensitively and sorted alphabetically.
   */
  readonly categories: () => Effect.Effect<ConnectorConnection.CategoryCatalog, EngineError>
  /** Service-scoped proxy passthrough; connection targeting follows the executeAction rules. */
  readonly proxy: (
    sessionID: string,
    input: {
      readonly service: string
      readonly method: string
      readonly path: string
      readonly query?: Record<string, string>
      readonly headers?: Record<string, string>
      readonly body?: unknown
      readonly connectionID?: ConnectorConnection.ID
    },
  ) => Effect.Effect<unknown, EngineError | ConflictError | NotFoundError>
  /** Uploads one transit file; the engine download URL is rewritten to the SaaS endpoint. */
  readonly uploadFile: (
    sessionID: string,
    input: { readonly name: string; readonly mimeType?: string; readonly data: Uint8Array },
  ) => Effect.Effect<ConnectorConnection.FileUpload, EngineError>
  /** Streams one transit file back through the SaaS endpoint. */
  readonly downloadFile: (fileId: string) => Effect.Effect<{ readonly contentType: string; readonly data: Uint8Array }, EngineError>
  /**
   * Creates a trigger schedule: mints a per-schedule persistent engine token, reconciles the
   * engine webhook subscription (active), and records the binding.
   */
  readonly createTrigger: (
    sessionID: string,
    input: {
      readonly service: string
      readonly triggerId: string
      readonly config?: Record<string, unknown>
      readonly connectionID?: ConnectorConnection.ID
    },
  ) => Effect.Effect<ConnectorConnection.TriggerInfo, EngineError | ConflictError | NotFoundError>
  readonly listTriggers: (sessionID: string) => Effect.Effect<ReadonlyArray<ConnectorConnection.TriggerInfo>>
  /** Cancels one of the session's triggers: engine deactivate (best-effort), token revoke, row cancel. */
  readonly cancelTrigger: (
    sessionID: string,
    triggerID: ConnectorConnection.TriggerID,
  ) => Effect.Effect<void, NotFoundError>
  /**
   * Forwards one webhook delivery to the engine receive operation and mirrors the checkpoint.
   * Simplified, non-atomic (protocol doc §1/§2 require an engine-side journal): the receive
   * result and the checkpoint save are not one transaction upstream.
   */
  readonly handleWebhook: (
    scheduleID: ConnectorConnection.TriggerID,
    input: {
      readonly method: string
      readonly headers: Record<string, string>
      readonly query: Record<string, string>
      readonly rawBody: string
    },
  ) => Effect.Effect<unknown, NotFoundError | EngineError | ConflictError>
  /** Reads one schedule now (poll/listener read) and saves the checkpoint under its lease. */
  readonly pollOnce: (scheduleID: ConnectorConnection.TriggerID) => Effect.Effect<unknown, NotFoundError | EngineError | ConflictError>
  /** Scheduler entry: claims due rows and polls each under its lease (multi-pod safe via CAS). */
  readonly pollDueTriggers: () => Effect.Effect<{ readonly polled: number }, EngineError>
  /**
   * Session event delivery port (protocol doc §6): enqueues one event payload as idempotent
   * input in the target session. Wired by core to the Session inbox admission; absent in tests.
   */
  readonly deliverEvent: (input: {
    readonly sessionID: string
    readonly deliveryKey: string
    readonly payload: unknown
  }) => Effect.Effect<boolean, never>
  /** Lists the session's OAuth requests from the SaaS ledger, refreshing non-terminal ones best-effort. */
  readonly listOAuthRequests: (sessionID: string) => Effect.Effect<ReadonlyArray<ConnectorConnection.OAuthRequestInfo>>
  /** Polls/completes an OAuth request; on success the engine connection is associated to the session. */
  readonly completeOAuth: (
    sessionID: string,
    input: { readonly connectionRequestID: string; readonly alias?: string },
  ) => Effect.Effect<ConnectorConnection.OAuthComplete, EngineError | ConflictError>
  /** Stores the OAuth client configuration for a service. */
  readonly configureOAuthClient: (input: {
    readonly service: string
    readonly clientId: string
    readonly clientSecret: string
    readonly extra?: Record<string, string>
    readonly requestedScopes?: ReadonlyArray<string>
  }) => Effect.Effect<void, EngineError>
  /**
   * Removes engine connections that no SaaS row references (crash between engine create and
   * persistence). Opt-in: do not run while OAuth requests are in flight — a callback-completed
   * connection is only associated once its request is completed.
   */
  readonly reconcileOrphans: () => Effect.Effect<{ removed: number }, EngineError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Connector") {}

export interface Options {
  /** Public URL of the SaaS MCP passthrough endpoint registered as a session MCP. */
  readonly mcpUrl: string | undefined
  readonly mcpName: string
  /** Public HTTPS base for trigger webhooks (`POST <webhookUrl>/<scheduleID>`); engine requires HTTPS. */
  readonly webhookUrl: string | undefined
  /** Public base used to rewrite engine file download URLs; falls back to a relative path. */
  readonly fileUrlBase: string | undefined
  /**
   * Idempotent session input admission for trigger events (protocol doc §6). Core wires this to
   * the Session inbox; the connector package keeps no Session dependency by design.
   */
  readonly deliverEvent?: (
    input: {
      readonly sessionID: string
      readonly deliveryKey: string
      readonly payload: unknown
    },
  ) => Effect.Effect<boolean>
}

const info = (
  row: Row,
  engine?: {
    readonly engineStatus: string
    readonly accountLabel?: string
  },
) =>
  ConnectorConnection.Info.make({
    id: row.id,
    service: row.service,
    alias: row.alias,
    authType: row.auth_type,
    status: row.status,
    engineConnectionID: row.engine_connection_id,
    engineStatus: engine?.engineStatus ?? (row.status === "active" ? "active" : "disconnected"),
    ...(engine?.accountLabel ? { accountLabel: engine.accountLabel } : {}),
    time: { created: row.time_created, updated: row.time_updated },
  })

/**
 * Sentinel allowlist for the no-auth channel: it matches no engine connection, so connection-scoped
 * actions are refused by the token policy while no_auth actions (which skip the connection check) run.
 */
const NO_AUTH_ONLY = "no-auth-only"

const oauthRequestInfo = (row: OAuthRequestRow, state = row.state) =>
  ConnectorConnection.OAuthRequestInfo.make({
    connectionRequestID: row.connection_request_id,
    service: row.service,
    ...(row.alias ? { alias: row.alias } : {}),
    status: state,
    time: { created: row.time_created, updated: row.time_updated },
  })

/** Engine request statuses that the SaaS ledger records as terminal without an associated connection. */
const terminalOAuthState = (status: string) => (status === "failed" || status === "expired" ? status : undefined)

/** Discovery stays usable with zero connections through the no-auth sentinel. */
const noAuthFallback = (rows: ReadonlyArray<Row>) =>
  rows.length === 0 ? [NO_AUTH_ONLY] : rows.map((row) => row.engine_connection_id)

/** Poll cadence for schedules without a provider-driven reconcile hint; leases cover multi-pod claims. */
const LEASE_MS = 120_000
const POLL_INTERVAL_MS = 60_000
/** Receipt replay bound (protocol doc §2): give up after this many attempts and park as failed. */
const RECEIPT_MAX_ATTEMPTS = 5

/** Provider/callback problems that retrying cannot fix; these suspend the schedule. */
const PERMANENT_ERROR = /not_found|not_supported|unsupported|invalid_input|forbidden|not_allowed|abandoned|connection_error/

/** Auth failures (401/403) never heal by retrying; they suspend the schedule like other permanent errors. */
const permanentError = (error: EngineError) => PERMANENT_ERROR.test(error.code) || error.status === 401 || error.status === 403

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

/** Engine trigger results stay untyped at the boundary; these narrow the fields the SaaS reads. */
const checkpointField = (value: unknown): unknown =>
  typeof value === "object" && value !== null && "checkpoint" in value ? value.checkpoint : undefined
const hasMoreField = (value: unknown): boolean =>
  typeof value === "object" && value !== null && "hasMore" in value && value.hasMore === true

const triggerInfo = (row: TriggerRow): ConnectorConnection.TriggerInfo =>
  ConnectorConnection.TriggerInfo.make({
    id: row.id,
    service: row.service,
    triggerId: row.trigger_id,
    status: row.status,
    config: (row.config ? JSON.parse(row.config) : {}) as never,
    nextRunAt: row.next_run_at,
    ...(row.last_result ? { lastResult: JSON.parse(row.last_result) as never } : {}),
    time: { created: row.time_created, updated: row.time_updated },
  })

export const make = (
  store: StoreInterface,
  triggerStore: TriggerStoreInterface,
  engine: ConnectorEngine.Interface,
  options: Options,
): Interface => {
  const tokenName = (owner: string) => `ccon-session-${owner}`
  const revokeSessionTokens = (owner: string) =>
    engine
      .listRuntimeTokens()
      .pipe(
        Effect.flatMap((tokens) =>
          Effect.forEach(
            tokens.filter((token) => token.name === tokenName(owner)),
            (token) => engine.revokeRuntimeToken(token.id),
            { discard: true },
          ),
        ),
      )
  const activeRows = (owner: string) => store.listBySession(owner).pipe(Effect.map((rows) => rows.filter((row) => row.status === "active")))
  /**
   * Runs one runtime call under an ephemeral token restricted to `connections`.
   * Empty connection lists must never mint a token: an empty allowlist is unrestricted upstream.
   */
  const withEphemeralToken = <A, E>(connections: readonly string[], run: (token: string) => Effect.Effect<A, E, never>) =>
    Effect.gen(function* () {
      if (connections.length === 0) return yield* Effect.fail(new ConflictError("no_connections", "The session has no active connector connections."))
      const issued = yield* engine.createRuntimeToken({
        name: `ccon-ephemeral-${crypto.randomUUID().replaceAll("-", "")}`,
        allowedConnections: [...connections],
        allowedProxies: ["*"],
      })
      return yield* run(issued.token).pipe(
        Effect.onExit(() => engine.revokeRuntimeToken(issued.id).pipe(Effect.catch(() => Effect.void))),
      )
    })
  /** Stable per-event delivery key: provider dedupe key when present, else a content fingerprint. */
  const eventDeliveryKey = (scheduleId: string, event: unknown) => {
    const candidate = event as { dedupeKey?: unknown; id?: unknown }
    if (typeof candidate?.dedupeKey === "string" && candidate.dedupeKey) return candidate.dedupeKey
    if (typeof candidate?.id === "string" && candidate.id) return candidate.id
    return sha256(`${scheduleId}:${JSON.stringify(event)}`)
  }
  /** Normalizes a poll page or listener page into delivery-keyed events. */
  const pageEvents = (scheduleId: string, result: unknown): ReadonlyArray<{ deliveryKey: string; payload: string }> => {
    const page = result as { events?: unknown; outputs?: unknown; dedupeKey?: unknown }
    if (Array.isArray(page?.events)) {
      return page.events.map((event) => ({
        deliveryKey: eventDeliveryKey(scheduleId, event),
        payload: JSON.stringify(event),
      }))
    }
    if (page?.outputs !== undefined) {
      return [{ deliveryKey: eventDeliveryKey(scheduleId, page), payload: JSON.stringify(page.outputs) }]
    }
    return []
  }
  /** Delivers undelivered events to the owning session; idempotent through the delivery-key-derived input id. */
  const deliverPendingEvents = (row: TriggerRow) =>
    Effect.gen(function* () {
      if (!options.deliverEvent) return
      const pending = yield* triggerStore.listUndeliveredEvents(row.id)
      for (const event of pending) {
        const delivered = yield* options
          .deliverEvent({
            sessionID: row.session_id,
            deliveryKey: event.delivery_key,
            payload: event.payload ? JSON.parse(event.payload) : null,
          })
          .pipe(Effect.catch(() => Effect.succeed(false)))
        if (delivered) yield* triggerStore.markDelivered([event.id])
      }
    })
  /**
   * One read pass under an already-held lease (protocol doc §5): the page events insert (delivery-key
   * dedupe) and the checkpoint advance commit in one store transaction; delivery happens afterwards
   * and is idempotent, so a crash between commit and delivery re-delivers the same key harmlessly.
   */
  const runPoll = (row: TriggerRow, epoch: number) =>
    Effect.gen(function* () {
      if (!row.engine_token) return yield* Effect.fail(new ConflictError("trigger_not_ready", "The trigger has no engine binding yet."))
      const result = yield* engine
        .triggerExecute({
          token: row.engine_token,
          service: row.service,
          triggerId: row.trigger_id,
          operation: "read",
          body: {
            operation: "read",
            config: row.config ? (JSON.parse(row.config) as Record<string, unknown>) : {},
            checkpoint: row.checkpoint ? (JSON.parse(row.checkpoint) as unknown) : null,
          },
          connectionId: row.engine_connection_id,
        })
        .pipe(
          Effect.catch((error) =>
            triggerStore
              .recordPollFailure({
                id: row.id,
                expectedEpoch: epoch,
                lastResult: JSON.stringify({ error: { code: error.code, message: error.message } }),
                nextRunAt: Date.now() + backoffDelayMs(row.poll_attempts + 1),
                suspend: permanentError(error),
              })
              .pipe(Effect.andThen(Effect.fail(error))),
          ),
        )
      const checkpoint = checkpointField(result)
      const saved = yield* triggerStore.savePollPage({
        id: row.id,
        expectedEpoch: epoch,
        checkpoint: checkpoint === undefined || checkpoint === null ? row.checkpoint : JSON.stringify(checkpoint),
        lastResult: JSON.stringify(result),
        nextRunAt: Date.now() + (hasMoreField(result) ? 0 : POLL_INTERVAL_MS),
        events: pageEvents(row.id, result),
      })
      if (!saved) return yield* Effect.fail(new ConflictError("lease_lost", "The trigger lease moved; this read pass was discarded."))
      yield* deliverPendingEvents(row)
      return result
    })
  /**
   * Receipt processing (protocol doc §1/§2 SaaS side): runs the engine receive, then commits the
   * receipt (processed + engine result + checkpoint) together with the schedule checkpoint mirror.
   * Failures bump attempts with backoff and surface the error so HTTP callers return 5xx.
   */
  const processReceipt = (row: TriggerRow, receipt: TriggerReceiptRow) =>
    Effect.gen(function* () {
      if (!row.engine_subscription_id || !row.engine_token) {
        yield* triggerStore.recordReceiptFailure({
          id: receipt.id,
          nextRetryAt: Date.now(),
          failed: true,
          engineResult: JSON.stringify({ error: { code: "trigger_not_ready", message: "The trigger has no engine binding." } }),
        })
        return yield* Effect.fail(new ConflictError("trigger_not_ready", "The trigger has no engine binding."))
      }
      const ingress = receipt.headers
        ? (JSON.parse(receipt.headers) as { method?: string; query?: Record<string, string>; headers?: Record<string, string> })
        : {}
      const result = yield* engine
        .triggerExecute({
          token: row.engine_token,
          service: row.service,
          triggerId: row.trigger_id,
          operation: "receive",
          body: {
            operation: "receive",
            subscriptionId: row.engine_subscription_id,
            method: ingress.method ?? "POST",
            headers: ingress.headers ?? {},
            query: ingress.query ?? {},
            rawBody: receipt.body_base64,
            admit: true,
            current: true,
          },
          connectionId: row.engine_connection_id,
        })
        .pipe(
          Effect.catch((error) =>
            triggerStore
              .recordReceiptFailure({
                id: receipt.id,
                nextRetryAt: Date.now() + backoffDelayMs(receipt.attempts),
                failed: receipt.attempts >= RECEIPT_MAX_ATTEMPTS,
                engineResult: JSON.stringify({ error: { code: error.code, message: error.message } }),
              })
              .pipe(Effect.andThen(Effect.fail(error))),
          ),
        )
      const checkpoint = checkpointField(result)
      const committed = yield* triggerStore.completeReceipt({
        id: receipt.id,
        scheduleId: row.id,
        expectedRevision: row.checkpoint_revision,
        engineResult: JSON.stringify(result),
        checkpoint: checkpoint === undefined || checkpoint === null ? row.checkpoint : JSON.stringify(checkpoint),
      })
      if (!committed)
        return yield* Effect.fail(
          new ConflictError("checkpoint_conflict", "The receipt settled or the trigger checkpoint moved concurrently; the redelivery replays the durable result."),
        )
      return result
    })
  /**
   * Token lifecycle (adapter-spec §2 simplified): retiring -> revoke -> revoked. A 404 from the engine
   * means the token is already gone, which still lands in revoked; any other failure stays retiring
   * and is logged so the token is never dropped silently.
   */
  const retireTriggerToken = (row: TriggerRow) =>
    Effect.gen(function* () {
      if (!row.engine_token_id || row.token_state === "revoked") return
      yield* triggerStore.updateTokenState(row.id, "retiring")
      const revoked = yield* engine.revokeRuntimeToken(row.engine_token_id).pipe(
        Effect.as(true),
        Effect.catch((error) => {
          if (error.status === 404) return Effect.succeed(true)
          return Effect.logWarning("connector trigger token revoke failed", { id: row.id, code: error.code }).pipe(Effect.as(false))
        }),
      )
      if (revoked) yield* triggerStore.updateTokenState(row.id, "revoked")
    })
  /** Engine deactivate + token retire for one schedule; deactivation is best-effort (upstream owns cleanup). */
  const deactivateTrigger = (row: TriggerRow) =>
    Effect.gen(function* () {
      if (row.engine_subscription_id && row.engine_token) {
        // Deactivate must repeat the exact registered endpoint URL and config (engine 409s otherwise).
        yield* engine
          .triggerExecute({
            token: row.engine_token,
            service: row.service,
            triggerId: row.trigger_id,
            operation: "reconcile",
            body: {
              operation: "reconcile",
              config: row.config ? (JSON.parse(row.config) as Record<string, unknown>) : {},
              requestKey: `ccon-${row.id}`,
              endpointUrl: row.endpoint_url,
              subscriptionId: row.engine_subscription_id,
              active: false,
            },
            connectionId: row.engine_connection_id,
          })
          .pipe(Effect.catch(() => Effect.logWarning("connector trigger engine deactivation failed", { id: row.id })))
      }
      yield* retireTriggerToken(row)
      yield* triggerStore.updateStatus(row.id, "cancelled")
    })

  const settleOAuthRequest = (connectionRequestID: string, state: string) =>
    store
      .updateOAuthRequestState(connectionRequestID, state)
      .pipe(Effect.catchCause((cause) => Effect.logWarning("connector oauth request ledger update failed", { cause })))

  return {
    associate: (sessionID, input) =>
      Effect.gen(function* () {
        const owner = yield* store.resolveOwner(sessionID)
        const created = yield* engine.createConnection({
          service: input.service,
          authType: input.authType,
          values: input.values,
          alias: input.alias,
        })
        const row: Row = {
          id: ConnectorConnection.ID.create(),
          session_id: owner,
          engine_connection_id: created.id,
          engine_connection_name: created.engineConnectionName,
          service: input.service,
          alias: input.alias ?? input.service,
          auth_type: input.authType,
          status: "active",
          time_created: Date.now(),
          time_updated: Date.now(),
        }
        // Compensation: an engine connection without a durable row is unusable and must not leak.
        // Defects still compensate (resource cleanup), while interruption stays interruption.
        const inserted = yield* store.insert(row).pipe(Effect.exit)
        if (!Exit.isSuccess(inserted)) {
          yield* engine
            .deleteConnection({ service: input.service, engineConnectionName: created.engineConnectionName })
            .pipe(Effect.catch(() => Effect.void))
          if (Cause.hasInterruptsOnly(inserted.cause)) return yield* Effect.failCause(inserted.cause)
          yield* Effect.logWarning("connector association persistence failed", { cause: inserted.cause })
          return yield* Effect.fail(new ConflictError("persist_failed", "Failed to record the connection."))
        }
        return info(row)
      }),

    list: (sessionID) =>
      Effect.gen(function* () {
        const owner = yield* store.resolveOwner(sessionID)
        const rows = (yield* store.listBySession(owner)).filter((row) => row.status !== "deleted")
        const merged: ConnectorConnection.Info[] = []
        for (const row of rows) {
          // Best-effort engine state per row: a failed probe degrades to a synthesized status, never fails the list.
          yield* engine.getConnection(row.engine_connection_id).pipe(
            Effect.match({
              onSuccess: (detail) =>
                void merged.push(
                  info(row, {
                    engineStatus: detail.status === "reauth_required" ? "reauth_required" : "active",
                    accountLabel: detail.profile.displayName || undefined,
                  }),
                ),
              onFailure: (error) =>
                void merged.push(
                  info(row, { engineStatus: error.code === "app_not_found" ? "disconnected" : "error" }),
                ),
            }),
          )
        }
        return merged
      }),

    remove: (sessionID, connectionID) =>
      Effect.gen(function* () {
        const owner = yield* store.resolveOwner(sessionID)
        const rows = yield* store.listBySession(owner)
        const row = rows.find((candidate) => candidate.id === connectionID)
        if (!row) return yield* Effect.fail(new NotFoundError(connectionID))
        yield* engine.deleteConnection({ service: row.service, engineConnectionName: row.engine_connection_name })
        yield* store.delete(row.id)
      }),

    cleanupSession: (sessionID) =>
      Effect.gen(function* () {
        // Triggers follow their session: deactivate engine subscriptions and revoke per-schedule tokens.
        for (const row of yield* triggerStore.listBySession(sessionID)) {
          if (row.status !== "cancelled") yield* deactivateTrigger(row)
          else yield* retireTriggerToken(row)
        }
        const rows = yield* store.listBySession(sessionID)
        for (const row of rows) {
          yield* engine
            .deleteConnection({ service: row.service, engineConnectionName: row.engine_connection_name })
            .pipe(Effect.catch(() => Effect.logWarning("connector cleanup missed engine connection", { id: row.id })))
        }
        yield* revokeSessionTokens(sessionID).pipe(Effect.catch(() => Effect.void))
        yield* store.deleteBySession(sessionID)
      }),

    attachMcp: (sessionID) =>
      Effect.gen(function* () {
        if (!options.mcpUrl)
          return yield* Effect.fail(
            new ConflictError("mcp_url_missing", "OPENCODE_CONNECTOR_MCP_URL is required to attach the session MCP."),
          )
        const owner = yield* store.resolveOwner(sessionID)
        const rows = (yield* store.listBySession(owner)).filter((row) => row.status === "active")
        if (rows.length === 0)
          return yield* Effect.fail(new ConflictError("no_connections", "The session has no active connector connections."))
        // Rotate: one scoped token per session; stale copies only ever covered stale connection sets.
        yield* revokeSessionTokens(owner)
        const issued = yield* engine.createRuntimeToken({
          name: tokenName(owner),
          allowedConnections: rows.map((row) => row.engine_connection_id),
          allowedProxies: ["*"],
        })
        return SessionMcp.Payload.make({
          name: options.mcpName as SessionMcp.Name,
          config: new SessionMcp.RemoteConfig({
            type: "remote",
            url: options.mcpUrl,
            headers: { authorization: `Bearer ${issued.token}` },
            oauth: false,
          }),
        })
      }),

    apps: (sessionID) =>
      Effect.gen(function* () {
        const owner = yield* store.resolveOwner(sessionID)
        const rows = yield* activeRows(owner)
        return yield* withEphemeralToken(
          noAuthFallback(rows),
          (token) => engine.runtimeCall({ token, method: "GET", path: "/v1/apps" }),
        )
      }),

    searchActions: (sessionID, input) =>
      Effect.gen(function* () {
        const owner = yield* store.resolveOwner(sessionID)
        const rows = yield* activeRows(owner)
        const query = new URLSearchParams()
        if (input.query) query.set("query", input.query)
        if (input.service) query.set("service", input.service)
        if (input.limit) query.set("limit", String(input.limit))
        return yield* withEphemeralToken(
          noAuthFallback(rows),
          (token) => engine.runtimeCall({ token, method: "GET", path: `/v1/actions/search?${query.toString()}` }),
        )
      }),

    actionGuide: (sessionID, actionId) =>
      Effect.gen(function* () {
        const owner = yield* store.resolveOwner(sessionID)
        const rows = yield* activeRows(owner)
        return yield* withEphemeralToken(
          noAuthFallback(rows),
          (token) => engine.runtimeCall({ token, method: "GET", path: `/v1/actions/${encodeURIComponent(actionId)}` }),
        )
      }),

    executeAction: (sessionID, input) =>
      Effect.gen(function* () {
        const owner = yield* store.resolveOwner(sessionID)
        const rows = yield* activeRows(owner)
        // The engine resolves a missing connection name to `default`, which never matches our
        // system-generated unique names; always resolve the target ourselves and pass the
        // stable engine connection id explicitly.
        let target: Row | undefined
        if (input.connectionID) {
          target = rows.find((row) => row.id === input.connectionID)
          if (!target) return yield* Effect.fail(new NotFoundError(input.connectionID))
        } else if (rows.length === 1) {
          target = rows[0]
        } else if (rows.length > 1) {
          return yield* Effect.fail(
            new ConflictError("connection_required", "Multiple connections are associated; specify connectionID (from connector_list_connections)."),
          )
        }
        // Zero connections still run no_auth actions: the sentinel allowlist refuses every real
        // connection while no_auth actions skip the connection check entirely.
        const headers = input.idempotencyKey ? { "idempotency-key": input.idempotencyKey } : undefined
        return yield* withEphemeralToken(
          [target?.engine_connection_id ?? NO_AUTH_ONLY],
          (token) =>
            engine.runtimeCall({
              token,
              method: "POST",
              path: `/v1/actions/${encodeURIComponent(input.actionId)}`,
              body: target
                ? { input: input.actionInput ?? {}, connectionId: target.engine_connection_id }
                : { input: input.actionInput ?? {} },
              ...(headers ? { headers } : {}),
            }),
        )
      }),

    startOAuth: (sessionID, input) =>
      Effect.gen(function* () {
        const owner = yield* store.resolveOwner(sessionID)
        const started = yield* engine.startOAuth({
          service: input.service,
          ...(input.authorizationOptionIds ? { authorizationOptionIds: input.authorizationOptionIds } : {}),
        })
        // Self-accounting ledger (the engine has no list route); best-effort audit only.
        yield* store
          .insertOAuthRequest({
            connection_request_id: started.connectionRequestId,
            session_id: owner,
            service: input.service,
            state: "initiated",
            alias: input.alias ?? null,
            time_created: Date.now(),
            time_updated: Date.now(),
          })
          .pipe(Effect.catchCause((cause) => Effect.logWarning("connector oauth request ledger insert failed", { cause })))
        return ConnectorConnection.OAuthStart.make({
          authorizationUrl: started.authorizationUrl,
          connectionRequestID: started.connectionRequestId,
          expiresAt: started.expiresAt,
        })
      }),

    completeOAuth: (sessionID, input) =>
      Effect.gen(function* () {
        const owner = yield* store.resolveOwner(sessionID)
        const request = yield* engine.connectionRequest(input.connectionRequestID)
        if (request.status !== "connected" || !request.appId) {
          const terminal = terminalOAuthState(request.status)
          if (terminal) yield* settleOAuthRequest(input.connectionRequestID, terminal)
          return ConnectorConnection.OAuthComplete.make({
            status: request.status,
            // The engine returns errorCode:null while a request is still initiated; optional
            // schema fields must receive undefined, not null.
            errorCode: request.errorCode ?? undefined,
          })
        }
        const engineIds = new Set((yield* store.listBySession(owner)).map((row) => row.engine_connection_id))
        if (engineIds.has(request.appId)) {
          const existing = (yield* store.listBySession(owner)).find((row) => row.engine_connection_id === request.appId)
          yield* settleOAuthRequest(input.connectionRequestID, "connected")
          return ConnectorConnection.OAuthComplete.make({
            status: "connected",
            connection: info(existing!),
          })
        }
        const created = yield* engine.getConnection(request.appId)
        const row: Row = {
          id: ConnectorConnection.ID.create(),
          session_id: owner,
          engine_connection_id: created.id,
          engine_connection_name: created.engineConnectionName,
          service: created.service || "unknown",
          alias: input.alias ?? (created.service || "oauth"),
          auth_type: "oauth2",
          status: "active",
          time_created: Date.now(),
          time_updated: Date.now(),
        }
        const inserted = yield* store.insert(row).pipe(Effect.exit)
        if (!Exit.isSuccess(inserted)) {
          if (Cause.hasInterruptsOnly(inserted.cause)) return yield* Effect.failCause(inserted.cause)
          return yield* Effect.fail(new ConflictError("persist_failed", "Failed to record the connection."))
        }
        yield* settleOAuthRequest(input.connectionRequestID, "connected")
        return ConnectorConnection.OAuthComplete.make({ status: "connected", connection: info(row) })
      }),

    listOAuthRequests: (sessionID) =>
      Effect.gen(function* () {
        const owner = yield* store.resolveOwner(sessionID)
        const rows = yield* store.listOAuthRequestsBySession(owner)
        return yield* Effect.forEach(rows, (row) => {
          if (row.state !== "initiated") return Effect.succeed(oauthRequestInfo(row))
          return engine.connectionRequest(row.connection_request_id).pipe(
            Effect.flatMap((request) => {
              const terminal = terminalOAuthState(request.status)
              if (!terminal) return Effect.succeed(oauthRequestInfo(row))
              return settleOAuthRequest(row.connection_request_id, terminal).pipe(
                Effect.as(oauthRequestInfo(row, terminal)),
              )
            }),
            Effect.catchCause(() => Effect.succeed(oauthRequestInfo(row))),
          )
        })
      }),

    configureOAuthClient: (input) => engine.putOAuthClient(input),

    reconnectOAuth: (sessionID, connectionID) =>
      Effect.gen(function* () {
        const owner = yield* store.resolveOwner(sessionID)
        const rows = yield* store.listBySession(owner)
        const row = rows.find((candidate) => candidate.id === connectionID)
        if (!row) return yield* Effect.fail(new NotFoundError(connectionID))
        const restarted = yield* engine.reconnect(row.engine_connection_id)
        return ConnectorConnection.ReconnectStart.make({
          authorizationUrl: restarted.authorizationUrl,
          connectionRequestID: restarted.connectionRequestId,
        })
      }),

    runs: (input) => engine.runs(input),

    catalog: (input) =>
      Effect.gen(function* () {
        // Engine entries stay untyped at the boundary; the provider contract validates each one.
        const decode = Schema.decodeUnknownOption(ConnectorConnection.ProviderSummary)
        const providers = (yield* engine.providers()).flatMap((entry) => {
          const decoded = decode(entry)
          if (Option.isNone(decoded)) return []
          const provider = decoded.value
          if (input?.service && provider.service !== input.service) return []
          if (input?.authType && !provider.authTypes.includes(input.authType)) return []
          return [provider]
        })
        return ConnectorConnection.ProviderCatalog.make({ providers: filterByCategory(providers, input?.category) })
      }),

    categories: () =>
      Effect.gen(function* () {
        const decode = Schema.decodeUnknownOption(ConnectorConnection.ProviderSummary)
        const providers = (yield* engine.providers()).flatMap((entry) => {
          const decoded = decode(entry)
          return Option.isNone(decoded) ? [] : [decoded.value]
        })
        return ConnectorConnection.CategoryCatalog.make({ categories: collectCategories(providers) })
      }),

    proxy: (sessionID, input) =>
      Effect.gen(function* () {
        const owner = yield* store.resolveOwner(sessionID)
        const rows = yield* activeRows(owner)
        // Same targeting rules as executeAction: explicit connection, the single connection,
        // or the no-auth sentinel when the session has none.
        let target: Row | undefined
        if (input.connectionID) {
          target = rows.find((row) => row.id === input.connectionID)
          if (!target) return yield* Effect.fail(new NotFoundError(input.connectionID))
        } else if (rows.length === 1) {
          target = rows[0]
        } else if (rows.length > 1) {
          return yield* Effect.fail(
            new ConflictError("connection_required", "Multiple connections are associated; specify connectionID (from connector_list_connections)."),
          )
        }
        return yield* withEphemeralToken(
          [target?.engine_connection_id ?? NO_AUTH_ONLY],
          (token) =>
            engine.proxy({
              token,
              service: input.service,
              method: input.method,
              path: input.path,
              ...(input.query ? { query: input.query } : {}),
              ...(input.headers ? { headers: input.headers } : {}),
              ...(input.body === undefined ? {} : { body: input.body }),
              ...(target ? { connectionId: target.engine_connection_id } : {}),
            }),
        )
      }),

    uploadFile: (sessionID, input) =>
      Effect.gen(function* () {
        yield* store.resolveOwner(sessionID)
        const uploaded = yield* engine.createFile({
          name: input.name,
          ...(input.mimeType ? { mimeType: input.mimeType } : {}),
          data: input.data,
        })
        const base = options.fileUrlBase?.replace(/\/+$/, "")
        return ConnectorConnection.FileUpload.make({
          fileId: uploaded.fileId,
          downloadUrl: `${base ?? ""}/api/connector/files/${encodeURIComponent(uploaded.fileId)}`,
          sizeBytes: uploaded.sizeBytes,
          name: uploaded.name,
          mimeType: uploaded.mimeType,
        })
      }),

    downloadFile: (fileId) => engine.readFile(fileId),

    createTrigger: (sessionID, input) =>
      Effect.gen(function* () {
        if (!options.webhookUrl)
          return yield* Effect.fail(
            new ConflictError("webhook_url_missing", "OPENCODE_CONNECTOR_WEBHOOK_URL is required to create triggers."),
          )
        const owner = yield* store.resolveOwner(sessionID)
        const rows = yield* activeRows(owner)
        if (rows.length === 0)
          return yield* Effect.fail(new ConflictError("no_connections", "The session has no active connector connections."))
        // Triggers are connection-bound: resolve the engine connection for the service explicitly.
        let target: Row | undefined
        if (input.connectionID) {
          target = rows.find((row) => row.id === input.connectionID)
          if (!target) return yield* Effect.fail(new NotFoundError(input.connectionID))
        } else {
          const candidates = rows.filter((row) => row.service === input.service)
          if (candidates.length !== 1)
            return yield* Effect.fail(
              new ConflictError(
                "connection_required",
                candidates.length === 0
                  ? `No active connection for service ${input.service}.`
                  : `Multiple connections for service ${input.service}; specify connectionID.`,
              ),
            )
          target = candidates[0]
        }
        const config = JSON.stringify(input.config ?? {})
        // Persistent per-schedule token: receive/reconcile must reuse the same stored token
        // (the engine binds the subscription to it); revocation happens on cancel/cleanup only.
        const issued = yield* engine.createRuntimeToken({
          name: `ccon-trigger-${crypto.randomUUID().replaceAll("-", "")}`,
          allowedConnections: [target.engine_connection_id],
          allowedProxies: ["*"],
        })
        const scheduleID = ConnectorConnection.TriggerID.create()
        const endpointUrl = `${options.webhookUrl.replace(/\/+$/, "")}/${encodeURIComponent(scheduleID)}`
        const reconciled = yield* engine
          .triggerExecute({
            token: issued.token,
            service: input.service,
            triggerId: input.triggerId,
            operation: "reconcile",
            body: { operation: "reconcile", config: input.config ?? {}, requestKey: `ccon-${scheduleID}`, endpointUrl, active: true },
            connectionId: target.engine_connection_id,
          })
          .pipe(
            Effect.catch((error) =>
              engine.revokeRuntimeToken(issued.id).pipe(
                Effect.catch(() => Effect.void),
                Effect.andThen(Effect.fail(error)),
              ),
            ),
          )
        const result = reconciled as { checkpoint?: unknown; subscription?: { id?: string } }
        const row: TriggerRow = {
          id: scheduleID,
          session_id: owner,
          service: input.service,
          trigger_id: input.triggerId,
          engine_connection_id: target.engine_connection_id,
          endpoint_url: endpointUrl,
          engine_subscription_id: result.subscription?.id ?? null,
          engine_token_id: issued.id,
          engine_token: issued.token,
          token_state: "active",
          config,
          checkpoint: result.checkpoint === undefined || result.checkpoint === null ? null : JSON.stringify(result.checkpoint),
          checkpoint_revision: result.checkpoint === undefined || result.checkpoint === null ? 0 : 1,
          next_run_at: Date.now(),
          lease_epoch: 0,
          lease_until: 0,
          status: "active",
          wake_seq: 0,
          poll_attempts: 0,
          last_result: null,
          time_created: Date.now(),
          time_updated: Date.now(),
        }
        // Compensation: an engine subscription without a durable row leaks the webhook registration.
        const inserted = yield* triggerStore.insert(row).pipe(Effect.exit)
        if (!Exit.isSuccess(inserted)) {
          yield* engine.revokeRuntimeToken(issued.id).pipe(Effect.catch(() => Effect.void))
          yield* engine
            .triggerExecute({
              token: issued.token,
              service: input.service,
              triggerId: input.triggerId,
              operation: "reconcile",
              body: {
                operation: "reconcile",
                config: input.config ?? {},
                requestKey: `ccon-${scheduleID}`,
                endpointUrl,
                active: false,
              },
              connectionId: target.engine_connection_id,
            })
            .pipe(Effect.catch(() => Effect.void))
          if (Cause.hasInterruptsOnly(inserted.cause)) return yield* Effect.failCause(inserted.cause)
          yield* Effect.logWarning("connector trigger persistence failed", { cause: inserted.cause })
          return yield* Effect.fail(new ConflictError("persist_failed", "Failed to record the trigger."))
        }
        return triggerInfo(row)
      }),

    listTriggers: (sessionID) =>
      Effect.gen(function* () {
        const owner = yield* store.resolveOwner(sessionID)
        const rows = yield* triggerStore.listBySession(owner)
        return rows.filter((row) => row.status !== "cancelled").map(triggerInfo)
      }),

    cancelTrigger: (sessionID, triggerID) =>
      Effect.gen(function* () {
        const owner = yield* store.resolveOwner(sessionID)
        const row = (yield* triggerStore.listBySession(owner)).find((candidate) => candidate.id === triggerID)
        if (!row) return yield* Effect.fail(new NotFoundError(triggerID))
        if (row.status === "cancelled") return
        yield* deactivateTrigger(row)
      }),

    handleWebhook: (scheduleID, input) =>
      Effect.gen(function* () {
        const row = yield* triggerStore.get(scheduleID)
        if (!row || row.status !== "active" || !row.engine_subscription_id || !row.engine_token) {
          return yield* Effect.fail(new NotFoundError(scheduleID))
        }
        // Journal first (protocol doc §1/§2): the receipt lands durably before any engine call. The
        // first admission counts as attempt 1; the insert is a no-op when the fingerprint already exists.
        const now = Date.now()
        const dedupKey = sha256(`${scheduleID}:${input.method}:${JSON.stringify(input.headers)}:${input.rawBody}`)
        yield* triggerStore.insertReceipt({
          id: crypto.randomUUID(),
          schedule_id: scheduleID,
          received_at: now,
          dedup_key: dedupKey,
          body_base64: input.rawBody,
          headers: JSON.stringify({ method: input.method, query: input.query, headers: input.headers }),
          state: "received",
          engine_result: null,
          checkpoint: null,
          attempts: 1,
          // Guards the scheduler replay against racing this in-flight admission.
          next_retry_at: now + LEASE_MS,
          time_created: now,
          time_updated: now,
        })
        const receipt = yield* triggerStore.findReceipt(scheduleID, dedupKey)
        if (!receipt) return yield* Effect.fail(new ConflictError("receipt_missing", "The webhook receipt could not be journaled."))
        // A processed receipt replays its durable result without another engine call.
        if (receipt.state === "processed") return receipt.engine_result ? JSON.parse(receipt.engine_result) : null
        if (receipt.state === "failed")
          return yield* Effect.fail(new ConflictError("receipt_failed", "The webhook receipt exhausted its replay attempts."))
        return yield* processReceipt(row, receipt)
      }),

    pollOnce: (scheduleID) =>
      Effect.gen(function* () {
        const row = yield* triggerStore.get(scheduleID)
        if (!row) return yield* Effect.fail(new NotFoundError(scheduleID))
        if (row.status === "suspended")
          return yield* Effect.fail(new ConflictError("trigger_suspended", "The trigger is suspended after a permanent error; recover it manually."))
        const now = Date.now()
        const claimed = yield* triggerStore.claim(scheduleID, now, LEASE_MS)
        if (!claimed) return yield* Effect.fail(new NotFoundError(scheduleID))
        return yield* runPoll(claimed, claimed.lease_epoch)
      }),

    pollDueTriggers: () =>
      Effect.gen(function* () {
        const now = Date.now()
        // Receipt reconciliation (protocol doc §2): replay still-`received` receipts past their
        // retry time; the claim bumps attempts and pushes the re-claim guard out, so a second pod
        // cannot double-replay within the window.
        const stale = yield* triggerStore.claimStaleReceipts(now, RECEIPT_MAX_ATTEMPTS, LEASE_MS)
        for (const receipt of stale) {
          const row = yield* triggerStore.get(receipt.schedule_id)
          if (!row || row.status !== "active") {
            yield* triggerStore.recordReceiptFailure({
              id: receipt.id,
              nextRetryAt: now,
              failed: true,
              engineResult: JSON.stringify({ error: { code: "trigger_inactive", message: "The trigger is no longer active." } }),
            })
            continue
          }
          yield* processReceipt(row, receipt).pipe(
            Effect.catch((error) =>
              Effect.logWarning("connector trigger receipt replay failed", {
                id: receipt.id,
                message: error instanceof Error ? error.message : String(error),
              }),
            ),
          )
        }
        const claimed = yield* triggerStore.claimDue(now, LEASE_MS)
        for (const row of claimed) {
          yield* runPoll(row, row.lease_epoch).pipe(
            Effect.catch((error) =>
              Effect.logWarning("connector trigger poll failed", {
                id: row.id,
                message: error instanceof Error ? error.message : String(error),
              }),
            ),
          )
        }
        // Leftover delivery: runPoll sweeps its schedule's undelivered events after every commit,
        // so events orphaned by a crash between commit and delivery ride the next poll pass.
        return { polled: claimed.length }
      }),

    deliverEvent: (input) =>
      options.deliverEvent
        ? options.deliverEvent(input).pipe(Effect.catch(() => Effect.succeed(false)))
        : Effect.succeed(false),

    reconcileOrphans: () =>
      Effect.gen(function* () {
        const [engineConnections, known] = yield* Effect.all([engine.listConnections(), store.listAllEngineConnectionIds()])
        const knownIds = new Set(known)
        let removed = 0
        for (const connection of engineConnections) {
          if (knownIds.has(connection.id)) continue
          yield* engine
            .deleteConnection({ service: connection.service, engineConnectionName: connection.engineConnectionName })
            .pipe(
              Effect.flatMap(() => Effect.sync(() => (removed += 1))),
              Effect.catch(() => Effect.logWarning("connector reconcile missed engine connection", { id: connection.id })),
            )
        }
        return { removed }
      }),
  }
}

export const layer = (options: Options): Layer.Layer<Service, never, Store | TriggerStore | ConnectorEngine.Service> =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      return Service.of(make(yield* Store, yield* TriggerStore, yield* ConnectorEngine.Service, options))
    }),
  )
