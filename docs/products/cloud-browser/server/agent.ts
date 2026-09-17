import type { ServerConfig } from './config.ts'
import { addSandboxAlias, createSandbox, destroySandbox } from './sandbox.ts'
import { db } from './db.ts'

export interface AgentSession {
  id: string
  sandboxId: string
  sessionId: string
  directory: string
  prompt: string
  title: string
  createdAt: string
  status: 'running' | 'idle' | 'error'
  mode: 'playwright' | 'agent-browser'
}

interface AgentRow {
  id: string
  sandbox_id: string
  session_id: string
  directory: string
  prompt: string
  title: string
  status: string
  mode: string
  created_at: string
}

const SKILL_NAME = 'cloud-browser'

function rowToAgent(row: AgentRow): AgentSession {
  return {
    id: row.id,
    sandboxId: row.sandbox_id,
    sessionId: row.session_id,
    directory: row.directory,
    prompt: row.prompt,
    title: row.title,
    createdAt: row.created_at,
    status: row.status as AgentSession['status'],
    mode: (row.mode ?? 'playwright') as 'playwright' | 'agent-browser',
  }
}

function buildPlaywrightSkillContent(sandboxId: string, apiBase: string): string {
  return `---
name: cloud-browser
description: 控制云端 Chrome 浏览器完成网页任务：打开页面、读取内容、点击、输入、滚动、截图。当任务需要访问/操作网页时使用。
---

# Cloud Browser 浏览器控制

你可以控制一个云端 Chrome 浏览器（sandbox id: \`${sandboxId}\`）。通过 REST API 用 bash + curl 调用。

**API 基础地址**: \`${apiBase}\`

> curl 必须加 \`-s --noproxy '*'\` 绕过本地代理。

## 可用操作

### 1. 打开网页
\`\`\`bash
curl -s --noproxy '*' -X POST ${apiBase}/api/sandboxes/${sandboxId}/browser/navigate \\
  -H 'Content-Type: application/json' -d '{"url": "https://example.com"}'
\`\`\`

### 2. 获取页面可交互元素 + 页面摘要（核心！）
\`\`\`bash
curl -s --noproxy '*' ${apiBase}/api/sandboxes/${sandboxId}/browser/snapshot
\`\`\`
返回 \`{snapshot, summary, url, title}\`：
- \`summary\`：页面正文前 800 字符（快速了解页面内容）
- \`snapshot\`：可交互元素列表（每行一个，带 ref 标号）：
\`\`\`
[e1] a "登录" -> https://...
[e2] input type=text "搜索..."
[e3] button "提交"
\`\`\`

### 3. 点击元素
\`\`\`bash
curl -s --noproxy '*' -X POST ${apiBase}/api/sandboxes/${sandboxId}/browser/click \\
  -H 'Content-Type: application/json' -d '{"ref": "e1"}'
\`\`\`

### 4. 输入文本（先清空再输入）
\`\`\`bash
curl -s --noproxy '*' -X POST ${apiBase}/api/sandboxes/${sandboxId}/browser/type \\
  -H 'Content-Type: application/json' -d '{"ref": "e2", "text": "要输入的内容"}'
\`\`\`

### 5. 下拉框选择
\`\`\`bash
curl -s --noproxy '*' -X POST ${apiBase}/api/sandboxes/${sandboxId}/browser/select \\
  -H 'Content-Type: application/json' -d '{"ref": "e3", "value": "选项文本或value"}'
\`\`\`

### 6. 按键（Enter/Tab/Escape 等）
\`\`\`bash
curl -s --noproxy '*' -X POST ${apiBase}/api/sandboxes/${sandboxId}/browser/key \\
  -H 'Content-Type: application/json' -d '{"key": "Enter"}'
\`\`\`

### 7. 滚动页面
\`\`\`bash
curl -s --noproxy '*' -X POST ${apiBase}/api/sandboxes/${sandboxId}/browser/scroll \\
  -H 'Content-Type: application/json' -d '{"direction": "down", "amount": 600}'
\`\`\`
direction: up / down / left / right

### 8. 读取页面正文文本
\`\`\`bash
curl -s --noproxy '*' '${apiBase}/api/sandboxes/${sandboxId}/browser/text?max=8000'
\`\`\`

### 9. 当前状态（URL + 标题）
\`\`\`bash
curl -s --noproxy '*' ${apiBase}/api/sandboxes/${sandboxId}/browser/state
\`\`\`

### 10. 等待元素/文本出现
\`\`\`bash
curl -s --noproxy '*' -X POST ${apiBase}/api/sandboxes/${sandboxId}/browser/wait \\
  -H 'Content-Type: application/json' -d '{"text": "加载完成", "timeoutMs": 10000}'
\`\`\`
也支持 \`{"selector": ".result-list"}\`。不带参数则等待 timeoutMs 毫秒。

### 11. 执行任意 JavaScript（兜底能力）
\`\`\`bash
curl -s --noproxy '*' -X POST ${apiBase}/api/sandboxes/${sandboxId}/browser/eval \\
  -H 'Content-Type: application/json' -d '{"script": "document.querySelectorAll(\".item\").length"}'
\`\`\`
返回 \`{"result": ...}\`。script 在页面上下文执行，可读取/操作 DOM。

### 12. 后退
\`\`\`bash
curl -s --noproxy '*' -X POST ${apiBase}/api/sandboxes/${sandboxId}/browser/go-back
\`\`\`

### 13. 标签页管理
\`\`\`bash
curl -s --noproxy '*' ${apiBase}/api/sandboxes/${sandboxId}/browser/tabs
curl -s --noproxy '*' -X POST ${apiBase}/api/sandboxes/${sandboxId}/browser/switch-tab \\
  -H 'Content-Type: application/json' -d '{"index": 1}'
\`\`\`

### 14. 下载文件（点击下载按钮并保存）
\`\`\`bash
curl -s --noproxy '*' -X POST ${apiBase}/api/sandboxes/${sandboxId}/browser/download \\
  -H 'Content-Type: application/json' -d '{"ref": "e5", "timeoutMs": 30000}'
\`\`\`
返回 \`{"filename": "orders.xlsx", "size": 12345, "downloadUrl": "..."}\`。
然后用 downloadUrl 把文件下载到你的沙箱：
\`\`\`bash
curl -s --noproxy '*' -o /workspace/orders.xlsx "${apiBase}/api/sandboxes/${sandboxId}/browser/files/orders.xlsx"
\`\`\`

### 15. 上传文件到上传框
\`\`\`bash
curl -s --noproxy '*' -X POST ${apiBase}/api/sandboxes/${sandboxId}/browser/upload \\
  -H 'Content-Type: application/json' -d '{"ref": "e6", "filename": "orders.xlsx"}'
\`\`\`
filename 是之前 download 保存的文件名（服务端已存）。也可直接传 base64：
\`\`\`bash
B64=$(base64 -w0 /workspace/local-file.csv)
curl -s --noproxy '*' -X POST ${apiBase}/api/sandboxes/${sandboxId}/browser/upload \\
  -H 'Content-Type: application/json' -d "{\"ref\": \"e6\", \"filename\": \"local-file.csv\", \"contentBase64\": \"$B64\"}"
\`\`\`

### 16. 截图（返回 base64 JPEG）
\`\`\`bash
curl -s --noproxy '*' ${apiBase}/api/sandboxes/${sandboxId}/browser/screenshot
\`\`\`
返回 \`{"image": "<base64>", "mimeType": "image/jpeg"}\`。如需查看截图内容：
\`\`\`bash
curl -s --noproxy '*' ${apiBase}/api/sandboxes/${sandboxId}/browser/screenshot | python3 -c "import json,sys,base64; open('/workspace/screenshot.jpg','wb').write(base64.b64decode(json.load(sys.stdin)['image']))"
\`\`\`
然后用 read 工具查看 \`/workspace/screenshot.jpg\`。**必须保存到 /workspace**（沙箱工作目录），其他路径会触发权限限制。

## 标准工作流程
1. \`navigate\` 打开目标页面，然后 \`sleep 2\` 等页面加载
2. \`snapshot\` 获取页面摘要 + 可交互元素
3. \`click\` / \`type\` / \`select\` / \`key\` 操作元素
4. 每次操作后重新 \`snapshot\`（ref 标号会变化）
5. 用 \`text\` 或 \`state\` 提取结果

## 注意事项
- **每次操作后 ref 会失效**，必须重新 snapshot 获取新标号
- 页面跳转/加载后等待 1-3 秒再 snapshot；动态内容用 \`wait\` 等待元素出现
- 点击打开新标签页时，用 \`tabs\` + \`switch-tab\` 切换
- 遇到登录/验证码，用 screenshot 查看页面并告知用户
- snapshot 里没有的元素可以用 \`eval\` 直接操作 DOM
- 需要等待时直接用 bash \`sleep N\`
`
}

