import { beforeAll, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"

const enabled = process.env.OPENCODE_COMMANDS_E2E === "1"
const run = enabled ? test : test.skip
const base = process.env.OPENCODE_COMMANDS_BASE_URL ?? "http://127.0.0.1:14097"
let authorization: string

beforeAll(() => {
  if (!enabled) return
  const logs = execFileSync("docker", ["logs", "opencode-saas-commands-test"], { encoding: "utf8" })
  const password = logs.match(/^server password (.+)$/m)?.[1]
  if (!password) throw new Error("The test container did not log its generated server password")
  authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
})

function query(statement: string) {
  return execFileSync(
    "psql",
    ["-h", "127.0.0.1", "-p", "5432", "-U", "local", "-d", "opencode-v2-up", "-At", "-F", "\t", "-c", statement],
    { encoding: "utf8" },
  ).trim()
}

async function request(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const raw = response.status === 204 ? "" : await response.text()
  let result: unknown
  if (raw) {
    try {
      result = JSON.parse(raw)
    } catch {
      result = raw
    }
  }
  return { status: response.status, result }
}

run("exercises session command CRUD and verifies PostgreSQL persistence", async () => {
  const oldSessions = query("SELECT id FROM session_v2 WHERE title = 'session commands E2E'").split("\n").filter(Boolean)
  for (const sessionID of oldSessions) await request("DELETE", `/api/session/${sessionID}`)

  const createdSession = await request("POST", "/api/session", { title: "session commands E2E" })
  expect(createdSession.status).toBe(200)
  const sessionID = (createdSession.result as { data: { id: string } }).data.id

  const created = await request("POST", `/api/session/${sessionID}/commands`, {
    name: "e2e-check",
    template: "Check $ARGUMENTS",
    description: "E2E command",
    agent: "plan",
    subtask: true,
  })
  if (created.status !== 200) throw new Error(`Create command failed (${created.status}): ${JSON.stringify(created.result)}`)
  expect(created.status).toBe(200)
  expect(created.result).toMatchObject({
    name: "e2e-check",
    template: "Check $ARGUMENTS",
    description: "E2E command",
    source: "session",
    subagent: true,
    subtask: true,
    hints: ["$ARGUMENTS"],
  })

  let values = query(`SELECT name, description, template, agent, subagent, hints, time_created, time_updated
    FROM session_commands WHERE session_id = '${sessionID}' AND name = 'e2e-check'`).split("\t")
  expect(values).toHaveLength(8)
  expect(values.slice(0, 5)).toEqual(["e2e-check", "E2E command", "Check $ARGUMENTS", "plan", "1"])
  expect(JSON.parse(values[5]!)).toEqual(["$ARGUMENTS"])
  const createdAt = values[6]
  const firstUpdatedAt = values[7]

  await new Promise((resolve) => setTimeout(resolve, 20))
  const updated = await request("POST", `/api/session/${sessionID}/commands`, {
    name: "e2e-check",
    template: "Updated $1 and $2",
    hints: ["explicit"],
  })
  expect(updated.status).toBe(200)
  expect(updated.result).toMatchObject({ template: "Updated $1 and $2", hints: ["explicit"] })
  values = query(`SELECT name, description, template, agent, subagent, hints, time_created, time_updated
    FROM session_commands WHERE session_id = '${sessionID}' AND name = 'e2e-check'`).split("\t")
  expect(values).toHaveLength(8)
  expect(values[2]).toBe("Updated $1 and $2")
  expect(values[6]).toBe(createdAt)
  expect(Number(values[7])).toBeGreaterThan(Number(firstUpdatedAt))
  expect(JSON.parse(values[5]!)).toEqual(["explicit"])

  const listing = await request("GET", `/api/session/${sessionID}/commands`)
  expect((listing.result as { data: Array<{ name: string }> }).data.some((item) => item.name === "e2e-check")).toBe(true)
  expect(query(`SELECT COUNT(*) FROM session_commands WHERE session_id = '${sessionID}'`)).toBe("1")

  expect((await request("DELETE", `/api/session/${sessionID}/commands/e2e-check`)).status).toBe(204)
  expect(query(`SELECT COUNT(*) FROM session_commands WHERE session_id = '${sessionID}'`)).toBe("0")

  await request("POST", `/api/session/${sessionID}/commands`, { name: "cascade-check", template: "cascade" })
  expect((await request("DELETE", `/api/session/${sessionID}`)).status).toBe(204)
  expect(query(`SELECT COUNT(*) FROM session_commands WHERE session_id = '${sessionID}'`)).toBe("0")
})
