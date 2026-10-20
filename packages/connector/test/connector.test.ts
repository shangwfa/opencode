import { describe, expect, it } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { ConnectorConnection } from "@opencode/schema/connector-connection"
import { Connector } from "@opencode/connector/adapter/connector"
import { ConnectorEngine, EngineError } from "@opencode/connector/adapter/engine"

const OWNER = "ses_owner"
const CHILD = "ses_child"

const makeStore = (rows: Connector.Row[] = [], oauthRows: Connector.OAuthRequestRow[] = []) => {
  const table = [...rows]
  const deleted: string[] = []
  const oauthRequests = [...oauthRows]
  return {
    table,
    deleted,
    oauthRequests,
    store: {
      resolveOwner: (sessionID: string) => Effect.succeed(sessionID === CHILD ? OWNER : sessionID),
      insert: (row: Connector.Row) =>
        Effect.sync(() => {
          table.push(row)
        }),
      listBySession: (sessionID: string) => Effect.succeed(table.filter((row) => row.session_id === sessionID)),
      delete: (id: ConnectorConnection.ID) =>
        Effect.sync(() => {
          const index = table.findIndex((row) => row.id === id)
          if (index >= 0) deleted.push(table.splice(index, 1)[0]!.id)
        }),
      deleteBySession: (sessionID: string) =>
        Effect.sync(() => {
          for (let index = table.length - 1; index >= 0; index--) {
            if (table[index]!.session_id === sessionID) deleted.push(table.splice(index, 1)[0]!.id)
          }
        }),
    listAllEngineConnectionIds: () => Effect.succeed(table.map((row) => row.engine_connection_id)),
      insertOAuthRequest: (row: Connector.OAuthRequestRow) =>
        Effect.sync(() => {
          if (oauthRequests.some((existing) => existing.connection_request_id === row.connection_request_id)) return false
          oauthRequests.push(row)
          return true
        }),
      updateOAuthRequestState: (connectionRequestId: string, state: string) =>
        Effect.sync(() => {
          const index = oauthRequests.findIndex((row) => row.connection_request_id === connectionRequestId)
          if (index >= 0) oauthRequests[index] = { ...oauthRequests[index]!, state }
        }),
      listOAuthRequestsBySession: (sessionID: string) =>
        Effect.succeed(oauthRequests.filter((row) => row.session_id === sessionID)),
    } satisfies Connector.StoreInterface,
  }
}

const makeEngine = (
  options: { insertFails?: boolean; connectionStatus?: string; accountDisplayName?: string } = {},
) => {
  const calls: Array<{ method: string; input: unknown }> = []
  let connection = 0
  let token = 0
  const engine: ConnectorEngine.Interface = {
    actionsForService: () => Effect.succeed([]),
    executeScopedAction: () => Effect.succeed(undefined),
    createConnection: (input) =>
      Effect.sync(() => {
        calls.push({ method: "createConnection", input })
        return {
          id: `eng_${++connection}`,
          engineConnectionName: `name_${connection}`,
          service: input.service,
          authType: input.authType,
        }
      }),
    deleteConnection: (input) =>
      Effect.sync(() => {
        calls.push({ method: "deleteConnection", input })
      }),
    createRuntimeToken: (input) =>
      Effect.sync(() => {
        calls.push({ method: "createRuntimeToken", input })
        return { id: `tok_${++token}`, token: `oct_secret_${token}` }
      }),
    revokeRuntimeToken: (id) =>
      Effect.sync(() => {
        calls.push({ method: "revokeRuntimeToken", input: id })
      }),
    listRuntimeTokens: () =>
      Effect.succeed(
        calls
          .filter((call) => call.method === "createRuntimeToken")
          .map((call, index) => ({ id: `tok_${index + 1}`, name: (call.input as { name: string }).name })),
      ),
    listConnections: () =>
      Effect.succeed([
        { id: "eng_1", engineConnectionName: "name_1", service: "github", authType: "api_key" },
        { id: "eng_orphan", engineConnectionName: "name_orphan", service: "notion", authType: "api_key" },
      ]),
    handleMcp: (input) => Effect.succeed({ status: 200, body: { ok: true, authorization: input.authorization } }),
    runtimeCall: (input) =>
      Effect.sync(() => {
        calls.push({ method: "runtimeCall", input })
        return { echoed: input }
      }),
    startOAuth: (input) =>
      Effect.sync(() => {
        calls.push({ method: "startOAuth", input })
        return { authorizationUrl: `https://provider/auth?service=${input.service}`, connectionRequestId: "creq_1", expiresAt: "2026-10-11T00:00:00Z" }
      }),
    connectionRequest: (id) =>
      Effect.succeed(
        id === "creq_1"
          ? { status: "connected", appId: "eng_9", errorCode: null }
          : { status: id === "creq_pending" ? "initiated" : "failed", appId: undefined, errorCode: id === "creq_pending" ? null : "oauth_denied" },
      ),
    getConnection: (id) =>
      Effect.sync(() => {
        calls.push({ method: "getConnection", input: id })
        return {
          id,
          engineConnectionName: `name_${id}`,
          service: "github",
          authType: "oauth2",
          status: options.connectionStatus ?? "active",
          profile: { accountId: "acct_1", displayName: options.accountDisplayName ?? "GH User" },
        }
      }),
    reconnect: (id) =>
      Effect.sync(() => {
        calls.push({ method: "reconnect", input: id })
        return { authorizationUrl: `https://provider/reconnect?app=${id}`, connectionRequestId: "creq_reconnect", expiresAt: "2026-10-11T00:00:00Z" }
      }),
    runs: (input) =>
      Effect.sync(() => {
        calls.push({ method: "runs", input })
        return { items: [{ id: "run_1", ok: true }], nextCursor: "cursor_2" }
      }),
    providers: () =>
      Effect.succeed([
        {
          service: "github",
          displayName: "GitHub",
          description: "Code hosting and collaboration",
          categories: ["developer"],
          authTypes: ["api_key", "oauth2"],
          homepageUrl: "https://github.com",
        },
        {
          service: "notion",
          displayName: "Notion",
          categories: ["productivity"],
          authTypes: ["oauth2"],
        },
      ]),
    provider: (service) =>
      Effect.succeed({
        service,
        displayName: service,
        categories: ["developer"],
        authTypes: ["api_key", "oauth2"],
        actions: [{ id: `${service}.list`, name: "list", operationType: "read" }],
      }),
    proxy: (input) =>
      Effect.sync(() => {
        calls.push({ method: "proxy", input })
        return { echoed: input }
      }),
    createFile: (input) =>
      Effect.sync(() => {
        calls.push({ method: "createFile", input })
        return {
          fileId: "file_1.bin",
          downloadUrl: `http://engine/connector/api/files/file_1.bin`,
          sizeBytes: input.data.byteLength,
          name: input.name,
          mimeType: input.mimeType ?? "application/octet-stream",
        }
      }),
    readFile: (fileId) =>
      Effect.sync(() => {
        calls.push({ method: "readFile", input: fileId })
        return { contentType: "application/octet-stream", data: new Uint8Array([1, 2, 3]) }
      }),
    triggerExecute: (input) =>
      Effect.sync(() => {
        calls.push({ method: "triggerExecute", input })
        if (input.operation === "reconcile") {
          return { outcome: "ready", checkpoint: { cursor: 1 }, subscription: { id: `sub_${(input.body as { requestKey: string }).requestKey}` }, reconcileAt: 1_000 }
        }
        if (input.operation === "receive") {
          return { result: { outcome: "event", outputs: { ok: true } }, checkpoint: { cursor: 2 }, subscription: { id: "sub_x" }, reconcileAt: 2_000 }
        }
        return { events: [], checkpoint: { cursor: 3 }, hasMore: false }
      }),
    putOAuthClient: (input) =>
      Effect.sync(() => {
        calls.push({ method: "putOAuthClient", input })
      }),
    oauthPassthrough: () => Effect.succeed({ status: 302, location: "/done", contentType: "text/html", body: "" }),
  }
  return {
    calls,
    engine,
    insertFails: options.insertFails ?? false,
  }
}

