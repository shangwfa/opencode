import { expect } from "bun:test"
import { Effect } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const setup = Effect.gen(function* () {
  const handler = yield* ServerFetch.make({
    app: { version: "test" },
    database: { path: ":memory:" },
    fs: { filewatcher: false },
    models: { fetch: false },
  })
  return (method: string, path: string, body?: unknown) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request(`http://opencode.local${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
      const text = response.status === 204 ? "" : await response.text()
      let result: unknown
      if (text) {
        try {
          result = JSON.parse(text)
        } catch {
          result = text
        }
      }
      return { status: response.status, result }
    })
})

it.live("covers session command CRUD, upsert, overlay, isolation, and clear", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const first = yield* request("POST", "/api/session", { title: "command owner" })
    const second = yield* request("POST", "/api/session", { title: "other session" })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const firstID = (first.result as { data: { id: string } }).data.id
    const secondID = (second.result as { data: { id: string } }).data.id
    const initialList = yield* request("GET", `/api/session/${firstID}/commands`)
    const initialNames = (initialList.result as { data: Array<{ name: string }> }).data.map((item) => item.name).sort()
    const secondBaseline = yield* request("GET", `/api/session/${secondID}/commands`)
    expect((yield* request("DELETE", `/api/session/${secondID}/commands`)).status).toBe(204)
    expect((yield* request("GET", `/api/session/${secondID}/commands`)).result).toEqual(secondBaseline.result)

    const created = yield* request("POST", `/api/session/${firstID}/commands`, {
      name: "release/check",
      description: "Check release readiness",
      template: "Review $ARGUMENTS",
    })
    expect(created.status).toBe(200)
    expect(created.result).toMatchObject({
      name: "release/check",
      description: "Check release readiness",
      template: "Review $ARGUMENTS",
      source: "session",
      hints: ["$ARGUMENTS"],
    })

    const updated = yield* request("POST", `/api/session/${firstID}/commands`, {
      name: "release/check",
      description: "Updated description",
      template: "Updated $ARGUMENTS",
      hints: ["custom"],
    })
    expect(updated.status).toBe(200)
    expect(updated.result).toMatchObject({ template: "Updated $ARGUMENTS", description: "Updated description", hints: ["custom"] })

    const metadata = yield* request("POST", `/api/session/${firstID}/commands`, {
      name: "metadata",
      template: "Uses $1 and $2",
      agent: "plan",
      model: "Yd-DeepSeek/deepseek-v4-flash",
      subtask: true,
    })
    expect(metadata.result).toMatchObject({
      agent: "plan",
      model: { providerID: "Yd-DeepSeek", model: "deepseek-v4-flash" },
      subagent: true,
      subtask: true,
      hints: ["$1", "$2"],
    })
    const shellTemplate = "Recent commits:\n!`git log --oneline -5`\nReview changes."
    const fileTemplate = "Review @README.md for improvements."
    expect((yield* request("POST", `/api/session/${firstID}/commands`, {
      name: "shell-review",
      template: shellTemplate,
    })).status).toBe(200)
    expect((yield* request("POST", `/api/session/${firstID}/commands`, {
      name: "file-review",
      template: fileTemplate,
    })).status).toBe(200)

    const listed = yield* request("GET", `/api/session/${firstID}/commands`)
    expect(listed.status).toBe(200)
    expect((listed.result as { data: Array<{ name: string; source: string }> }).data).toContainEqual(
      expect.objectContaining({ name: "release/check", source: "session" }),
    )
    expect((listed.result as { data: Array<{ name: string; template?: string }> }).data).toContainEqual(
      expect.objectContaining({ name: "shell-review", template: shellTemplate }),
    )
    expect((listed.result as { data: Array<{ name: string; template?: string }> }).data).toContainEqual(
      expect.objectContaining({ name: "file-review", template: fileTemplate }),
    )
    const refreshed = yield* request("POST", `/api/session/${firstID}/commands/refresh`)
    expect(refreshed.status).toBe(200)
    expect((refreshed.result as { data: Array<{ name: string }> }).data.some((item) => item.name === "release/check")).toBe(true)

    const isolated = yield* request("GET", `/api/session/${secondID}/commands`)
    expect(isolated.status).toBe(200)
    expect((isolated.result as { data: Array<{ name: string }> }).data.some((item) => item.name === "release/check")).toBe(
      false,
    )

    const builtinName = initialNames[0]
    if (builtinName) {
      const override = yield* request("POST", `/api/session/${firstID}/commands`, {
        name: builtinName,
        description: "Session override",
        template: "Override builtin",
      })
      expect(override.result).toMatchObject({ source: "session", description: "Session override" })
      const afterOverride = yield* request("GET", `/api/session/${firstID}/commands`)
      expect((afterOverride.result as { data: Array<{ name: string }> }).data.filter((item) => item.name === builtinName)).toHaveLength(1)
    }

    const noSuchDelete = yield* request("DELETE", `/api/session/${firstID}/commands/not-present`)
    expect(noSuchDelete.status).toBe(204)
    const cleared = yield* request("DELETE", `/api/session/${firstID}/commands`)
    expect(cleared.status).toBe(204)
    const afterClear = yield* request("GET", `/api/session/${firstID}/commands`)
    const remaining = (afterClear.result as { data: Array<{ name: string; source: string }> }).data
    expect(remaining.map((item) => item.name).sort()).toEqual(initialNames)
    expect(remaining.some((item) => item.name === "release/check")).toBe(false)

    const deletedExisting = yield* request("DELETE", `/api/session/${firstID}/commands/release%2Fcheck`)
    expect(deletedExisting.status).toBe(204)

    const reinserted = yield* request("POST", `/api/session/${firstID}/commands`, {
      name: "release/check",
      template: "For cascade verification",
    })
    expect(reinserted.status).toBe(200)
    const removedSession = yield* request("DELETE", `/api/session/${firstID}`)
    expect(removedSession.status).toBe(204)
    const missingCommands = yield* request("GET", `/api/session/${firstID}/commands`)
    expect(missingCommands.status).toBe(404)
    const missingCommand = yield* request("POST", `/api/session/${secondID}/command`, { name: "no-such-command", text: "" })
    expect(missingCommand.status).toBe(404)
  }).pipe(Effect.scoped),
)

it.live("rejects command names that could escape their namespace", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const session = yield* request("POST", "/api/session", { title: "invalid command owner" })
    const sessionID = (session.result as { data: { id: string } }).data.id
    const response = yield* request("POST", `/api/session/${sessionID}/commands`, {
      name: "../outside",
      template: "Do not run",
    })
    expect(response.status).toBe(400)
    expect((yield* request("POST", `/api/session/${sessionID}/commands`, { template: "missing name" })).status).toBe(400)
    expect((yield* request("POST", `/api/session/${sessionID}/commands`, { name: "missing-template" })).status).toBe(400)
    expect((yield* request("GET", "/api/session/ses_NOTEXIST/commands")).status).toBe(404)
    expect((yield* request("POST", "/api/session/ses_NOTEXIST/commands", { name: "ghost", template: "x" })).status).toBe(404)
  }).pipe(Effect.scoped),
)
