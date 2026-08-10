import { loadEnv } from 'vite'
import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as httpRequest } from 'node:http'
import { loadServerConfig } from './config.ts'
import type { ServerConfig } from './config.ts'
import {
  createSandbox,
  destroySandbox,
  requireSandbox,
  listSandboxes,
} from './sandbox.ts'
import {
  execCommand,
  screenshot,
  listFiles,
  readFileBase64,
  writeFile,
} from './windows.ts'
import {
  abortAgent,
  createAgent,
  destroyAgent,
  getAgent,
  listAgents,
  rebuildAgentWindows,
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

async function handleWindowsApi(
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
  const { sandbox } = entry

  switch (action) {
    case 'exec': {
      const body = await readJson(req)
      const command = String(body.command ?? '')
      if (!command) {
        json(res, 400, { error: 'command is required' })
        return
      }
      const timeoutSeconds = body.timeoutSeconds ? Number(body.timeoutSeconds) : 120
      const result = await execCommand(sandbox, command)
      void timeoutSeconds
      json(res, 200, result)
      return
    }
    case 'screenshot': {
      const image = await screenshot(sandbox)
      json(res, 200, { image, mimeType: 'image/jpeg' })
      return
    }
    case 'files': {
      const subMatch = action
      void subMatch
      json(res, 404, { error: 'Use files/list, files/read, or files/write' })
      return
    }
    default:
      json(res, 404, { error: `Unknown windows action: ${action}` })
  }
}

async function handleWindowsFilesApi(
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
  const { sandbox } = entry

  switch (action) {
    case 'list': {
      const body = await readJson(req)
      const dirPath = String(body.path ?? 'C:\\')
      const files = await listFiles(sandbox, dirPath)
      json(res, 200, { files })
      return
    }
    case 'read': {
      const body = await readJson(req)
      const filePath = String(body.path ?? '')
      if (!filePath) {
        json(res, 400, { error: 'path is required' })
        return
      }
      const result = await readFileBase64(sandbox, filePath)
      json(res, 200, result)
      return
    }
    case 'write': {
      const body = await readJson(req)
      const filePath = String(body.path ?? '')
      const contentBase64 = String(body.contentBase64 ?? '')
      if (!filePath || !contentBase64) {
        json(res, 400, { error: 'path and contentBase64 are required' })
        return
      }
      await writeFile(sandbox, filePath, contentBase64)
      json(res, 200, { success: true })
      return
    }
    default:
      json(res, 404, { error: `Unknown files action: ${action}` })
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

async function handleVncProxy(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
  sandboxId: string,
  subPath: string,
): Promise<void> {
  const entry = await requireSandbox(config, sandboxId)
  if (!entry) {
    json(res, 404, { error: 'Sandbox not found or not running' })
    return
  }

  const target = entry.webEndpoint
  const targetUrl = new URL(`http://${target.endpoint}${subPath}`)

  const proxyReq = httpRequest(
    {
      hostname: targetUrl.hostname,
      port: Number(targetUrl.port),
      path: targetUrl.pathname + targetUrl.search,
      method: req.method ?? 'GET',
      headers: {
        ...req.headers,
        host: target.endpoint,
        ...target.headers,
      },
    },
    (proxyRes) => {
      const headers = { ...proxyRes.headers }
      delete headers['x-frame-options']
      delete headers['content-security-policy']
      res.writeHead(proxyRes.statusCode ?? 502, headers)
      proxyRes.pipe(res)
    },
  )
  proxyReq.on('error', (err) => {
    console.error(`[vnc-proxy] error (${sandboxId}):`, err.message)
    if (!res.headersSent) json(res, 502, { error: err.message })
    else res.end()
  })
  req.on('close', () => proxyReq.destroy())
  proxyReq.end()
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

    const vncProxyMatch = pathname.match(/^\/api\/sandboxes\/([^/]+)\/vnc(?:\/(.*))?$/)
    if (vncProxyMatch) {
      const subPath = '/' + (vncProxyMatch[2] ?? '')
      await handleVncProxy(req, res, config, vncProxyMatch[1], subPath)
      return true
    }

    const vncUrlMatch = pathname.match(/^\/api\/sandboxes\/([^/]+)\/vnc-url$/)
    if (vncUrlMatch && req.method === 'GET') {
      const entry = await requireSandbox(config, vncUrlMatch[1])
      if (!entry) {
        json(res, 404, { error: 'Sandbox not found or not running' })
        return true
      }
      json(res, 200, { url: `http://${entry.webEndpoint.endpoint}` })
      return true
    }

    const windowsFilesMatch = pathname.match(/^\/api\/sandboxes\/([^/]+)\/windows\/files\/([a-z]+)$/)
    if (windowsFilesMatch) {
      await handleWindowsFilesApi(req, res, config, windowsFilesMatch[1], windowsFilesMatch[2])
      return true
    }

    const windowsMatch = pathname.match(/^\/api\/sandboxes\/([^/]+)\/windows\/([a-z-]+)$/)
    if (windowsMatch) {
      await handleWindowsApi(req, res, config, windowsMatch[1], windowsMatch[2])
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

    const agentRebuildMatch = pathname.match(/^\/api\/agents\/([^/]+)\/rebuild-windows$/)
    if (agentRebuildMatch && req.method === 'POST') {
      const agent = await rebuildAgentWindows(config, agentRebuildMatch[1])
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

export function cloudWindows(): Plugin {
  let config: ServerConfig

  return {
    name: 'cloud-windows',
    apply: 'serve',
    enforce: 'pre',

    configResolved(resolvedConfig) {
      config = loadServerConfig(
        loadEnv(resolvedConfig.mode, resolvedConfig.root, ''),
      )
    },

    configureServer(server) {
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
