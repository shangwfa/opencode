import { loadEnv } from 'vite'
import type { Plugin, ViteDevServer } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as httpRequest } from 'node:http'
import { canvasContextForAI, createCanvas, elementsSummary, getCanvas, onCanvasUpdate, syncElements } from './canvas.ts'
import {
  abortSession,
  createSaasSession,
  deleteSession,
  fetchMessages,
  getSession,
  listModels,
  listSessions,
  loadServerConfig,
  newSessionRecord,
  registerSkill,
  saveSession,
  sendPrompt,
  setKeepAlive,
} from './sessions.ts'
import type { ServerConfig } from './sessions.ts'
import { startPolling, stopPolling } from './ops.ts'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req)
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
}

// SSE：转发 SaaS /event 流，并把画布更新事件注入同一连接
function streamEvents(req: IncomingMessage, res: ServerResponse, config: ServerConfig, canvasId: string) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  })

  const send = (event: unknown) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  const unsubscribe = onCanvasUpdate(canvasId, (canvas) => {
    send({
      type: 'canvas.update',
      canvasId,
      revision: canvas.revision,
      state: canvas.state,
      mermaid: canvas.mermaid,
      elements: canvas.elements,
    })
  })

  // 立即推送当前画布快照，前端无需额外拉取
  const canvas = getCanvas(canvasId)
  if (canvas) {
    send({
      type: 'canvas.update',
      canvasId,
      revision: canvas.revision,
      state: canvas.state,
      mermaid: canvas.mermaid,
      elements: canvas.elements,
    })
  }

  const target = new URL(`${config.saasBaseUrl}/event`)
  const upstreamReq = httpRequest(
    {
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'GET',
      headers: { Accept: 'text/event-stream', 'x-opencode-directory': '/workspace' },
    },
    (upstreamRes) => {
      upstreamRes.on('data', (chunk: Buffer) => res.write(chunk))
      upstreamRes.on('end', () => res.end())
    },
  )
  upstreamReq.on('error', () => {
    // SaaS 不可达也要保住 canvas 流
    console.error('[sse] saas upstream error')
  })

  req.on('close', () => {
    unsubscribe()
    upstreamReq.destroy()
  })
  upstreamReq.end()
}

function canvasSummaryText(canvasId: string): string | null {
  const canvas = getCanvas(canvasId)
  if (!canvas) return null
  // mermaid 态注入 mermaid；manual 态注入元素清单（patch/delete 按 id 引用）
  if (canvas.state === 'manual') return elementsSummary(canvas)
  return canvasContextForAI(canvas)
}

