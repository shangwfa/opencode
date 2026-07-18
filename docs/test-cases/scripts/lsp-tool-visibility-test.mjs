#!/usr/bin/env bun

const BASE = process.env.BASE || "http://localhost:14096"
const PROVIDER = process.env.PROVIDER || "zhipuai"
const MODEL = process.env.MODEL_ID || "glm-5.1"
const EXPECT_DISABLED = process.env.EXPECT_LSP_DISABLED === "1"

async function getJSON(path) {
  const response = await fetch(`${BASE}${path}`)
  const text = await response.text()
  const data = JSON.parse(text)
  if (!response.ok) throw new Error(`GET ${path} failed: HTTP ${response.status} ${text}`)
  return data
}

let pass = 0
let fail = 0

function check(name, ok, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`)
  if (ok) pass++
  else fail++
}

const ids = await getJSON("/experimental/tool/ids")
const tools = await getJSON(`/experimental/tool?provider=${encodeURIComponent(PROVIDER)}&model=${encodeURIComponent(MODEL)}`)
const lsp = tools.find((tool) => tool.id === "lsp")
const operations = lsp?.parameters?.properties?.operation?.enum ?? []
const expectedOperations = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
]

if (EXPECT_DISABLED) {
  check("ids excludes lsp", !ids.includes("lsp"), `count=${ids.length}`)
  check("provider tool schema excludes lsp", !lsp, `count=${tools.length}`)
} else {
  check("ids includes lsp", ids.includes("lsp"), `count=${ids.length}`)
  check("provider tool schema includes lsp", !!lsp, `count=${tools.length}`)
  check("lsp exposes operation enum", expectedOperations.every((operation) => operations.includes(operation)), operations.join(", "))
  check("lsp description mentions sandbox-safe capabilities", lsp?.description?.includes("workspaceSymbol") && lsp.description.includes("goToImplementation"))
}

console.log(`\n===== LSP Tool Visibility: PASS=${pass} FAIL=${fail} =====`)
process.exit(fail > 0 ? 1 : 0)