const makeTriggerStore = (rows: Connector.TriggerRow[] = []) => {
  const table = [...rows]
  const receipts: Connector.TriggerReceiptRow[] = []
  const events: Connector.TriggerEventRow[] = []
  return {
    table,
    receipts,
    events,
    store: {
      insert: (row: Connector.TriggerRow) =>
        Effect.sync(() => {
          table.push(row)
        }),
      // Snapshots like the PG store: a reader keeps the values it loaded, even if a writer commits meanwhile.
      get: (id: string) => Effect.sync(() => {
        const row = table.find((candidate) => candidate.id === id)
        return row && { ...row }
      }),
      listBySession: (sessionID: string) =>
        Effect.succeed(table.filter((row) => row.session_id === sessionID).map((row) => ({ ...row }))),
      delete: (id: string) =>
        Effect.sync(() => {
          const index = table.findIndex((row) => row.id === id)
          if (index >= 0) table.splice(index, 1)
        }),
      updateStatus: (id: string, status: string) =>
        Effect.sync(() => {
          const row = table.find((candidate) => candidate.id === id)
          if (row) Object.assign(row, { status, time_updated: Date.now() })
        }),
      updateTokenState: (id: string, state: string) =>
        Effect.sync(() => {
          const row = table.find((candidate) => candidate.id === id)
          if (row) Object.assign(row, { token_state: state, time_updated: Date.now() })
        }),
      claimDue: (now: number, leaseMs: number) =>
        Effect.sync(() =>
          table
            .filter((row) => row.status === "active" && row.next_run_at <= now && row.lease_until < now)
            .map((row) => {
              const claimed = { ...row, lease_epoch: row.lease_epoch + 1, lease_until: now + leaseMs }
              Object.assign(row, claimed)
              return { ...claimed }
            }),
        ),
      claim: (id: string, now: number, leaseMs: number) =>
        Effect.sync(() => {
          const row = table.find((candidate) => candidate.id === id)
          if (!row || row.status !== "active" || row.lease_until >= now) return undefined
          const claimed = { ...row, lease_epoch: row.lease_epoch + 1, lease_until: now + leaseMs }
          Object.assign(row, claimed)
          return { ...claimed }
        }),
      savePollPage: (input: Parameters<Connector.TriggerStoreInterface["savePollPage"]>[0]) =>
        Effect.sync(() => {
          const row = table.find((candidate) => candidate.id === input.id)
          if (!row || row.lease_epoch !== input.expectedEpoch) return false
          for (const event of input.events) {
            if (events.some((existing) => existing.schedule_id === input.id && existing.delivery_key === event.deliveryKey)) continue
            events.push({
              id: crypto.randomUUID(),
              schedule_id: input.id,
              delivery_key: event.deliveryKey,
              payload: event.payload,
              delivered_at: null,
              time_created: Date.now(),
              time_updated: Date.now(),
            })
          }
          Object.assign(row, {
            checkpoint: input.checkpoint,
            checkpoint_revision: row.checkpoint_revision + 1,
            last_result: input.lastResult,
            next_run_at: input.nextRunAt,
            poll_attempts: 0,
          })
          return true
        }),
      recordPollFailure: (input: Parameters<Connector.TriggerStoreInterface["recordPollFailure"]>[0]) =>
        Effect.sync(() => {
          const row = table.find((candidate) => candidate.id === input.id)
          if (!row || row.lease_epoch !== input.expectedEpoch) return false
          Object.assign(row, {
            last_result: input.lastResult,
            next_run_at: input.nextRunAt,
            poll_attempts: row.poll_attempts + 1,
            ...(input.suspend ? { status: "suspended" } : {}),
          })
          return true
        }),
      insertReceipt: (row: Connector.TriggerReceiptRow) =>
        Effect.sync(() => {
          if (receipts.some((existing) => existing.schedule_id === row.schedule_id && existing.dedup_key === row.dedup_key)) return false
          receipts.push(row)
          return true
        }),
      findReceipt: (scheduleId: string, dedupKey: string) =>
        Effect.succeed(receipts.find((row) => row.schedule_id === scheduleId && row.dedup_key === dedupKey)),
      claimStaleReceipts: (now: number, maxAttempts: number, reclaimMs: number) =>
        Effect.sync(() => {
          for (const receipt of receipts) {
            if (receipt.state === "received" && receipt.next_retry_at <= now && receipt.attempts >= maxAttempts)
              Object.assign(receipt, { state: "failed", time_updated: now })
          }
          const claimed: Connector.TriggerReceiptRow[] = []
          for (const receipt of receipts) {
            if (receipt.state !== "received" || receipt.next_retry_at > now || receipt.attempts >= maxAttempts) continue
            Object.assign(receipt, { attempts: receipt.attempts + 1, next_retry_at: now + reclaimMs, time_updated: now })
            claimed.push({ ...receipt })
          }
          return claimed
        }),
      completeReceipt: (input: Parameters<Connector.TriggerStoreInterface["completeReceipt"]>[0]) =>
        Effect.sync(() => {
          const row = table.find((candidate) => candidate.id === input.scheduleId)
          const receipt = receipts.find((candidate) => candidate.id === input.id)
          if (!row || row.checkpoint_revision !== input.expectedRevision) return false
          if (!receipt || receipt.state !== "received") return false
          Object.assign(row, {
            checkpoint: input.checkpoint,
            checkpoint_revision: row.checkpoint_revision + 1,
          })
          Object.assign(receipt, {
            state: "processed",
            engine_result: input.engineResult,
            checkpoint: input.checkpoint,
          })
          return true
        }),
      recordReceiptFailure: (input: Parameters<Connector.TriggerStoreInterface["recordReceiptFailure"]>[0]) =>
        Effect.sync(() => {
          const receipt = receipts.find((candidate) => candidate.id === input.id)
          if (!receipt || receipt.state !== "received") return
          Object.assign(receipt, {
            engine_result: input.engineResult,
            next_retry_at: input.nextRetryAt,
            state: input.failed ? "failed" : "received",
          })
        }),
      listUndeliveredEvents: (scheduleId: string) =>
        Effect.succeed(events.filter((event) => event.schedule_id === scheduleId && event.delivered_at === null)),
      markDelivered: (ids: ReadonlyArray<string>) =>
        Effect.sync(() => {
          for (const event of events) {
            if (ids.includes(event.id)) Object.assign(event, { delivered_at: Date.now() })
          }
        }),
    } satisfies Connector.TriggerStoreInterface,
  }
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect)

const expectSuccess = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  const exit = await run(effect)
  if (!Exit.isSuccess(exit)) throw new Error(`expected success, got failure: ${String(exit.cause)}`)
  return exit.value
}

const expectFailure = async <A, E>(effect: Effect.Effect<A, E>): Promise<E> => {
  const exit = await run(effect)
  if (Exit.isSuccess(exit)) throw new Error("expected failure, got success")
  return Cause.squash(exit.cause) as E
}

const row = (overrides: Partial<Connector.Row> = {}): Connector.Row => ({
  id: ConnectorConnection.ID.create(),
  session_id: OWNER,
  engine_connection_id: "eng_1",
  engine_connection_name: "name_1",
  service: "github",
  alias: "github",
  auth_type: "api_key",
  status: "active",
  time_created: 1,
  time_updated: 1,
  ...overrides,
})

const service = (
  store: Connector.StoreInterface,
  engine: ConnectorEngine.Interface,
  options: { mcpUrl?: string; webhookUrl?: string; fileUrlBase?: string } = {},
) =>
  Connector.make(store, makeTriggerStore().store, engine, {
    mcpUrl: options.mcpUrl,
    mcpName: "connector",
    webhookUrl: options.webhookUrl,
    fileUrlBase: options.fileUrlBase,
  })

