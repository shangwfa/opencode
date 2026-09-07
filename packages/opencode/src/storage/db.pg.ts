import postgres from "postgres"
import { drizzle } from "drizzle-orm/postgres-js"
import { Flag } from "@/flag/flag"

// SQLite Drizzle exposes `.run()`, `.get()`, `.all()` on query objects;
// the PG driver does not. To keep business code portable across dialects,
// we install these shims on the PG query prototypes by walking up the
// prototype chain of sample queries and patching each unique prototype.
let shimmed = false

function shim(proto: any) {
  if (!proto || proto === Object.prototype) return
  if (typeof proto.run !== "function") {
    proto.run = function () {
      return Promise.resolve(this).then(() => undefined)
    }
  }
  if (typeof proto.all !== "function") {
    proto.all = function () {
      return Promise.resolve(this)
    }
  }
  if (typeof proto.get !== "function") {
    proto.get = function () {
      return Promise.resolve(this).then((rows: any[]) => (Array.isArray(rows) ? rows[0] : rows))
    }
  }
}

function walk(obj: any) {
  let p = Object.getPrototypeOf(obj)
  while (p && p !== Object.prototype) {
    shim(p)
    p = Object.getPrototypeOf(p)
  }
}

// Install shims using a sample table. Each unique query-builder prototype
// gets `.run/.get/.all` injected. Idempotent — safe to call multiple times.
export function install(db: any, table: any) {
  if (shimmed) return
  shimmed = true

  try {
    walk(db.select().from(table))
    const ins = db.insert(table).values({ __shim: true })
    walk(ins)
    try { walk(ins.onConflictDoUpdate({ target: table.id, set: { __shim: true } })) } catch {}
    try { walk(ins.onConflictDoNothing()) } catch {}
    walk(db.delete(table))
    try {
      walk(db.update(table).set({ __shim: true }))
    } catch {
      walk(db.update(table))
    }
  } catch {
    // Best effort
  }
}

// PG OID constants for type overrides
const OID_INT8 = 20 // bigint
const OID_JSON = 114
const OID_JSONB = 3802

// PG rejects NUL (\u0000) inside json/jsonb values ("unsupported Unicode escape
// sequence") even though the JSON spec allows it. Upstream text such as Vite's
// virtual module names ("\0virtual:...") regularly carries NUL and would break
// every durable write (part/event rows). Strip it before serializing.
function stripNul(value: unknown): unknown {
  if (typeof value === "string") return value.includes("\0") ? value.replace(/\0/g, "") : value
  if (Array.isArray(value)) return value.map(stripNul)
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k.includes("\0") ? k.replace(/\0/g, "") : k] = stripNul(v)
    return out
  }
  return value
}

function serializeJson(x: any) {
  if (typeof x !== "string") return JSON.stringify(stripNul(x))
  return x.includes("\0") ? x.replace(/\0/g, "") : x
}

// Drizzle sends every parameterized query through client.unsafe() with values
// already JSON.stringify-ed as plain text params, so the json/jsonb type
// serializers above never see jsonb columns. Wrapping unsafe() is the one
// choke point where every bound parameter can be sanitized before PG parses
// it and rejects NUL inside jsonb values. Transactions must be wrapped too:
// postgres.js hands drizzle a fresh client object inside begin().
function stripNulParam(value: unknown): unknown {
  // JSON.stringify turns a real NUL into the six-character escape text \u0000,
  // so string params never contain the raw byte — strip the escaped form (PG
  // jsonb rejects it) plus any raw NUL for safety.
  if (typeof value === "string") return /\\u0000|\0/.test(value) ? value.replace(/\\u0000/g, "").replace(/\0/g, "") : value
  return value
}

const NUL_GUARD = Symbol("nul-guard")

function installNulGuard(client: any): any {
  if (!client || client[NUL_GUARD]) return client
  try {
    Object.defineProperty(client, NUL_GUARD, { value: true })
  } catch {
    return client
  }
  const originalUnsafe = client.unsafe.bind(client)
  client.unsafe = ((query: string, params: any, options?: any) => {
    if (Array.isArray(params) && params.some((p: any) => typeof p === "string" && /\\u0000|\0/.test(p))) {
      params = params.map(stripNulParam)
    }
    return originalUnsafe(query, params, options)
  }) as any
  const originalBegin = client.begin?.bind(client)
  if (originalBegin) {
    client.begin = ((callback: any, ...rest: any[]) =>
      originalBegin((tx: any) => callback(installNulGuard(tx)), ...rest)) as any
  }
  return client
}

export function init(url: string) {
  // Configure postgres.js to return raw values for jsonb, json and bigint
  // so that Drizzle column decoders (which were written for SQLite semantics)
  // see the same shape of data in both dialects. This lets the existing
  // `*.sql.ts` schemas (with `text({mode:"json"})` and `integer()`) work
  // unchanged against PG: the text-json decoder parses the string, and the
  // integer decoder converts the numeric string to a number.
  const client = postgres(url, {
    max: 20,
    connect_timeout: 10,
    idle_timeout: 30,
    max_lifetime: 600,
    // statement_timeout guards against network half-open connections leaving
    // queries pending forever (a hung PG write keeps the session run alive and
    // its lock held). lock_timeout bounds advisory-lock waits in migrations.
    connection: {
      statement_timeout: Flag.OPENCODE_PG_STATEMENT_TIMEOUT_MS,
      lock_timeout: Flag.OPENCODE_PG_STATEMENT_TIMEOUT_MS,
    },
    types: {
      bigint: {
        to: OID_INT8,
        from: [OID_INT8],
        serialize: (x: number | bigint | string) => x.toString(),
        parse: (x: string) => Number(x),
      },
      json: {
        to: OID_JSON,
        from: [OID_JSON],
        serialize: serializeJson,
        parse: (x: string) => x,
      },
      jsonb: {
        to: OID_JSONB,
        from: [OID_JSONB],
        serialize: serializeJson,
        parse: (x: string) => x,
      },
    } as any,
  })
  const db = drizzle({ client: client as any })
  installNulGuard(client)
  return { db, client }
}
