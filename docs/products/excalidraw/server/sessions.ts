import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// ---- 配置 ----

export interface ServerConfig {
  saasBaseUrl: string
  defaultModel: { providerID: string; modelID: string }
}

export function loadServerConfig(env: Record<string, string | undefined>): ServerConfig {
  const modelRaw = env.OPENCODE_SAAS_MODEL ?? 'Yd-KiMi/kimi-k3'
  const [providerID, modelID] = modelRaw.split('/')
  return {
    saasBaseUrl: env.OPENCODE_SAAS_BASE_URL ?? 'http://localhost:14096',
    defaultModel: { providerID: providerID ?? 'Yd-KiMi', modelID: modelID ?? 'kimi-k3' },
  }
}

// ---- 本地会话存储 ----

export interface SessionRecord {
  id: string
  saasSessionId: string
  directory: string
  canvasId: string
  title: string
  createdAt: string
}

const dataDir = path.resolve(import.meta.dirname, 'data')
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
const sessionsFile = path.join(dataDir, 'sessions.json')

function loadSessions(): SessionRecord[] {
  if (!fs.existsSync(sessionsFile)) return []
  return JSON.parse(fs.readFileSync(sessionsFile, 'utf8')) as SessionRecord[]
}

function saveSessions(sessions: SessionRecord[]) {
  fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2))
}

