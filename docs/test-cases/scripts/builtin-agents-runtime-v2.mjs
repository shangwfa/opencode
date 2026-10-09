// Real-model / OpenSandbox runtime checks for the built-in explore Agent.
// The matrix API script stays deterministic; this script adds execution-time tool and file effects.
import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import {
  agents,
  authenticate,
  api,
  assert as helperAssert,
  check,
  close,
  fresh,
  messages,
  model,
  pg,
  permissionDecision,
  prompt,
  put,
  quote,
  raw,
  results,
  sessions,
  shell,
  text,
  tools,
  until,
  watch,
  write,
} from "./session-agents-matrix-lib.mjs"

const nonce = randomUUID().replaceAll("-", "").slice(0, 12)
const fixtureRoots = []
const children = []
const helper = (condition, message) => helperAssert(condition, message)
const eventData = (event) => event.data ?? event.properties ?? {}
const toolSucceeded = (events, name) => {
  const ids = new Set(
    events.filter((event) => event.type === "session.tool.input.started" && eventData(event).name === name)
      .map((event) => eventData(event).id),
  )
  return events.some((event) => event.type === "session.tool.success" && ids.has(eventData(event).id))
}

function evidenceEvents(sessionID) {
  try {
    return readFileSync(`${process.env.EVIDENCE_DIR}/events.jsonl`, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.sid === sessionID)
  } catch {
    return []
  }
}

async function createChild(parentID, title) {
  const result = await api("/api/session", "POST", {
    title,
    parentID,
    location: { directory: "/workspace" },
    agent: "explore",
    model,
  })
  const childID = result.data.id
  helper(childID, "child Session API did not return an ID")
  children.push({ id: childID, parentID })
  sessions.push({ sid: childID, title, parentID })
  await watch(childID)
  return childID
}

async function prepareExplore(parentID, childID, childInstruction, task) {
  await put(parentID, "explore", {
    description: "T62 runtime permission probe",
    system: [
      "You are executing a controlled built-in explore permission test.",
      "Follow the caller's task literally. Attempt each specifically named tool call once, even if the policy may reject it.",
      "Do not substitute other tools, do not claim a blocked operation succeeded, and report the actual tool results.",
    ].join(" "),
  })
  const effective = (await agents(childID)).find((item) => item.agent.id === "explore")
  helper(effective?.source === "session", "child Session did not resolve its owner's Session Agent overlay")
  const edit = await api(`/api/session/${childID}/permission`, "POST", {
    action: "edit",
    resources: [`/workspace/src/runtime-probe-${nonce}.txt`],
    agent: "explore",
  })
  const shellRule = await api(`/api/session/${childID}/permission`, "POST", {
    action: "shell",
    resources: ["touch /workspace/runtime-probe"],
    agent: "explore",
  })
  helper(edit.data.effect === "deny" && shellRule.data.effect === "deny", "Session system-prompt override did not preserve explore's built-in deny rules")

  return { childInstruction, task }
}

async function runExplore(childID, task) {
  // Prompt the existing child Session directly. This avoids a parent LLM repeating a completed
  // subagent call when it receives the child-completion notification, making tool-count assertions deterministic.
  const run = await prompt(childID, task)
  const childMessages = await messages(childID)
  const childTools = tools(childMessages)
  return { childID, run, childMessages, childTools, transcript: text(childMessages) }
}

