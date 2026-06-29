import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { provideTestInstance, disposeAllInstances } from "../fixture/fixture"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "../../src/session/session"
import type { SessionID } from "../../src/session/schema"
import type { Skill } from "../../src/skill"
import { Log } from "@opencode-ai/core/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

const svc = {
  create(input?: SessionNs.CreateInput) {
    return run(SessionNs.Service.use((svc) => svc.create(input)))
  },
  remove(id: SessionID) {
    return run(SessionNs.Service.use((svc) => svc.remove(id)))
  },
}

afterEach(async () => {
  await disposeAllInstances()
})

describe("session skills routes", () => {
  test("create, list, unload and clear session skills", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const app = Server.Default().app

        const created = await app.request(`/session/${session.id}/skills/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "route-skill",
            description: "Route",
            content: "route",
            resources: [{ path: "references/route.md", type: "doc", content: "route docs" }],
          }),
        })
        expect(created.status).toBe(200)
        const json = (await created.json()) as Skill.Info
        expect(json.location).toContain("route-skill")
        expect(json.resources![0].path).toBe("references/route.md")

        const listed = await app.request(`/session/${session.id}/skills`)
        expect(listed.status).toBe(200)
        const items = (await listed.json()) as Skill.Info[]
        expect(items.map((item) => item.name)).toContain("route-skill")
        expect(items[0]!.resources![0].content).toBe("route docs")

        const unloaded = await app.request(`/session/${session.id}/skills/route-skill`, { method: "DELETE" })
        expect(unloaded.status).toBe(204)

        const empty = await app.request(`/session/${session.id}/skills`)
        expect((await empty.json()) as Skill.Info[]).toEqual([])

        await app.request(`/session/${session.id}/skills/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "route-skill", description: "Route", content: "route" }),
        })
        const cleared = await app.request(`/session/${session.id}/skills`, { method: "DELETE" })
        expect(cleared.status).toBe(204)

        const after = await app.request(`/session/${session.id}/skills`)
        expect((await after.json()) as Skill.Info[]).toEqual([])

        await svc.remove(session.id)
      },
    })
  })

  test("returns 404 for missing session", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const res = await app.request("/session/ses_missing/skills/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "missing", description: "Missing", content: "missing" }),
        })
        expect(res.status).toBe(404)
      },
    })
  })
})