const triggerService = (
  store: Connector.StoreInterface,
  triggerStore: Connector.TriggerStoreInterface,
  engine: ConnectorEngine.Interface,
  options: { mcpUrl?: string; webhookUrl?: string; fileUrlBase?: string } = {},
) =>
  Connector.make(store, triggerStore, engine, {
    mcpUrl: options.mcpUrl,
    mcpName: "connector",
    webhookUrl: options.webhookUrl,
    fileUrlBase: options.fileUrlBase,
  })

describe("Connector.associate", () => {
  it("creates the engine connection and records it under the session resource owner", async () => {
    const fake = makeEngine()
    const { store } = makeStore()
    const created = await expectSuccess(
      service(store, fake.engine).associate(CHILD, {
        service: "github",
        authType: "api_key",
        values: { apiKey: "secret" },
        alias: "work",
      }),
    )
    expect(created.engineConnectionID).toBe("eng_1")
    expect(created.alias).toBe("work")
    const calls = fake.calls.map((call) => call.method)
    expect(calls).toContain("createConnection")
    const saved = await expectSuccess(store.listBySession(OWNER))
    expect(saved).toHaveLength(1)
    expect(saved[0]!.session_id).toBe(OWNER)
    expect(saved[0]!.engine_connection_id).toBe("eng_1")
  })

  it("compensates by deleting the engine connection when persistence fails", async () => {
    const fake = makeEngine()
    const failingStore: Connector.StoreInterface = {
      ...makeStore().store,
      insert: () => Effect.die("db down"),
    }
    const error = await expectFailure(
      service(failingStore, fake.engine).associate(OWNER, {
        service: "github",
        authType: "api_key",
        values: { apiKey: "secret" },
      }),
    )
    expect(error).toBeInstanceOf(Connector.ConflictError)
    expect((error as Connector.ConflictError).code).toBe("persist_failed")
    expect(fake.calls.map((call) => call.method)).toEqual(["createConnection", "deleteConnection"])
  })
})

describe("Connector.list / remove", () => {
  it("lists only the resource owner's connections and hides deleted rows", async () => {
    const { store } = makeStore([row(), row({ id: ConnectorConnection.ID.create(), engine_connection_id: "eng_2", status: "deleted" })])
    const listed = await expectSuccess(service(store, makeEngine().engine).list(CHILD))
    expect(listed).toHaveLength(1)
    expect(listed[0]!.engineConnectionID).toBe("eng_1")
  })

  it("refuses to remove another session's connection", async () => {
    const fake = makeEngine()
    const target = row({ session_id: "ses_other" })
    const { store } = makeStore([target])
    const error = await expectFailure(service(store, fake.engine).remove(OWNER, target.id))
    expect(error).toBeInstanceOf(Connector.NotFoundError)
    expect(fake.calls).toHaveLength(0)
  })

  it("deletes the engine connection and the row", async () => {
    const fake = makeEngine()
    const target = row()
    const { store } = makeStore([target])
    await expectSuccess(service(store, fake.engine).remove(CHILD, target.id))
    expect(fake.calls.map((call) => call.method)).toEqual(["deleteConnection"])
    expect(await expectSuccess(store.listBySession(OWNER))).toHaveLength(0)
  })
})

describe("Connector.cleanupSession", () => {
  it("removes engine connections, session tokens and rows even when engine deletes fail", async () => {
    const fake = makeEngine()
    const store = makeStore([
      row(),
      row({ id: ConnectorConnection.ID.create(), engine_connection_id: "eng_2", engine_connection_name: "name_2" }),
    ])
    const broken: ConnectorEngine.Interface = {
      ...fake.engine,
      deleteConnection: () => Effect.fail(new EngineError("engine_error", "boom")),
      listRuntimeTokens: () => Effect.succeed([{ id: "tok_1", name: "ccon-session-ses_owner" }, { id: "tok_2", name: "other" }]),
    }
    await expectSuccess(service(store.store, broken).cleanupSession(OWNER))
    expect(await expectSuccess(store.store.listBySession(OWNER))).toHaveLength(0)
    const revoked = fake.calls.filter((call) => call.method === "revokeRuntimeToken")
    expect(revoked.map((call) => call.input)).toEqual(["tok_1"])
  })
})

describe("Connector discovery / executeAction", () => {
  it("mints an ephemeral token scoped to the session's connections and revokes it afterwards", async () => {
    const fake = makeEngine()
    const { store } = makeStore([row()])
    const result = await expectSuccess(service(store, fake.engine).searchActions(CHILD, { query: "issue", limit: 5 }))
    expect((result as { echoed: { path: string } }).echoed.path).toContain("/v1/actions/search?query=issue&limit=5")
    const tokens = fake.calls.filter((call) => call.method === "createRuntimeToken")
    expect(tokens).toHaveLength(1)
    expect((tokens[0]!.input as { allowedConnections: string[] }).allowedConnections).toEqual(["eng_1"])
    // Empty proxy allowlist would deny every proxy call in engine policy (bug #7).
    expect((tokens[0]!.input as { allowedProxies: string[] }).allowedProxies).toEqual(["*"])
    const revokes = fake.calls.filter((call) => call.method === "revokeRuntimeToken")
    expect(revokes).toHaveLength(1)
  })

  it("serves apps through the no-auth sentinel when the session has no active connections", async () => {
    const fake = makeEngine()
    const result = await expectSuccess(service(makeStore().store, fake.engine).apps(OWNER))
    expect((result as { echoed: { path: string } }).echoed.path).toBe("/v1/apps")
    const tokens = fake.calls.filter((call) => call.method === "createRuntimeToken")
    expect(tokens).toHaveLength(1)
    expect((tokens[0]!.input as { allowedConnections: string[] }).allowedConnections).toEqual(["no-auth-only"])
    expect(fake.calls.filter((call) => call.method === "revokeRuntimeToken")).toHaveLength(1)
  })

  it("executes no_auth actions without any connection and omits connectionId from the body", async () => {
    const fake = makeEngine()
    const result = await expectSuccess(
      service(makeStore().store, fake.engine).executeAction(OWNER, { actionId: "arxiv.search_papers", actionInput: { query: "effect systems" } }),
    )
    expect((result as { echoed: { path: string } }).echoed.path).toBe("/v1/actions/arxiv.search_papers")
    const call = fake.calls.find((entry) => entry.method === "runtimeCall")!
    expect((call.input as { body: Record<string, unknown> }).body.connectionId).toBeUndefined()
    const tokens = fake.calls.filter((entry) => entry.method === "createRuntimeToken")
    expect((tokens[0]!.input as { allowedConnections: string[] }).allowedConnections).toEqual(["no-auth-only"])
  })

  it("still scopes discovery and execution to the real connection when one exists", async () => {
    const fake = makeEngine()
    const { store } = makeStore([row()])
    await expectSuccess(service(store, fake.engine).apps(CHILD))
    const tokens = fake.calls.filter((call) => call.method === "createRuntimeToken")
    expect((tokens[0]!.input as { allowedConnections: string[] }).allowedConnections).toEqual(["eng_1"])
  })

  it("scopes executeAction to the requested connection and rejects unknown ones", async () => {
    const fake = makeEngine()
    const target = row()
    const { store } = makeStore([target, row({ id: ConnectorConnection.ID.create(), engine_connection_id: "eng_2", engine_connection_name: "name_2" })])
    await expectSuccess(service(store, fake.engine).executeAction(CHILD, { actionId: "github.create_issue", connectionID: target.id, actionInput: { title: "x" } }))
    const tokens = fake.calls.filter((call) => call.method === "createRuntimeToken")
    expect((tokens[0]!.input as { allowedConnections: string[] }).allowedConnections).toEqual(["eng_1"])
    const call = fake.calls.find((entry) => entry.method === "runtimeCall")
    expect((call!.input as { body: { connectionId?: string } }).body.connectionId).toBe("eng_1")
    const error = await expectFailure(
      service(store, fake.engine).executeAction(OWNER, { actionId: "github.create_issue", connectionID: ConnectorConnection.ID.create() }),
    )
    expect(error).toBeInstanceOf(Connector.NotFoundError)
  })

  it("injects the engine connectionId when the session has exactly one connection (bug #6)", async () => {
    const fake = makeEngine()
    const { store } = makeStore([row()])
    await expectSuccess(service(store, fake.engine).executeAction(CHILD, { actionId: "github.get_current_user" }))
    const call = fake.calls.find((entry) => entry.method === "runtimeCall")
    expect((call!.input as { body: { connectionId?: string } }).body.connectionId).toBe("eng_1")
  })

  it("requires an explicit connectionID when multiple connections are active", async () => {
    const fake = makeEngine()
    const { store } = makeStore([row(), row({ id: ConnectorConnection.ID.create(), engine_connection_id: "eng_2", engine_connection_name: "name_2" })])
    const error = await expectFailure(service(store, fake.engine).executeAction(OWNER, { actionId: "github.get_current_user" }))
    expect((error as Connector.ConflictError).code).toBe("connection_required")
    expect(fake.calls.filter((call) => call.method === "runtimeCall")).toHaveLength(0)
  })

  it("forwards idempotencyKey as the idempotency-key header on the runtime call", async () => {
    const fake = makeEngine()
    const target = row()
    const { store } = makeStore([target])
    await expectSuccess(
      service(store, fake.engine).executeAction(CHILD, {
        actionId: "github.create_issue",
        connectionID: target.id,
        idempotencyKey: "idem-1",
      }),
    )
    const call = fake.calls.find((entry) => entry.method === "runtimeCall")!
    expect((call.input as { headers?: Record<string, string> }).headers?.["idempotency-key"]).toBe("idem-1")
  })

  it("omits the idempotency-key header when no idempotencyKey is given", async () => {
    const fake = makeEngine()
    const { store } = makeStore([row()])
    await expectSuccess(service(store, fake.engine).executeAction(CHILD, { actionId: "github.get_current_user" }))
    const call = fake.calls.find((entry) => entry.method === "runtimeCall")!
    expect((call.input as { headers?: Record<string, string> }).headers).toBeUndefined()
  })
})