try {
  await authenticate()

  await check(11, "Code Mode sandbox is active for a normal built-in Agent", async () => {
    const sessionID = await fresh(`builtin-code-mode-${nonce}`)
    const run = await prompt(
      sessionID,
      "Call execute exactly once with this code and do not call another tool: return { marker: 'BUILTIN_CODEMODE_ACTIVE' }",
    )
    helper(toolSucceeded(run.events, "execute"), "default Agent did not successfully call Code Mode execute")
    helper(run.text.includes("BUILTIN_CODEMODE_ACTIVE"), "Code Mode result marker missing from assistant response")
    return { sessionID, executor: process.env.OPENCODE_CODEMODE_EXECUTOR ?? "sandbox-default", marker: "BUILTIN_CODEMODE_ACTIVE" }
  })

  await check(12, "explore reads an allowed file but cannot write or run shell", async () => {
    const parentID = await fresh(`builtin-explore-readonly-${nonce}`)
    fixtureRoots.push({ parentID, paths: [] })
    const source = `/workspace/src/explore-canary-${nonce}.js`
    const writeTarget = `/workspace/src/explore-denied-write-${nonce}.txt`
    const shellTarget = `/workspace/src/explore-denied-shell-${nonce}.txt`
    const canary = `EXPLORE_READ_ALLOWED_${nonce}`
    fixtureRoots.at(-1).paths.push(source, writeTarget, shellTarget)
    await write(parentID, source, canary)
    const childID = await createChild(parentID, `explore-readonly-${nonce}`)

    const task = [
      `Use read on ${source} and report its exact contents.`,
      `Then use write to create ${writeTarget} with the exact content DENIED_WRITE_${nonce}.`,
      `Then use shell to run exactly: touch '${shellTarget}'.`,
      "Do not use another tool or claim a denied side effect succeeded.",
    ].join(" ")
    await prepareExplore(parentID, childID, "read allowed source; then attempt denied write and shell", task)

    helper((await api(`/api/session/${childID}/permission`, "POST", {
      action: "edit",
      resources: [`src/explore-denied-write-${nonce}.txt`],
      agent: "explore",
    })).data.effect === "deny", "explore edit permission API did not return deny")
    helper((await api(`/api/session/${childID}/permission`, "POST", {
      action: "shell",
      resources: [`touch ${shellTarget}`],
      agent: "explore",
    })).data.effect === "deny", "explore shell permission API did not return deny")

    const result = await runExplore(childID, task)
    const readTool = result.childTools.find((tool) => tool.name === "read")
    helper(readTool?.state?.status === "completed", "explore did not complete the allowed read tool")
    helper(result.transcript.includes(canary), "allowed canary was not returned by the explore child")
    for (const tool of result.childTools.filter((item) => ["write", "edit", "patch", "shell", "execute"].includes(item.name))) {
      helper(tool.state?.status !== "completed", `${tool.name} unexpectedly succeeded under explore permissions`)
    }
    const shellCheck = await shell(parentID, `test ! -e '${writeTarget}' && test ! -e '${shellTarget}' && echo ABSENT`)
    helper(shellCheck.trim() === "ABSENT", "explore denied-operation files exist in the Sandbox")
    const persisted = await pg(`SELECT parent_id || '|' || agent FROM session_v2 WHERE id=${quote(childID)}`)
    helper(persisted === `${parentID}|explore`, `child Session PG identity mismatch: ${persisted}`)
    return { parentID, childID, read: "completed", deniedTargets: [writeTarget, shellTarget], sideEffects: "absent" }
  })

  await check(13, "explore .env-pattern read creates an ask and reject prevents disclosure", async () => {
    const parentID = await fresh(`builtin-explore-env-${nonce}`)
    fixtureRoots.push({ parentID, paths: [] })
    const envFile = `/workspace/.env.local-${nonce}`
    // Keep the secret independent from the path/nonce so a model cannot reconstruct it from the prompt.
    const secret = randomBytes(32).toString("hex")
    fixtureRoots.at(-1).paths.push(envFile)
    await write(parentID, envFile, secret)
    const childID = await createChild(parentID, `explore-env-${nonce}`)
    permissionDecision(childID, "reject")

    const task = `Use read exactly once on ${envFile} and report only the actual tool result. Do not use any other tool.`
    await prepareExplore(parentID, childID, "read a sensitive .env-pattern file", task)
    helper((await api(`/api/session/${childID}/permission`, "POST", {
      action: "read",
      resources: [`.env.local-${nonce}`],
      agent: "explore",
    })).data.effect === "ask", "explore .env.local-pattern permission API did not return ask")

    const result = await runExplore(childID, task)
    const readTool = result.childTools.find((tool) => tool.name === "read")
    helper(result.childTools.filter((tool) => tool.name === "read").length === 1, "explore did not make exactly one read attempt")
    helper(readTool && readTool.state?.status !== "completed", "rejected .env read unexpectedly completed")
    helper(!JSON.stringify(result.childMessages).includes(secret), "sensitive .env content leaked into child message history")
    helper(!JSON.stringify(await messages(parentID)).includes(secret), "sensitive .env content leaked into parent message history")

    const asked = await until("child SSE permission.asked evidence", () => {
      const found = evidenceEvents(childID).find((event) => event.type === "permission.asked" && event.data?.action === "read")
      return found
    })
    const events = evidenceEvents(childID)
    helper(asked?.data?.resources?.includes(`.env.local-${nonce}`), "child SSE did not record the matching read permission.asked event")
    helper(
      events.some((event) => event.type === "permission.replied" && event.data?.requestID === asked.data.id && event.data?.reply === "reject"),
      "child SSE did not record the automated reject reply",
    )
    const saved = await pg(
      `SELECT count(*) FROM permission WHERE project_id=(SELECT project_id FROM session_v2 WHERE id=${quote(parentID)}) AND action='read' AND resource=${quote(`.env.local-${nonce}`)}`,
    )
    helper(saved === "0", `reject unexpectedly persisted a saved permission row: ${saved}`)
    return { parentID, childID, permission: "ask → reject", secretDisclosed: false, savedPermissionRows: 0 }
  })
} finally {
  for (const fixture of fixtureRoots) {
    try {
      if (fixture.paths.length) await shell(fixture.parentID, `rm -f ${fixture.paths.map(quote).join(" ")}`)
    } catch {}
  }
  for (const child of children) await raw(`/api/session/${child.id}`, "DELETE").catch(() => undefined)
  await close(true)
}

if (results.some((result) => result.status === "failed")) process.exitCode = 1
