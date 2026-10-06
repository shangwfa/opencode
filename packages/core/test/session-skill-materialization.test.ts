import { expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { Database } from "../src/database/database"
import { SandboxProvider } from "../src/sandbox/provider"
import { SessionSkills } from "../src/session/skills"
import * as SkillResource from "../src/session/skill-resource.js"
import { SessionTable } from "../src/session/sql"
import { Session } from "@opencode/schema/session"
import { SessionSkill } from "@opencode/schema/session-skill"
import { Skill } from "@opencode/schema/skill"
import { testEffect } from "./lib/effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { ensureSession, removeIfCreated, sessionInfo } from "./lib/session"

const files = new Map<string, string>()
let failAt: string | undefined
let listing = ""
let foundFiles: Array<{ path: string; isDirectory: boolean }> = []
let ready = true
let generation = "generation-one"
let scans = 0
const writes: string[] = []
const sandbox = Layer.mock(SandboxProvider.Service, {
  enabled: true,
  isReady: () => Effect.succeed(ready),
  sandboxId: () => Effect.succeed(ready ? generation : null),
  fileRead: (_session, file) => Effect.succeed(files.get(file) ?? null),
  fileFind: () => Effect.succeed(foundFiles),
  fileStat: (_session, file) =>
    Effect.succeed(files.has(file) ? { isDirectory: false, size: files.get(file)?.length } : null),
  fileWrite: (_session, file, content) =>
    Effect.suspend(() => {
      if (failAt && file.endsWith(failAt)) return Effect.fail(new Error("injected resource failure"))
      writes.push(file)
      files.set(file, content)
      return Effect.void
    }),
  run: () =>
    Effect.sync(() => {
      scans++
      return { exitCode: 0, timedOut: false, output: listing }
    }),
})
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, SessionSkills.node]), [SandboxProvider.node.replace(sandbox)]),
)
const fixture = Effect.gen(function* () {
  files.clear()
  writes.length = 0
  failAt = undefined
  listing = ""
  foundFiles = []
  ready = true
  generation = "generation-one"
  scans = 0
  const { db } = yield* Database.Service
  const { session: template, created } = yield* ensureSession(db)
  const id = Session.ID.create()
  yield* db
    .insert(SessionTable)
    .values({ ...template, id, slug: id, parent_id: null, fork_session_id: null, directory: "/workspace" })
    .run()
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* db.delete(SessionTable).where(eq(SessionTable.id, id)).run()
      yield* removeIfCreated(db, template, created)
    }).pipe(Effect.orDie),
  )
  const service = yield* SessionSkills.Service
  const session = sessionInfo({ ...template, id, directory: "/workspace" })
  const info = yield* service.create(id, {
    id: Skill.ID.make("materialization"),
    content: "OLD INSTRUCTIONS",
    resources: [{ path: "scripts/run.sh", type: "script", content: "OLD RESOURCE" }],
  })
  return { service, session, info }
})

// V1 baseline (feat/opencode-1.18.31 packages/opencode/src/skill/resource.ts): the
// directory must reproduce V1 byte-for-byte for V1-shaped data so materialized
// paths stay stable across the migration.
const v1Root = "/home/sandbox/.local/share/opencode/session-skills"
const v1Digest = (content: string) => createHash("sha256").update(content).digest("hex")
const v1Snapshot = (content: string, resources: ReadonlyArray<{ path: string; content: string }>) =>
  v1Digest(
    JSON.stringify({
      content,
      resources: resources
        .map((resource) => ({ path: resource.path, digest: v1Digest(resource.content) }))
        .toSorted((a, b) => a.path.localeCompare(b.path)),
    }),
  )
const v1Directory = (
  sessionID: string,
  id: string,
  content: string,
  resources: ReadonlyArray<{ path: string; content: string }>,
) => path.posix.join(v1Root, sessionID, id, v1Snapshot(content, resources))