function buildAgentBrowserSkillContent(sandboxId: string, apiBase: string): string {
  const cdpWsUrl = apiBase.replace('http://', 'ws://') + `/ws/cdp/${sandboxId}`
  return `---
name: cloud-browser
description: 控制云端 Chrome 浏览器完成网页任务：打开页面、读取内容、点击、输入、滚动、截图。使用 agent-browser CLI 直接连接 CDP。
---

# Cloud Browser 浏览器控制（agent-browser 直连）

本机的 \`agent-browser\` CLI 已安装（版本 0.33.2），可以直接通过 CDP 连接控制云端 Chrome 浏览器。

**当前浏览器 sandbox id**: \`${sandboxId}\`

## 连接方式

### 第一步：连接 CDP
\`\`\`bash
agent-browser connect ${cdpWsUrl}
\`\`\`

### 第二步：打开网页
\`\`\`bash
agent-browser open https://example.com
\`\`\`

### 第三步：获取可交互元素
\`\`\`bash
agent-browser wait --load networkidle && agent-browser snapshot -i
\`\`\`

### 第四步：交互
\`\`\`bash
agent-browser click @e1
agent-browser fill @e2 "text"
agent-browser press Enter
agent-browser scroll down 500
\`\`\`

### 截图
\`\`\`bash
agent-browser screenshot --annotate
\`\`\`

### 获取页面信息
\`\`\`bash
agent-browser get url
agent-browser get title
agent-browser get text @e1
\`\`\`

### 等待
\`\`\`bash
agent-browser wait --load networkidle
agent-browser wait @e1
agent-browser wait 2000
\`\`\`

### 执行 JavaScript
\`\`\`bash
agent-browser eval 'document.title'
\`\`\`

## 多浏览器控制（可选）

\`\`\`bash
# 创建新沙箱
curl -s --noproxy '*' -X POST ${cdpWsUrl.replace('/ws/cdp/', '/api/sandboxes/').replace('ws://', 'http://').split('/api')[0] + '/api/sandboxes'}

# 用 --session 区分不同浏览器
agent-browser --session B connect ws://host:port/ws/cdp/<new-sandbox-id>
agent-browser --session B open https://other-site.com
\`\`\`

## 注意事项
- 先 \`connect\` 再执行其他命令
- 每次操作后 ref 会失效，重新 \`snapshot -i\`
- 截图保存到 \`/workspace\` 后用 read 工具查看
`
}

