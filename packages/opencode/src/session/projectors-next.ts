import { and, desc, eq } from "drizzle-orm"
import type { TxOrDb } from "@/storage/db"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageUpdater } from "@opencode-ai/core/session/message-updater"
import { SessionEvent } from "@opencode-ai/core/session/event"
import * as DateTime from "effect/DateTime"
import { SyncEvent } from "@/sync"
import type { EventV2 } from "@opencode-ai/core/event"
import { SessionEntryTable, SessionTable } from "./session.pg"
import type { SessionID } from "./schema"
import { Schema } from "effect"

/** Bridge an EventV2 Definition (core) into a SyncEvent Definition (opencode sync). */
function toSyncDefinition<D extends EventV2.Definition>(def: D): SyncEvent.Definition<D["type"]> {
  return {
    type: def.type,
    version: def.sync?.version ?? 0,
    aggregate: def.sync?.aggregate ?? "sessionID",
    schema: def.data,
    properties: def.data,
  }
}

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)
type SessionMessageData = NonNullable<(typeof SessionEntryTable.$inferInsert)["data"]>

function encodeDateTimes(value: unknown): unknown {
  if (DateTime.isDateTime(value)) return DateTime.toEpochMillis(value)
  if (Array.isArray(value)) return value.map(encodeDateTimes)
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeDateTimes(item)]))
  }
  return value
}

function encodeMessageData(value: unknown): SessionMessageData {
  return encodeDateTimes(value) as SessionMessageData
}

function sqlite(db: TxOrDb, sessionID: SessionID): any {
  return {
    async getCurrentAssistant() {
      const rows = await db
        .select()
        .from(SessionEntryTable)
        .where(and(eq(SessionEntryTable.session_id, sessionID), eq(SessionEntryTable.type, "assistant")))
        .orderBy(desc(SessionEntryTable.id))
        .all()
      return (rows as any[])
        .map((row: any) => decodeMessage({ ...row.data, id: row.id, type: row.type }))
        .find((message: any): message is SessionMessage.Assistant => message.type === "assistant" && !message.time.completed)
    },
    async getCurrentCompaction() {
      const rows = await db
        .select()
        .from(SessionEntryTable)
        .where(and(eq(SessionEntryTable.session_id, sessionID), eq(SessionEntryTable.type, "compaction")))
        .orderBy(desc(SessionEntryTable.id))
        .all()
      return (rows as any[])
        .map((row: any) => decodeMessage({ ...row.data, id: row.id, type: row.type }))
        .find((message: any): message is SessionMessage.Compaction => message.type === "compaction")
    },
    async getCurrentShell(callID: string) {
      const rows = await db
        .select()
        .from(SessionEntryTable)
        .where(and(eq(SessionEntryTable.session_id, sessionID), eq(SessionEntryTable.type, "shell")))
        .orderBy(desc(SessionEntryTable.id))
        .all()
      return (rows as any[])
        .map((row: any) => decodeMessage({ ...row.data, id: row.id, type: row.type }))
        .find((message: any): message is SessionMessage.Shell => message.type === "shell" && message.callID === callID)
    },
    async updateAssistant(assistant: any) {
      const { id, type, ...data } = assistant
      await db.update(SessionEntryTable)
        .set({ data: encodeMessageData(data) })
        .where(
          and(
            eq(SessionEntryTable.id, id),
            eq(SessionEntryTable.session_id, sessionID),
            eq(SessionEntryTable.type, type),
          ),
        )
        .run()
    },
    async updateCompaction(compaction: any) {
      const { id, type, ...data } = compaction
      await db.update(SessionEntryTable)
        .set({ data: encodeMessageData(data) })
        .where(
          and(
            eq(SessionEntryTable.id, id),
            eq(SessionEntryTable.session_id, sessionID),
            eq(SessionEntryTable.type, type),
          ),
        )
        .run()
    },
    async updateShell(shell: any) {
      const { id, type, ...data } = shell
      await db.update(SessionEntryTable)
        .set({ data: encodeMessageData(data) })
        .where(
          and(
            eq(SessionEntryTable.id, id),
            eq(SessionEntryTable.session_id, sessionID),
            eq(SessionEntryTable.type, type),
          ),
        )
        .run()
    },
    async appendMessage(message: any) {
      const { id, type, ...data } = message
      await db.insert(SessionEntryTable)
        .values([
          {
            id,
            session_id: sessionID,
            type,
            time_created: DateTime.toEpochMillis(message.time.created),
            data: encodeMessageData(data),
          },
        ])
        .run()
    },
    finish() {},
  }
}

async function update(db: TxOrDb, event: { id: any; type: string; data: any }) {
  await (SessionMessageUpdater.update as any)(sqlite(db, event.data.sessionID), event)
}

export default [
  SyncEvent.project(toSyncDefinition(SessionEvent.AgentSwitched), async (db, data: any, event) => {
    await db.update(SessionTable)
      .set({
        agent: data.agent,
        time_updated: DateTime.toEpochMillis(data.timestamp),
      })
      .where(eq(SessionTable.id, data.sessionID))
      .run()
    await update(db, { id: SessionMessage.ID.make(event.id as string), type: "session.next.agent.switched", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.ModelSwitched), async (db, data: any, event) => {
    await db.update(SessionTable)
      .set({
        model: data.model,
        time_updated: DateTime.toEpochMillis(data.timestamp),
      })
      .where(eq(SessionTable.id, data.sessionID))
      .run()
    await update(db, { id: SessionMessage.ID.make(event.id as string), type: "session.next.model.switched", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Prompted), async (db, data: any, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id as string), type: "session.next.prompted", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Synthetic), async (db, data: any, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id as string), type: "session.next.synthetic", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Shell.Started), async (db, data: any, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id as string), type: "session.next.shell.started", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Shell.Ended), async (db, data: any, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id as string), type: "session.next.shell.ended", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Step.Started), async (db, data: any, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id as string), type: "session.next.step.started", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Step.Ended), async (db, data: any, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id as string), type: "session.next.step.ended", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Step.Failed), async (db, data: any, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id as string), type: "session.next.step.failed", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Text.Started), async (db, data: any, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id as string), type: "session.next.text.started", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Text.Delta), () => {}),
  SyncEvent.project(toSyncDefinition(SessionEvent.Text.Ended), async (db, data: any, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id as string), type: "session.next.text.ended", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Tool.Input.Started), async (db, data: any, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id as string), type: "session.next.tool.input.started", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Tool.Input.Delta), () => {}),
  SyncEvent.project(toSyncDefinition(SessionEvent.Tool.Input.Ended), async (db, data: any, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id as string), type: "session.next.tool.input.ended", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Tool.Called), async (db, data: any, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id as string), type: "session.next.tool.called", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Tool.Success), async (db, data: any, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id as string), type: "session.next.tool.success", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Tool.Failed), async (db, data: any, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id as string), type: "session.next.tool.failed", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Reasoning.Started), async (db, data: any, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id as string), type: "session.next.reasoning.started", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Reasoning.Delta), () => {}),
  SyncEvent.project(toSyncDefinition(SessionEvent.Reasoning.Ended), async (db, data: any, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id as string), type: "session.next.reasoning.ended", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Retried), async (db, data: any, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id as string), type: "session.next.retried", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Compaction.Started), async (db, data: any, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id as string), type: "session.next.compaction.started", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Compaction.Delta), () => {}),
  SyncEvent.project(toSyncDefinition(SessionEvent.Compaction.Ended), async (db, data: any, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id as string), type: "session.next.compaction.ended", data })
  }),
]
