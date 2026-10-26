import type { Connection } from "@opencode/core/sandbox/vercel/client"

export const credentials = { teamId: "team_test", projectId: "prj_test", token: "test-token", name: "oc-test" }
type Transport = NonNullable<Connection["fetch"]>
export type Call = {
  method: string
  path: string
  query: URLSearchParams
  body: Record<string, unknown>
  signal?: AbortSignal | null
}

export function fixture(status = "running", id = "vm-1") {
  const now = 1_700_000_000_000
  return {
    sandbox: {
      name: credentials.name,
      persistent: true,
      currentSessionId: id,
      createdAt: now,
      updatedAt: now,
      status,
    },
    session: {
      id, memory: 4096, vcpus: 2, region: "iad1", timeout: 120_000, status, cwd: "/workspace",
      requestedAt: now, createdAt: now, updatedAt: now,
    },
    routes: [{ port: 9911, subdomain: "test", url: "https://test.invalid" }, { port: 19911, subdomain: "gate", url: "https://gate.invalid" }],
  }
}

export const command = (exitCode: number | null = null) => ({
  id: "cmd-1", name: "sh", args: ["-c", "exit 7"], cwd: "/workspace",
  sessionId: "vm-1", exitCode, startedAt: 1_700_000_000_000,
})

export const error = (status: number, code: string) =>
  Response.json({ error: { code, message: code } }, { status, headers: { "retry-after": "21" } })

export function transport(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetch: Transport = Object.assign(async (input: Parameters<Transport>[0], init?: Parameters<Transport>[1]) => {
    const url = new URL(String(input))
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : {},
      signal: init?.signal,
    }
    calls.push(call)
    return handler(call)
  }, { preconnect() {} })
  return { fetch, calls }
}

export function logs(chunks: Array<{ stream: "stdout" | "stderr"; data: string }>) {
  return new Response(chunks.map((chunk) => JSON.stringify(chunk)).join("\n") + "\n", {
    headers: { "content-type": "application/x-ndjson" },
  })
}
