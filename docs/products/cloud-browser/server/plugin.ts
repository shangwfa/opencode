import { loadEnv } from 'vite'
import type { Plugin, ViteDevServer } from 'vite'
import { WebSocketServer, WebSocket } from 'ws'
import type { Server, IncomingMessage, ServerResponse } from 'node:http'
import { request as httpRequest } from 'node:http'
import { loadServerConfig } from './config.ts'
import type { ServerConfig } from './config.ts'
import {
  createSandbox,
  destroySandbox,
  requireSandbox,
  listSandboxes,
} from './sandbox.ts'
import type { SandboxEntry } from './sandbox.ts'
import {
  getPage,
  snapshot,
  clickRef,
  typeRef,
  pressKey,
  scrollPage,
  pageText,
  pageState,
  screenshotBase64,
  closeBrowser,
} from './browser.ts'
import {
  createAgent,
  destroyAgent,
  getAgent,
  listAgents,
  rebuildAgentBrowser,
  sendAgentMessage,
} from './agent.ts'

const JSON_CONTENT_TYPE = { 'Content-Type': 'application/json' }

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, JSON_CONTENT_TYPE)
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
  if (!raw) return {}
  return JSON.parse(raw) as Record<string, unknown>
}

async function handleBrowserApi(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
  sandboxId: string,
  action: string,
): Promise<void> {
  const entry = await requireSandbox(config, sandboxId)
  if (!entry) {
    json(res, 404, { error: 'Sandbox not found or not running' })
    return
  }
  const page = await getPage(sandboxId, entry.cdpEndpoint.endpoint)

  switch (action) {
    case 'navigate': {
      const body = await readJson(req)
      const url = String(body.url ?? '')
      if (!url) {
        json(res, 400, { error: 'url is required' })
        return
      }
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      json(res, 200, await pageState(page))
      return
    }
    case 'snapshot': {
      json(res, 200, { snapshot: await snapshot(page), ...(await pageState(page)) })
      return
    }
    case 'click': {
      const body = await readJson(req)
      await clickRef(page, String(body.ref ?? ''))
      json(res, 200, { success: true, ...(await pageState(page)) })
      return
    }
    case 'type': {
      const body = await readJson(req)
      await typeRef(page, String(body.ref ?? ''), String(body.text ?? ''))
      json(res, 200, { success: true })
      return
    }
    case 'key': {
      const body = await readJson(req)
      await pressKey(page, String(body.key ?? 'Enter'))
      json(res, 200, { success: true })
      return
    }
    case 'scroll': {
      const body = await readJson(req)
      await scrollPage(
        page,
        String(body.direction ?? 'down'),
        Number(body.amount ?? 600),
      )
      json(res, 200, { success: true })
      return
    }
    case 'text': {
      json(res, 200, { text: await pageText(page), ...(await pageState(page)) })
      return
    }
    case 'state': {
      json(res, 200, await pageState(page))
      return
    }
    case 'screenshot': {
      json(res, 200, { image: await screenshotBase64(page), mimeType: 'image/jpeg' })
      return
    }
    default:
      json(res, 404, { error: `Unknown browser action: ${action}` })
  }
}

function proxySaasSse(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
  agentId: string,
) {
  const agent = getAgent(agentId)
  if (!agent) {
    json(res, 404, { error: 'Agent not found' })
    return
  }

  const target = new URL(`${config.saas.baseUrl}/event`)
  const proxyReq = httpRequest(
    {
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        'x-opencode-directory': agent.directory,
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      })
      proxyRes.pipe(res)
    },
  )
  proxyReq.on('error', (err) => {
    console.error(`[sse] proxy error (${agentId}):`, err.message)
    if (!res.headersSent) json(res, 502, { error: err.message })
    else res.end()
  })
  req.on('close', () => proxyReq.destroy())
  proxyReq.end()
}

