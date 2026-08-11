import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Database, eq } from "../../src/storage/db"
import { provideTestInstance, disposeAllInstances, tmpdir } from "../fixture/fixture"
import { Server } from "../../src/server/server"
import { Log } from "@opencode-ai/core/util/log"
import { ExecLogTable, queryExecLogsBySession } from "../../src/session/exec-log"
import { SessionTable } from "../../src/session/session.pg"

Log.init({ print: false })

const DB_URL = process.env.OPENCODE_DATABASE_URL
if (!DB_URL) {
  console.log("skip: OPENCODE_DATABASE_URL not set")
  process.exit(0)
}

const db = Database.Client()

async function queryLogs(sid: string) {
  return queryExecLogsBySession(sid)
}

async function cleanupSession(sid: string) {
  await db.delete(ExecLogTable).where(eq(ExecLogTable.session_id, sid as any)).run().catch(() => {})
  await db.delete(SessionTable).where(eq(SessionTable.id, sid as any)).run().catch(() => {})
}

beforeAll(async () => {
  await Database.initialize()
})

afterEach(async () => {
  await disposeAllInstances()
})

describe("session exec_log integration (PG)", () => {
  test("agent create/delete/clear are logged", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const sid = ((await (await app.request("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "exec-log-agent" }),
        })).json()) as { id: string }).id

        await app.request(`/session/${sid}/agents/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "a1", description: "A1", mode: "primary", prompt: "p1" }),
        })
        await app.request(`/session/${sid}/agents/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "a2", description: "A2", mode: "primary", prompt: "p2" }),
        })
        await app.request(`/session/${sid}/agents/a1`, { method: "DELETE" })
        await app.request(`/session/${sid}/agents`, { method: "DELETE" })

        const logs = await queryLogs(sid)
        const sources = logs.map((l) => l.source)
        expect(sources.filter((s) => s === "agent-create").length).toBe(2)
        expect(sources).toContain("agent-delete")
        expect(sources).toContain("agent-clear")

        await cleanupSession(sid)
      },
    })
  })

  test("session create is logged", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const sid = ((await (await app.request("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "exec-log-create" }),
        })).json()) as { id: string }).id

        const logs = await queryLogs(sid)
        expect(logs.some((l) => l.source === "session-create")).toBe(true)

        await cleanupSession(sid)
      },
    })
  })

  test("session update (patch) is logged", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const sid = ((await (await app.request("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "exec-log-patch" }),
        })).json()) as { id: string }).id

        await app.request(`/session/${sid}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "updated" }),
        })

        const logs = await queryLogs(sid)
        expect(logs.some((l) => l.source === "patch")).toBe(true)
        const patch = logs.find((l) => l.source === "patch")
        expect(patch?.command).toContain("updated")

        await cleanupSession(sid)
      },
    })
  })

  test("session abort is logged", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const sid = ((await (await app.request("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "exec-log-abort" }),
        })).json()) as { id: string }).id

        try { await app.request(`/session/${sid}/abort`, { method: "POST" }) } catch {}

        const logs = await queryLogs(sid)
        expect(logs.some((l) => l.source === "session-abort")).toBe(true)

        await cleanupSession(sid)
      },
    })
  })

  test("session share/unshare are logged", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const sid = ((await (await app.request("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "exec-log-share" }),
        })).json()) as { id: string }).id

        try { await app.request(`/session/${sid}/share`, { method: "POST" }) } catch {}
        try { await app.request(`/session/${sid}/share`, { method: "DELETE" }) } catch {}

        const logs = await queryLogs(sid)
        expect(logs.some((l) => l.source === "session-share")).toBe(true)
        expect(logs.some((l) => l.source === "session-unshare")).toBe(true)

        await cleanupSession(sid)
      },
    })
  })

  test("failed permission respond does not create exec_log", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const sid = ((await (await app.request("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "exec-log-perm-fail" }),
        })).json()) as { id: string }).id

        try {
          await app.request(`/session/${sid}/permission/perm_nonexistent`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ response: { action: "allow" } }),
          })
        } catch {}

        const logs = await queryLogs(sid)
        expect(logs.some((l) => l.source === "permission-respond")).toBe(false)

        await cleanupSession(sid)
      },
    })
  })

  test("message delete is logged", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const sid = ((await (await app.request("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "exec-log-msg-del" }),
        })).json()) as { id: string }).id

        try { await app.request(`/session/${sid}/message/msg_test`, { method: "DELETE" }) } catch {}

        const logs = await queryLogs(sid)
        expect(logs.some((l) => l.source === "message-delete")).toBe(true)

        await cleanupSession(sid)
      },
    })
  })

  test("command create/delete/clear are logged", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const sid = ((await (await app.request("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "exec-log-cmd" }),
        })).json()) as { id: string }).id

        await app.request(`/session/${sid}/commands/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "c1", template: "echo hi", description: "C1" }),
        })
        await app.request(`/session/${sid}/commands/c1`, { method: "DELETE" })
        await app.request(`/session/${sid}/commands`, { method: "DELETE" })

        const logs = await queryLogs(sid)
        const sources = logs.map((l) => l.source)
        expect(sources).toContain("command-create")
        expect(sources).toContain("command-delete")
        expect(sources).toContain("command-clear")

        await cleanupSession(sid)
      },
    })
  })

  test("agents-md create/clear are logged", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const sid = ((await (await app.request("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "exec-log-agentsmd" }),
        })).json()) as { id: string }).id

        await app.request(`/session/${sid}/agents-md/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "# Agents" }),
        })
        await app.request(`/session/${sid}/agents-md`, { method: "DELETE" })

        const logs = await queryLogs(sid)
        const sources = logs.map((l) => l.source)
        expect(sources).toContain("agentsmd-create")
        expect(sources).toContain("agentsmd-clear")

        await cleanupSession(sid)
      },
    })
  })

  test("plugin create/delete/clear are logged", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const sid = ((await (await app.request("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "exec-log-plugin" }),
        })).json()) as { id: string }).id

        await app.request(`/session/${sid}/plugins/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "p1", code: "export default {}" }),
        })
        await app.request(`/session/${sid}/plugins/p1`, { method: "DELETE" })
        await app.request(`/session/${sid}/plugins`, { method: "DELETE" })

        const logs = await queryLogs(sid)
        const sources = logs.map((l) => l.source)
        expect(sources).toContain("plugin-create")
        expect(sources).toContain("plugin-delete")
        expect(sources).toContain("plugin-clear")

        await cleanupSession(sid)
      },
    })
  })

  test("exec_log command captures payload", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const sid = ((await (await app.request("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "exec-log-payload" }),
        })).json()) as { id: string }).id

        const payload = { name: "payload-agent", description: "payload test", mode: "primary", prompt: "test" }
        await app.request(`/session/${sid}/agents/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })

        const logs = await queryLogs(sid)
        const agentLog = logs.find((l) => l.source === "agent-create")
        expect(agentLog).toBeDefined()
        expect(agentLog!.command).toContain("payload-agent")
        expect(agentLog!.command).toContain("payload test")

        await cleanupSession(sid)
      },
    })
  })

  test("nonexistent session returns 404 for agent create", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const res = await app.request("/session/ses_nonexistent/agents/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "ghost", description: "ghost", mode: "primary", prompt: "ghost" }),
        })
        expect(res.status).toBe(404)
      },
    })
  })

  test("reserved agent names are rejected", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const sid = ((await (await app.request("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "exec-log-reserved" }),
        })).json()) as { id: string }).id

        for (const name of ["compaction", "title", "summary", "build", "plan", "general", "explore"]) {
          const res = await app.request(`/session/${sid}/agents/create`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, description: "override", mode: "primary", prompt: "override" }),
          })
          expect(res.status).toBeGreaterThanOrEqual(400)
        }

        await cleanupSession(sid)
      },
    })
  })

  test("different sessions have isolated exec_logs", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const sidA = ((await (await app.request("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "iso-A" }),
        })).json()) as { id: string }).id
        const sidB = ((await (await app.request("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "iso-B" }),
        })).json()) as { id: string }).id

        await app.request(`/session/${sidA}/agents/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "a1", description: "A1", mode: "primary", prompt: "A" }),
        })
        await app.request(`/session/${sidB}/agents/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "b1", description: "B1", mode: "primary", prompt: "B" }),
        })

        const logsA = await queryLogs(sidA)
        const logsB = await queryLogs(sidB)

        expect(logsA.some((l) => l.source === "agent-create" && l.command.includes("A1"))).toBe(true)
        expect(logsB.some((l) => l.source === "agent-create" && l.command.includes("B1"))).toBe(true)
        expect(logsA.some((l) => l.command.includes("B1"))).toBe(false)
        expect(logsB.some((l) => l.command.includes("A1"))).toBe(false)

        await cleanupSession(sidA)
        await cleanupSession(sidB)
      },
    })
  })
})