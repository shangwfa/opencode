import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Agent } from "@opencode/core/agent"
import { SessionAgents } from "@opencode/core/session/agents"
import { MAX_SCAN_FILES, SandboxDefinitionCache } from "@opencode/core/session/scan"
import { ConfigAgent } from "@opencode/schema/config/agent"
import { Session } from "@opencode/schema/session"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"

/** Mirrors `find -printf '%p\t%T@\t%s\n'` output consumed by the shared scanner. */
const scanLine = (path: string, mtime = "1000.0000000000", size = "0") => `${path}\t${mtime}\t${size}`

test("merges configured, session, and sandbox agents by ID and field priority", () => {
  const id = Agent.ID.make("reviewer")
  const configured = Agent.Info.make({ ...Agent.Info.default(id), system: "global system" })
  const merged = SessionAgents.mergeAgents(
    [configured],
    [
      {
        id,
        config: ConfigAgent.Info.make({
          system: "session system",
          description: "session description",
          color: "#112233",
          model: { providerID: Provider.ID.make("test-provider"), model: Model.ID.make("session-model") },
        }),
      },
    ],
    [
      {
        id,
        config: ConfigAgent.Info.make({ system: "sandbox system" }),
        source: "sandbox",
        sourcePath: "reviewer.md",
      },
    ],
  )

  expect(merged).toHaveLength(1)
  expect(merged[0]).toMatchObject({
    source: "sandbox",
    sourcePath: "reviewer.md",
    agent: {
      id,
      system: "sandbox system",
      description: "session description",
      color: "#112233",
      model: { providerID: "test-provider", id: "session-model" },
    },
  })
})

test("adds session-only agents and allows sandbox definitions to restore disabled IDs", () => {
  const id = Agent.ID.make("session/reviewer")
  const merged = SessionAgents.mergeAgents(
    [],
    [{ id, config: ConfigAgent.Info.make({ system: "session-only", mode: "subagent" }) }],
    [{ id, config: ConfigAgent.Info.make({ description: "sandbox definition" }), source: "sandbox" }],
  )

  expect(merged).toHaveLength(1)
  expect(merged[0]).toMatchObject({
    source: "sandbox",
    agent: { id, system: "session-only", description: "sandbox definition", mode: "subagent" },
  })
})

test("a higher-priority disabled definition removes the lower-priority agent", () => {
  const id = Agent.ID.make("reviewer")
  const merged = SessionAgents.mergeAgents(
    [Agent.Info.default(id)],
    [{ id, config: ConfigAgent.Info.make({ disabled: true }) }],
    [],
  )

  expect(merged).toEqual([])
})

test("a disabled sandbox definition removes an active session override", () => {
  const id = Agent.ID.make("scanned")
  const merged = SessionAgents.mergeAgents(
    [],
    [{ id, config: ConfigAgent.Info.make({ system: "session", mode: "subagent" }) }],
    [{ id, config: ConfigAgent.Info.make({ disabled: true }), source: "sandbox", sourcePath: "scanned.md" }],
  )

  expect(merged).toEqual([])
})

test("sandbox definitions contribute permissions to the effective agent", () => {
  // Documents current behaviour for SAS-AG-11 / SAS-DEF-01: a scanned definition can add
  // permissions. Whether that is allowed is a product policy decision, not a test outcome.
  const id = Agent.ID.make("scanned-permission")
  const merged = SessionAgents.mergeAgents(
    [Agent.Info.default(id)],
    [],
    [
      {
        id,
        config: ConfigAgent.Info.make({ permissions: [{ action: "read", resource: "*.secret", effect: "allow" }] }),
        source: "sandbox",
        sourcePath: "scanned-permission.md",
      },
    ],
  )

  expect(merged[0]?.agent.permissions).toContainEqual({ action: "read", resource: "*.secret", effect: "allow" })
})

test("expands home-relative permission resources for filesystem actions", () => {
  const id = Agent.ID.make("home-paths")
  const home = "/home/test-user"
  const merged = SessionAgents.mergeAgents(
    [],
    [
      {
        id,
        config: ConfigAgent.Info.make({
          permissions: [
            { action: "read", resource: "~/private/*", effect: "allow" },
            { action: "external_directory", resource: "$HOME/shared/*", effect: "ask" },
            { action: "edit", resource: "$HOME", effect: "deny" },
          ],
        }),
      },
    ],
    [],
    home,
  )

  expect(merged[0]?.agent.permissions.slice(-3)).toEqual([
    { action: "read", resource: "/home/test-user/private/*", effect: "allow" },
    { action: "external_directory", resource: "/home/test-user/shared/*", effect: "ask" },
    { action: "edit", resource: home, effect: "deny" },
  ])
})