describe("Connector OAuth", () => {
  it("starts a request and completes it into an oauth2 connection bound to the owner", async () => {
    const fake = makeEngine()
    const { store } = makeStore()
    const started = await expectSuccess(service(store, fake.engine).startOAuth(CHILD, { service: "github" }))
    expect(String(started.connectionRequestID)).toBe("creq_1")
    const completed = await expectSuccess(service(store, fake.engine).completeOAuth(CHILD, { connectionRequestID: "creq_1", alias: "gh" }))
    expect(completed.status).toBe("connected")
    expect(completed.connection?.authType).toBe("oauth2")
    expect(completed.connection?.engineConnectionID).toBe("eng_9")
    const rows = await expectSuccess(store.listBySession(OWNER))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.session_id).toBe(OWNER)
    expect(rows[0]!.alias).toBe("gh")
  })

  it("reports pending and failed requests without persisting rows", async () => {
    const fake = makeEngine()
    const { store } = makeStore()
    const pending = await expectSuccess(service(store, fake.engine).completeOAuth(OWNER, { connectionRequestID: "creq_pending" }))
    expect(pending.status).toBe("initiated")
    const failed = await expectSuccess(service(store, fake.engine).completeOAuth(OWNER, { connectionRequestID: "creq_bad" }))
    expect(failed.status).toBe("failed")
    expect(String(failed.errorCode)).toBe("oauth_denied")
    expect(await expectSuccess(store.listBySession(OWNER))).toHaveLength(0)
  })

  it("is idempotent when the engine connection is already associated", async () => {
    const fake = makeEngine()
    const target = row({ engine_connection_id: "eng_9" })
    const { store } = makeStore([target])
    const completed = await expectSuccess(service(store, fake.engine).completeOAuth(OWNER, { connectionRequestID: "creq_1" }))
    expect(completed.connection?.id).toBe(target.id)
    expect(await expectSuccess(store.listBySession(OWNER))).toHaveLength(1)
  })
})

describe("Connector.reconcileOrphans", () => {
  it("deletes engine connections without a SaaS row and keeps referenced ones", async () => {
    const fake = makeEngine()
    const { store } = makeStore([row()])
    const result = await expectSuccess(service(store, fake.engine).reconcileOrphans())
    expect(result.removed).toBe(1)
    const deletions = fake.calls.filter((call) => call.method === "deleteConnection")
    expect(deletions).toHaveLength(1)
    expect((deletions[0]!.input as { engineConnectionName: string }).engineConnectionName).toBe("name_orphan")
  })

  it("reports zero when every engine connection is referenced", async () => {
    const fake = makeEngine()
    const { store } = makeStore([row(), row({ id: ConnectorConnection.ID.create(), engine_connection_id: "eng_orphan" })])
    const result = await expectSuccess(service(store, fake.engine).reconcileOrphans())
    expect(result.removed).toBe(0)
  })
})

describe("Connector.list engine status", () => {
  it("merges engine status and the account label into each row", async () => {
    const fake = makeEngine({ connectionStatus: "reauth_required", accountDisplayName: "octocat" })
    const { store } = makeStore([row()])
    const listed = await expectSuccess(service(store, fake.engine).list(CHILD))
    expect(listed).toHaveLength(1)
    expect(listed[0]!.engineStatus).toBe("reauth_required")
    expect(listed[0]!.accountLabel).toBe("octocat")
  })

  it("marks rows the engine no longer knows as disconnected and other failures as error", async () => {
    const target = row()
    const gone = makeEngine()
    const missing: ConnectorEngine.Interface = {
      ...gone.engine,
      getConnection: (id: string) => Effect.fail(new EngineError("app_not_found", `Connection not found: ${id}.`)),
    }
    const listedMissing = await expectSuccess(service(makeStore([target]).store, missing).list(OWNER))
    expect(listedMissing[0]!.engineStatus).toBe("disconnected")
    expect(listedMissing[0]!.accountLabel).toBeUndefined()

    const broken = makeEngine()
    const failing: ConnectorEngine.Interface = {
      ...broken.engine,
      getConnection: () => Effect.fail(new EngineError("engine_unavailable", "boom")),
    }
    const listedFailing = await expectSuccess(service(makeStore([row()]).store, failing).list(OWNER))
    expect(listedFailing[0]!.engineStatus).toBe("error")
  })
})

describe("Connector OAuth request ledger", () => {
  const oauthRow = (overrides: Partial<Connector.OAuthRequestRow> = {}): Connector.OAuthRequestRow => ({
    connection_request_id: "creq_1",
    session_id: OWNER,
    service: "github",
    state: "initiated",
    alias: null,
    time_created: 1,
    time_updated: 1,
    ...overrides,
  })

  it("records an initiated request on start and the connected state on completion", async () => {
    const fake = makeEngine()
    const { store, oauthRequests } = makeStore()
    await expectSuccess(service(store, fake.engine).startOAuth(CHILD, { service: "github", alias: "gh" }))
    expect(oauthRequests).toHaveLength(1)
    expect(oauthRequests[0]).toMatchObject({
      connection_request_id: "creq_1",
      session_id: OWNER,
      service: "github",
      state: "initiated",
      alias: "gh",
    })
    await expectSuccess(service(store, fake.engine).completeOAuth(OWNER, { connectionRequestID: "creq_1" }))
    expect(oauthRequests[0]!.state).toBe("connected")
  })

  it("settles failed requests and leaves pending requests initiated", async () => {
    const fake = makeEngine()
    const { store, oauthRequests } = makeStore([], [oauthRow({ connection_request_id: "creq_bad" }), oauthRow({ connection_request_id: "creq_pending" })])
    await expectSuccess(service(store, fake.engine).completeOAuth(OWNER, { connectionRequestID: "creq_bad" }))
    await expectSuccess(service(store, fake.engine).completeOAuth(OWNER, { connectionRequestID: "creq_pending" }))
    expect(oauthRequests.find((row) => row.connection_request_id === "creq_bad")!.state).toBe("failed")
    expect(oauthRequests.find((row) => row.connection_request_id === "creq_pending")!.state).toBe("initiated")
  })

  it("lists the owner's requests and refreshes non-terminal ones best-effort", async () => {
    const fake = makeEngine()
    const { store } = makeStore(
      [],
      [
        oauthRow({ connection_request_id: "creq_bad" }),
        oauthRow({ connection_request_id: "creq_pending" }),
        oauthRow({ connection_request_id: "creq_done", state: "connected" }),
        oauthRow({ connection_request_id: "creq_other", session_id: "ses_other" }),
      ],
    )
    const listed = await expectSuccess(service(store, fake.engine).listOAuthRequests(CHILD))
    expect(listed.map((request) => [String(request.connectionRequestID), request.status])).toEqual([
      ["creq_bad", "failed"],
      ["creq_pending", "initiated"],
      ["creq_done", "connected"],
    ])
    expect(listed[0]!.time).toEqual({ created: 1, updated: 1 })
  })
})

