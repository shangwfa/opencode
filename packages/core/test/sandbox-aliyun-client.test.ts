import { expect, test } from "bun:test"
import { client } from "../src/sandbox/aliyun/client"

test("E2B SDK uses the explicitly configured Aliyun API endpoint and native network policy", async () => {
  const calls: Array<{ method: string; path: string; auth: string | null; body: unknown }> = []
  const fixture = {
    sandboxID: "sbx-client-fixture", templateID: "code-interpreter-v1", envdVersion: "0.5.1",
    envdAccessToken: "envd-test-token", trafficAccessToken: "traffic-test-token", domain: "cn-hangzhou.sandbox.aliyuncs.com",
    startedAt: new Date().toISOString(), endAt: new Date(Date.now() + 300000).toISOString(),
    cpuCount: 2, memoryMB: 2048, state: "running", metadata: {},
  }
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url)
    const body = request.method === "POST" ? await request.json() : {}
    calls.push({ method: request.method, path: url.pathname, auth: request.headers.get("x-api-key"), body })
    if (request.method === "DELETE") return new Response(null, { status: 204 })
    return Response.json(fixture)
  } })
  try {
    const api = client({ apiKey: "e2b_0000000000000000000000000000000000000000", apiUrl: `http://127.0.0.1:${server.port}`,
      domain: "cn-hangzhou.sandbox.aliyuncs.com", template: "code-interpreter-v1", pauseEnabled: false }, 5000)
    const created = await api.create("code-interpreter-v1", { secure: true, network: { allowPublicTraffic: false },
      lifecycle: { onTimeout: "kill", autoResume: false }, timeoutMs: 300000 })
    expect(created.id).toBe(fixture.sandboxID)
    expect(created.token).toBe("traffic-test-token")
    expect(calls[0]?.body).toMatchObject({ secure: true, network: { allowPublicTraffic: false } })
    expect((await api.info(created.id)).state).toBe("running")
    expect((await api.connect(created.id)).token).toBe("traffic-test-token")
    expect(await api.kill(created.id)).toBe(true)
    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ["POST", "/sandboxes"], ["GET", `/sandboxes/${fixture.sandboxID}`],
      ["POST", `/sandboxes/${fixture.sandboxID}/connect`], ["DELETE", `/sandboxes/${fixture.sandboxID}`],
    ])
    expect(calls.every((call) => call.auth === "e2b_0000000000000000000000000000000000000000")).toBe(true)
  } finally { server.stop(true) }
})

test("static Snapshot APIs reject an unsupported endpoint override instead of reaching another region", async () => {
  const api = client({ apiKey: "not-a-real-key", apiUrl: "http://127.0.0.1:1", domain: "cn-hangzhou.sandbox.aliyuncs.com",
    template: "base-5wa5", pauseEnabled: false }, 100)
  await expect(api.snapshots("owned-source")).rejects.toThrow("Configure E2B_API_URL")
  expect(() => api.deleteSnapshot("owned-snapshot")).toThrow("Configure E2B_API_URL")
})
