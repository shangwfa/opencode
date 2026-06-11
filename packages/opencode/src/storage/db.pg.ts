import postgres from "postgres"
import { drizzle } from "drizzle-orm/postgres-js"

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
        serialize: (x: any) => (typeof x === "string" ? x : JSON.stringify(x)),
        parse: (x: string) => x,
      },
      jsonb: {
        to: OID_JSONB,
        from: [OID_JSONB],
        serialize: (x: any) => (typeof x === "string" ? x : JSON.stringify(x)),
        parse: (x: string) => x,
      },
    } as any,
  })
  const db = drizzle(client as any)
  return { db, client }
}
