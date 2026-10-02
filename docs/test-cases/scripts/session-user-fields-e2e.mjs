import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const base = (process.env.BASE ?? "http://127.0.0.1:14101").replace(/\/$/, "")
const pgUrl = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const auth = process.env.OPENCODE_PASSWORD
  ? `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`
  : undefined

async function request(path, { body, headers = {}, signal, method } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(auth ? { authorization: auth } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  const text = await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = text
  }
  assert(response.ok, `${response.status} ${path}: ${JSON.stringify(data)}`)
  return data
}

async function createSession(title) {
  const result = await request("/api/session", {
    body: {
      title,
      location: { directory: "/workspace" },
      model: { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" },
    },
  })
  assert(result?.data?.id, `session create returned no ID: ${JSON.stringify(result)}`)
  return result.data.id
}

async function messages(sessionID) {
  const result = await request(`/api/session/${sessionID}/message?order=asc`)
  const data = Array.isArray(result) ? result : result?.data
  assert(Array.isArray(data), `unexpected message response: ${JSON.stringify(result)}`)
  return data.filter((item) => item.type === "user")
}

async function waitForUser(sessionID, text) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const found = (await messages(sessionID)).find((item) => item.text === text)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for projected user message: ${text}`)
}

let sessionID
try {
  sessionID = await createSession(`user-fields-e2e-${Date.now()}`)
  console.log(`E2E session: ${sessionID}`)
  const expected = []

  async function prompt(text, userName, userId, bodyUserId = "forged-body-id") {
    const body = { text, userName, userId: bodyUserId, resume: true }
    const data = await request(`/api/session/${sessionID}/prompt`, {
      body,
      headers: userId ? { "x-user-id": userId } : {},
    })
    assert(data?.data?.id, `prompt returned no admitted message ID: ${JSON.stringify(data)}`)
    const message = await waitForUser(sessionID, text)
    assert.equal(message.userName, userName)
    if (userId) {
      assert.equal(message.userId, userId)
      assert.notEqual(message.userId, bodyUserId)
    } else {
      assert.equal(message.userId, undefined)
    }
    await request(`/api/session/${sessionID}/interrupt?resume=false`, { method: "POST" })
    await request(`/api/experimental/session/${sessionID}/wait`, { method: "POST" })
    expected.push({ text, userName, userId })
  }

  await prompt("identity: alice", "alice", "pm-001")
  console.log("PASS T25.1/T25.2 header identity reaches message history")

  await prompt("identity omitted", undefined, undefined, undefined)
  console.log("PASS T25.3 omitted identity remains compatible")

  await prompt("body identity is untrusted", "bob", undefined, "spoofed-user")
  console.log("PASS T25.4 body userId is ignored without trusted header")

  await prompt("team: alice", "alice", "pm-001")
  await prompt("team: bob", "bob", "fe-002")
  await prompt("team: alice again", "alice", "pm-001")
  const userMessages = await messages(sessionID)
  const team = userMessages.filter((message) => message.text.startsWith("team:"))
  assert.deepEqual(
    team.map(({ userName, userId }) => [userName, userId]),
    [
      ["alice", "pm-001"],
      ["bob", "fe-002"],
      ["alice", "pm-001"],
    ],
  )
  console.log("PASS T25.5 multi-round identity and message ordering")

  const rows = execFileSync(
    "psql",
    [
      pgUrl,
      "-X",
      "-A",
      "-t",
      "-F",
      "\t",
      "-c",
      `SELECT data::jsonb->>'text', data::jsonb->>'userName', data::jsonb->>'userId' FROM session_message WHERE session_id = '${sessionID.replaceAll("'", "''")}' AND type = 'user' ORDER BY seq`,
    ],
    { encoding: "utf8" },
  )
  const dbRows = rows
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
  for (const item of expected) {
    const row = dbRows.find((candidate) => candidate[0] === item.text)
    assert(row, `PG is missing user message ${item.text}`)
    assert.equal(row[1] || undefined, item.userName)
    assert.equal(row[2] || undefined, item.userId)
  }
  console.log(`PASS PG projection verified (${dbRows.length} user messages)`)
} finally {
  if (sessionID) {
    try {
      const result = await request(`/api/session/${sessionID}`, { method: "DELETE" })
      assert.equal(result?.data?.deleted ?? true, true)
      console.log(`CLEANUP session removed: ${sessionID}`)
    } catch (error) {
      console.error(`CLEANUP failed for ${sessionID}: ${String(error)}`)
      process.exitCode = 1
    }
  }
}