describe("Connector.reconnectOAuth", () => {
  it("restarts authorization for the owner's connection and returns the request handle", async () => {
    const fake = makeEngine()
    const target = row()
    const { store } = makeStore([target])
    const started = await expectSuccess(service(store, fake.engine).reconnectOAuth(CHILD, target.id))
    expect(started.authorizationUrl).toContain("eng_1")
    expect(String(started.connectionRequestID)).toBe("creq_reconnect")
    expect(fake.calls.filter((call) => call.method === "reconnect").map((call) => call.input)).toEqual(["eng_1"])
  })

  it("refuses to reconnect another session's connection", async () => {
    const fake = makeEngine()
    const target = row({ session_id: "ses_other" })
    const { store } = makeStore([target])
    const error = await expectFailure(service(store, fake.engine).reconnectOAuth(OWNER, target.id))
    expect(error).toBeInstanceOf(Connector.NotFoundError)
    expect(fake.calls.filter((call) => call.method === "reconnect")).toHaveLength(0)
  })
})

describe("Connector.runs", () => {
  it("passes cursor and limit through and returns the engine page", async () => {
    const fake = makeEngine()
    const page = await expectSuccess(service(makeStore().store, fake.engine).runs({ cursor: "cursor_1", limit: 10 }))
    expect(page.items).toHaveLength(1)
    expect(String(page.nextCursor)).toBe("cursor_2")
    expect(fake.calls.filter((call) => call.method === "runs")[0]!.input).toEqual({ cursor: "cursor_1", limit: 10 })
  })
})

describe("Connector.catalog", () => {
  it("passes the engine provider directory through unchanged", async () => {
    const catalog = await expectSuccess(service(makeStore().store, makeEngine().engine).catalog())
    expect(catalog.providers.map((provider) => provider.service)).toEqual(["github", "notion"])
    const github = catalog.providers[0]
    expect(github?.displayName).toBe("GitHub")
    expect(github?.description).toBe("Code hosting and collaboration")
    expect(github?.categories).toEqual(["developer"])
    expect(github?.authTypes).toEqual(["api_key", "oauth2"])
    expect(github?.homepageUrl).toBe("https://github.com")
  })

  it("filters by service", async () => {
    const catalog = await expectSuccess(service(makeStore().store, makeEngine().engine).catalog({ service: "notion" }))
    expect(catalog.providers.map((provider) => provider.service)).toEqual(["notion"])
  })

  it("filters by authType across the directory", async () => {
    const catalog = await expectSuccess(service(makeStore().store, makeEngine().engine).catalog({ authType: "api_key" }))
    expect(catalog.providers.map((provider) => provider.service)).toEqual(["github"])
  })
})

describe("Connector.proxy", () => {
  it("routes through an ephemeral token and the real connection when one exists", async () => {
    const fake = makeEngine()
    const target = row()
    const { store } = makeStore([target])
    const result = await expectSuccess(
      service(store, fake.engine).proxy(CHILD, { service: "github", method: "GET", path: "/repos/owner/repo" }),
    )
    const proxyCalls = fake.calls.filter((call) => call.method === "proxy")
    expect(proxyCalls).toHaveLength(1)
    const input = proxyCalls[0]!.input as { token: string; path: string; connectionId?: string }
    expect(input.path).toBe("/repos/owner/repo")
    expect(input.connectionId).toBe("eng_1")
    expect(input.token).toBe("oct_secret_1")
    const tokens = fake.calls.filter((call) => call.method === "createRuntimeToken")
    expect((tokens[0]!.input as { allowedConnections: string[] }).allowedConnections).toEqual(["eng_1"])
    expect((result as { echoed: { service: string } }).echoed.service).toBe("github")
  })

  it("falls back to the no-auth sentinel when the session has zero connections", async () => {
    const fake = makeEngine()
    await expectSuccess(service(makeStore().store, fake.engine).proxy(OWNER, { service: "arxiv", method: "GET", path: "/feed" }))
    const tokens = fake.calls.filter((call) => call.method === "createRuntimeToken")
    expect((tokens[0]!.input as { allowedConnections: string[] }).allowedConnections).toEqual(["no-auth-only"])
    expect((fake.calls.find((call) => call.method === "proxy")!.input as { connectionId?: string }).connectionId).toBeUndefined()
  })
})

describe("Connector transit files", () => {
  it("uploads through the engine and rewrites the download URL to the SaaS endpoint", async () => {
    const fake = makeEngine()
    const { store } = makeStore()
    const uploaded = await expectSuccess(
      service(store, fake.engine, { fileUrlBase: "http://saas" }).uploadFile(OWNER, { name: "report.bin", mimeType: "application/pdf", data: new Uint8Array([1, 2, 3]) }),
    )
    expect(uploaded.fileId).toBe("file_1.bin")
    expect(uploaded.downloadUrl).toBe("http://saas/api/connector/files/file_1.bin")
    expect(uploaded.sizeBytes).toBe(3)
    expect(fake.calls.filter((call) => call.method === "createFile")).toHaveLength(1)
  })

  it("returns a relative download URL when no public base is configured", async () => {
    const uploaded = await expectSuccess(
      service(makeStore().store, makeEngine().engine).uploadFile(OWNER, { name: "x.bin", data: new Uint8Array([]) }),
    )
    expect(uploaded.downloadUrl).toBe("/api/connector/files/file_1.bin")
  })

  it("downloads stream engine bytes straight through", async () => {
    const fake = makeEngine()
    const file = await expectSuccess(service(makeStore().store, fake.engine).downloadFile("file_1.bin"))
    expect(Array.from(file.data)).toEqual([1, 2, 3])
    expect(fake.calls.filter((call) => call.method === "readFile").map((call) => call.input)).toEqual(["file_1.bin"])
  })
})

describe("Connector.startOAuth options", () => {
  it("forwards authorizationOptionIds to the engine", async () => {
    const fake = makeEngine()
    const { store } = makeStore()
    await expectSuccess(service(store, fake.engine).startOAuth(OWNER, { service: "slack", authorizationOptionIds: ["opt-workspace"] }))
    const started = fake.calls.find((call) => call.method === "startOAuth")!
    expect((started.input as { authorizationOptionIds?: string[] }).authorizationOptionIds).toEqual(["opt-workspace"])
  })
})

