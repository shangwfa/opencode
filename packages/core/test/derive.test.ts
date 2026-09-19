import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "@opencode/core/database/database"
import { SessionDerive } from "@opencode/core/session/derive"
import { SessionStore } from "@opencode/core/session/store"
import { ProjectTable } from "@opencode/core/project/sql"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Project } from "@opencode/schema/project"
import { location } from "./fixture/location"
import { Location } from "@opencode/core/location"
import { testEffect } from "./lib/effect"
import type { SessionMessage } from "@opencode/schema/session-message"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, SessionStore.node]), [Location.node.replace(current)]))

const source = "ses_src" as never

const seed = (messages: ReadonlyArray<Partial<SessionMessage.Info>>) =>
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: source,
        project_id: Project.ID.global,
        slug: "src",
        directory: "/project",
        title: "src",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    for (const [index, message] of messages.entries()) {
      yield* db
        .insert(SessionMessageTable)
        .values([
          {
            id: `msg_${index}`,
            session_id: source,
            type: message.type ?? "user",
            seq: index,
            time_created: index,
            time_updated: index,
            // store.messages decodes this JSON ({...data, id: row.id, type:
            // row.type}); it needs the full message body minus id/type.
            data: { ...message, time: { created: index } } as never,
          },
        ] as never)
        .run()
        .pipe(Effect.orDie)
    }
    return store
  })

describe("SessionDerive.transcript", () => {
  it.effect("returns undefined for an empty source (v1 silent skip)", () =>
    Effect.gen(function* () {
      const store = yield* seed([])
      expect(yield* SessionDerive.transcript(store, source)).toBeUndefined()
    }),
  )

  it.effect("returns undefined when no user message exists", () =>
    Effect.gen(function* () {
      const store = yield* seed([
        { type: "system", text: "system only" } as never,
      ])
      expect(yield* SessionDerive.transcript(store, source)).toBeUndefined()
    }),
  )

  it.effect("serializes user and assistant turns with speaker prefixes", () =>
    Effect.gen(function* () {
      const store = yield* seed([
        { type: "user", text: "代号是凤凰" } as never,
        {
          type: "assistant",
          agent: "build",
          model: { id: "m", providerID: "p", variant: "default" },
          content: [{ type: "text", text: "已记录" }],
        } as never,
      ])
      const text = (yield* SessionDerive.transcript(store, source))!
      expect(text).toContain("<conversation>")
      expect(text).toContain("User: 代号是凤凰")
      expect(text).toContain("Assistant: 已记录")
      expect(text).not.toContain("<prior-summary>")
    }),
  )

  it.effect("serializes tool calls and outputs so summaries cover tool results (v1 SUM-7)", () =>
    Effect.gen(function* () {
      const store = yield* seed([
        { type: "user", text: "执行 echo" } as never,
        {
          type: "assistant",
          agent: "build",
          model: { id: "m", providerID: "p", variant: "default" },
          content: [
            {
              type: "tool",
              id: "t1",
              name: "bash",
              time: { created: 1 },
              state: {
                status: "completed",
                input: { command: "echo hello-phoenix-777" },
                content: [{ type: "text", text: "hello-phoenix-777" }],
              },
            },
            {
              type: "tool",
              id: "t2",
              name: "read",
              time: { created: 2 },
              state: { status: "error", input: { path: "/x" }, error: { type: "tool.execution", message: "File not found" } },
            },
          ],
        } as never,
      ])
      const text = (yield* SessionDerive.transcript(store, source))!
      expect(text).toContain("Assistant tool bash")
      expect(text).toContain("hello-phoenix-777")
      expect(text).toContain("Assistant tool read")
      expect(text).toContain("error: File not found")
    }),
  )

  it.effect("anchors on the latest completed compaction and drops earlier turns", () =>
    Effect.gen(function* () {
      const store = yield* seed([
        { type: "user", text: "旧事实：芝麻开门" } as never,
        {
          type: "assistant",
          agent: "build",
          model: { id: "m", providerID: "p", variant: "default" },
          content: [{ type: "text", text: "旧回复" }],
        } as never,
        { type: "compaction", status: "completed", reason: "manual", summary: "旧摘要：包含芝麻", recent: "" } as never,
        { type: "user", text: "新事实：西瓜开门" } as never,
        {
          type: "assistant",
          agent: "build",
          model: { id: "m", providerID: "p", variant: "default" },
          content: [{ type: "text", text: "新回复" }],
        } as never,
      ])
      const text = (yield* SessionDerive.transcript(store, source))!
      expect(text).toContain("<prior-summary>")
      expect(text).toContain("旧摘要：包含芝麻")
      expect(text).toContain("User: 新事实：西瓜开门")
      // Pre-anchor turns never enter the generation input.
      expect(text).not.toContain("芝麻开门")
      expect(text).not.toContain("旧回复")
    }),
  )

  it.effect("keeps the prior summary alone when nothing follows the anchor", () =>
    Effect.gen(function* () {
      const store = yield* seed([
        { type: "user", text: "早期" } as never,
        { type: "compaction", status: "completed", reason: "auto", summary: "只有摘要", recent: "" } as never,
      ])
      const text = (yield* SessionDerive.transcript(store, source))!
      expect(text).toContain("<prior-summary>\n只有摘要")
      expect(text).not.toContain("<conversation>")
    }),
  )

  it.effect("ignores running or failed compactions as anchors", () =>
    Effect.gen(function* () {
      const store = yield* seed([
        { type: "user", text: "事实A" } as never,
        { type: "compaction", status: "running", reason: "auto", summary: "进行中", recent: "" } as never,
        { type: "user", text: "事实B" } as never,
      ])
      const text = (yield* SessionDerive.transcript(store, source))!
      expect(text).not.toContain("<prior-summary>")
      expect(text).toContain("User: 事实A")
      expect(text).toContain("User: 事实B")
    }),
  )
})