test("decodes sandbox Agent markdown metadata and body into a partial config", () => {
  expect(
    SessionAgents.decodeMarkdown(
      "reviewer",
      "---\ndescription: Review changes\nmode: subagent\n---\nReview the code carefully.",
    ),
  ).toMatchObject({
    description: "Review changes",
    mode: "subagent",
    system: "Review the code carefully.",
  })
  expect(SessionAgents.decodeMarkdown("../outside", "Do not load me")).toBeUndefined()
})

test("scans sandbox Agent markdown through the owning Session sandbox", async () => {
  const sessionID = Session.ID.make("ses_agent_scan")
  const seen: string[] = []
  const sandbox = {
    enabled: true,
    run: (input: { sessionID: string; command: string; hostWorkdir: string; cwd?: string; retryPolicy?: string }) => {
      expect(input.sessionID).toBe(sessionID)
      expect(input.hostWorkdir).toBe("/host/repo")
      expect(input.cwd).toBe("/workspace")
      expect(input.retryPolicy).toBe("safe-read")
      expect(input.command).toContain("/workspace/.opencode/agents")
      return Effect.succeed({
        exitCode: 0,
        output: [
          scanLine("/workspace/.opencode/agents/nested/reviewer.md"),
          scanLine("/workspace/.opencode/agent/malformed.md"),
          scanLine("/workspace/.opencode/agent/../outside.md"),
          scanLine("/host/outside.md"),
        ].join("\n"),
        timedOut: false,
      })
    },
    fileRead: (id: string, file: string) => {
      expect(id).toBe(sessionID)
      seen.push(file)
      if (file.endsWith("malformed.md")) return Effect.succeed("---\nmode: impossible\n---\n")
      return Effect.succeed("---\ndescription: Sandbox reviewer\nmode: subagent\n---\nReview the code")
    },
  }

  const definitions = await Effect.runPromise(SessionAgents.scanSandbox(sessionID, "/host/repo", sandbox))
  expect(seen.sort()).toEqual([
    "/workspace/.opencode/agent/malformed.md",
    "/workspace/.opencode/agents/nested/reviewer.md",
  ])
  expect(definitions.map((item) => [item.id, item.source, item.sourcePath, item.config.description])).toEqual([
    [Agent.ID.make("nested/reviewer"), "sandbox", "nested/reviewer.md", "Sandbox reviewer"],
  ])
})

test("surfaces sandbox Agent scan failures instead of returning an empty definition list", async () => {
  const sessionID = Session.ID.make("ses_agent_scan_failed")
  const sandbox = {
    enabled: true,
    run: () => Effect.succeed({ exitCode: 1, output: "sandbox unavailable", timedOut: false }),
    fileRead: () => Effect.succeed(null),
  }
  await expect(Effect.runPromise(SessionAgents.scanSandbox(sessionID, "/host/repo", sandbox))).rejects.toThrow(
    "Sandbox Agent scan failed: sandbox unavailable",
  )
})

test("treats a sandbox Agent scan timeout as a typed failure", async () => {
  const sessionID = Session.ID.make("ses_agent_scan_timeout")
  const sandbox = {
    enabled: true,
    run: () => Effect.succeed({ exitCode: 1, output: "partial", timedOut: true }),
    fileRead: () => Effect.succeed(null),
  }
  await expect(Effect.runPromise(SessionAgents.scanSandbox(sessionID, "/host/repo", sandbox))).rejects.toThrow(
    "Sandbox Agent scan timed out",
  )
})

test("bounds the number of sandbox Agent files read in one scan", async () => {
  const sessionID = Session.ID.make("ses_agent_scan_bounded")
  const files = Array.from({ length: MAX_SCAN_FILES + 25 }, (_, index) => `/workspace/.opencode/agents/a-${index}.md`)
  const seen: string[] = []
  const sandbox = {
    enabled: true,
    run: () => Effect.succeed({ exitCode: 0, output: files.map((path) => scanLine(path)).join("\n"), timedOut: false }),
    fileRead: (_id: string, file: string) => {
      seen.push(file)
      return Effect.succeed(`System for ${file}`)
    },
  }
  const definitions = await Effect.runPromise(SessionAgents.scanSandbox(sessionID, "/host/repo", sandbox))
  expect(seen).toHaveLength(MAX_SCAN_FILES)
  expect(definitions).toHaveLength(MAX_SCAN_FILES)
})