describe("Connector triggers", () => {
  const WEBHOOK = "https://saas/connector/webhook"

  it("creates a schedule: persistent scoped token, engine reconcile, durable row", async () => {
    const fake = makeEngine()
    const target = row()
    const { store } = makeStore([target])
    const triggers = makeTriggerStore()
    const created = await expectSuccess(
      triggerService(store, triggers.store, fake.engine, { webhookUrl: WEBHOOK }).createTrigger(CHILD, {
        service: "github",
        triggerId: "github.issues",
        config: { repo: "owner/repo" },
      }),
    )
    expect(String(created.id)).toStartWith("ctrg_")
    expect(created.status).toBe("active")
    const reconciles = fake.calls.filter((call) => call.method === "triggerExecute" && (call.input as { operation: string }).operation === "reconcile")
    expect(reconciles).toHaveLength(1)
    const input = reconciles[0]!.input as { token: string; connectionId?: string; body: { requestKey: string; endpointUrl: string; active: boolean } }
    expect(input.connectionId).toBe("eng_1")
    expect(input.body.active).toBe(true)
    expect(input.body.endpointUrl).toBe(`${WEBHOOK}/${created.id}`)
    expect(input.body.requestKey).toBe(`ccon-${created.id}`)
    // The token used for reconcile is the persistent one recorded on the row (not revoked afterwards).
    expect(triggers.table[0]!.engine_token).toBe(input.token)
    expect(fake.calls.filter((call) => call.method === "revokeRuntimeToken")).toHaveLength(0)
    expect(triggers.table[0]!.engine_subscription_id).toBe(`sub_ccon-${created.id}`)
  })

  it("refuses trigger creation without connections or webhook URL", async () => {
    const fake = makeEngine()
    const noConnections = await expectFailure(
      triggerService(makeStore().store, makeTriggerStore().store, fake.engine, { webhookUrl: WEBHOOK }).createTrigger(OWNER, { service: "github", triggerId: "t" }),
    )
    expect((noConnections as Connector.ConflictError).code).toBe("no_connections")
    const noWebhook = await expectFailure(
      triggerService(makeStore([row()]).store, makeTriggerStore().store, fake.engine).createTrigger(OWNER, { service: "github", triggerId: "t" }),
    )
    expect((noWebhook as Connector.ConflictError).code).toBe("webhook_url_missing")
    expect(fake.calls).toHaveLength(0)
  })

  it("forwards webhook deliveries to the engine receive and mirrors the checkpoint", async () => {
    const fake = makeEngine()
    const triggers = makeTriggerStore()
    const svc = triggerService(makeStore([row()]).store, triggers.store, fake.engine, { webhookUrl: WEBHOOK })
    const created = await expectSuccess(svc.createTrigger(OWNER, { service: "github", triggerId: "github.issues" }))
    const result = await expectSuccess(
      svc.handleWebhook(created.id, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": "sig" }, query: {}, rawBody: Buffer.from("{}").toString("base64") }),
    )
    const receive = fake.calls.find((call) => call.method === "triggerExecute" && (call.input as { operation: string }).operation === "receive")!
    const input = receive.input as { body: { subscriptionId: string; method: string; rawBody: string; admit: boolean } }
    expect(input.body.subscriptionId).toBe(`sub_ccon-${created.id}`)
    expect(input.body.method).toBe("POST")
    expect(input.body.admit).toBe(true)
    expect((result as { checkpoint: { cursor: number } }).checkpoint.cursor).toBe(2)
    expect(triggers.table[0]!.checkpoint).toBe(JSON.stringify({ cursor: 2 }))
    expect(triggers.table[0]!.checkpoint_revision).toBe(2)
  })

  it("rejects webhooks for unknown or unbound schedules", async () => {
    const fake = makeEngine()
    const triggers = makeTriggerStore()
    const svc = triggerService(makeStore().store, triggers.store, fake.engine, { webhookUrl: WEBHOOK })
    const error = await expectFailure(svc.handleWebhook(ConnectorConnection.TriggerID.create(), { method: "POST", headers: {}, query: {}, rawBody: "" }))
    expect(error).toBeInstanceOf(Connector.NotFoundError)
  })

  it("polls due schedules under the lease and advances the checkpoint", async () => {
    const fake = makeEngine()
    const triggers = makeTriggerStore()
    const svc = triggerService(makeStore([row()]).store, triggers.store, fake.engine, { webhookUrl: WEBHOOK })
    const created = await expectSuccess(svc.createTrigger(OWNER, { service: "github", triggerId: "github.issues" }))
    Object.assign(triggers.table[0]!, { next_run_at: Date.now() - 1 })
    const summary = await expectSuccess(svc.pollDueTriggers())
    expect(summary.polled).toBe(1)
    const read = fake.calls.find((call) => call.method === "triggerExecute" && (call.input as { operation: string }).operation === "read")!
    expect((read.input as { body: { checkpoint: unknown } }).body.checkpoint).toEqual({ cursor: 1 })
    expect(triggers.table[0]!.checkpoint).toBe(JSON.stringify({ cursor: 3 }))
  })

  it("cancels the schedule: engine deactivate with the original endpoint, token revoked, row cancelled", async () => {
    const fake = makeEngine()
    const triggers = makeTriggerStore()
    const { store } = makeStore([row()])
    const svc = triggerService(store, triggers.store, fake.engine, { webhookUrl: WEBHOOK })
    const created = await expectSuccess(svc.createTrigger(CHILD, { service: "github", triggerId: "github.issues" }))
    await expectSuccess(svc.cancelTrigger(OWNER, created.id))
    const deactivations = fake.calls.filter(
      (call) => call.method === "triggerExecute" && (call.input as { body: { active?: boolean } }).body.active === false,
    )
    expect(deactivations).toHaveLength(1)
    const input = deactivations[0]!.input as { body: { endpointUrl: string; subscriptionId?: string } }
    expect(input.body.endpointUrl).toBe(`${WEBHOOK}/${created.id}`)
    expect(input.body.subscriptionId).toBe(`sub_ccon-${created.id}`)
    expect(fake.calls.filter((call) => call.method === "revokeRuntimeToken").map((call) => call.input)).toContain(triggers.table[0]!.engine_token_id)
    expect(triggers.table[0]!.status).toBe("cancelled")
    // Cancel is idempotent and refuses foreign schedules.
    await expectSuccess(svc.cancelTrigger(OWNER, created.id))
    const foreign = await expectFailure(svc.cancelTrigger("ses_other", created.id))
    expect(foreign).toBeInstanceOf(Connector.NotFoundError)
  })
})

describe("Connector trigger token lifecycle", () => {
  const WEBHOOK = "https://saas/connector/webhook"

  const createdSchedule = async (overrides: Partial<ConnectorEngine.Interface> = {}) => {
    const fake = makeEngine()
    const triggers = makeTriggerStore()
    const { store } = makeStore([row()])
    const engine: ConnectorEngine.Interface = { ...fake.engine, ...overrides }
    const svc = triggerService(store, triggers.store, engine, { webhookUrl: WEBHOOK })
    const created = await expectSuccess(svc.createTrigger(OWNER, { service: "github", triggerId: "github.issues" }))
    return { fake, triggers, svc, id: created.id }
  }

  it("cancel moves the token retiring -> revoked", async () => {
    const { fake, triggers, svc, id } = await createdSchedule()
    await expectSuccess(svc.cancelTrigger(OWNER, id))
    expect(triggers.table[0]!.token_state).toBe("revoked")
    expect(triggers.table[0]!.status).toBe("cancelled")
    expect(fake.calls.filter((call) => call.method === "revokeRuntimeToken")).toHaveLength(1)
  })

  it("treats an engine 404 on revoke as already revoked", async () => {
    const { triggers, svc, id } = await createdSchedule({
      revokeRuntimeToken: () => Effect.fail(new EngineError("runtime_token_not_found", "gone", 404)),
    })
    await expectSuccess(svc.cancelTrigger(OWNER, id))
    expect(triggers.table[0]!.token_state).toBe("revoked")
    expect(triggers.table[0]!.status).toBe("cancelled")
  })

  it("keeps the token retiring when the revoke fails for any other reason", async () => {
    const { triggers, svc, id } = await createdSchedule({
      revokeRuntimeToken: () => Effect.fail(new EngineError("engine_unavailable", "boom", 503)),
    })
    await expectSuccess(svc.cancelTrigger(OWNER, id))
    expect(triggers.table[0]!.token_state).toBe("retiring")
    expect(triggers.table[0]!.status).toBe("cancelled")
  })

  it("cleanupSession retries revoke for a cancelled schedule still retiring", async () => {
    let attempts = 0
    const { fake, triggers, svc, id } = await createdSchedule({
      revokeRuntimeToken: () => {
        attempts += 1
        return attempts === 1 ? Effect.fail(new EngineError("engine_unavailable", "boom", 503)) : Effect.void
      },
    })
    await expectSuccess(svc.cancelTrigger(OWNER, id))
    expect(triggers.table[0]!.token_state).toBe("retiring")
    await expectSuccess(svc.cleanupSession(OWNER))
    expect(triggers.table[0]!.token_state).toBe("revoked")
    expect(fake.calls.filter((call) => call.method === "createRuntimeToken")).toHaveLength(1)
  })
})

type TriggerExecute = ConnectorEngine.Interface["triggerExecute"]
type FakeEngine = ReturnType<typeof makeEngine>
type TriggerFixture = ReturnType<typeof makeTriggerStore>

const HOUR = 3_600_000
const FIFTEEN_MINUTES = 15 * 60_000
const WEBHOOK_URL = "https://saas/connector/webhook"
const webhook = { method: "POST", headers: { "x-event": "1" }, query: {}, rawBody: Buffer.from("{}").toString("base64") }

const only = <T>(rows: ReadonlyArray<T>): T => {
  const [first] = rows
  if (first === undefined) throw new Error("expected exactly one row")
  return first
}

/** Routes one trigger operation to `impl`; every other operation (reconcile, deactivate) reaches the fake. */
const onTriggerOperation = (fake: FakeEngine, operation: string, impl: TriggerExecute): TriggerExecute =>
  (input) => (input.operation === operation ? impl(input) : fake.engine.triggerExecute(input))

const triggerHarness = (configure: (fake: FakeEngine, triggers: TriggerFixture) => Partial<ConnectorEngine.Interface> = () => ({})) => {
  const fake = makeEngine()
  const triggers = makeTriggerStore()
  const engine: ConnectorEngine.Interface = { ...fake.engine, ...configure(fake, triggers) }
  const svc = triggerService(makeStore([row()]).store, triggers.store, engine, { webhookUrl: WEBHOOK_URL })
  return { fake, triggers, svc }
}

const createSchedule = (svc: ReturnType<typeof triggerService>) =>
  expectSuccess(svc.createTrigger(OWNER, { service: "github", triggerId: "github.issues" }))

/** Keeps the poll scheduler out of a receipt-focused test by pushing the schedule far into the future. */
const parkSchedule = (triggers: TriggerFixture) => Object.assign(only(triggers.table), { next_run_at: Date.now() + HOUR })

/** Makes the schedule due and unleased so the next scheduler pass claims it. */
const makeDue = (triggers: TriggerFixture) => Object.assign(only(triggers.table), { next_run_at: 0, lease_until: 0 })

describe("Connector trigger receipts", () => {
  it("journals the receipt as received before the engine receive and settles it with the checkpoint", async () => {
    const seen: string[] = []
    const { triggers, svc } = triggerHarness((fake, triggers) => ({
      triggerExecute: onTriggerOperation(fake, "receive", (input) => {
        seen.push(...triggers.receipts.map((receipt) => receipt.state))
        return fake.engine.triggerExecute(input)
      }),
    }))
    const created = await createSchedule(svc)
    parkSchedule(triggers)
    const result = await expectSuccess(svc.handleWebhook(created.id, webhook))
    expect(seen).toEqual(["received"])
    expect(triggers.receipts).toHaveLength(1)
    expect(only(triggers.receipts).state).toBe("processed")
    expect(only(triggers.receipts).engine_result).toBe(JSON.stringify(result))
    expect(only(triggers.table).checkpoint).toBe(JSON.stringify({ cursor: 2 }))
    expect(only(triggers.table).checkpoint_revision).toBe(2)
  })

  it("keeps a failed receive journaled as received and replays it from the scheduler", async () => {
    let failing = true
    const { fake, triggers, svc } = triggerHarness((fake) => ({
      triggerExecute: onTriggerOperation(fake, "receive", (input) =>
        failing ? Effect.fail(new EngineError("engine_unavailable", "boom", 503)) : fake.engine.triggerExecute(input),
      ),
    }))
    const created = await createSchedule(svc)
    parkSchedule(triggers)
    const before = Date.now()
    const error = await expectFailure(svc.handleWebhook(created.id, webhook))
    expect(error).toBeInstanceOf(EngineError)
    expect(only(triggers.receipts)).toMatchObject({ state: "received", attempts: 1 })
    expect(only(triggers.receipts).next_retry_at).toBeGreaterThanOrEqual(before + 500)
    expect(only(triggers.receipts).next_retry_at).toBeLessThanOrEqual(Date.now() + 1000)
    expect(only(triggers.table).checkpoint_revision).toBe(1)

    failing = false
    Object.assign(only(triggers.receipts), { next_retry_at: 0 })
    await expectSuccess(svc.pollDueTriggers())
    expect(only(triggers.receipts)).toMatchObject({ state: "processed", attempts: 2 })
    expect(only(triggers.table).checkpoint).toBe(JSON.stringify({ cursor: 2 }))
    expect(only(triggers.table).checkpoint_revision).toBe(2)
    expect(fake.calls.filter((call) => (call.input as { operation?: string }).operation === "receive")).toHaveLength(1)
  })

  it("parks a receipt as failed after five attempts and stops calling the engine", async () => {
    let receives = 0
    const { triggers, svc } = triggerHarness((fake) => ({
      triggerExecute: onTriggerOperation(fake, "receive", () => {
        receives += 1
        return Effect.fail(new EngineError("engine_unavailable", "boom", 503))
      }),
    }))
    const created = await createSchedule(svc)
    parkSchedule(triggers)
    await expectFailure(svc.handleWebhook(created.id, webhook))
    for (let replay = 2; replay <= 5; replay++) {
      Object.assign(only(triggers.receipts), { next_retry_at: 0 })
      await expectSuccess(svc.pollDueTriggers())
    }
    expect(receives).toBe(5)
    expect(only(triggers.receipts)).toMatchObject({ state: "failed", attempts: 5 })

    Object.assign(only(triggers.receipts), { next_retry_at: 0 })
    await expectSuccess(svc.pollDueTriggers())
    expect(receives).toBe(5)
    const redelivered = await expectFailure(svc.handleWebhook(created.id, webhook))
    expect((redelivered as Connector.ConflictError).code).toBe("receipt_failed")
    expect(receives).toBe(5)
  })

  it("replays a processed receipt from its durable result without another engine call", async () => {
    let receives = 0
    const { fake, triggers, svc } = triggerHarness((fake) => ({
      triggerExecute: onTriggerOperation(fake, "receive", (input) => {
        receives += 1
        return fake.engine.triggerExecute(input)
      }),
    }))
    const created = await createSchedule(svc)
    parkSchedule(triggers)
    const first = await expectSuccess(svc.handleWebhook(created.id, webhook))
    const second = await expectSuccess(svc.handleWebhook(created.id, webhook))
    expect(second).toEqual(first)
    expect(receives).toBe(1)
    expect(only(triggers.table).checkpoint_revision).toBe(2)
    expect(fake.calls.filter((call) => (call.input as { operation?: string }).operation === "receive")).toHaveLength(1)
  })

  it("does not commit the receipt when the checkpoint moved during the receive", async () => {
    const { triggers, svc } = triggerHarness((fake, triggers) => ({
      triggerExecute: onTriggerOperation(fake, "receive", (input) => {
        Object.assign(only(triggers.table), { checkpoint_revision: only(triggers.table).checkpoint_revision + 1 })
        return fake.engine.triggerExecute(input)
      }),
    }))
    const created = await createSchedule(svc)
    parkSchedule(triggers)
    const error = await expectFailure(svc.handleWebhook(created.id, webhook))
    expect((error as Connector.ConflictError).code).toBe("checkpoint_conflict")
    expect(only(triggers.receipts).state).toBe("received")
    expect(only(triggers.table).checkpoint).toBe(JSON.stringify({ cursor: 1 }))
  })

  it("parks replayable receipts as failed once their schedule is cancelled", async () => {
    let receives = 0
    const { triggers, svc } = triggerHarness((fake) => ({
      triggerExecute: onTriggerOperation(fake, "receive", () => {
        receives += 1
        return Effect.fail(new EngineError("engine_unavailable", "boom", 503))
      }),
    }))
    const created = await createSchedule(svc)
    parkSchedule(triggers)
    await expectFailure(svc.handleWebhook(created.id, webhook))
    await expectSuccess(svc.cancelTrigger(OWNER, created.id))
    Object.assign(only(triggers.receipts), { next_retry_at: 0 })
    await expectSuccess(svc.pollDueTriggers())
    expect(only(triggers.receipts).state).toBe("failed")
    expect(receives).toBe(1)
  })
})

describe("Connector trigger polls", () => {
  it("writes page events once per delivery key and advances the checkpoint with the page", async () => {
    const pages: unknown[] = [
      { events: [{ dedupeKey: "e1" }, { dedupeKey: "e1" }, { dedupeKey: "e2" }], checkpoint: { cursor: 10 } },
      { events: [{ dedupeKey: "e2" }, { dedupeKey: "e3" }], checkpoint: { cursor: 20 } },
    ]
    const readBodies: unknown[] = []
    const { triggers, svc } = triggerHarness((fake) => ({
      triggerExecute: onTriggerOperation(fake, "read", (input) => {
        readBodies.push(input.body)
        return Effect.succeed(pages.shift())
      }),
    }))
    await createSchedule(svc)
    makeDue(triggers)
    await expectSuccess(svc.pollDueTriggers())
    expect(triggers.events.map((event) => event.delivery_key)).toEqual(["e1", "e2"])
    expect(only(triggers.table).checkpoint).toBe(JSON.stringify({ cursor: 10 }))

    makeDue(triggers)
    await expectSuccess(svc.pollDueTriggers())
    expect(triggers.events.map((event) => event.delivery_key)).toEqual(["e1", "e2", "e3"])
    expect(only(triggers.table).checkpoint).toBe(JSON.stringify({ cursor: 20 }))
    expect(readBodies).toMatchObject([{ checkpoint: { cursor: 1 } }, { checkpoint: { cursor: 10 } }])
  })

  it("backs off transient read failures with jitter, capped at fifteen minutes, and keeps the schedule active", async () => {
    const { triggers, svc } = triggerHarness((fake) => ({
      triggerExecute: onTriggerOperation(fake, "read", () => Effect.fail(new EngineError("engine_unavailable", "boom", 503))),
    }))
    await createSchedule(svc)
    makeDue(triggers)
    const first = Date.now()
    await expectSuccess(svc.pollDueTriggers())
    expect(only(triggers.table)).toMatchObject({ status: "active", poll_attempts: 1 })
    expect(only(triggers.table).next_run_at).toBeGreaterThanOrEqual(first + 500)
    expect(only(triggers.table).next_run_at).toBeLessThanOrEqual(Date.now() + 1000)

    let lastFailure = 0
    for (let failure = 2; failure <= 12; failure++) {
      makeDue(triggers)
      lastFailure = Date.now()
      await expectSuccess(svc.pollDueTriggers())
    }
    expect(only(triggers.table)).toMatchObject({ status: "active", poll_attempts: 12 })
    // Twelfth failure: 1s * 2^11 exceeds the cap, so the delay is jittered within [cap/2, cap].
    expect(only(triggers.table).next_run_at).toBeGreaterThanOrEqual(lastFailure + FIFTEEN_MINUTES / 2)
    expect(only(triggers.table).next_run_at).toBeLessThanOrEqual(Date.now() + FIFTEEN_MINUTES)
  })

  it("suspends the schedule on a permanent auth error and stops polling it", async () => {
    let reads = 0
    const { triggers, svc } = triggerHarness((fake) => ({
      triggerExecute: onTriggerOperation(fake, "read", () => {
        reads += 1
        return Effect.fail(new EngineError("token_invalid", "expired", 401))
      }),
    }))
    const created = await createSchedule(svc)
    makeDue(triggers)
    await expectSuccess(svc.pollDueTriggers())
    expect(only(triggers.table)).toMatchObject({ status: "suspended", poll_attempts: 1 })

    makeDue(triggers)
    await expectSuccess(svc.pollDueTriggers())
    expect(reads).toBe(1)
    const suspended = await expectFailure(svc.pollOnce(created.id))
    expect((suspended as Connector.ConflictError).code).toBe("trigger_suspended")
  })

  it("discards a read pass whose lease epoch was taken over before the commit", async () => {
    const { triggers, svc } = triggerHarness((fake, triggers) => ({
      triggerExecute: onTriggerOperation(fake, "read", () => {
        Object.assign(only(triggers.table), { lease_epoch: only(triggers.table).lease_epoch + 1 })
        return Effect.succeed({ events: [{ dedupeKey: "late" }], checkpoint: { cursor: 99 } })
      }),
    }))
    await createSchedule(svc)
    makeDue(triggers)
    await expectSuccess(svc.pollDueTriggers())
    expect(triggers.events).toHaveLength(0)
    expect(only(triggers.table).checkpoint).toBe(JSON.stringify({ cursor: 1 }))
  })

  it("schedules the next page immediately on hasMore and otherwise after the poll interval", async () => {
    const pages: unknown[] = [
      { events: [{ dedupeKey: "p1" }], checkpoint: { cursor: 5 }, hasMore: true },
      { events: [], checkpoint: { cursor: 6 }, hasMore: false },
    ]
    let reads = 0
    const { triggers, svc } = triggerHarness((fake) => ({
      triggerExecute: onTriggerOperation(fake, "read", () => {
        reads += 1
        return Effect.succeed(pages.shift())
      }),
    }))
    await createSchedule(svc)
    makeDue(triggers)
    await expectSuccess(svc.pollDueTriggers())
    expect(only(triggers.table).next_run_at).toBeLessThanOrEqual(Date.now())

    makeDue(triggers)
    const before = Date.now()
    await expectSuccess(svc.pollDueTriggers())
    expect(only(triggers.table).next_run_at).toBeGreaterThanOrEqual(before + 60_000)
    expect(reads).toBe(2)
  })
})

describe("Connector.attachMcp", () => {
  it("fails when mcp url is not configured", async () => {
    const error = await expectFailure(service(makeStore().store, makeEngine().engine).attachMcp(OWNER))
    expect((error as Connector.ConflictError).code).toBe("mcp_url_missing")
  })

  it("fails when the session has no active connections", async () => {
    const error = await expectFailure(service(makeStore().store, makeEngine().engine, { mcpUrl: "http://x/mcp" }).attachMcp(OWNER))
    expect((error as Connector.ConflictError).code).toBe("no_connections")
  })

  it("issues a token scoped to the session's engine connection ids and rotates old tokens", async () => {
    const fake = makeEngine()
    const { store } = makeStore([row(), row({ id: ConnectorConnection.ID.create(), engine_connection_id: "eng_2", engine_connection_name: "name_2" })])
    const first = await expectSuccess(service(store, fake.engine, { mcpUrl: "http://saas/api/connector/mcp" }).attachMcp(CHILD))
    const second = await expectSuccess(service(store, fake.engine, { mcpUrl: "http://saas/api/connector/mcp" }).attachMcp(OWNER))
    const issued = fake.calls.filter((call) => call.method === "createRuntimeToken")
    expect(issued).toHaveLength(2)
    expect((issued[0]!.input as { allowedConnections: string[] }).allowedConnections).toEqual(["eng_1", "eng_2"])
    expect(fake.calls.filter((call) => call.method === "revokeRuntimeToken")).toHaveLength(1)
    const config = second.config
    expect(config.type).toBe("remote")
    if (config.type !== "remote") throw new Error("expected remote config")
    expect(config.url).toBe("http://saas/api/connector/mcp")
    expect(config.oauth).toBe(false)
    expect(config.headers?.["authorization"]).toBe("Bearer oct_secret_2")
    expect(String(first.name)).toBe("connector")
  })
})