test("materialization directories are byte-identical to the V1 algorithm for V1-shaped ids", () => {
  const resources = [
    { path: "z.md", type: "doc" as const, content: "Z" },
    { path: "B.md", type: "doc" as const, content: "uppercase first sorts after a.md under localeCompare" },
    { path: "a.md", type: "doc" as const, content: "A" },
  ]
  const content = "# Skill\ninstructions"
  // V1 server-generated ids: `ssk_` + base64url, always path-safe.
  for (const id of [`ssk_${randomBytes(12).toString("base64url")}`, "resource-check"]) {
    expect(SkillResource.directory("ses_owner", id, content, resources)).toBe(
      v1Directory("ses_owner", id, content, resources),
    )
  }
})

test("unsafe ids fall back to a digest segment without escaping the V1 layout", () => {
  const resources = [{ path: "scripts/run.sh", type: "script" as const, content: "OLD RESOURCE" }]
  for (const id of ["../escape", "with space", "a/b", ".hidden", ""]) {
    const directory = SkillResource.directory("ses_owner", id, "BODY", resources)
    const segment = directory.split("/").at(-2) ?? ""
    expect(segment).toMatch(/^~[a-f0-9]{64}$/)
    expect(segment.slice(1)).toBe(v1Digest(id))
    expect(directory).not.toContain("..")
    expect(directory).toBe(`${v1Root}/ses_owner/${segment}/${v1Snapshot("BODY", resources)}`)
  }
})

it.effect("resource directories match the V1 root, skill namespace, and snapshot digest", () =>
  Effect.gen(function* () {
    const { service, session, info } = yield* fixture
    const hash = (value: string) => createHash("sha256").update(value).digest("hex")
    const snapshot = hash(
      JSON.stringify({
        content: info.skill.content,
        resources: [{ path: "scripts/run.sh", digest: hash("OLD RESOURCE") }],
      }),
    )
    expect(yield* service.materialize(session, info)).toBe(
      `/home/sandbox/.local/share/opencode/session-skills/${session.id}/materialization/${snapshot}`,
    )
  }),
)

it.effect("returns persisted resource paths and discovers sandbox skill files", () =>
  Effect.gen(function* () {
    const { service, session, info } = yield* fixture
    expect(yield* service.files(session, info)).toEqual(["scripts/run.sh"])

    const directory = "/workspace/.opencode/skills/demo"
    foundFiles = [
      { path: `${directory}/SKILL.md`, isDirectory: false },
      { path: `${directory}/references`, isDirectory: true },
      { path: `${directory}/references/guide.md`, isDirectory: false },
      { path: `${directory}/scripts/check.mjs`, isDirectory: false },
    ]
    const sandboxSkill = SessionSkill.Info.make({
      skill: Skill.Info.make({
        id: Skill.ID.make("demo"),
        name: Skill.Name.make("Demo"),
        path: `${directory}/SKILL.md` as Skill.Info["path"],
        content: "Demo instructions",
      }),
      source: "sandbox",
      resources: [],
    })
    expect(yield* service.files(session, sandboxSkill)).toEqual(["references/guide.md", "scripts/check.mjs"])
  }),
)

it.effect("internal children use the owner resource root while history forks remain isolated", () =>
  Effect.gen(function* () {
    const { service, session } = yield* fixture
    const { db } = yield* Database.Service
    const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get()
    if (!row) return yield* Effect.die(new Error("missing owner session"))
    for (const fork of [false, true]) {
      const id = Session.ID.create()
      yield* db
        .insert(SessionTable)
        .values({ ...row, id, slug: id, parent_id: session.id, fork_session_id: fork ? session.id : null })
        .run()
      yield* Effect.addFinalizer(() => db.delete(SessionTable).where(eq(SessionTable.id, id)).run().pipe(Effect.orDie))
      expect(yield* service.resourceRoot(id)).toBe(
        `/home/sandbox/.local/share/opencode/session-skills/${fork ? id : session.id}`,
      )
    }
  }),
)

it.effect("resource order does not change the V1-compatible directory", () =>
  Effect.gen(function* () {
    const { service, session } = yield* fixture
    const resources = [
      { path: "z.md", type: "doc" as const, content: "Z" },
      { path: "a.md", type: "doc" as const, content: "A" },
    ]
    const first = yield* service.create(session.id, { id: Skill.ID.make("stable-order"), content: "BODY", resources })
    const second = yield* service.create(session.id, {
      id: first.skill.id,
      content: "BODY",
      resources: resources.toReversed(),
    })
    expect(yield* service.materialize(session, first)).toBe(yield* service.materialize(session, second))
  }),
)

