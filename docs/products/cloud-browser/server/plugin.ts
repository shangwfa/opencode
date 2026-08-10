import { loadEnv } from 'vite'
import type { Plugin, ViteDevServer } from 'vite'
import { WebSocketServer, WebSocket } from 'ws'
import type { Server, IncomingMessage, ServerResponse } from 'node:http'
import { request as httpRequest } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
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
  pageSummary,
  clickRef,
  typeRef,
  selectRef,
  pressKey,
  scrollPage,
  pageText,
  pageState,
  screenshotBase64,
  evaluateJs,
  waitFor,
  goBack,
  listTabs,
  switchTab,
  clickAndDownload,
  getDownloadedFile,
  uploadToRef,
  closeBrowser,
} from './browser.ts'
import {
  abortAgent,
  createAgent,
  destroyAgent,
  getAgent,
  listAgents,
  rebuildAgentBrowser,
  sendAgentMessage,
} from './agent.ts'
import { listAgentFiles, readAgentFile } from './files.ts'

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
      json(res, 200, {
        snapshot: await snapshot(page),
        summary: await pageSummary(page),
        ...(await pageState(page)),
      })
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
    case 'select': {
      const body = await readJson(req)
      const values = Array.isArray(body.values)
        ? body.values.map(String)
        : [String(body.value ?? '')]
      const selected = await selectRef(page, String(body.ref ?? ''), values)
      json(res, 200, { success: true, selected })
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
      json(res, 200, {
        text: await pageText(page, Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('max')) || 4000),
        ...(await pageState(page)),
      })
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
    case 'eval': {
      const body = await readJson(req)
      const script = String(body.script ?? '')
      if (!script) {
        json(res, 400, { error: 'script is required' })
        return
      }
      const result = await evaluateJs(page, script)
      json(res, 200, { result: result ?? null })
      return
    }
    case 'wait': {
      const body = await readJson(req)
      await waitFor(page, {
        selector: body.selector ? String(body.selector) : undefined,
        text: body.text ? String(body.text) : undefined,
        timeoutMs: body.timeoutMs ? Number(body.timeoutMs) : undefined,
      })
      json(res, 200, { success: true, ...(await pageState(page)) })
      return
    }
    case 'go-back': {
      await goBack(page)
      json(res, 200, { success: true, ...(await pageState(page)) })
      return
    }
    case 'tabs': {
      json(res, 200, { tabs: await listTabs(page) })
      return
    }
    case 'switch-tab': {
      const body = await readJson(req)
      const ok = await switchTab(sandboxId, Number(body.index ?? 0))
      if (!ok) {
        json(res, 404, { error: 'tab not found' })
        return
      }
      json(res, 200, { success: true })
      return
    }
    case 'download': {
      const body = await readJson(req)
      const file = await clickAndDownload(
        page,
        sandboxId,
        String(body.ref ?? ''),
        body.timeoutMs ? Number(body.timeoutMs) : undefined,
      )
      json(res, 200, {
        ...file,
        downloadUrl: `/api/sandboxes/${sandboxId}/browser/files/${encodeURIComponent(file.filename)}`,
      })
      return
    }
    case 'upload': {
      const body = await readJson(req)
      await uploadToRef(
        page,
        sandboxId,
        String(body.ref ?? ''),
        String(body.filename ?? ''),
        body.contentBase64 ? String(body.contentBase64) : undefined,
      )
      json(res, 200, { success: true })
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
  const pathname = url.pathname

  try {
    if (req.method === 'POST' && pathname === '/api/sandboxes') {
      const info = await createSandbox(config)
      json(res, 201, info)
      return true
    }

    if (req.method === 'GET' && pathname === '/api/sandboxes') {
      json(res, 200, listSandboxes())
      return true
    }

    const browserFileMatch = pathname.match(/^\/api\/sandboxes\/([^/]+)\/browser\/files\/(.+)$/)
    if (browserFileMatch && req.method === 'GET') {
      const filePath = getDownloadedFile(browserFileMatch[1], decodeURIComponent(browserFileMatch[2]))
      if (!filePath) {
        json(res, 404, { error: 'File not found' })
        return true
      }
      const filename = path.basename(filePath)
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      })
      fs.createReadStream(filePath).pipe(res)
      return true
    }

    const browserMatch = pathname.match(/^\/api\/sandboxes\/([^/]+)\/browser\/([a-z-]+)$/)
    if (browserMatch) {
      await handleBrowserApi(req, res, config, browserMatch[1], browserMatch[2])
      return true
    }

    const sandboxMatch = pathname.match(/^\/api\/sandboxes\/([^/]+)$/)
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

    if (req.method === 'POST' && pathname === '/api/agents') {
      const body = await readJson(req)
      const prompt = String(body.prompt ?? '').trim()
      if (!prompt) {
        json(res, 400, { error: 'prompt is required' })
        return true
      }
      const model = body.model as { providerID?: string; modelID?: string } | undefined
      const agent = await createAgent(
        config,
        prompt,
        model?.providerID && model.modelID
          ? { providerID: model.providerID, modelID: model.modelID }
          : undefined,
      )
      json(res, 201, agent)
      return true
    }

    if (req.method === 'GET' && pathname === '/api/agents') {
      json(res, 200, listAgents())
      return true
    }

    if (req.method === 'GET' && pathname === '/api/models') {
      const upstream = await fetch(`${config.saas.baseUrl}/provider`)
      const data = (await upstream.json()) as {
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
      const defaultModel = models.find(
        (m) => data.default?.[m.providerID] === m.modelID,
      )
      json(res, 200, {
        models,
        current: defaultModel
          ? { providerID: defaultModel.providerID, modelID: defaultModel.modelID }
          : config.saas.model,
      })
      return true
    }

    const agentEventsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/events$/)
    if (agentEventsMatch && req.method === 'GET') {
      proxySaasSse(req, res, config, agentEventsMatch[1])
      return true
    }

    const agentFilesContentMatch = pathname.match(/^\/api\/agents\/([^/]+)\/files\/content$/)
    if (agentFilesContentMatch && req.method === 'GET') {
      const filePath = url.searchParams.get('path')
      if (!filePath) {
        json(res, 400, { error: 'path is required' })
        return true
      }
      const content = await readAgentFile(config, agentFilesContentMatch[1], filePath)
      json(res, 200, content)
      return true
    }

    const agentFilesMatch = pathname.match(/^\/api\/agents\/([^/]+)\/files$/)
    if (agentFilesMatch && req.method === 'GET') {
      const files = await listAgentFiles(config, agentFilesMatch[1])
      json(res, 200, files)
      return true
    }

    const agentRebuildMatch = pathname.match(/^\/api\/agents\/([^/]+)\/rebuild-browser$/)
    if (agentRebuildMatch && req.method === 'POST') {
      const agent = await rebuildAgentBrowser(config, agentRebuildMatch[1])
      json(res, 200, agent)
      return true
    }

    const agentStatusMatch = pathname.match(/^\/api\/agents\/([^/]+)\/status$/)
    if (agentStatusMatch && req.method === 'GET') {
      const agent = getAgent(agentStatusMatch[1])
      if (!agent) {
        json(res, 404, { error: 'Agent not found' })
        return true
      }
      const upstream = await fetch(`${config.saas.baseUrl}/session/status`)
      const data = (await upstream.json()) as Record<string, { type?: string }>
      const busy = data[agent.sessionId]?.type === 'busy'
      json(res, 200, { busy })
      return true
    }

    const agentAbortMatch = pathname.match(/^\/api\/agents\/([^/]+)\/abort$/)
    if (agentAbortMatch && req.method === 'POST') {
      await abortAgent(config, agentAbortMatch[1])
      json(res, 200, { success: true })
      return true
    }

    const agentMessagesMatch = pathname.match(/^\/api\/agents\/([^/]+)\/messages$/)
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
        const model = body.model as { providerID?: string; modelID?: string } | undefined
        await sendAgentMessage(
          config,
          id,
          text,
          model?.providerID && model.modelID
            ? { providerID: model.providerID, modelID: model.modelID }
            : undefined,
        )
        json(res, 200, { success: true })
        return true
      }
    }

    const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/)
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
