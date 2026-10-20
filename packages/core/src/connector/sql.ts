import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

/** One application/account/tool policy and one shared, hash-only MCP credential. */
export const ConnectorMcpTable = sqliteTable("connector_mcp_deployment", {
  id: text().primaryKey(),
  session_id: text().notNull(),
  service: text().notNull(),
  connection_id: text(),
  name: text().notNull(),
  status: text().notNull(),
  revision: integer().notNull(),
  tools: text("tools_json").notNull(),
  token_hash: text().notNull(),
  token_prefix: text().notNull(),
  time_created: integer().notNull(),
  time_updated: integer().notNull(),
}, (table) => [
  index("connector_mcp_owner_idx").on(table.session_id, table.status),
  index("connector_mcp_connection_idx").on(table.connection_id),
])

/**
 * SaaS-side association between a session resource domain and an engine connection.
 * Credentials never live here: the engine stores them encrypted under its own schema,
 * referenced by the stable `engine_connection_id` used for authorization.
 *
 * Defined locally (not imported from `@opencode/connector/adapter/sql`) so the tables share
 * core's drizzle-orm resolution context — cross-package table objects made tsgo load two
 * unrelated copies of the drizzle types — and so the core migration generator discovers them
 * directly through its scan of the sql.ts files under src.
 */
export const ConnectorConnectionTable = sqliteTable(
  "connector_connection",
  {
    id: text().primaryKey(),
    /** Session resource owner (root session); child sessions share the owner's domain. */
    session_id: text().notNull(),
    engine_connection_id: text().notNull(),
    engine_connection_name: text().notNull(),
    service: text().notNull(),
    alias: text().notNull(),
    auth_type: text().notNull(),
    status: text().notNull(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
    time_updated: integer()
      .notNull()
      .$default(() => Date.now())
      .$onUpdate(() => Date.now()),
  },
  (table) => [
    uniqueIndex("connector_connection_engine_id_uq").on(table.engine_connection_id),
    index("connector_connection_session_idx").on(table.session_id),
  ],
)

/**
 * Simplified trigger schedule (protocol doc §5 slice): one row per created trigger binding.
 * The engine holds the real subscription state; this row tracks ownership, the per-schedule
 * engine token (see adapter-spec §2 TODO: encrypt at rest), and a best-effort checkpoint mirror.
 */
export const ConnectorTriggerScheduleTable = sqliteTable(
  "connector_trigger_schedule",
  {
    id: text().primaryKey(),
    /** Session resource owner (root session); child sessions share the owner's domain. */
    session_id: text().notNull(),
    service: text().notNull(),
    trigger_id: text().notNull(),
    /** Target engine connection used for every trigger operation (subscription owner binding). */
    engine_connection_id: text().notNull(),
    /** The exact HTTPS callback URL registered with the provider; deactivate must repeat it verbatim. */
    endpoint_url: text().notNull(),
    /** Subscription id returned by the engine reconcile; null until the first reconcile succeeds. */
    engine_subscription_id: text(),
    /** Persistent engine runtime token minted for this schedule; receive/reconcile must reuse it. */
    engine_token_id: text(),
    /** Legacy plaintext token column; kept for lazy migration, cleared once rewritten as ciphertext. */
    engine_token: text(),
    /** Ciphertext (enc:v1:) of the engine token; preferred over the legacy plaintext column. */
    engine_token_encrypted: text(),
    /** active | retiring | revoked (adapter-spec §2 simplified lifecycle). */
    token_state: text().notNull().default("active"),
    config: text("config_json").notNull().default("{}"),
    checkpoint: text("checkpoint_json"),
    checkpoint_revision: integer().notNull().default(0),
    next_run_at: integer().notNull(),
    lease_epoch: integer().notNull().default(0),
    lease_until: integer().notNull().default(0),
    /** active | cancelled */
    status: text().notNull(),
    /** Reserved for listener wake signaling (protocol doc §5); unused in this slice. */
    wake_seq: integer().notNull().default(0),
    /** Consecutive transient read failures driving exponential backoff; reset on success. */
    poll_attempts: integer().notNull().default(0),
    /** Latest engine read/receive outcome (simplified audit; session delivery not implemented). */
    last_result: text("last_result_json"),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
    time_updated: integer()
      .notNull()
      .$default(() => Date.now())
      .$onUpdate(() => Date.now()),
  },
  (table) => [
    index("connector_trigger_schedule_session_idx").on(table.session_id),
    index("connector_trigger_schedule_due_idx").on(table.next_run_at),
  ],
)

/**
 * Durable webhook receipt journal (protocol doc §1/§2, SaaS side): every ingress lands as
 * `received` before the engine call, and the engine result + checkpoint mirror commit together
 * with the transition to `processed`. A crash at any point leaves a replayable receipt.
 */
export const ConnectorTriggerReceiptTable = sqliteTable(
  "connector_trigger_receipt",
  {
    id: text().primaryKey(),
    schedule_id: text().notNull(),
    received_at: integer().notNull(),
    /** Provider event fingerprint (method + headers + raw body); unique per schedule. */
    dedup_key: text().notNull(),
    body_base64: text().notNull(),
    headers: text("headers_json").notNull(),
    /** received | processed | failed */
    state: text().notNull(),
    engine_result: text("engine_result_json"),
    checkpoint: text("checkpoint_json"),
    attempts: integer().notNull().default(0),
    /** Due time for the next reconciliation replay of a still-`received` receipt. */
    next_retry_at: integer().notNull(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
    time_updated: integer()
      .notNull()
      .$default(() => Date.now())
      .$onUpdate(() => Date.now()),
  },
  (table) => [
    uniqueIndex("connector_trigger_receipt_dedup_uq").on(table.schedule_id, table.dedup_key),
    index("connector_trigger_receipt_retry_idx").on(table.state, table.next_retry_at),
  ],
)

/**
 * Page-level poll/listener events (protocol doc §5): inserted with a unique delivery key in the
 * same transaction that advances the schedule checkpoint, then delivered to the target session
 * through the idempotent inbox admission and marked delivered afterwards.
 */
export const ConnectorTriggerEventTable = sqliteTable(
  "connector_trigger_event",
  {
    id: text().primaryKey(),
    schedule_id: text().notNull(),
    delivery_key: text().notNull(),
    payload: text("payload_json").notNull(),
    delivered_at: integer(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
    time_updated: integer()
      .notNull()
      .$default(() => Date.now())
      .$onUpdate(() => Date.now()),
  },
  (table) => [
    uniqueIndex("connector_trigger_event_delivery_uq").on(table.schedule_id, table.delivery_key),
    index("connector_trigger_event_schedule_idx").on(table.schedule_id),
  ],
)

/**
 * SaaS-side OAuth request ledger: the engine exposes no list route, so start/complete maintain
 * this account per session resource domain (best-effort audit trail).
 */
export const ConnectorOAuthRequestTable = sqliteTable(
  "connector_oauth_request",
  {
    connection_request_id: text().primaryKey(),
    session_id: text().notNull(),
    service: text().notNull(),
    /** initiated | connected | failed | expired */
    state: text().notNull(),
    alias: text(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
    time_updated: integer()
      .notNull()
      .$default(() => Date.now())
      .$onUpdate(() => Date.now()),
  },
  (table) => [index("connector_oauth_request_session_idx").on(table.session_id)],
)