it.effect("arbitrary skill IDs cannot escape the owner namespace or collide with ordinary IDs", () =>
  Effect.gen(function* () {
    const { service, session } = yield* fixture
    const directories = new Set<string>()
    for (const id of ["../../escape", "/absolute", ".", "..", "", "中文/技能", "ordinary-id"]) {
      const info = yield* service.create(session.id, {
        id: Skill.ID.make(id),
        content: "BODY",
        resources: [{ path: "script.sh", type: "script", content: "echo OK" }],
      })
      const directory = yield* service.materialize(session, info)
      expect(directory?.startsWith(`/home/sandbox/.local/share/opencode/session-skills/${session.id}/`)).toBe(true)
      expect(directory?.split("/").slice(-2, -1)[0]).not.toBe("..")
      expect(directory?.split("/").length).toBe(10)
      if (directory) directories.add(directory)
    }
    expect(directories.size).toBe(7)
  }),
)

for (const effect of ["ask", "deny"] as const) {
  it.effect(`automatic recovery does not pre-write ${effect}-only resources`, () =>
    Effect.gen(function* () {
      const { service, session } = yield* fixture
      yield* service.rematerialize(session, [{ action: "skill", resource: "*", effect }])
      expect(writes).toEqual([])
    }),
  )
}
it.effect("materializing script resources only writes files and never executes commands", () =>
  Effect.gen(function* () {
    const { service, session, info } = yield* fixture
    const directory = yield* service.materialize(session, info)
    expect(files.get(`${directory}/scripts/run.sh`)).toBe("OLD RESOURCE")
    expect(scans).toBe(0)
    expect(writes.at(-1)).toBe(`${directory}/resources.json`)
    yield* service.materialize(session, info)
    expect(scans).toBe(0)
  }),
)
it.effect("automatic recovery preserves explicitly allowed resources", () =>
  Effect.gen(function* () {
    const { service, session } = yield* fixture
    yield* service.rematerialize(session, [{ action: "skill", resource: "*", effect: "allow" }])
    expect(
      [...files.entries()].some(([file, content]) => file.endsWith("/scripts/run.sh") && content === "OLD RESOURCE"),
    ).toBe(true)
  }),
)

it.effect("failed resource writes do not publish a completion marker", () =>
  Effect.gen(function* () {
    const { service, session, info } = yield* fixture
    failAt = "/scripts/run.sh"
    expect((yield* service.materialize(session, info).pipe(Effect.result))._tag).toBe("Failure")
    expect([...files.keys()].some((file) => file.endsWith("/resources.json"))).toBe(false)
    failAt = undefined
    yield* service.rematerialize(session)
    expect(
      [...files.entries()].some(([file, content]) => file.endsWith("/scripts/run.sh") && content === "OLD RESOURCE"),
    ).toBe(true)
    expect(writes.at(-1)?.endsWith("/resources.json")).toBe(true)
  }),
)

it.effect("a legacy marker cannot hide a missing or same-size corrupted resource", () =>
  Effect.gen(function* () {
    const { service, session, info } = yield* fixture
    const directory = yield* service.materialize(session, info)
    if (!directory) return yield* Effect.die(new Error("missing resource directory"))
    files.delete(`${directory}/scripts/run.sh`)
    files.set(`${directory}/resources.json`, JSON.stringify({ id: info.skill.id, resources: info.resources }))
    yield* service.rematerialize(session)
    expect(files.get(`${directory}/scripts/run.sh`)).toBe("OLD RESOURCE")
    files.set(`${directory}/scripts/run.sh`, "BAD RESOURCE")
    yield* service.rematerialize(session)
    expect(files.get(`${directory}/scripts/run.sh`)).toBe("OLD RESOURCE")
  }),
)

