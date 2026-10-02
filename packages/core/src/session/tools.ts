export * as SessionTools from "./tools.js"

import { and, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Tool } from "@opencode/schema/tool"
import { SessionTool } from "@opencode/schema/session-tool"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Database } from "../database/database.js"
import { SandboxProvider } from "../sandbox/provider.js"
import type { Session } from "../session.js"
import { scanSandboxTools } from "./tool-scan.js"
import { SessionToolTable } from "./sql.js"
import { SessionToolSandbox } from "./tool-sandbox.js"
import { SessionResourceOwner } from "./resource-owner.js"

export type Info = SessionTool.Info
export type Payload = SessionTool.Payload
export interface Interface {
  readonly list: (sessionID: Session.ID) => Effect.Effect<ReadonlyArray<Info>>
  readonly create: (sessionID: Session.ID, input: Payload) => Effect.Effect<Info>
  readonly remove: (sessionID: Session.ID, name: SessionTool.Name) => Effect.Effect<void>
  readonly clear: (sessionID: Session.ID) => Effect.Effect<void>
  readonly load: (session: Session.Info) => Effect.Effect<ReadonlyArray<Tool.Info>, Error>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTools") {}

/** Sandbox project definitions are the narrowest overlay, then API/session definitions. */
export function mergeDefinitions(session: ReadonlyArray<Tool.Info>, sandbox: ReadonlyArray<Tool.Info>) {
  const effective = new Map<string, Tool.Info>()
  for (const tool of session) effective.set(tool.name, tool)
  for (const tool of sandbox) effective.set(tool.name, tool)
  return [...effective.values()]
}

function fromRow(row: typeof SessionToolTable.$inferSelect): Info {
  return SessionTool.Info.make({
    id: row.id,
    name: row.name,
    description: row.description,
    code: row.code,
    time: { created: row.time_created, updated: row.time_updated },
  })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const backend = yield* SessionToolSandbox.Service
    const sandbox = yield* SandboxProvider.Service
    const stored = (sessionID: Session.ID) =>
      SessionResourceOwner.id(db, sessionID).pipe(
        Effect.flatMap((ownerID) =>
          db
            .select()
            .from(SessionToolTable)
            .where(eq(SessionToolTable.session_id, ownerID))
            .all()
            .pipe(
              Effect.map((rows) => rows.map(fromRow).toSorted((a, b) => a.name.localeCompare(b.name))),
              Effect.orDie,
            ),
        ),
      )
    return Service.of({
      list: stored,
      create: (requestedSessionID, input) =>
        Effect.gen(function* () {
          const sessionID = yield* SessionResourceOwner.id(db, requestedSessionID)
          const now = Date.now()
          yield* db
            .insert(SessionToolTable)
            .values({
              id: SessionTool.ID.create(),
              session_id: sessionID,
              name: input.name,
              description: input.description,
              code: input.code,
              time_created: now,
              time_updated: now,
            })
            .onConflictDoUpdate({
              target: [SessionToolTable.session_id, SessionToolTable.name],
              set: {
                description: input.description,
                code: input.code,
                time_updated: sql`max(${now}, ${SessionToolTable.time_updated} + 1)`,
              },
            })
            .run()
            .pipe(Effect.orDie)
          const row = yield* db
            .select()
            .from(SessionToolTable)
            .where(and(eq(SessionToolTable.session_id, sessionID), eq(SessionToolTable.name, input.name)))
            .get()
            .pipe(Effect.orDie)
          if (!row) return yield* Effect.die(new Error(`Session tool upsert disappeared: ${input.name}`))
          return fromRow(row)
        }),
      remove: (sessionID, name) =>
        SessionResourceOwner.id(db, sessionID).pipe(
          Effect.flatMap((ownerID) =>
            db
              .delete(SessionToolTable)
              .where(and(eq(SessionToolTable.session_id, ownerID), eq(SessionToolTable.name, name)))
              .run()
              .pipe(Effect.orDie),
          ),
        ),
      clear: (sessionID) =>
        SessionResourceOwner.id(db, sessionID).pipe(
          Effect.flatMap((ownerID) =>
            db.delete(SessionToolTable).where(eq(SessionToolTable.session_id, ownerID)).run().pipe(Effect.orDie),
          ),
        ),
      load: (session) =>
        Effect.gen(function* () {
          const loadDefinitions = (rows: ReadonlyArray<Info>, source: "session" | "sandbox") =>
            Effect.gen(function* () {
              const tools: Tool.Info[] = []
              for (const row of rows) {
                const info = yield* backend.load(session, row).pipe(
                  Effect.catch((error) => {
                    // Broken user modules are isolated; infrastructure failures must stay observable.
                    if ("code" in error && ["source-invalid", "unsupported-schema"].includes(String(error.code)))
                      return Effect.logWarning(`Invalid ${source} tool source`, {
                        sessionID: session.id,
                        name: row.name,
                        error: error.message,
                      }).pipe(Effect.as(undefined))
                    return Effect.fail(error)
                  }),
                )
                if (info) tools.push(info)
              }
              return tools
            })
          const sessionTools = yield* loadDefinitions(yield* stored(session.id), "session")
          const sandboxRows = yield* scanSandboxTools(session, sandbox)
          const sandboxTools = yield* loadDefinitions(sandboxRows, "sandbox")
          return mergeDefinitions(sessionTools, sandboxTools)
        }),
    })
  }),
)
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, SandboxProvider.node, SessionToolSandbox.node],
})
