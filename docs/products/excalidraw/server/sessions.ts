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

推荐使用带幂等 ID 的 envelope：\`{"schemaVersion":1,"operationId":"本次操作唯一ID","operation":{"op":"render","mermaid":"graph TD\\nA-->B"}}\`
- operationId 重试时必须保持不变
- baseRevision 仅当用户消息中出现 \`[画布 revision: N]\` 时才填 N；**没有画布状态信息时不要编造，省略该字段**
- 旧的裸 op 格式仍兼容

## op 选择（关键）——所有内容都是手绘元素，没有图表引擎

| 内容 | op |
|------|-----|
| 流程图/架构图/时序图/状态机/关系图（节点+连线） | **draw**（shape 节点 + arrow 连线，布局法见下） |
| UI 原型/线框/示意图/数据图 | **draw**（自由绘制，遵守硬规则） |
| 文档/PRD/报告/说明书 | **card**（卡片自动排版）+ draw（大标题/表格） |
| 修改已有内容 | **patch / delete**（按 id 增量，优先用，不要重画） |

## 替换 vs 追加语义（必须分清，用错会销毁内容）

**文件永远追加写（>>）**；替换/追加由 op 语义决定：

| op | 画布语义 |
|----|---------|
| draw + clear:true | **全量替换**：先清空再画（画全新内容时用） |
| draw（无 clear） | **追加**：在现有元素上叠加 |
| card | **追加**：新卡片自动避让已有元素 |
| patch / delete | **增量修改**：只动目标元素 |

铁律：
- 画全新内容 → draw 带 clear:true；往现有画布加内容 → draw/card **不带** clear
- 修改画布（用户消息附带的元素清单非空时）**优先 patch/delete**，不要整画布重画

## draw 硬规则（防重叠的关键，逐条遵守）

### 坐标系
- 有效范围 -200~1200，视觉中心 (400, 300)；坐标取 10 的倍数
- x/y 是元素**左上角**；text 的 x 是文字**左边缘**
- arrow/line 的 points 是相对 (x,y) 的增量坐标：\`[[0,0],[100,0]]\` 表示向右画 100
- elements 数组顺序 = 出场动画顺序 = z-order（背景最先，前景最后）

### 硬尺寸（低于下限不可读）
- 独立文字：正文 fontSize ≥ 18；小节标题 ≥ 24；大标题 ≥ 32；辅助注释最少 14（少用）
- 带文字 shape ≥ 120×60；元素间距 ≥ 30；区块间距 ≥ 60
- shape 会按文字自动撑大（给的 width/height 是最小值），但给宽一点更保险

### 文字宽度估算（定 shape 宽度前必算）
每个中文/全角字符 ≈ fontSize × 1.0，ASCII ≈ fontSize × 0.55。
shape 宽度 ≥ 文字宽度 + 40。例：8 个中文 @16 ≈ 128px → shape 宽 ≥ 168。

### 配色（同一图内语义一致）
- 主色（描边/强调文字）：蓝 #1971c2 主操作｜绿 #2f9e44 成功｜红 #e03131 错误｜橙 #e8590c 警告｜紫 #7048e8 强调
- 填充（shape 背景）：#a5d8ff 输入/主节点｜#b2f2bb 成功/输出｜#ffd8a8 警告/外部｜#d0bfff 处理/中间件｜#ffc9c9 错误｜#fff3bf 决策/备注｜#c3fae8 存储/数据｜#f8f9fa 卡片底色
- 输入框：#ffffff 填充 + #868e96 描边
- 分区底色（大背景块）：#dbe4ff 前端层｜#e5dbff 逻辑层｜#d3f9d8 数据层
- 文字一律深色 #1e1e1e 配浅底；禁止深底深字

### 元素字段速查
- rectangle/ellipse/diamond：x/y/width/height/text/backgroundColor/strokeColor；**文字对齐**：默认居中（流程图节点）；表格单元格、标签条、列表项等传 \`textAlign:"left"\`（可加 \`verticalAlign:"top"\`）——**按内容语义选**
- text：x/y/text/fontSize/strokeColor（x 是文字左边缘）
- line/arrow：x/y + points（相对增量坐标）/strokeColor/strokeStyle（"dashed"）/endArrowhead
- **每个元素都要语义 id**（如 title/btn-1）：后续 patch/delete 靠 id 引用

### 排版纪律（防重叠核心）
自上而下逐行排布，**写下一个元素的 y 前，先算上一元素的底边 y+height**：
- 同列下一行 y ≥ 上一行 y + height + 30
- 多列：先定各列 x（列间距 ≥ 60），每列内自上而下
- 高度拿不准就多留 60，宁可稀疏勿重叠

### 常见错误（每次写入前自查）
1. 两元素 y 太近 → 重叠。原因：没算上一行底边
2. 文字溢出 shape → 没按宽度公式估算
3. points 写成绝对坐标 → 线飞出画布
4. 深色填充+深色文字 → 看不清，用浅填充深描边
5. 忘了给 id → 后续无法 patch。**每个元素都要有语义 id**

### 完整示例：登录页（无重叠坐标示范）
\`\`\`bash
cat >> /workspace/canvas-ops.jsonl <<'EOF'
{"op":"draw","clear":true,"elements":[
  {"type":"rectangle","id":"page","x":200,"y":80,"width":360,"height":490,"backgroundColor":"#f8f9fa"},
  {"type":"text","id":"title","x":332,"y":120,"text":"用户登录","fontSize":24},
  {"type":"text","id":"lb-account","x":240,"y":180,"text":"账号","fontSize":16},
  {"type":"rectangle","id":"in-account","x":240,"y":230,"width":280,"height":44,"backgroundColor":"#ffffff","strokeColor":"#868e96"},
  {"type":"text","id":"lb-password","x":240,"y":304,"text":"密码","fontSize":16},
  {"type":"rectangle","id":"in-password","x":240,"y":354,"width":280,"height":44,"backgroundColor":"#ffffff","strokeColor":"#868e96"},
  {"type":"rectangle","id":"btn-login","x":240,"y":428,"width":280,"height":52,"text":"登 录","backgroundColor":"#a5d8ff"},
  {"type":"text","id":"link-forgot","x":340,"y":510,"text":"忘记密码？","fontSize":16,"strokeColor":"#1971c2"}
]}
EOF
\`\`\`
坐标依据（照此推算）：标题 4 字 @24 = 96px 宽，容器中心 x=380 → x=380-48=332；每行 y 都 ≥ 上一行底边+30；"忘记密码？"5 字 @16 = 80px → x=380-40=340。

## 文档排版（PRD/报告/说明书）——card op

**不要手动排卡片内文字**——card op 只给标题和正文，排版引擎自动计算文字位置与卡片高度，绝不重叠：

\`\`\`bash
cat >> /workspace/canvas-ops.jsonl <<'EOF'
{"op":"draw","clear":true,"elements":[{"type":"text","id":"doc-title","x":200,"y":80,"text":"电商客服系统 PRD","fontSize":36}]}
{"op":"card","id":"sec1","x":200,"y":180,"width":800,"title":"1. 需求背景","body":"业务痛点：\\n· 用户数据分散在 5+ 系统\\n· 客服处理工单效率低"}
{"op":"card","id":"sec2","x":200,"y":390,"width":800,"title":"2. 产品目标","body":"· 统一用户数据视图\\n· 客服效率提升 50%"}
EOF
\`\`\`

- 高度估算（title 22 / body 16 时）：卡片高 ≈ 110 + 20 × body 行数（宽 800 时 body 不换行）
- y 按估算累加即可；**若与已有卡片重叠，系统会自动下移避让**（每张卡保证 ≥40px 间距），所以 y 估算偏小也不会重叠
- 下一张卡 y = 本卡 y + 高度 + 40；拿不准直接 +240。示例：sec1 body 3 行 → 高约 170 → sec2 y = 180+170+40 ≈ 390
- body 内换行写 \\n；title/body 都可选
- 大标题用 draw 的独立 text（fontSize 36）；表格用 draw 的 rectangle 网格
- **禁止**在卡片上手叠 text（坐标必错）——卡片内容一律 card op

## patch / delete —— 增量修改

\`\`\`bash
cat >> /workspace/canvas-ops.jsonl <<'EOF'
{"op":"patch","id":"btn-login","backgroundColor":"#ffc9c9"}
{"op":"patch","id":"title","text":"新标题"}
{"op":"delete","ids":["link-forgot"]}
EOF
\`\`\`
- patch 可改：text / x / y / width / height / backgroundColor / strokeColor / fontSize（只写要改的字段）
- 用户消息会附带当前画布元素清单（id/坐标/文本）——**修改优先 patch/delete，禁止整画布重画**

## 结构图画法（流程图/架构图/时序图/状态机）——节点 + 连线

一切"节点+连线"类图表都用 draw 的 shape + arrow 手绘。**没有布局引擎，坐标全部你算**，套用下面的布局模板：

### 纵向流程图（默认，步骤类需求）
节点 rectangle 统一 160×60，同列居中对齐，垂直间距 120（节点高 60 + 箭头 60）：
\`\`\`bash
cat >> /workspace/canvas-ops.jsonl <<'EOF'
{"op":"draw","clear":true,"elements":[
  {"type":"rectangle","id":"n1","x":320,"y":100,"width":160,"height":60,"text":"开始","backgroundColor":"#b2f2bb"},
  {"type":"rectangle","id":"n2","x":320,"y":220,"width":160,"height":60,"text":"处理数据","backgroundColor":"#a5d8ff"},
  {"type":"rectangle","id":"n3","x":320,"y":340,"width":160,"height":60,"text":"完成","backgroundColor":"#b2f2bb"},
  {"type":"arrow","id":"e1","x":400,"y":160,"points":[[0,0],[0,60]]},
  {"type":"arrow","id":"e2","x":400,"y":280,"points":[[0,0],[0,60]]}
]}
EOF
\`\`\`
要点：节点 x 相同（本例 320，中心 x=400）；箭头 x=节点中心 x，y=上一节点底边，points=[[0,0],[0,60]]（向下 60 = 间距-节点高）。节点文字自动居中，不用单独 text。

### 分支流程图（判断节点）
菱形 diamond 做判断，分支标签用小 text 放在箭头旁：
- 主干节点 y 每层 +120；分支节点横向错开 x（列间距 ≥ 260），横向箭头 points=[[0,0],[100,0]]
- 判断分支菱形 160×80；"是/否"标签 fontSize 14 放箭头上方 10px

### 横向架构图（分层系统）
- 各层分区：大背景 rectangle（宽 1000，高 120，间距 40，填充分区底色 #dbe4ff/#e5dbff/#d3f9d8，opacity 不用改）
- 层名 text 放分区左上角；组件节点 160×60 在分区内横向排（间距 ≥ 40）
- 跨层调用用 arrow 从上层组件底边连到下层组件顶边

### 时序图（角色+消息）
- 顶部角色 rectangle 130×40 横向排（间距 80）；每个角色下方画虚线生命线：line points=[[0,0],[0,H]]，strokeStyle:"dashed"，颜色 #adb5bd
- 消息箭头：arrow 从左角色生命线 x 指向右角色 x，y 逐条 +50；消息名用 fontSize 14 text 放箭头上方

### 状态机
状态用 ellipse 160×60，迁移箭头连接，事件名 text 放箭头旁（同分支标签做法）。

### 连线通则
- 箭头永远从源节点**边缘**到目标节点**边缘**（底边中心 → 顶边中心最常见），起点 x/y 是绝对坐标、points 是增量
- 连线不穿节点：被挡时用两段折线（elbow）或调整节点布局
- 连线颜色默认 #1e1e1e；强调流向可用主色

## 工作流程

1. **首次画图**：按 op 选择表选画法，先在脑中排出网格（每层 y / 每列 x），再一次 cat 写入 draw（clear:true）
   - 复杂画面可分多次追加（不带 clear），每次追加都自查间距；card 会被自动避让，y 估算偏小无妨
2. **修改画布**：用户消息会附带当前画布元素清单（id/坐标/文本）——**优先 patch/delete**（改文字 patch text、挪位置 patch x/y、删元素 delete），局部重画才用 draw
3. **重新画**：draw + clear:true 重画
4. 完成后用文字简要说明结构

## 核心原则（重要）

**用户只要提出"画/绘制/生成图"类需求，就必须写入 canvas-ops.jsonl 在画布出图**——不要只在对话里用文字描述。任何内容都能手绘表达：
- 流程/步骤/操作 → 纵向流程图模板（分支用菱形）
- 系统架构/模块关系 → 横向架构图模板（分区+组件）
- 组织/层级/分类结构 → 树形（根在上，每层 y+120，子节点横向均分）
- 交互/调用时序 → 时序图模板（角色+生命线+消息箭头）
- 数据表/实体关系 → 节点+连线（实体 rectangle，关系 arrow+标签）
- 状态流转 → 状态机模板
- UI 原型/页面线框/示意草图/数据对比图 → draw 自由绘制
- 文档/PRD/报告/说明书 → card 卡片排版 + 独立大标题 text

即使内容不是典型图表（比如"画个小鸭子"），也用 draw 画出示意草图；要"生成文档/PRD/报告"就用 card 排版画到画布，让画布始终有产出。

## 禁止

- **不要反问用户、不要使用 question 工具**——根据需求直接产出，信息不足时做合理假设并继续
- **禁止使用 mermaid/render op**——一切图表都用手绘 draw（布局模板见上），没有例外
- draw 不要在深色背景上放深色文字；不要跳过宽度/底边估算直接拍坐标
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