test("degrades sandbox Agent discovery to no definitions instead of failing the read path", async () => {
  const sessionID = Session.ID.make("ses_agent_scan_degraded")
  const sandbox = {
    enabled: true,
    run: () => Effect.succeed({ exitCode: 1, output: "sandbox unavailable", timedOut: false }),
    fileRead: () => Effect.succeed(null),
  }
  const definitions = await Effect.runPromise(
    SessionAgents.scanSandboxBestEffort(sessionID, "/host/repo", sandbox),
  )
  expect(definitions).toEqual([])
})

test("reads only sandbox Agent files whose fingerprint changed", async () => {
  const sessionID = Session.ID.make("ses_agent_scan_incremental")
  const cache = new SandboxDefinitionCache<SessionAgents.SourceConfig>()
  let reads = 0
  let fingerprint = "1000.0000000000"
  const reviewer = "/workspace/.opencode/agents/reviewer.md"
  const sandbox = {
    enabled: true,
    run: () =>
      Effect.succeed({ exitCode: 0, output: scanLine(reviewer, fingerprint, "12"), timedOut: false }),
    fileRead: () => {
      reads++
      return Effect.succeed("---\ndescription: Review\nmode: subagent\n---\nReview the code")
    },
  }
  const scan = () => Effect.runPromise(SessionAgents.scanSandbox(sessionID, "/host/repo", sandbox, { cache }))

  expect(await scan()).toHaveLength(1)
  expect(reads).toBe(1)

  // An unchanged fingerprint reuses the cached definition without touching the file again.
  expect(await scan()).toHaveLength(1)
  expect(reads).toBe(1)

  // A rewritten file changes its fingerprint and is read again.
  fingerprint = "2000.0000000000"
  await scan()
  expect(reads).toBe(2)

  // `force` re-reads even when the fingerprint is unchanged, so a refresh can recover.
  await Effect.runPromise(SessionAgents.scanSandbox(sessionID, "/host/repo", sandbox, { cache, force: true }))
  expect(reads).toBe(3)

  // A file that disappears drops out of the cache, so its return costs one read.
  sandbox.run = () => Effect.succeed({ exitCode: 0, output: "", timedOut: false })
  expect(await scan()).toEqual([])
  sandbox.run = () => Effect.succeed({ exitCode: 0, output: scanLine(reviewer, fingerprint, "12"), timedOut: false })
  await scan()
  expect(reads).toBe(4)
})

test("retries a sandbox Agent file whose read failed instead of caching the failure", async () => {
  const sessionID = Session.ID.make("ses_agent_scan_retry")
  const cache = new SandboxDefinitionCache<SessionAgents.SourceConfig>()
  const reviewer = "/workspace/.opencode/agents/reviewer.md"
  let fail = true
  let reads = 0
  const sandbox = {
    enabled: true,
    run: () => Effect.succeed({ exitCode: 0, output: scanLine(reviewer, "1000.0000000000", "12"), timedOut: false }),
    fileRead: () => {
      reads++
      return fail
        ? Effect.fail(new Error("transient sandbox read failure"))
        : Effect.succeed("---\ndescription: Review\nmode: subagent\n---\nReview the code")
    },
  }
  const scan = () => Effect.runPromise(SessionAgents.scanSandbox(sessionID, "/host/repo", sandbox, { cache }))

  // A failed read yields no definition, but must not be frozen against this fingerprint.
  expect(await scan()).toEqual([])
  expect(reads).toBe(1)
  fail = false
  expect(await scan()).toHaveLength(1)
  expect(reads).toBe(2)
})

test("keeps the last known definition when a changed file cannot be read", async () => {
  const sessionID = Session.ID.make("ses_agent_scan_stale")
  const cache = new SandboxDefinitionCache<SessionAgents.SourceConfig>()
  const reviewer = "/workspace/.opencode/agents/reviewer.md"
  let fingerprint = "1000.0000000000"
  let fail = false
  let reads = 0
  const sandbox = {
    enabled: true,
    run: () => Effect.succeed({ exitCode: 0, output: scanLine(reviewer, fingerprint, "12"), timedOut: false }),
    fileRead: () => {
      reads++
      if (fail) return Effect.fail(new Error("transient sandbox read failure"))
      return Effect.succeed(`---\ndescription: Review\n---\nSystem ${fingerprint}`)
    },
  }
  const scan = () => Effect.runPromise(SessionAgents.scanSandbox(sessionID, "/host/repo", sandbox, { cache }))

  expect((await scan())[0]?.config.system).toBe("System 1000.0000000000")
  // The file changed but the read failed: keep the last known value and retry next scan.
  fingerprint = "2000.0000000000"
  fail = true
  expect((await scan())[0]?.config.system).toBe("System 1000.0000000000")
  fail = false
  expect((await scan())[0]?.config.system).toBe("System 2000.0000000000")
  expect(reads).toBe(3)
})
