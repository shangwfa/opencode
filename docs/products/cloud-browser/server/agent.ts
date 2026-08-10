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
}

interface AgentRow {
  id: string
  sandbox_id: string
  session_id: string
  directory: string
  prompt: string
  title: string
  status: string
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
  }
}

function buildSkillContent(sandboxId: string, apiBase: string): string {
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

### 2. 获取页面可交互元素（核心！返回带 ref 标号的元素列表）
\`\`\`bash
curl -s --noproxy '*' ${apiBase}/api/sandboxes/${sandboxId}/browser/snapshot
\`\`\`
返回格式（每行一个元素）：
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

### 5. 按键（Enter/Tab/Escape 等）
\`\`\`bash
curl -s --noproxy '*' -X POST ${apiBase}/api/sandboxes/${sandboxId}/browser/key \\
  -H 'Content-Type: application/json' -d '{"key": "Enter"}'
\`\`\`

### 6. 滚动页面
\`\`\`bash
curl -s --noproxy '*' -X POST ${apiBase}/api/sandboxes/${sandboxId}/browser/scroll \\
  -H 'Content-Type: application/json' -d '{"direction": "down", "amount": 600}'
\`\`\`
direction: up / down / left / right

### 7. 读取页面正文文本
\`\`\`bash
curl -s --noproxy '*' ${apiBase}/api/sandboxes/${sandboxId}/browser/text
\`\`\`

### 8. 当前状态（URL + 标题）
\`\`\`bash
curl -s --noproxy '*' ${apiBase}/api/sandboxes/${sandboxId}/browser/state
\`\`\`

### 9. 截图（返回 base64 JPEG）
\`\`\`bash
curl -s --noproxy '*' ${apiBase}/api/sandboxes/${sandboxId}/browser/screenshot
\`\`\`

## 标准工作流程
1. \`navigate\` 打开目标页面，然后 \`sleep 2\` 等页面加载
2. \`snapshot\` 获取可交互元素列表
3. \`click\` / \`type\` / \`key\` 操作元素
4. 每次操作后重新 \`snapshot\`（ref 标号会变化）
5. 用 \`text\` 或 \`state\` 提取结果

## 注意事项
- **每次操作后 ref 会失效**，必须重新 snapshot 获取新标号
- 页面跳转/加载后等待 1-3 秒再 snapshot
- 如果遇到登录/验证码，用 screenshot 查看页面并告知用户
- 需要等待时直接用 bash \`sleep N\`
`
}

export async function createAgent(
  config: ServerConfig,
  prompt: string,
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

    const skillRes = await fetch(
      `${config.saas.baseUrl}/session/${session.id}/skills/create`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: SKILL_NAME,
          description:
            '控制云端 Chrome 浏览器完成网页任务：打开页面、读取内容、点击、输入、滚动、截图。当任务需要访问/操作网页时使用。',
          content: buildSkillContent(sandboxId, config.agent.apiBase),
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
          model: config.saas.model,
        }),
      },
    )
    if (!promptRes.ok) {
      throw new Error(`send prompt failed: HTTP ${promptRes.status}`)
    }

    const createdAt = new Date().toISOString()
    db.prepare(
      `INSERT INTO agent (id, sandbox_id, session_id, directory, prompt, title, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      session.id,
      sandboxId,
      session.id,
      session.directory ?? '/workspace',
      prompt,
      prompt.slice(0, 30),
      'running',
      createdAt,
    )

    console.log(`[agent] created: ${session.id}, sandbox: ${sandboxId}`)
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
        model: config.saas.model,
      }),
    },
  )
  if (!res.ok) throw new Error(`send message failed: HTTP ${res.status}`)
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
        content: buildSkillContent(newSandboxId, config.agent.apiBase),
      }),
    },
  ).catch((err) => console.warn('[agent] skill re-register failed:', err))

  console.log(`[agent] browser rebuilt: ${agentId}, ${oldSandboxId} -> ${newSandboxId}`)
  return getAgent(agentId)!
}
