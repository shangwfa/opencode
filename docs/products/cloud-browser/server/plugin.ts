import { loadEnv } from 'vite'
import type { Plugin, ViteDevServer } from 'vite'
import { WebSocketServer, WebSocket } from 'ws'
import type { Server, IncomingMessage, ServerResponse } from 'node:http'
import { loadServerConfig } from './config.ts'
import type { ServerConfig } from './config.ts'
import {
  createSandbox,
  destroySandbox,
  getSandbox,
  listSandboxes,
} from './sandbox.ts'
import type { SandboxEntry } from './sandbox.ts'

const JSON_CONTENT_TYPE = { 'Content-Type': 'application/json' }

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, JSON_CONTENT_TYPE)
  res.end(JSON.stringify(body))
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

    const match = path.match(/^\/api\/sandboxes\/([^/]+)$/)
    if (match) {
      const id = match[1]
      if (req.method === 'GET') {
        const entry = getSandbox(id)
        if (!entry) {
          json(res, 404, { error: 'Sandbox not found' })
          return true
        }
        json(res, 200, entry.info)
        return true
      }
      if (req.method === 'DELETE') {
        try {
          await destroySandbox(id)
          json(res, 200, { success: true })
        } catch (err) {
          json(res, 500, { error: err instanceof Error ? err.message : String(err) })
        }
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
    const entry = getSandbox(id)

    if (!entry) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      forwardVncConnection(ws, request, entry, config)
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