async function proxySaasMessages(
  res: ServerResponse,
  config: ServerConfig,
  agentId: string,
) {
  const agent = getAgent(agentId)
  if (!agent) {
    json(res, 404, { error: 'Agent not found' })
    return
  }
  const upstream = await fetch(
    `${config.saas.baseUrl}/session/${agent.sessionId}/message`,
  )
  const body = await upstream.text()
  res.writeHead(upstream.status, JSON_CONTENT_TYPE)
  res.end(body)
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname

  try {
    if (req.method === 'POST' && path === '/api/sandboxes') {
      const info = await createSandbox(config)
      json(res, 201, info)
      return true
    }

    if (req.method === 'GET' && path === '/api/sandboxes') {
      json(res, 200, listSandboxes())
      return true
    }

    const browserMatch = path.match(/^\/api\/sandboxes\/([^/]+)\/browser\/([a-z]+)$/)
    if (browserMatch) {
      await handleBrowserApi(req, res, config, browserMatch[1], browserMatch[2])
      return true
    }

    const sandboxMatch = path.match(/^\/api\/sandboxes\/([^/]+)$/)
    if (sandboxMatch) {
      const id = sandboxMatch[1]
      if (req.method === 'GET') {
        const entry = await requireSandbox(config, id)
        if (!entry) {
          json(res, 404, { error: 'Sandbox not found' })
          return true
        }
        json(res, 200, entry.info)
        return true
      }
      if (req.method === 'DELETE') {
        await closeBrowser(id).catch(() => {})
        await destroySandbox(id)
        json(res, 200, { success: true })
        return true
      }
    }

    if (req.method === 'POST' && path === '/api/agents') {
      const body = await readJson(req)
      const prompt = String(body.prompt ?? '').trim()
      if (!prompt) {
        json(res, 400, { error: 'prompt is required' })
        return true
      }
      const agent = await createAgent(config, prompt)
      json(res, 201, agent)
      return true
    }

    if (req.method === 'GET' && path === '/api/agents') {
      json(res, 200, listAgents())
      return true
    }

    const agentEventsMatch = path.match(/^\/api\/agents\/([^/]+)\/events$/)
    if (agentEventsMatch && req.method === 'GET') {
      proxySaasSse(req, res, config, agentEventsMatch[1])
      return true
    }

    const agentRebuildMatch = path.match(/^\/api\/agents\/([^/]+)\/rebuild-browser$/)
    if (agentRebuildMatch && req.method === 'POST') {
      const agent = await rebuildAgentBrowser(config, agentRebuildMatch[1])
      json(res, 200, agent)
      return true
    }

    const agentMessagesMatch = path.match(/^\/api\/agents\/([^/]+)\/messages$/)
    if (agentMessagesMatch) {
      const id = agentMessagesMatch[1]
      if (req.method === 'GET') {
        await proxySaasMessages(res, config, id)
        return true
      }
      if (req.method === 'POST') {
        const body = await readJson(req)
        const text = String(body.text ?? '').trim()
        if (!text) {
          json(res, 400, { error: 'text is required' })
          return true
        }
        await sendAgentMessage(config, id, text)
        json(res, 200, { success: true })
        return true
      }
    }

    const agentMatch = path.match(/^\/api\/agents\/([^/]+)$/)
    if (agentMatch) {
      const id = agentMatch[1]
      if (req.method === 'GET') {
        const agent = getAgent(id)
        if (!agent) {
          json(res, 404, { error: 'Agent not found' })
          return true
        }
        json(res, 200, agent)
        return true
      }
      if (req.method === 'DELETE') {
        const agent = getAgent(id)
        if (agent) await closeBrowser(agent.sandboxId).catch(() => {})
        await destroyAgent(config, id)
        json(res, 200, { success: true })
        return true
      }
    }
  } catch (err) {
    console.error('[api] error:', err)
    json(res, 500, { error: err instanceof Error ? err.message : String(err) })
    return true
  }

  return false
}

function setupWebSocketForwarding(server: ViteDevServer, config: ServerConfig) {
  const wss = new WebSocketServer({ noServer: true })
  const httpServer = server.httpServer as Server

  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
    if (!url.pathname.startsWith('/ws/vnc/')) return

    const id = url.pathname.split('/').pop() ?? ''

    void requireSandbox(config, id).then((entry) => {
      if (!entry) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        forwardVncConnection(ws, request, entry, config)
      })
    })
  })

  return wss
}

function forwardVncConnection(
  ws: WebSocket,
  request: IncomingMessage,
  entry: SandboxEntry,
  config: ServerConfig,
) {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
  const id = url.pathname.split('/').pop() ?? ''
  const protocols = request.headers['sec-websocket-protocol']
    ?.split(',')
    .map((protocol) => protocol.trim())
    .filter(Boolean)

  const upstream = new WebSocket(
    `ws://${entry.vncEndpoint.endpoint}`,
    protocols?.length ? protocols : undefined,
    {
      headers: {
        'OPEN-SANDBOX-API-KEY': config.sandbox.apiKey,
        ...entry.vncEndpoint.headers,
      },
    },
  )

  upstream.on('open', () => {
    console.log(`[vnc] connected: ${id}`)
  })

  ws.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary })
    }
  })

  upstream.on('message', (data, isBinary) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data, { binary: isBinary })
    }
  })

  const closeBoth = () => {
    if (ws.readyState === WebSocket.OPEN) ws.close()
    if (upstream.readyState === WebSocket.OPEN) upstream.close()
  }

  upstream.on('error', (err) => {
    console.error(`[vnc] upstream error (${id}):`, err.message)
    closeBoth()
  })
  upstream.on('close', closeBoth)
  ws.on('error', closeBoth)
  ws.on('close', closeBoth)
}

export function cloudBrowser(): Plugin {
  let config: ServerConfig

  return {
    name: 'cloud-browser',
    apply: 'serve',
    enforce: 'pre',

    configResolved(resolvedConfig) {
      config = loadServerConfig(
        loadEnv(resolvedConfig.mode, resolvedConfig.root, ''),
      )
    },

    configureServer(server) {
      setupWebSocketForwarding(server, config)

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (!url.pathname.startsWith('/api/')) {
          next()
          return
        }

        const handled = await handleApi(req, res, config)
        if (!handled) {
          json(res, 404, { error: 'Not found' })
        }
      })
    },
  }
}