it.effect("materialization consumes the captured definition and resources after an update", () =>
  Effect.gen(function* () {
    const { service, session, info } = yield* fixture
    yield* service.create(session.id, {
      id: info.skill.id,
      content: "NEW INSTRUCTIONS",
      resources: [{ path: "scripts/run.sh", type: "script", content: "NEW RESOURCE" }],
    })
    const oldDirectory = yield* service.materialize(session, info)
    expect(files.get(`${oldDirectory}/SKILL.md`)).toBe(info.skill.content)
    expect(files.get(`${oldDirectory}/scripts/run.sh`)).toBe("OLD RESOURCE")
    const current = yield* service.get(session, info.skill.id)
    if (!current) return yield* Effect.die(new Error("missing updated definition"))
    const newDirectory = yield* service.materialize(session, current)
    expect(newDirectory).not.toBe(oldDirectory)
    expect(files.get(`${newDirectory}/SKILL.md`)).toBe("NEW INSTRUCTIONS")
  }),
)

it.effect("sandbox discovery excludes reference documents and keeps flat and directory skills", () =>
  Effect.gen(function* () {
    const { service, session } = yield* fixture
    const prefix = "/workspace/.opencode/skills/"
    const entries = ["deploy/SKILL.md", "deploy/references/guide.md", "flat.md"]
    for (const entry of entries) files.set(prefix + entry, "---\ndescription: example\n---\nBODY")
    listing = entries.map((entry) => `${prefix}${entry}\t1\t40`).join("\n")
    const found = (yield* service.list(session))
      .filter((item) => item.source === "sandbox")
      .map((item) => String(item.skill.id))
    expect(found).toEqual(["deploy", "flat"])
  }),
)

it.effect("sandbox scan caches cannot cross physical generations with identical fingerprints", () =>
  Effect.gen(function* () {
    const { service, session } = yield* fixture
    const file = "/workspace/.opencode/skills/deploy/SKILL.md"
    listing = `${file}\t1\t40`
    files.set(file, "---\ndescription: first\n---\nOLD")
    expect((yield* service.get(session, Skill.ID.make("deploy")))?.skill.content).toBe("OLD")
    generation = "generation-two"
    files.set(file, "---\ndescription: other\n---\nNEW")
    expect((yield* service.get(session, Skill.ID.make("deploy")))?.skill.content).toBe("NEW")
  }),
)

it.effect("definition lookup does not create a sandbox when none is ready", () =>
  Effect.gen(function* () {
    const { service, session, info } = yield* fixture
    ready = false
    expect((yield* service.get(session, info.skill.id))?.skill.content).toBe(info.skill.content)
    expect(writes).toEqual([])
    expect(scans).toBe(0)
  }),
)

it.effect("reference documents cannot consume the skill discovery read cap", () =>
  Effect.gen(function* () {
    const { service, session } = yield* fixture
    const prefix = "/workspace/.opencode/skills/"
    listing = [
      ...Array.from({ length: 220 }, (_, index) => `${prefix}a/references/r${index}.md\t1\t30`),
      `${prefix}z/SKILL.md\t1\t30`,
    ].join("\n")
    files.set(`${prefix}z/SKILL.md`, "---\ndescription: real skill\n---\nREAL")
    expect((yield* service.get(session, Skill.ID.make("z")))?.skill.content).toBe("REAL")
  }),
)

it.effect("a verified complete bundle is reused without rewriting files", () =>
  Effect.gen(function* () {
    const { service, session, info } = yield* fixture
    const directory = yield* service.materialize(session, info)
    const count = writes.length
    expect(yield* service.materialize(session, info)).toBe(directory)
    expect(writes.length).toBe(count)
  }),
)

it.effect("otherwise identical skills have separate resource namespaces", () =>
  Effect.gen(function* () {
    const { service, session, info } = yield* fixture
    const other = yield* service.create(session.id, {
      id: Skill.ID.make("other-materialization"),
      content: info.skill.content,
      resources: [{ path: "scripts/run.sh", type: "script", content: "OLD RESOURCE" }],
    })
    expect(yield* service.materialize(session, info)).not.toBe(yield* service.materialize(session, other))
  }),
)
