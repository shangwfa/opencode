import { expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Session } from "@opencode/schema/session"
import { SessionSkill } from "@opencode/schema/session-skill"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { SandboxProvider } from "@opencode/core/sandbox/provider"
import { SessionExecution } from "@opencode/core/session/execution"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

it.live("skill HTTP routes reject unsafe bundles and incomplete inputs, then repair resources on retry", () =>
  Effect.gen(function* () {
    const files = new Map<string, string>()
    let failResource = true
    let removed = false
    const sandbox = Layer.mock(SandboxProvider.Service, {
      enabled: true,
      keepAlive: () => Effect.void,
      boot: () => Effect.succeed("test-sandbox"),
      isReady: () => Effect.succeed(true),
      sandboxId: () => Effect.succeed("test-sandbox"),
      run: () => Effect.succeed({ exitCode: 0, output: "", timedOut: false }),
      fileRead: (_session, file) => Effect.succeed(files.get(file) ?? null),
      fileWrite: (_session, file, content) =>
        Effect.suspend(() => {
          if (failResource && file.endsWith("/scripts/run.sh"))
            return Effect.fail(new Error("injected resource failure"))
          files.set(file, content)
          return Effect.void
        }),
      destroy: () =>
        Effect.sync(() => {
          removed = true
        }),
      lifecycle: () =>
        Effect.succeed({ sandboxID: "test-sandbox", state: removed ? "destroyed" : "running", persistMode: "pvc" }),
      deleteSnapshots: () => Effect.void,
      endpoint: () => Effect.succeed({ _tag: "no-sandbox" }),
    })
    const handler = yield* ServerFetch.make(
      {
        app: { version: "test" },
        database: { path: ":memory:" },
        fs: { filewatcher: false },
        models: { fetch: false },
      },
      { overrides: [SandboxProvider.node.replace(sandbox), SessionExecution.node.replace(SessionExecution.noopLayer)] },
    )
    const request = (method: string, route: string, payload?: unknown) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${route}`, {
            method,
            headers: { "content-type": "application/json" },
            body: payload === undefined ? undefined : JSON.stringify(payload),
          }),
        )
        const body: unknown = response.status === 204 ? undefined : await response.json()
        return { status: response.status, body }
      })
    const created = yield* request("POST", "/api/session", { title: "skill resources HTTP" })
    expect(created.status).toBe(200)
    const id = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Struct({ id: Session.ID }) }))(created.body).data
      .id
    for (const resourcePath of ["SKILL.md", "resources.json", "SKILL.md/nested", "resources.json/nested"]) {
      expect(
        (yield* request("POST", `/api/session/${id}/skills`, {
          id: "unsafe",
          content: "BODY",
          resources: [{ path: resourcePath, type: "doc", content: "overwrite" }],
        })).status,
      ).toBe(400)
    }
    const listed = yield* request("GET", `/api/session/${id}/skills`)
    const definitions = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(SessionSkill.Info) }))(
      listed.body,
    ).data
    expect(definitions.filter((info) => info.source === "session")).toEqual([])
    expect(
      (yield* request("POST", `/api/session/${id}/skills`, {
        id: "resource",
        content: "requires scripts/run.sh",
        resources: [{ path: "scripts/run.sh", type: "script", content: "RESOURCE" }],
      })).status,
    ).toBe(200)
    const prompt = { text: "load resource", skills: [{ id: "resource" }], resume: false }
    expect((yield* request("POST", `/api/session/${id}/prompt`, prompt)).status).toBe(400)
    expect([...files.keys()].some((file) => file.endsWith("/resources.json"))).toBe(false)
    failResource = false
    const admitted = yield* request("POST", `/api/session/${id}/prompt`, prompt)
    expect(admitted.status).toBe(200)
    const input = Schema.decodeUnknownSync(Schema.Struct({ data: SessionInbox.User }))(admitted.body).data
    // The skill resource root was aligned to V1's layout in 2026-10-04
    // (`packages/core/src/session/skill-resource.ts` root = /home/sandbox/.local/share/opencode/session-skills).
    expect(input.payload.skills?.[0]?.text).toContain("/home/sandbox/.local/share/opencode/session-skills/")
    const script = [...files.keys()].find((file) => file.endsWith("/scripts/run.sh"))
    if (!script) return yield* Effect.die(new Error("materialized script missing"))
    files.set(script, "CORRUPTED")
    expect((yield* request("POST", `/api/session/${id}/prompt`, prompt)).status).toBe(200)
    expect(files.get(script)).toBe("RESOURCE")
    expect((yield* request("DELETE", `/api/session/${id}`)).status).toBe(204)
    expect((yield* request("GET", `/api/session/${id}/skills`)).status).toBe(404)
  }),
)
