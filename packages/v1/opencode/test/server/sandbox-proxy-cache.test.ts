import { afterAll, afterEach, describe, expect } from "bun:test"
import http from "node:http"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { SandboxProvider } from "../../src/tool/sandbox-provider"
import { Bus } from "../../src/bus"
import { sandboxProxyRoute } from "../../src/server/sandbox-proxy"
import { testEffect } from "../lib/effect"

// These tests exercise the raw proxy route directly: a fake upstream HTTP server
// stands in for the sandbox dev server, and a mock provider records endpoint
// resolution so we can assert the per-session:port target cache and byte passthrough.
const it = testEffect(Layer.empty)

type Counters = { get: number; endpoint: number }

const servers: http.Server[] = []

function startUpstream(handler: http.RequestListener) {
  return Effect.promise(
    () =>
      new Promise<{ port: number }>((resolve) => {
        const server = http.createServer(handler)
        servers.push(server)
        server.listen(0, "127.0.0.1", () => {
          const address = server.address()
          resolve({ port: typeof address === "object" && address ? address.port : 0 })
        })
      }),
  )
}

function mockProvider(endpoint: () => string, counters: Counters) {
  const sandbox = {
    id: "sb_proxy_cache_test",
    sandboxes: {
      getSandboxEndpoint: () => {
        counters.endpoint += 1
        return Promise.resolve({ endpoint: endpoint() })
      },
    },
  }
  return Layer.mock(SandboxProvider.Service, {
    get: () => {
      counters.get += 1
      return Effect.succeed(sandbox as never)
    },
    runInSession: () =>
      Effect.succeed({ logs: { stdout: [{ text: "PORT=" }], stderr: [] }, exitCode: 0 } as never),
  })
}

const busStub = Layer.succeed(
  Bus.Service,
  Bus.Service.of({
    publish: () => Effect.void,
    subscribe: () => Effect.never as never,
    subscribeAll: () => Effect.never as never,
    subscribeCallback: () => Effect.succeed(() => undefined),
    subscribeAllCallback: () => Effect.succeed(() => undefined),
  }),
)

function buildLayer(endpoint: () => string, counters: Counters) {
  const routes = HttpRouter.serve(sandboxProxyRoute, { disableListenLog: true, disableLogger: true })
  return routes.pipe(
    Layer.provide(mockProvider(endpoint, counters)),
    Layer.provide(busStub),
    Layer.provide(layerWebSocketConstructorGlobal),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(NodeServices.layer),
  )
}

function request(path: string) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

afterAll(() => {
  for (const server of servers.splice(0)) server.close()
})

describe("sandbox proxy - streaming + target cache", () => {
  it.live("streams binary response bytes and reuses the resolved endpoint across assets", () => {
    const counters: Counters = { get: 0, endpoint: 0 }
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10, 0x42])
    const target: { endpoint: string } = { endpoint: "" }
    return Effect.gen(function* () {
      const upstream = yield* startUpstream((_req, res) => {
        res.writeHead(200, { "content-type": "image/png" })
        res.end(Buffer.from(bytes))
      })
      target.endpoint = `127.0.0.1:${upstream.port}`
      const sid = `ses_proxy_cache_${Date.now()}`

      const first = yield* request(`/session/${sid}/proxy/5173/logo.png`)
      expect(first.status).toBe(200)
      expect(first.headers["content-type"]).toBe("image/png")
      expect(new Uint8Array(yield* first.arrayBuffer)).toEqual(bytes)

      const second = yield* request(`/session/${sid}/proxy/5173/icon.png`)
      expect(second.status).toBe(200)
      expect(new Uint8Array(yield* second.arrayBuffer)).toEqual(bytes)

      // Both asset requests must share one sandbox lookup and one endpoint resolution.
      expect(counters.get).toBe(1)
      expect(counters.endpoint).toBe(1)
    }).pipe(Effect.provide(buildLayer(() => target.endpoint, counters)))
  })

  it.live("rewrites html and injects the proxy prefix script", () => {
    const counters: Counters = { get: 0, endpoint: 0 }
    const target: { endpoint: string } = { endpoint: "" }
    return Effect.gen(function* () {
      const upstream = yield* startUpstream((_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        res.end(`<html><head></head><body><script type="module" src="/src/main.tsx"></script></body></html>`)
      })
      target.endpoint = `127.0.0.1:${upstream.port}`
      const sid = `ses_proxy_html_${Date.now()}`

      const res = yield* request(`/session/${sid}/proxy/5173/`)
      expect(res.status).toBe(200)
      expect(res.headers["content-type"]).toContain("text/html")
      const body = yield* res.text
      expect(body).toContain(`${sid}/proxy/5173/src/main.tsx`)
      expect(body).toContain("__OC_PROXY_PREFIX__")
    }).pipe(Effect.provide(buildLayer(() => target.endpoint, counters)))
  })

  it.live("rewrites root-relative imports in javascript modules", () => {
    const counters: Counters = { get: 0, endpoint: 0 }
    const target: { endpoint: string } = { endpoint: "" }
    return Effect.gen(function* () {
      const upstream = yield* startUpstream((_req, res) => {
        res.writeHead(200, { "content-type": "application/javascript" })
        res.end(`import x from "/src/a.ts";`)
      })
      target.endpoint = `127.0.0.1:${upstream.port}`
      const sid = `ses_proxy_js_${Date.now()}`

      const res = yield* request(`/session/${sid}/proxy/5173/src/a.ts`)
      expect(res.status).toBe(200)
      const body = yield* res.text
      expect(body).toBe(`import x from "/session/${sid}/proxy/5173/src/a.ts";`)
    }).pipe(Effect.provide(buildLayer(() => target.endpoint, counters)))
  })

  it.live("re-resolves the endpoint after an upstream connection failure", () => {
    const counters: Counters = { get: 0, endpoint: 0 }
    let endpoint = "127.0.0.1:1"
    return Effect.gen(function* () {
      const upstream = yield* startUpstream((_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" })
        res.end("ok")
      })
      const sid = `ses_proxy_fail_${Date.now()}`

      const failed = yield* request(`/session/${sid}/proxy/5173/`)
      expect(failed.status).toBe(502)
      expect(counters.endpoint).toBe(1)

      // Failure must invalidate the cached target; the next request re-resolves.
      endpoint = `127.0.0.1:${upstream.port}`
      const recovered = yield* request(`/session/${sid}/proxy/5173/`)
      expect(recovered.status).toBe(200)
      expect(counters.endpoint).toBe(2)
    }).pipe(Effect.provide(buildLayer(() => endpoint, counters)))
  })
})