function buildSkillContent(sandboxId: string, apiBase: string, mode: 'playwright' | 'agent-browser'): string {
  if (mode === 'agent-browser') {
    return buildAgentBrowserSkillContent(sandboxId, apiBase)
  }
  return buildPlaywrightSkillContent(sandboxId, apiBase)
}
export async function createAgent(
  config: ServerConfig,
  prompt: string,
  model?: { providerID: string; modelID: string },
  mode?: 'playwright' | 'agent-browser',
): Promise<AgentSession> {
  const sandboxInfo = await createSandbox(config)
  const sandboxId = sandboxInfo.id

  try {
    const sessionRes = await fetch(`${config.saas.baseUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    if (!sessionRes.ok) {
      throw new Error(`create session failed: HTTP ${sessionRes.status}`)
    }
    const session = (await sessionRes.json()) as { id: string; directory?: string }

    const resolvedMode = mode ?? config.agent.browserMode

    const skillRes = await fetch(
      `${config.saas.baseUrl}/session/${session.id}/skills/create`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: SKILL_NAME,
          description:
            '控制云端 Chrome 浏览器完成网页任务：打开页面、读取内容、点击、输入、滚动、截图。当任务需要访问/操作网页时使用。',
          content: buildSkillContent(sandboxId, config.agent.apiBase, resolvedMode),
        }),
      },
    )
    if (!skillRes.ok) {
      throw new Error(`register skill failed: HTTP ${skillRes.status}`)
    }

    const promptRes = await fetch(
      `${config.saas.baseUrl}/session/${session.id}/prompt_async`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parts: [{ type: 'text', text: prompt }],
          skills: [SKILL_NAME],
          model: model ?? config.saas.model,
        }),
      },
    )
    if (!promptRes.ok) {
      throw new Error(`send prompt failed: HTTP ${promptRes.status}`)
    }

    const createdAt = new Date().toISOString()
    db.prepare(
      `INSERT INTO agent (id, sandbox_id, session_id, directory, prompt, title, status, mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      session.id,
      sandboxId,
      session.id,
      session.directory ?? '/workspace',
      prompt,
      prompt.slice(0, 30),
      'running',
      resolvedMode,
      createdAt,
    )

    console.log(`[agent] created: ${session.id}, sandbox: ${sandboxId}, mode: ${resolvedMode}`)
    return getAgent(session.id)!
  } catch (err) {
    await destroySandbox(sandboxId).catch(() => {})
    throw err
  }
}

export async function sendAgentMessage(
  config: ServerConfig,
  agentId: string,
  text: string,
  model?: { providerID: string; modelID: string },
): Promise<void> {
  const agent = getAgent(agentId)
  if (!agent) throw new Error(`Agent ${agentId} not found`)
  const res = await fetch(
    `${config.saas.baseUrl}/session/${agent.sessionId}/prompt_async`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parts: [{ type: 'text', text }],
        model: model ?? config.saas.model,
      }),
    },
  )
  if (!res.ok) throw new Error(`send message failed: HTTP ${res.status}`)
}

