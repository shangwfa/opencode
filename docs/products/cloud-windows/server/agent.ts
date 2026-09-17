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

const SKILL_NAME = 'cloud-windows'

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
name: cloud-windows
description: 控制云端 Windows 沙箱完成桌面任务：执行命令、截图、管理文件。当任务需要操作 Windows 系统或桌面应用时使用。
---

# Cloud Windows 沙箱控制

你可以控制一个云端 Windows 沙箱（sandbox id: \`${sandboxId}\`）。通过 REST API 用 bash + curl 调用。

**API 基础地址**: \`${apiBase}\`

> curl 必须加 \`-s --noproxy '*'\` 绕过本地代理。

## 可用操作

### 1. 执行命令（核心！）
在 Windows 沙箱中执行 cmd 或 PowerShell 命令。
\`\`\`bash
curl -s --noproxy '*' -X POST ${apiBase}/api/sandboxes/${sandboxId}/windows/exec \\
  -H 'Content-Type: application/json' -d '{"command": "cmd /c echo Hello"}'
\`\`\`
返回 \`{stdout, stderr, exitCode}\`。

也可以执行 PowerShell 命令：
\`\`\`bash
curl -s --noproxy '*' -X POST ${apiBase}/api/sandboxes/${sandboxId}/windows/exec \\
  -H 'Content-Type: application/json' -d '{"command": "powershell -Command Get-Process | Select-Object -First 5"}'
\`\`\`

### 2. 截图（返回 base64 JPEG）
\`\`\`bash
curl -s --noproxy '*' ${apiBase}/api/sandboxes/${sandboxId}/windows/screenshot
\`\`\`
返回 \`{"image": "<base64>", "mimeType": "image/jpeg"}\`。如需查看截图：
\`\`\`bash
curl -s --noproxy '*' ${apiBase}/api/sandboxes/${sandboxId}/windows/screenshot | python3 -c "import json,sys,base64; open('/workspace/screenshot.jpg','wb').write(base64.b64decode(json.load(sys.stdin)['image']))"
\`\`\`
然后用 read 工具查看 \`/workspace/screenshot.jpg\`。**必须保存到 /workspace**。

### 3. 列目录
\`\`\`bash
curl -s --noproxy '*' -X POST ${apiBase}/api/sandboxes/${sandboxId}/windows/files/list \\
  -H 'Content-Type: application/json' -d '{"path": "C:\\\\Users\\\\Docker\\\\Desktop"}'
\`\`\`
返回 \`{files: [{name, size, modifiedAt, isDir}]}\`。

### 4. 读取文件（返回 base64）
\`\`\`bash
curl -s --noproxy '*' -X POST ${apiBase}/api/sandboxes/${sandboxId}/windows/files/read \\
  -H 'Content-Type: application/json' -d '{"path": "C:\\\\Users\\\\Docker\\\\Desktop\\\\output.txt"}'
\`\`\`
返回 \`{contentBase64, size}\`。保存到 /workspace：
\`\`\`bash
curl -s --noproxy '*' -X POST ${apiBase}/api/sandboxes/${sandboxId}/windows/files/read \\
  -H 'Content-Type: application/json' -d '{"path": "C:\\\\Users\\\\Docker\\\\Desktop\\\\output.txt"}' | python3 -c "import json,sys,base64; open('/workspace/output.txt','wb').write(base64.b64decode(json.load(sys.stdin)['contentBase64']))"
\`\`\`

### 5. 写入文件
\`\`\`bash
B64=$(base64 -w0 /workspace/local-file.csv)
curl -s --noproxy '*' -X POST ${apiBase}/api/sandboxes/${sandboxId}/windows/files/write \\
  -H 'Content-Type: application/json' \\
  -d '{"path":"C:/Users/Docker/Desktop/data.csv","contentBase64":"'"$B64"'"}'
\`\`\`
> Windows 路径中可以用正斜杠 \`/\` 避免转义问题。
\`\`\`

## 标准工作流程
1. 用 \`exec\` 执行 PowerShell/cmd 命令操作 Windows
2. 用 \`screenshot\` 截图查看桌面状态（尤其操作 GUI 应用后）
3. 用 \`files/list\` 和 \`files/read\` 管理文件
4. 把需要查看的文件保存到 \`/workspace\`（你的工作目录）

## 常用命令示例
\`\`\`bash
# 列出桌面文件
cmd /c dir /b C:\\Users\\Docker\\Desktop

# 检查系统信息
powershell -Command "Get-ComputerInfo | Select-Object OsName, OsVersion"

# 安装软件（winget）
cmd /c winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements

# 运行程序
cmd /c "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe https://example.com"

# 网络请求
powershell -Command "Invoke-WebRequest -Uri 'https://httpbin.org/get' | Select-Object -ExpandProperty Content"
\`\`\`

## 注意事项
- 命令在 Windows guest 内执行，路径用 Windows 格式（反斜杠 \`\\\`）
- JSON 中的反斜杠需要双重转义（\`\\\\\\\\\` 表示一个 \`\\\`）
- 截图保存到 \`/workspace\` 后才能用 read 工具查看
- 首次启动 Windows 沙箱可能需要几分钟，请耐心等待
- Windows 桌面通过 noVNC Web 控制台显示（端口 8006）
`
}

export async function createAgent(
  config: ServerConfig,
  prompt: string,
  model?: { providerID: string; modelID: string },
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
            '控制云端 Windows 沙箱完成桌面任务：执行命令、截图、管理文件。当任务需要操作 Windows 系统或桌面应用时使用。',
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
          model: model ?? config.saas.model,
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
  const row = db.prepare('SELECT * FROM agent WHERE id = ?').get(id) as
    | AgentRow
    | undefined
  return row ? rowToAgent(row) : undefined
}

export function listAgents(): AgentSession[] {
  const rows = db
    .prepare('SELECT * FROM agent ORDER BY created_at DESC')
    .all() as AgentRow[]
  return rows.map(rowToAgent)
}

export function updateAgentStatus(id: string, status: AgentSession['status']): void {
  db.prepare('UPDATE agent SET status = ? WHERE id = ?').run(status, id)
}

export async function rebuildAgentWindows(
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
          '控制云端 Windows 沙箱完成桌面任务：执行命令、截图、管理文件。当任务需要操作 Windows 系统或桌面应用时使用。',
        content: buildSkillContent(newSandboxId, config.agent.apiBase),
      }),
    },
  ).catch((err) => console.warn('[agent] skill re-register failed:', err))

  console.log(`[agent] windows rebuilt: ${agentId}, ${oldSandboxId} -> ${newSandboxId}`)
  return getAgent(agentId)!
}
