import { describe, expect, it } from "bun:test"
import { APIError, Sandbox } from "@vercel/sandbox"
import { inspect, resume } from "@opencode/core/sandbox/vercel/client"
import { singleSubmissionFetch } from "@opencode/core/sandbox/vercel/transport"
import { command, credentials, fixture, transport } from "./fixture/vercel"

describe("Vercel single-submission transport", () => {
  for (const failure of ["network", "500", "429"] as const) {
    it(`does not resend a detached submission after ${failure}`, async () => {
      const cause = new Error("Response lost after possible execution")
      const mock = transport((call) => {
        if (!call.path.endsWith("/cmd")) return Response.json(fixture())
        if (failure === "network") throw cause
        return Response.json({ error: { code: "uncertain", message: "Submission not confirmed" } }, {
          status: Number(failure),
        })
      })
      const active = await resume({ ...credentials, fetch: mock.fetch })
      const result = active.session.runCommand({ cmd: "sh", detached: true })
      if (failure === "network") await expect(result).rejects.toBe(cause)
      else {
        try {
          await result
          throw new Error("Expected rejection")
        } catch (error) {
          expect(error).toBeInstanceOf(APIError)
          if (!(error instanceof APIError)) throw error
          expect(error.response.status).toBe(Number(failure))
          expect(error.json).toEqual({ error: { code: "uncertain", message: "Submission not confirmed" } })
        }
      }
      expect(mock.calls.filter((call) => call.path.endsWith("/cmd"))).toHaveLength(1)
    })
  }

  it("does not coalesce distinct successful commands with identical bodies", async () => {
    const mock = transport((call) => call.path.endsWith("/cmd")
      ? Response.json({ command: command() })
      : Response.json(fixture()))
    const active = await resume({ ...credentials, fetch: mock.fetch })
    await active.session.runCommand({ cmd: "sh", detached: true })
    await active.session.runCommand({ cmd: "sh", detached: true })
    expect(mock.calls.filter((call) => call.path.endsWith("/cmd"))).toHaveLength(2)
  })

  it("does not retry a retrieve that can resume a VM", async () => {
    const mock = transport(() => Response.json({ error: { message: "Unknown resume outcome" } }, { status: 503 }))
    await expect(resume({ ...credentials, fetch: mock.fetch })).rejects.toBeInstanceOf(APIError)
    expect(mock.calls).toHaveLength(1)
    expect(mock.calls[0].query.get("resume")).toBe("true")
  })

  it("preserves metadata GET retries", async () => {
    let calls = 0
    const mock = transport(() => ++calls < 3
      ? Response.json({ error: { message: "Temporary read failure" } }, { status: 503 })
      : Response.json(fixture()))
    expect((await inspect({ ...credentials, fetch: mock.fetch })).generation).toBe("vm-1")
    expect(mock.calls).toHaveLength(3)
    expect(mock.calls.every((call) => call.query.get("resume") === "false")).toBe(true)
  })

  it("applies the same no-replay policy to named creation", async () => {
    const mock = transport(() => { throw new Error("Uncertain create outcome") })
    await expect(Sandbox.create({ ...credentials, fetch: singleSubmissionFetch(mock.fetch) })).rejects.toThrow("Uncertain create outcome")
    expect(mock.calls).toHaveLength(1)
    expect(mock.calls[0].method).toBe("POST")
  })

  it("does not consume or clone a successful response body", async () => {
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("stream")); controller.close() } }))
    const mock = transport(() => response)
    const fetch = singleSubmissionFetch(mock.fetch)
    const actual = await fetch("https://example.invalid/cmd", { method: "POST" })
    expect(actual).toBe(response)
    expect(actual.bodyUsed).toBe(false)
    expect(await actual.text()).toBe("stream")
  })

  it("does not dispatch a pre-aborted SDK mutation", async () => {
    const mock = transport((call) => Response.json(call.path.endsWith("/cmd") ? { command: command() } : fixture()))
    const active = await resume({ ...credentials, fetch: mock.fetch })
    const controller = new AbortController()
    controller.abort(new Error("cancelled"))
    await expect(active.session.runCommand({ cmd: "sh", detached: true, signal: controller.signal })).rejects.toThrow("cancelled")
    expect(mock.calls).toHaveLength(1)
  })
})
