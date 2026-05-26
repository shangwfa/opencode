import { and, desc, eq } from "@/storage/db"
import type { Database } from "@/storage/db"
import { SessionMessage } from "@opencode-ai/core/session-message"
import { SessionMessageUpdater } from "@opencode-ai/core/session-message-updater"
import { SessionEvent } from "@opencode-ai/core/session-event"
import * as DateTime from "effect/DateTime"
import { SyncEvent } from "@/sync"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionMessageTable, SessionTable } from "./session.sql"
import type { SessionID } from "./schema"
import { Schema } from "effect"

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)
type SessionMessageData = NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>

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

function sqlite(db: Database.TxOrDb, sessionID: SessionID): SessionMessageUpdater.Adapter<void> {
  return {
    async getCurrentAssistant() {
      const rows = await db
        .select()
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "assistant")))
        .orderBy(desc(SessionMessageTable.id))
        .all()
      return (rows as any[])
        .map((row: any) => decodeMessage({ ...row.data, id: row.id, type: row.type }))
        .find((message: any): message is SessionMessage.Assistant => message.type === "assistant" && !message.time.completed)
    },
    async getCurrentCompaction() {
      const rows = await db
        .select()
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "compaction")))
        .orderBy(desc(SessionMessageTable.id))
        .all()
      return (rows as any[])
        .map((row: any) => decodeMessage({ ...row.data, id: row.id, type: row.type }))
        .find((message: any): message is SessionMessage.Compaction => message.type === "compaction")
    },
    async getCurrentShell(callID) {
      const rows = await db
        .select()
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "shell")))
        .orderBy(desc(SessionMessageTable.id))
        .all()
      return (rows as any[])
        .map((row: any) => decodeMessage({ ...row.data, id: row.id, type: row.type }))
        .find((message: any): message is SessionMessage.Shell => message.type === "shell" && message.callID === callID)
    },
    async updateAssistant(assistant) {
      const { id, type, ...data } = assistant
      await db.update(SessionMessageTable)
        .set({ data: encodeMessageData(data) })
        .where(
          and(
            eq(SessionMessageTable.id, id),
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, type),
          ),
        )
        .run()
    },
    async updateCompaction(compaction) {
      const { id, type, ...data } = compaction
      await db.update(SessionMessageTable)
        .set({ data: encodeMessageData(data) })
        .where(
          and(
            eq(SessionMessageTable.id, id),
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, type),
          ),
        )
        .run()
    },
    async updateShell(shell) {
      const { id, type, ...data } = shell
      await db.update(SessionMessageTable)
        .set({ data: encodeMessageData(data) })
        .where(
          and(
            eq(SessionMessageTable.id, id),
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, type),
          ),
        )
        .run()
    },
    async appendMessage(message) {
      const { id, type, ...data } = message
      await db.insert(SessionMessageTable)
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

async function update(db: Database.TxOrDb, event: SessionEvent.Event) {
  await SessionMessageUpdater.update(sqlite(db, event.data.sessionID), event)
}

export default [
  SyncEvent.project(EventV2Bridge.toSyncDefinition(SessionEvent.AgentSwitched), async (db, data, event) => {
    await db.update(SessionTable)
      .set({
        agent: data.agent,
        time_updated: DateTime.toEpochMillis(data.timestamp),
      })
      .where(eq(SessionTable.id, data.sessionID))
      .run()
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.agent.switched", data })
  }),
  SyncEvent.project(EventV2Bridge.toSyncDefinition(SessionEvent.ModelSwitched), async (db, data, event) => {
    await db.update(SessionTable)
      .set({
        model: data.model,
        time_updated: DateTime.toEpochMillis(data.timestamp),
      })
      .where(eq(SessionTable.id, data.sessionID))
      .run()
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.model.switched", data })
  }),
  SyncEvent.project(EventV2Bridge.toSyncDefinition(SessionEvent.Prompted), async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.prompted", data })
  }),
  SyncEvent.project(EventV2Bridge.toSyncDefinition(SessionEvent.Synthetic), async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.synthetic", data })
  }),
  SyncEvent.project(EventV2Bridge.toSyncDefinition(SessionEvent.Shell.Started), async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.shell.started", data })
  }),
  SyncEvent.project(EventV2Bridge.toSyncDefinition(SessionEvent.Shell.Ended), async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.shell.ended", data })
  }),
  SyncEvent.project(EventV2Bridge.toSyncDefinition(SessionEvent.Step.Started), async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.step.started", data })
  }),
  SyncEvent.project(EventV2Bridge.toSyncDefinition(SessionEvent.Step.Ended), async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.step.ended", data })
  }),
  SyncEvent.project(EventV2Bridge.toSyncDefinition(SessionEvent.Step.Failed), async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.step.failed", data })
  }),
  SyncEvent.project(EventV2Bridge.toSyncDefinition(SessionEvent.Text.Started), async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.text.started", data })
  }),
  SyncEvent.project(EventV2Bridge.toSyncDefinition(SessionEvent.Text.Delta), () => {}),
  SyncEvent.project(EventV2Bridge.toSyncDefinition(SessionEvent.Text.Ended), async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.text.ended", data })
  }),
  SyncEvent.project(EventV2Bridge.toSyncDefinition(SessionEvent.Tool.Input.Started), async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.tool.input.started", data })
  }),
  SyncEvent.project(EventV2Bridge.toSyncDefinition(SessionEvent.Tool.Input.Delta), () => {}),
  SyncEvent.project(EventV2Bridge.toSyncDefinition(SessionEvent.Tool.Input.Ended), async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.tool.input.ended", data })
  }),
  SyncEvent.project(EventV2Bridge.toSyncDefinition(SessionEvent.Tool.Called), async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.tool.called", data })
  }),
  SyncEvent.project(EventV2Bridge.toSyncDefinition(SessionEvent.Tool.Success), async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.tool.success", data })
  }),
  SyncEvent.project(EventV2Bridge.toSyncDefinition(SessionEvent.Tool.Failed), async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.tool.failed", data })
  }),
  SyncEvent.project(EventV2Bridge.toSyncDefinition(SessionEvent.Reasoning.Started), async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.reasoning.started", data })
  }),
  SyncEvent.project(EventV2Bridge.toSyncDefinition(SessionEvent.Reasoning.Delta), () => {}),
  SyncEvent.project(EventV2Bridge.toSyncDefinition(SessionEvent.Reasoning.Ended), async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.reasoning.ended", data })
  }),
  SyncEvent.project(EventV2Bridge.toSyncDefinition(SessionEvent.Retried), async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.retried", data })
  }),
  SyncEvent.project(EventV2Bridge.toSyncDefinition(SessionEvent.Compaction.Started), async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.compaction.started", data })
  }),
  SyncEvent.project(EventV2Bridge.toSyncDefinition(SessionEvent.Compaction.Delta), () => {}),
  SyncEvent.project(EventV2Bridge.toSyncDefinition(SessionEvent.Compaction.Ended), async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.compaction.ended", data })
  }),
]
