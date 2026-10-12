// read deny 语义最小探针：区分「read 执行授权未生效」与「精确路径匹配问题」。
import { assert, authenticate, api, fresh, put, select, prompt, write, shell, messages, tools, close, results, until, save } from "./session-agents-matrix-lib.mjs"

const success = (r) => assert(r.events.some(e => e.type === "session.execution.succeeded"), JSON.stringify(r.events.filter(e => /execution\./.test(e.type))))
const MARKER = "/workspace/probe-read.txt"

async function probe(label, rule) {
  const sid = await fresh(`read-probe-${label}`)
  await write(sid, MARKER, "PROBE_READ_TOKEN\n")
  await put(sid, "session/helper", {
    mode: "subagent",
    permissions: [rule],
    system: "Read the requested file exactly once with the read tool and reply with its exact content. If the read is denied, blocked, or errors, reply exactly READ_BLOCKED. Do not use other tools.",
  })
  await select(sid, "session/matrix-main", { mode: "primary", system: "Follow the exact requested tool calls. Do not retry or repair." })
  const r = await prompt(sid, `Call the native subagent tool exactly once: agent session/helper, description ${label}, prompt "Read ${MARKER} with the read tool and reply with its exact content. If denied reply READ_BLOCKED."`)
  success(r)
  const call = r.tools.find(p => p.name === "subagent")
  assert(call?.state?.metadata?.sessionID, "必须有真实 child")
  const child = call.state.metadata.sessionID
  await until("child 终态", () => api(`/api/session/${child}/message?order=asc`).then(x => x.data.some(m => m.type === "assistant")).then(ok => ok ? true : undefined), 120_000)
  const childTools = tools(await messages(child)).filter(p => p.name === "read")
  const childText = (await messages(child)).filter(m => m.type === "assistant").flatMap(m => (m.content ?? []).filter(p => p.type === "text").map(p => p.text)).join(" ")
  const readVisible = await api(`/api/session/${child}/agents`).then(x => true).catch(() => false)
  return {
    label, rule, child, childText: childText.slice(0, 120),
    readToolCalls: childTools.map(p => ({ status: p.state.status, error: p.state.error?.message?.slice(0, 140) })),
    blocked: childText.includes("READ_BLOCKED"), contentLeaked: childText.includes("PROBE_READ_TOKEN"),
  }
}

try {
  await authenticate()
  const evidence = {}
  evidence.wildcard = await probe("wildcard", { action: "read", resource: "*", effect: "deny" })
  evidence.exactPath = await probe("exact", { action: "read", resource: MARKER, effect: "deny" })
  evidence.globTxt = await probe("glob", { action: "read", resource: "*.txt", effect: "deny" })
  // 父会话自身选择带 deny 的 agent：primary 直接执行，验证同一规则在 primary 路径是否生效。
  {
    const sid = await fresh("read-probe-primary")
    await write(sid, MARKER, "PROBE_READ_TOKEN\n")
    await put(sid, "session/denied-primary", { mode: "primary", permissions: [{ action: "read", resource: "*", effect: "deny" }], system: "Read the requested file exactly once with the read tool and reply with its exact content. If denied reply READ_BLOCKED_PRIMARY." })
    await select(sid, "session/denied-primary")
    const r = await prompt(sid, `Read ${MARKER} with the read tool and reply with its exact content. If denied reply READ_BLOCKED_PRIMARY.`)
    success(r)
    evidence.primarySelf = { sid, text: r.text.trim().slice(0, 160), readParts: r.tools.filter(p => p.name === "read").map(p => ({ status: p.state.status, error: p.state.error?.message?.slice(0, 140) })) }
  }
  save("read-deny-probe", evidence)
  console.log(JSON.stringify(evidence, null, 2))
} catch (e) {
  results.push({ status: "failed", error: String(e), stack: e.stack })
} finally {
  await close(results.every(r => r.status !== "failed"))
}
process.exitCode = results.some(r => r.status === "failed") ? 1 : 0