async function handleApi(req: IncomingMessage, res: ServerResponse, config: ServerConfig): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = url.pathname
  const method = req.method ?? 'GET'

  try {
    // 画布：浏览器 SSE 订阅（懒启动轮询：页面打开即开始拉取，修复重启/遗漏场景）
    const streamMatch = pathname.match(/^\/api\/canvas\/([^/]+)\/stream$/)
    if (streamMatch && method === 'GET') {
      const canvasId = streamMatch[1]
      if (!getCanvas(canvasId)) {
        json(res, 404, { error: 'canvas not found' })
        return true
      }
      const session = listSessions().find((s) => s.canvasId === canvasId)
      if (session) startPolling(config, session)
      streamEvents(req, res, config, canvasId)
      return true
    }

    // 画布：摘要读取
    const canvasMatch = pathname.match(/^\/api\/canvas\/([^/]+)$/)
    if (canvasMatch && method === 'GET') {
      const canvas = getCanvas(canvasMatch[1])
      if (!canvas) {
        json(res, 404, { error: 'canvas not found' })
        return true
      }
      json(res, 200, { id: canvas.id, revision: canvas.revision, state: canvas.state, mermaid: canvas.mermaid })
      return true
    }

    // 画布：前端手动编辑后的回传同步（不广播，仅持久化）
    const syncMatch = pathname.match(/^\/api\/canvas\/([^/]+)\/sync$/)
    if (syncMatch && method === 'POST') {
      const canvas = getCanvas(syncMatch[1])
      if (!canvas) {
        json(res, 404, { error: 'canvas not found' })
        return true
      }
      const body = await readJson(req)
      if (!Array.isArray(body.elements)) {
        json(res, 400, { error: 'elements array is required' })
        return true
      }
      const live = (body.elements as Array<{ isDeleted?: boolean }>).filter((e) => !e.isDeleted)
      const serverLive = canvas.elements.filter((e) => !e.isDeleted)
      // 防护：空回传不覆盖非空画布（前端初始化/异常时可能误传空场景）
      if (live.length === 0 && serverLive.length > 0) {
        console.warn(`[sync] 忽略空回传（server 有 ${serverLive.length} 元素）`)
        json(res, 200, { success: true, ignored: true })
        return true
      }
      syncElements(canvas, body.elements as never)
      json(res, 200, { success: true })
      return true
    }

    // 会话列表
    if (method === 'GET' && pathname === '/api/sessions') {
      json(res, 200, listSessions())
      return true
    }

    // 新建会话：SaaS session + 画布 + skill + keepAlive + 轮询 + prompt
    if (method === 'POST' && pathname === '/api/sessions') {
      const body = await readJson(req)
      const prompt = String(body.prompt ?? '').trim()
      if (!prompt) {
        json(res, 400, { error: 'prompt is required' })
        return true
      }
      const saas = await createSaasSession(config)
      const canvas = createCanvas()
      const session = newSessionRecord(saas, canvas.id, prompt.slice(0, 30))
      saveSession(session)
      await registerSkill(config, session)
      await setKeepAlive(config, session, true)
      json(res, 201, session)
      await sendPrompt(config, session, prompt, null, body.model as { providerID: string; modelID: string } | undefined)
      startPolling(config, session)
      return true
    }

    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (sessionMatch) {
      const session = getSession(sessionMatch[1])
      if (!session) {
        json(res, 404, { error: 'session not found' })
        return true
      }
      if (method === 'GET') {
        json(res, 200, session)
        return true
      }
      if (method === 'DELETE') {
        stopPolling(session.id)
        await setKeepAlive(config, session, false)
        await fetch(`${config.saasBaseUrl}/session/${session.saasSessionId}`, { method: 'DELETE' }).catch(() => {})
        deleteSession(session.id)
        json(res, 200, { success: true })
        return true
      }
    }

    // 发送消息
    const promptMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/prompt$/)
    if (promptMatch && method === 'POST') {
      const session = getSession(promptMatch[1])
      if (!session) {
        json(res, 404, { error: 'session not found' })
        return true
      }
      const body = await readJson(req)
      const text = String(body.text ?? '').trim()
      if (!text) {
        json(res, 400, { error: 'text is required' })
        return true
      }
      await sendPrompt(
        config,
        session,
        text,
        canvasSummaryText(session.canvasId),
        body.model as { providerID: string; modelID: string } | undefined,
      )
      startPolling(config, session)
      json(res, 200, { success: true })
      return true
    }

    // 终止
    const abortMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/abort$/)
    if (abortMatch && method === 'POST') {
      const session = getSession(abortMatch[1])
      if (!session) {
        json(res, 404, { error: 'session not found' })
        return true
      }
      await abortSession(config, session)
      json(res, 200, { success: true })
      return true
    }

    // 消息（代理 SaaS）
    const messagesMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/)
    if (messagesMatch && method === 'GET') {
      const session = getSession(messagesMatch[1])
      if (!session) {
        json(res, 404, { error: 'session not found' })
        return true
      }
      const messages = await fetchMessages(config, session)
      json(res, 200, messages)
      return true
    }

    // 模型列表
    if (method === 'GET' && pathname === '/api/models') {
      json(res, 200, await listModels(config))
      return true
    }
  } catch (err) {
    console.error('[api] error:', err)
    json(res, 500, { error: err instanceof Error ? err.message : String(err) })
    return true
  }

  return false
}

export function excalidrawServer(): Plugin {
  let config: ServerConfig

  return {
    name: 'excalidraw-server',
    apply: 'serve',
    enforce: 'pre',

    configResolved(resolvedConfig) {
      config = loadServerConfig(loadEnv(resolvedConfig.mode, resolvedConfig.root, ''))
    },

    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (!url.pathname.startsWith('/api/')) {
          next()
          return
        }
        const handled = await handleApi(req, res, config)
        if (!handled) json(res, 404, { error: 'Not found' })
      })
    },
  }
}