export function listSessions(): SessionRecord[] {
  return loadSessions().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function getSession(id: string): SessionRecord | undefined {
  return loadSessions().find((s) => s.id === id)
}

export function saveSession(session: SessionRecord) {
  const sessions = loadSessions()
  const idx = sessions.findIndex((s) => s.id === session.id)
  if (idx >= 0) sessions[idx] = session
  else sessions.push(session)
  saveSessions(sessions)
}

export function deleteSession(id: string) {
  saveSessions(loadSessions().filter((s) => s.id !== id))
}

// ---- SaaS 交互 ----

async function saasFetch(config: ServerConfig, path: string, init?: RequestInit) {
  const res = await fetch(`${config.saasBaseUrl}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  })
  if (!res.ok) throw new Error(`SaaS ${path} failed: HTTP ${res.status}`)
  return res
}

export async function createSaasSession(config: ServerConfig): Promise<{ id: string; directory?: string }> {
  const res = await saasFetch(config, '/session', { method: 'POST', body: '{}' })
  return res.json() as Promise<{ id: string; directory?: string }>
}

export async function registerSkill(config: ServerConfig, session: SessionRecord) {
  await saasFetch(config, `/session/${session.saasSessionId}/skills/create`, {
    method: 'POST',
    body: JSON.stringify({ name: 'excalidraw-canvas', description: SKILL_DESCRIPTION, content: buildSkillContent() }),
  })
}

export async function sendPrompt(
  config: ServerConfig,
  session: SessionRecord,
  text: string,
  canvasContext: string | null,
  model?: { providerID: string; modelID: string },
) {
  // 应用上下文：声明这是画布应用，产出必须画到画布（防止 AI 把内容写成文件或只回文字）
  const contextPrefix =
    '[系统] 这是一个 Excalidraw 画布应用。无论用户要求生成什么（图表、原型、文档、PRD、报告等），都必须使用 excalidraw-canvas 技能把内容画到画布上（写入 /workspace/canvas-ops.jsonl），不要 write 成文件、不要只在对话里回复。'
  const canvasPart = canvasContext
    ? `\n\n[当前画布状态（修改时基于它做增量 patch/delete，或输出完整新版）]\n${canvasContext}`
    : ''
  const fullText = `${contextPrefix}${canvasPart}\n\n[用户需求]\n${text}`
  await saasFetch(config, `/session/${session.saasSessionId}/prompt_async`, {
    method: 'POST',
    body: JSON.stringify({
      parts: [{ type: 'text', text: fullText }],
      model: model ?? config.defaultModel,
    }),
  })
}

export async function abortSession(config: ServerConfig, session: SessionRecord) {
  await saasFetch(config, `/session/${session.saasSessionId}/abort`, { method: 'POST' })
}

export async function setKeepAlive(config: ServerConfig, session: SessionRecord, enabled: boolean) {
  await saasFetch(config, `/session/${session.saasSessionId}/keep-alive`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  }).catch(() => {})
}

export async function fetchMessages(config: ServerConfig, session: SessionRecord): Promise<unknown> {
  const res = await saasFetch(
    config,
    `/session/${session.saasSessionId}/message`,
    { headers: { 'x-opencode-directory': session.directory } },
  )
  return res.json() as Promise<unknown>
}

export interface ModelOption {
  providerID: string
  modelID: string
  name: string
  label: string
}

export async function listModels(config: ServerConfig): Promise<{ models: ModelOption[]; current: { providerID: string; modelID: string } }> {
  const res = await saasFetch(config, '/provider')
  const data = (await res.json()) as {
    connected: string[]
    all: Array<{ id: string; models: Record<string, { name?: string }> }>
    default?: Record<string, string>
  }
  const models = data.all
    .filter((p) => data.connected.includes(p.id))
    .flatMap((p) =>
      Object.entries(p.models).map(([modelID, info]) => ({
        providerID: p.id,
        modelID,
        name: info.name ?? modelID,
        label: `${p.id}/${modelID}`,
      })),
    )
  const preferred = models.find(
    (m) => m.providerID === config.defaultModel.providerID && m.modelID === config.defaultModel.modelID,
  )
  return {
    models,
    current: preferred
      ? { providerID: preferred.providerID, modelID: preferred.modelID }
      : (models[0] ?? config.defaultModel),
  }
}

// ---- Skill 内容 ----

const SKILL_DESCRIPTION =
  '所有内容产出都必须画到 Excalidraw 画布上：图表（流程/架构/时序/ER/类/状态机）、UI原型、示意图、数据图、文档（PRD/报告/说明书）。只要用户要求生成、绘制、创建任何内容，就使用本技能在画布上产出。'

export function buildSkillContent(): string {
  return `---
name: excalidraw-canvas
description: ${SKILL_DESCRIPTION}
---

# Excalidraw 画布控制

**这是一个画布应用——你的所有产出都必须呈现在画布上，不要写成文件、不要只在对话里回复文字。**

用户的一切"生成/画/绘制/创建"类需求（图表、原型、文档、PRD、报告、示意图等），都必须通过写入 \`/workspace/canvas-ops.jsonl\` 画到画布上。即使需求听起来像"写文档"（比如"生成一个 PRD"），也要用文档排版画到画布，而不是 write 成 .md 文件。

方法：用 bash 把**一行 JSON**追加到 \`/workspace/canvas-ops.jsonl\`，外部系统会实时渲染到画布。

**必须用追加写（>>），每行一个完整 JSON。**

## 写入方法

有两种 op，根据内容类型选择：

### 方式一：render —— 结构化图表（流程/架构/时序/ER/类图/状态机）
\`\`\`bash
cat >> /workspace/canvas-ops.jsonl <<'EOF'
{"op":"render","mermaid":"graph TD\\n  A([开始]) --> B[输入账号密码]\\n  B --> C{校验通过?}\\n  C -->|成功| D[登录成功]"}
EOF
\`\`\`
mermaid 字符串内的换行必须写成 \\n（JSON 转义）。布局由引擎自动计算，**不要给坐标**。

### 方式二：draw —— 自由绘制（UI原型/示意图/数据图/文档排版）
\`\`\`bash
cat >> /workspace/canvas-ops.jsonl <<'EOF'
{"op":"draw","clear":true,"elements":[
  {"type":"text","id":"title","x":200,"y":80,"text":"登录","fontSize":24},
  {"type":"rectangle","id":"card","x":200,"y":100,"width":400,"height":300},
  {"type":"rectangle","id":"btn","x":240,"y":320,"width":320,"height":48,"text":"登 录","backgroundColor":"#1971c2"}
]}
EOF
\`\`\`
- elements 支持：rectangle/ellipse/diamond（带 text/backgroundColor）、text（fontSize）、line/arrow（points 相对坐标）
- **给每个元素起 id**（如 title/btn-1）：后续修改直接用 id 引用，不用重画
- **坐标你定**：以 (400, 300) 为视觉中心布局，间距 20 的倍数，画布有效范围约 -200~1200
- clear:true 先清空再画（全新内容时）；追加内容不带 clear

### 方式三：patch / delete —— 增量修改（画布上已有内容时）
\`\`\`bash
# 改单个元素（只写要改的字段）
cat >> /workspace/canvas-ops.jsonl <<'EOF'
{"op":"patch","id":"title","text":"新标题","fontSize":28}
{"op":"patch","id":"btn","backgroundColor":"#e03131"}
{"op":"delete","ids":["card","btn"]}
EOF
\`\`\`
- 用户消息会附带当前画布元素清单（id 和内容）——修改时**优先用 patch/delete**，不要重画整个画布

## 怎么选（关键）

- 流程/架构/时序/数据关系/类图/状态机 → **render**（布局引擎自动排版，最美观）
- UI 原型、页面线框、示意草图、简单数据图（柱状/对比） → **draw**
- **文档/PRD/报告/说明书 → draw（文档排版）**
- 拿不准时：有"节点+连线"关系用 render；是"画面布局/文档排版"用 draw

## draw 文档排版模板（PRD/报告/说明书）

把文档画成"卡片墙"：主标题 + 各章节卡片，自上而下排列。

\`\`\`bash
cat >> /workspace/canvas-ops.jsonl <<'EOF'
{"op":"draw","clear":true,"elements":[
  {"type":"text","x":200,"y":80,"text":"用户管理系统 PRD","fontSize":36},
  {"type":"line","x":200,"y":140,"points":[[0,0],[800,0]]},
  {"type":"rectangle","x":200,"y":180,"width":800,"height":140,"backgroundColor":"#f8f9fa","text":""},
  {"type":"text","x":230,"y":200,"text":"1. 需求背景","fontSize":22},
  {"type":"text","x":230,"y":240,"text":"业务痛点：\\n- 客服处理工单效率低\\n- 用户数据分散","fontSize":16},
  {"type":"rectangle","x":200,"y":360,"width":800,"height":140,"backgroundColor":"#f8f9fa","text":""},
  {"type":"text","x":230,"y":380,"text":"2. 功能范围","fontSize":22},
  {"type":"text","x":230,"y":420,"text":"用户列表 / 详情 / 权限 / 批量操作","fontSize":16}
]}
EOF
\`\`\`

排版规则：
- 页面左边距 x=200，内容宽度 800；主标题 fontSize 36，章节标题 22，正文 16
- 章节用浅色背景卡片（rectangle backgroundColor #f8f9fa），标题+正文要点 text 叠在卡片上（text 的 x = 卡片x+30）
- 正文要点用 \n 换行（多行 text）；y 坐标按内容高度递增，卡片间留 40px
- 表格用多个 rectangle 网格（表头深色底 #e9ecef）+ 单元格 text
- 文档内容多时分多个 draw op 追加写（不要 clear，累加往下排）

## mermaid 语法（支持的图类型）

根据需求选择图类型，**写对应的 mermaid 定义**：

### 1. flowchart — 流程图 / 架构图 / 组织结构（最常用）
\`\`\`
graph TD
  A([开始]) --> B[输入账号密码]
  B --> C{校验通过?}
  C -->|成功| D[登录成功]
  C -->|失败| E[登录失败]
\`\`\`
- \`graph TD\` 自上而下（架构图可用 \`graph LR\` 从左到右）
- 形状：\`[文本]\`矩形 \`{文本}\`菱形(判断) \`([文本])\`椭圆(起止) \`[(文本)]\`圆柱(存储)
- 标签连线：\`A -->|是| B\`；分组：\`subgraph 名称 ... end\`（名称用英文或拼音）

### 2. sequenceDiagram — 时序图 / 交互流程
\`\`\`
sequenceDiagram
  participant U as 用户
  participant S as 服务端
  U->>S: 提交登录
  S-->>U: 返回令牌
\`\`\`

### 3. classDiagram — UML 类图
\`\`\`
classDiagram
  class User { +String name +login() }
  class Admin { +banUser() }
  User <|-- Admin
\`\`\`

### 4. erDiagram — 实体关系图
\`\`\`
erDiagram
  USER ||--o{ ORDER : places
  ORDER ||--|{ ITEM : contains
\`\`\`

### 5. stateDiagram-v2 — 状态机
\`\`\`
stateDiagram-v2
  [*] --> 待支付
  待支付 --> 已支付: 付款
  已支付 --> [*]
\`\`\`

规则：
- 节点 id 用简单字母/英文（A、User…），显示文本写在括号里
- flowchart 的分支必须带标签（是/否、成功/失败）
- **不支持** mindmap/gantt/journey/pie——若用户需求是这些，用最接近的已支持类型表达（如思维导图→flowchart 层级、时间线→flowchart LR）

## 工作流程

1. **首次画图**：直接构思 → 一次 cat 写入一个 render op
   - 图较大时（>12 节点）可分两步：先写主干版本，再写完整增强版本（每版都必须是完整可渲染的 mermaid）
2. **修改画布**：用户消息会附带当前 mermaid，基于它修改后**输出完整新版本**（不要只输出 diff）
3. **重新画**：输出全新的 mermaid（自然覆盖旧图）
4. 完成后用文字简要说明图的结构

## 核心原则（重要）

**用户只要提出"画/绘制/生成图"类需求，就必须写入 canvas-ops.jsonl 在画布出图**——不要只在对话里用文字描述或用文字说明"只能画流程图"。任何内容都能用某种图类型表达：
- 流程/步骤/操作 → flowchart
- 系统架构/模块关系 → flowchart（LR 或 TD + subgraph 分组）
- 组织/层级/分类结构 → flowchart 树形
- 交互/调用时序 → sequenceDiagram
- 数据表关系 → erDiagram
- 状态流转 → stateDiagram-v2
- 类/接口设计 → classDiagram
- UI 原型/页面线框/示意草图/数据对比图 → draw（自由绘制）
- 文档/PRD/报告/说明书 → draw（文档排版，用上方模板）

即使内容不是典型图表（比如"画个小鸭子"），也用 draw 画出示意草图；要"生成文档/PRD/报告"就用文档排版模板画到画布，让画布始终有产出。

## 禁止

- **不要反问用户、不要使用 question 工具**——根据需求直接产出，信息不足时做合理假设并继续
- render 模式不要输出坐标——布局由引擎自动计算
- render 只用上面 5 种图类型；subgraph 名称避免纯中文（用英文/拼音，显示文本可中文）
- 不要在一次 op 里塞非 JSON 内容
`
}

export function newSessionRecord(saas: { id: string; directory?: string }, canvasId: string, title: string): SessionRecord {
  return {
    id: `s_${crypto.randomUUID().slice(0, 8)}`,
    saasSessionId: saas.id,
    directory: saas.directory ?? '/workspace',
    canvasId,
    title,
    createdAt: new Date().toISOString(),
  }
}
