/**
 * Phase B：从会话生成固定草稿候选（POST /api/automation-apps/draft，同步等待结构化 AI）。
 * 产物：draft-candidate.json（definition 原样落盘，供人工审阅与后续阶段复用）。
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs"
import { signIn, api, log, DIR } from "./lib.mjs"

const state = JSON.parse(readFileSync(`${DIR}state.json`, "utf8"))
const request = api(state.token ?? (await signIn()))
log("生成固定草稿候选（结构化 AI，可能数分钟）…")
const res = await request("POST", "/api/automation-apps/draft", { sessionId: state.sessionId }, 700_000)
if (!res.ok) throw new Error(`生成草稿失败 ${res.status}: ${res.text}`)
writeFileSync(`${DIR}draft-candidate.json`, JSON.stringify(res.body, null, 2))
const d = res.body.definition
log("候选生成完成：", d.name, `| steps=${d.steps.length} | params=${d.parameters.length} | verification=${d.verification ? d.verification.path : "无"}`)
for (const [i, step] of d.steps.entries())
  log(`  ${i + 1}. [${step.businessStage ?? "-"}] ${step.title} · ${step.operation.type}${step.operation.type === "script" ? `/${step.operation.runtime} ${step.operation.source.length}B` : ""}`)