export async function abortAgent(
  config: ServerConfig,
  agentId: string,
): Promise<void> {
  const agent = getAgent(agentId)
  if (!agent) throw new Error(`Agent ${agentId} not found`)
  const res = await fetch(
    `${config.saas.baseUrl}/session/${agent.sessionId}/abort`,
    { method: 'POST' },
  )
  if (!res.ok) throw new Error(`abort failed: HTTP ${res.status}`)
}

export async function destroyAgent(
  config: ServerConfig,
  agentId: string,
): Promise<void> {
  const agent = getAgent(agentId)
  if (!agent) throw new Error(`Agent ${agentId} not found`)
  await fetch(`${config.saas.baseUrl}/session/${agent.sessionId}`, {
    method: 'DELETE',
  }).catch(() => {})
  await destroySandbox(agent.sandboxId).catch(() => {})
  db.prepare("UPDATE agent SET status = 'destroyed' WHERE id = ?").run(agentId)
  console.log(`[agent] destroyed: ${agentId}`)
}

export function getAgent(id: string): AgentSession | undefined {
  const row = db
    .prepare("SELECT * FROM agent WHERE id = ? AND status != 'destroyed'")
    .get(id) as AgentRow | undefined
  return row ? rowToAgent(row) : undefined
}

export function listAgents(): AgentSession[] {
  const rows = db
    .prepare("SELECT * FROM agent WHERE status != 'destroyed' ORDER BY created_at DESC")
    .all() as AgentRow[]
  return rows.map(rowToAgent)
}

export function updateAgentStatus(id: string, status: AgentSession['status']): void {
  db.prepare('UPDATE agent SET status = ? WHERE id = ?').run(status, id)
}

export async function rebuildAgentBrowser(
  config: ServerConfig,
  agentId: string,
): Promise<AgentSession> {
  const agent = getAgent(agentId)
  if (!agent) throw new Error(`Agent ${agentId} not found`)

  const sandboxInfo = await createSandbox(config)
  const newSandboxId = sandboxInfo.id
  const oldSandboxId = agent.sandboxId

  addSandboxAlias(oldSandboxId, newSandboxId)
  db.prepare('UPDATE agent SET sandbox_id = ? WHERE id = ?').run(newSandboxId, agentId)

  await fetch(
    `${config.saas.baseUrl}/session/${agent.sessionId}/skills/create`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: SKILL_NAME,
        description:
          '控制云端 Chrome 浏览器完成网页任务：打开页面、读取内容、点击、输入、滚动、截图。当任务需要访问/操作网页时使用。',
        content: buildSkillContent(newSandboxId, config.agent.apiBase, agent.mode),
      }),
    },
  ).catch((err) => console.warn('[agent] skill re-register failed:', err))

  console.log(`[agent] browser rebuilt: ${agentId}, ${oldSandboxId} -> ${newSandboxId}`)
  return getAgent(agentId)!
}
