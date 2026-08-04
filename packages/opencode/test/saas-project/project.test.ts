import { afterAll, beforeAll, beforeEach, describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { chmod, mkdir, rm } from "fs/promises"
import os from "os"
import path from "path"
import postgres from "postgres"
import { SaasProject } from "@/saas-project"
import { ProjectGit } from "@/saas-project/git"
import { ProjectSecret } from "@/saas-project/secret"
import { Database } from "@/storage/db"
import { testEffect } from "../lib/effect"

const url = process.env.OPENCODE_DATABASE_URL
if (!url) throw new Error("OPENCODE_DATABASE_URL is required")

const sql = postgres(url)
const fakeGitDirectory = path.join(os.tmpdir(), `opencode-project-git-${process.pid}`)
const fakeGit = path.join(fakeGitDirectory, "git")
const gitLayer = Layer.succeed(ProjectGit.Service, ProjectGit.Service.of({ verify: () => Effect.void }))
const secretLayer = ProjectSecret.layer("test", Buffer.alloc(32, 7))
const projectLayer = SaasProject.layer.pipe(Layer.provide([gitLayer, secretLayer]))
const it = testEffect(projectLayer)
const verificationLayer = SaasProject.layer.pipe(
  Layer.provide([ProjectGit.layer({ command: fakeGit, allowPrivateHosts: new Set(["git.local"]) }), secretLayer]),
)
const verifyIt = testEffect(verificationLayer)

beforeAll(async () => {
  await mkdir(fakeGitDirectory, { recursive: true })
  await Bun.write(
    fakeGit,
    `#!/bin/sh
url="$4"
case "$url" in
  *public/repository.git)
    test -z "$OPENCODE_GIT_PASSWORD" && exit 0
    ;;
  *private/token.git)
    test "$OPENCODE_GIT_PASSWORD" = "valid-token" && exit 0
    echo "Authentication failed" >&2
    exit 128
    ;;
  *private/basic.git)
    test "$OPENCODE_GIT_USERNAME" = "developer" && test "$OPENCODE_GIT_PASSWORD" = "valid-password" && exit 0
    echo "Authentication failed" >&2
    exit 128
    ;;
  *private/ssh.git)
    echo "$GIT_SSH_COMMAND" | grep -q "StrictHostKeyChecking=yes" && exit 0
    echo "Host key verification failed" >&2
    exit 128
    ;;
  *)
    echo "Repository not found" >&2
    exit 128
    ;;
esac
`,
  )
  await chmod(fakeGit, 0o700)
  await Database.initialize()
})

beforeEach(async () => {
  await sql`DELETE FROM mcp`
  await sql`DELETE FROM skill`
  await sql`DELETE FROM agent`
  await sql`DELETE FROM saas_project`
})

afterAll(async () => {
  await Database.close()
  await sql.end()
  await rm(fakeGitDirectory, { recursive: true, force: true })
})

const input = {
  name: "OpenCode",
  repository: {
    provider: "generic" as const,
    url: "https://example.com/opencode/repository.git",
    auth: { type: "none" as const },
  },
}

describe("SaaS Project", () => {
  it.live("creates and updates a project", () =>
    Effect.gen(function* () {
      const service = yield* SaasProject.Service
      const created = yield* service.create(input)
      expect(created.id).toStartWith("prj_")
      expect(created.repository.url).toBe("https://example.com/opencode/repository.git")
      expect(created.repository.hasCredential).toBe(false)

      const updated = yield* service.update(created.id, { name: "Renamed" })
      expect(updated.name).toBe("Renamed")
      expect(yield* service.list()).toHaveLength(1)
    }),
  )

  it.live("stores resources by project and upserts by name", () =>
    Effect.gen(function* () {
      const service = yield* SaasProject.Service
      const first = yield* service.create(input)
      const second = yield* service.create({ ...input, name: "Second" })

      yield* service.upsertAgent(first.id, "builder", { description: "first" })
      yield* service.upsertAgent(first.id, "builder", { description: "updated" })
      yield* service.upsertAgent(second.id, "builder", { description: "second" })
      yield* service.upsertSkill(first.id, "review", { description: "Review", content: "Review code" })
      yield* service.upsertMcp(first.id, "docs", { type: "remote", url: "https://example.com/mcp" })

      expect((yield* service.listAgents(first.id)).map((item) => item.description)).toEqual(["updated"])
      expect((yield* service.listAgents(second.id)).map((item) => item.description)).toEqual(["second"])
      expect(yield* service.listSkills(first.id)).toHaveLength(1)
      expect(yield* service.listMcps(first.id)).toHaveLength(1)
    }),
  )

  it.live("stores credentials encrypted and only returns secret metadata", () =>
    Effect.gen(function* () {
      const service = yield* SaasProject.Service
      const project = yield* service.create({
        ...input,
        repository: {
          ...input.repository,
          auth: { type: "token", token: "repository-secret" },
        },
      })
      const mcp = yield* service.upsertMcp(project.id, "private-docs", {
        type: "remote",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer mcp-secret" },
      })

      expect(project.repository.hasCredential).toBe(true)
      expect(mcp.headerKeys).toEqual(["Authorization"])
      expect(mcp.hasSecrets).toBe(true)

      const before = yield* Effect.promise(
        () => sql`
          SELECT repository_credential::text AS repository_credential,
            (SELECT secrets::text FROM mcp WHERE project_id = ${project.id}) AS mcp_secret
          FROM saas_project WHERE id = ${project.id}
        `,
      )
      const updated = yield* service.upsertMcp(project.id, "private-docs", {
        type: "remote",
        url: "https://example.com/mcp",
        enabled: false,
      })
      const after = yield* Effect.promise(
        () => sql`SELECT secrets::text AS mcp_secret FROM mcp WHERE project_id = ${project.id}`,
      )

      expect(String(before[0].repository_credential)).not.toContain("repository-secret")
      expect(String(before[0].mcp_secret)).not.toContain("mcp-secret")
      expect(updated.headerKeys).toEqual(["Authorization"])
      expect(after[0].mcp_secret).toBe(before[0].mcp_secret)
    }),
  )

  it.live("checks project existence without database foreign keys", () =>
    Effect.gen(function* () {
      const service = yield* SaasProject.Service
      const missing = SaasProject.ID.make("prj_00000000000000000000000000")
      const exit = yield* Effect.exit(service.upsertAgent(missing, "builder", {}))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("SaasProject.NotFound")

      const constraints = yield* Effect.promise(
        () => sql`
          SELECT conname FROM pg_constraint
          WHERE contype = 'f' AND conrelid IN ('agent'::regclass, 'skill'::regclass, 'mcp'::regclass)
        `,
      )
      expect(constraints).toHaveLength(0)
    }),
  )

  it.live("purges child resources explicitly", () =>
    Effect.gen(function* () {
      const service = yield* SaasProject.Service
      const project = yield* service.create(input)
      yield* service.upsertAgent(project.id, "builder", {})
      yield* service.upsertSkill(project.id, "review", { description: "Review", content: "Review code" })
      yield* service.upsertMcp(project.id, "docs", { type: "remote", url: "https://example.com/mcp" })

      yield* service.purge(project.id)
      const rows = yield* Effect.promise(
        () => sql`
          SELECT
            (SELECT count(*) FROM saas_project WHERE id = ${project.id}) AS projects,
            (SELECT count(*) FROM agent WHERE project_id = ${project.id}) AS agents,
            (SELECT count(*) FROM skill WHERE project_id = ${project.id}) AS skills,
            (SELECT count(*) FROM mcp WHERE project_id = ${project.id}) AS mcps
        `,
      )
      expect(Number(rows[0].projects)).toBe(0)
      expect(Number(rows[0].agents)).toBe(0)
      expect(Number(rows[0].skills)).toBe(0)
      expect(Number(rows[0].mcps)).toBe(0)
    }),
  )

  it.live("cleans orphan resources without foreign keys", () =>
    Effect.gen(function* () {
      const service = yield* SaasProject.Service
      const now = Date.now()
      yield* Effect.promise(
        () => sql`
          INSERT INTO agent (id, project_id, name, time_created, time_updated)
          VALUES ('agt_orphan', 'prj_missing', 'orphan', ${now}, ${now})
        `,
      )

      expect(yield* service.cleanupOrphans()).toBe(1)
      const rows = yield* Effect.promise(() => sql`SELECT count(*) AS count FROM agent WHERE id = 'agt_orphan'`)
      expect(Number(rows[0].count)).toBe(0)
    }),
  )
})

describe("SaaS Project repository verification", () => {
  verifyIt.live("creates a project for a public repository without authentication", () =>
    Effect.gen(function* () {
      const service = yield* SaasProject.Service
      const project = yield* service.create({
        name: "Public",
        repository: {
          provider: "generic",
          url: "https://git.local/public/repository.git",
          auth: { type: "none" },
        },
      })

      expect(project.repository.authType).toBe("none")
      expect(project.repository.hasCredential).toBe(false)
      expect((yield* service.verifyRepository(project.id)).repository.connectionStatus).toBe("verified")
    }),
  )

  verifyIt.live("rejects a private repository without authentication and does not create a project", () =>
    Effect.gen(function* () {
      const service = yield* SaasProject.Service
      const exit = yield* Effect.exit(
        service.create({
          name: "Private without auth",
          repository: {
            provider: "generic",
            url: "https://git.local/private/token.git",
            auth: { type: "none" },
          },
        }),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* service.list()).toHaveLength(0)
    }),
  )

  verifyIt.live("accepts a private repository with a valid token", () =>
    Effect.gen(function* () {
      const service = yield* SaasProject.Service
      const project = yield* service.create({
        name: "Private token",
        repository: {
          provider: "generic",
          url: "https://git.local/private/token.git",
          auth: { type: "token", token: "valid-token" },
        },
      })

      expect(project.repository.authType).toBe("token")
      expect(project.repository.hasCredential).toBe(true)
      expect((yield* service.verifyRepository(project.id)).repository.connectionStatus).toBe("verified")
    }),
  )

  verifyIt.live("rejects an invalid token and an invalid repository URL", () =>
    Effect.gen(function* () {
      const service = yield* SaasProject.Service
      const invalidToken = yield* Effect.exit(
        service.create({
          name: "Invalid token",
          repository: {
            provider: "generic",
            url: "https://git.local/private/token.git",
            auth: { type: "token", token: "wrong-token" },
          },
        }),
      )
      const invalidUrl = yield* Effect.exit(
        service.create({
          name: "Invalid URL",
          repository: {
            provider: "generic",
            url: "file:///tmp/repository.git",
            auth: { type: "none" },
          },
        }),
      )

      expect(Exit.isFailure(invalidToken)).toBe(true)
      expect(Exit.isFailure(invalidUrl)).toBe(true)
      expect(yield* service.list()).toHaveLength(0)
    }),
  )

  verifyIt.live("supports basic and SSH authentication transports", () =>
    Effect.gen(function* () {
      const service = yield* SaasProject.Service
      const basic = yield* service.create({
        name: "Basic",
        repository: {
          provider: "generic",
          url: "https://git.local/private/basic.git",
          auth: { type: "basic", username: "developer", password: "valid-password" },
        },
      })
      const ssh = yield* service.create({
        name: "SSH",
        repository: {
          provider: "generic",
          url: "git@git.local:private/ssh.git",
          auth: { type: "ssh", privateKey: "private-key", hostFingerprint: "git.local ssh-ed25519 key" },
        },
      })

      expect(basic.repository.authType).toBe("basic")
      expect(ssh.repository.authType).toBe("ssh")
    }),
  )
})

describe("ProjectSecret", () => {
  it.effect("encrypts with AAD and rejects tampering", () =>
    Effect.gen(function* () {
      const service = yield* ProjectSecret.make("test", Buffer.alloc(32, 9))
      const envelope = yield* service.encrypt({ token: "secret" }, "project:one")
      expect(yield* service.decrypt(envelope, "project:one")).toEqual({ token: "secret" })
      expect(Exit.isFailure(yield* Effect.exit(service.decrypt(envelope, "project:two")))).toBe(true)
      expect(
        Exit.isFailure(yield* Effect.exit(service.decrypt({ ...envelope, ciphertext: "broken" }, "project:one"))),
      ).toBe(true)
    }),
  )
})

describe("ProjectGit", () => {
  it.effect("normalizes supported remotes and rejects unsafe URLs", () =>
    Effect.gen(function* () {
      const github = yield* ProjectGit.parse("github", "git@github.com:anomalyco/opencode.git")
      expect(github.url).toBe("git@github.com:anomalyco/opencode.git")
      expect(github.path).toBe("anomalyco/opencode")

      expect(Exit.isFailure(yield* Effect.exit(ProjectGit.parse("generic", "file:///tmp/repository")))).toBe(true)
      expect(
        Exit.isFailure(yield* Effect.exit(ProjectGit.parse("github", "https://gitlab.com/group/repository.git"))),
      ).toBe(true)
      expect(
        Exit.isFailure(yield* Effect.exit(ProjectGit.parse("generic", "https://token@example.com/repository.git"))),
      ).toBe(true)
    }),
  )
})
