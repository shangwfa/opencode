import { NodeHttpServer } from "@effect/platform-node"
import { afterAll, beforeAll, beforeEach, describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import postgres from "postgres"
import { SaasProject } from "@/saas-project"
import { ProjectGit } from "@/saas-project/git"
import { ProjectSecret } from "@/saas-project/secret"
import { ServerAuth } from "@/server/auth"
import { SaasProjectRootApi } from "@/server/routes/instance/httpapi/api"
import { saasProjectHandlers } from "@/server/routes/instance/httpapi/handlers/saas-project"
import { authorizationLayer } from "@/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "@/server/routes/instance/httpapi/middleware/schema-error"
import { Database } from "@/storage/db"
import { testEffect } from "../lib/effect"

const url = process.env.OPENCODE_DATABASE_URL
if (!url) throw new Error("OPENCODE_DATABASE_URL is required")

const sql = postgres(url)
const gitLayer = Layer.succeed(
  ProjectGit.Service,
  ProjectGit.Service.of({
    verify: (remote, auth) => {
      if (!remote.path.startsWith("private/")) return Effect.void
      if (auth.type === "token" && auth.token === "valid-token") return Effect.void
      return new ProjectGit.VerificationError({
        reason: "unauthorized",
        message: "Repository authentication failed",
      })
    },
  }),
)
const projectLayer = SaasProject.layer.pipe(Layer.provide([ProjectSecret.layer("test", Buffer.alloc(32, 5)), gitLayer]))
const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(SaasProjectRootApi).pipe(
    Layer.provide(saasProjectHandlers),
    Layer.provide(projectLayer),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
)
const it = testEffect(apiLayer)

beforeAll(() => Database.initialize())
afterAll(async () => {
  await Database.close()
  await sql.end()
})
beforeEach(async () => {
  await sql`DELETE FROM mcp`
  await sql`DELETE FROM skill`
  await sql`DELETE FROM agent`
  await sql`DELETE FROM saas_project`
})

describe("SaaS Project HttpApi", () => {
  it.live("creates and reads a project without directory routing", () =>
    Effect.gen(function* () {
      const created = yield* HttpClientRequest.post("/saas/project").pipe(
        HttpClientRequest.setBody(
          HttpBody.jsonUnsafe({
            name: "OpenCode",
            repository: {
              provider: "generic",
              url: "https://example.com/opencode/repository.git",
              auth: { type: "none" },
            },
          }),
        ),
        HttpClient.execute,
      )
      expect(created.status).toBe(200)
      const project = (yield* created.json) as { id: string; name: string }
      expect(project.id).toStartWith("prj_")

      const read = yield* HttpClient.get(`/saas/project/${project.id}`)
      expect(read.status).toBe(200)
      expect(yield* read.json).toMatchObject({ id: project.id, name: "OpenCode" })
    }),
  )

  it.live("rejects a private repository without authentication", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post("/saas/project").pipe(
        HttpClientRequest.setBody(
          HttpBody.jsonUnsafe({
            name: "Private",
            repository: {
              provider: "generic",
              url: "https://example.com/private/repository.git",
              auth: { type: "none" },
            },
          }),
        ),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
      const rows = yield* Effect.promise(() => sql`SELECT count(*) AS count FROM saas_project`)
      expect(Number(rows[0].count)).toBe(0)
    }),
  )

  it.live("creates a private repository project with a valid token", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post("/saas/project").pipe(
        HttpClientRequest.setBody(
          HttpBody.jsonUnsafe({
            name: "Private",
            repository: {
              provider: "generic",
              url: "https://example.com/private/repository.git",
              auth: { type: "token", token: "valid-token" },
            },
          }),
        ),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({
        name: "Private",
        repository: { authType: "token", hasCredential: true, connectionStatus: "verified" },
      })
    }),
  )
})
