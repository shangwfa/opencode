import { describe, expect, it } from "bun:test"
import { APIError, Sandbox } from "@vercel/sandbox"
import { inspect, resume } from "@opencode/core/sandbox/vercel/client"
import { command, credentials, error, fixture, transport } from "./fixture/vercel"

describe("Vercel strict connection boundary", () => {
  it("inspects stopped metadata without resuming or exposing the SDK handle", async () => {
    const mock = transport(() => Response.json(fixture("stopped")))
    expect(await inspect({ ...credentials, fetch: mock.fetch })).toEqual({
      name: "oc-test",
      persistent: true,
      status: "stopped",
      generation: "vm-1",
    })
    expect(mock.calls).toHaveLength(1)
    expect(mock.calls[0].method).toBe("GET")
    expect(mock.calls[0].query.get("resume")).toBe("false")
    expect(mock.calls[0].query.get("projectId")).toBe("prj_test")
    expect(mock.calls[0].query.get("teamId")).toBe("team_test")
  })

  it("resumes explicitly and returns the current VM generation", async () => {
    const mock = transport(() => Response.json(fixture("running", "vm-2")))
    const connected = await resume({ ...credentials, fetch: mock.fetch })
    expect(connected.generation).toBe("vm-2")
    expect(connected.session.sessionId).toBe("vm-2")
    expect(mock.calls[0].query.get("resume")).toBe("true")
  })

  for (const [status, code] of [[404, "not_found"], [410, "snapshot_not_found"], [403, "forbidden"], [429, "rate_limited"]] as const) {
    it(`does not create/delete when strict resume fails with ${code}`, async () => {
      const mock = transport(() => error(status, code))
      await expect(resume({ ...credentials, fetch: mock.fetch })).rejects.toBeInstanceOf(APIError)
      expect(mock.calls).toHaveLength(1)
      expect(mock.calls.every((call) => call.method === "GET")).toBe(true)
    })
  }

  it("fails when retrieve returns a non-running VM", async () => {
    const mock = transport(() => Response.json(fixture("stopped")))
    await expect(resume({ ...credentials, fetch: mock.fetch })).rejects.toThrow("did not become running")
    expect(mock.calls).toHaveLength(1)
  })

  for (const key of ["teamId", "projectId", "token", "name"] as const) {
    it(`rejects an empty ${key} before any API request`, async () => {
      const mock = transport(() => { throw new Error("Unexpected network access") })
      await expect(resume({ ...credentials, [key]: " ", fetch: mock.fetch })).rejects.toThrow(`Missing Vercel sandbox ${key}`)
      expect(mock.calls).toHaveLength(0)
    })
  }

  it("a pinned session cannot silently resume a stopped VM during execution", async () => {
    const mock = transport((call) => call.path.endsWith("/cmd")
      ? error(410, "sandbox_stopped")
      : Response.json(fixture()))
    const connected = await resume({ ...credentials, fetch: mock.fetch })
    await expect(connected.session.runCommand("sh", ["-c", "exit 7"])).rejects.toBeInstanceOf(APIError)
    expect(mock.calls.map((call) => call.method)).toEqual(["GET", "POST"])
  })

  it("stop preserves named identity and does not issue DELETE", async () => {
    const snapshot = {
      id: "snap-1", sourceSessionId: "vm-1", region: "iad1", status: "created",
      sizeBytes: 32, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
    }
    const mock = transport((call) => Response.json(call.path.endsWith("/stop")
      ? { ...fixture("stopped"), snapshot }
      : fixture()))
    const connected = await resume({ ...credentials, fetch: mock.fetch })
    const stopped = await connected.sandbox.stop()
    expect(stopped.snapshot?.id).toBe("snap-1")
    expect(connected.sandbox.name).toBe("oc-test")
    expect(connected.sandbox.status).toBe("stopped")
    expect(mock.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /api/v2/sandboxes/oc-test", "POST /api/v2/sandboxes/sessions/vm-1/stop",
    ])
  })

  it("retrieves and kills a command on its pinned VM without resuming another generation", async () => {
    const mock = transport((call) => call.path.includes("/cmd/")
      ? Response.json({ command: command() })
      : Response.json(fixture()))
    const connected = await resume({ ...credentials, fetch: mock.fetch })
    const task = await connected.session.getCommand("cmd-1")
    await task.kill("SIGTERM")
    expect(mock.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /api/v2/sandboxes/oc-test",
      "GET /api/v2/sandboxes/sessions/vm-1/cmd/cmd-1",
      "POST /api/v2/sandboxes/sessions/vm-1/cmd/cmd-1/kill",
    ])
    expect(mock.calls[2].body.signal).toBe(15)
  })
})

describe("Vercel SDK 3.8.0 behavioral evidence (not a provider acceptance)", () => {
  it("getOrCreate deletes and recreates BEFORE onCreate can reject", async () => {
    const mock = transport((call) => {
      if (call.method === "GET") return error(410, "snapshot_not_found")
      if (call.method === "DELETE") return Response.json({ sandbox: fixture().sandbox })
      return Response.json(fixture())
    })
    await expect(Sandbox.getOrCreate({
      ...credentials, fetch: mock.fetch, resume: true,
      onCreate: async () => { throw new Error("Refuse cold start") },
    })).rejects.toThrow("Refuse cold start")
    expect(mock.calls.map((call) => call.method)).toEqual(["GET", "DELETE", "POST"])
  })

  it("sends foreground commands once on transport failure", async () => {
    const mock = transport((call) => {
      if (call.path.endsWith("/cmd")) throw new Error("Ambiguous transport failure")
      return Response.json(fixture())
    })
    const connected = await resume({ ...credentials, fetch: mock.fetch })
    await expect(connected.session.runCommand("sh", ["-c", "exit 7"])).rejects.toThrow("Ambiguous transport failure")
    expect(mock.calls.filter((call) => call.path.endsWith("/cmd"))).toHaveLength(1)
  })

  it("UNSAFE: detached command submissions are retried on transport failure", async () => {
    const mock = transport((call) => {
      if (call.path.endsWith("/cmd")) throw new Error("Ambiguous detached submission")
      return Response.json(fixture())
    })
    const sandbox = await Sandbox.get({ ...credentials, fetch: mock.fetch, resume: true })
    await expect(sandbox.currentSession().runCommand({ cmd: "sh", detached: true })).rejects.toThrow("Ambiguous detached submission")
    expect(mock.calls.filter((call) => call.path.endsWith("/cmd"))).toHaveLength(3)
  })

  it("forwards timeout=0 and awaits foreground launcher exit", async () => {
    const mock = transport((call) => call.path.endsWith("/cmd")
      ? new Response([
          JSON.stringify({ command: command() }),
          JSON.stringify({ stream: "stdout", data: "launcher failed\n" }),
          JSON.stringify({ command: command(7) }),
        ].join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } })
      : Response.json(fixture()))
    const connected = await resume({ ...credentials, fetch: mock.fetch })
    const result = await connected.session.runCommand({ cmd: "sh", args: ["-c", "exit 7"], timeoutMs: 0 })
    expect(result.exitCode).toBe(7)
    expect(await result.stdout()).toBe("launcher failed\n")
    expect(mock.calls[1].body.timeout).toBe(0)
    expect(mock.calls[1].body.wait).toBe(true)
  })
})
