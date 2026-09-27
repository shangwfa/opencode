import { describe, expect, test } from "bun:test"
import { SessionCommand } from "@opencode/schema/session-command"
import { Session } from "@opencode/schema/session"
import { Money } from "@opencode/schema/money"
import { Project } from "@opencode/schema/project"
import { Location } from "@opencode/schema/location"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { SessionMessage } from "@opencode/schema/session-message"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionCommands } from "@opencode/core/session/commands"
import { SandboxDefinitionCache } from "@opencode/core/session/scan"
import { SandboxProvider } from "@opencode/core/sandbox/provider"
import { DateTime, Effect } from "effect"

const definition = (name: string, template: string, source: SessionCommand.Definition["source"]) =>
  SessionCommand.Definition.make({ name, template, source, hints: [] })

describe("SessionCommands", () => {
  test("merges command sources with sandbox definitions taking precedence", () => {
    const merged = SessionCommands.mergeCommands(
      [definition("review", "builtin", "builtin"), definition("init", "init", "builtin")],
      [definition("review", "session", "session"), definition("release", "release", "session")],
      [definition("review", "sandbox", "sandbox")],
    )

    expect(merged.map((item) => [item.name, item.template, item.source])).toEqual([
      ["init", "init", "builtin"],
      ["release", "release", "session"],
      ["review", "sandbox", "sandbox"],
    ])
  })

  test("decodes markdown command metadata and template", () => {
    expect(
      SessionCommands.decodeMarkdown(`---\ndescription: Review changes\nagent: reviewer\nsubagent: true\n---\nReview $ARGUMENTS`),
    ).toEqual({
      description: "Review changes",
      agent: "reviewer",
      subagent: true,
      template: "Review $ARGUMENTS",
    })
  })

  test("decodes legacy subtask and model metadata and ignores malformed command documents", () => {
    const decoded = SessionCommands.decodeMarkdown(
      `---\ndescription: Analyze\nagent: plan\nmodel: provider/model-id\nsubtask: true\n---\nAnalyze $1`,
    )
    expect(decoded).toMatchObject({
      template: "Analyze $1",
      description: "Analyze",
      agent: "plan",
      model: { providerID: "provider", model: "model-id" },
      subagent: true,
    })
    expect(SessionCommands.decodeMarkdown("---\nunknown metadata\n---\nNo body")).toMatchObject({ template: "No body" })
    expect(SessionCommands.decodeMarkdown("---\nnot valid metadata\n---\n")).toBeUndefined()
  })

  test("validates command names without allowing traversal or malformed path segments", () => {
    expect(SessionCommands.validName("review")).toBe(true)
    expect(SessionCommands.validName("docs/review-2.v1")).toBe(true)
    for (const name of ["", "../outside", "docs/../outside", "docs//review", "/absolute", "has space"]) {
      expect(SessionCommands.validName(name)).toBe(false)
    }
  })

  test("accepts a markdown template without frontmatter", () => {
    expect(SessionCommands.decodeMarkdown("Review changes")).toEqual({
      template: "Review changes",
      description: undefined,
      agent: undefined,
      model: undefined,
      subagent: undefined,
    })
  })

  test("expands all arguments and makes the last numbered placeholder absorb the remainder", () => {
    expect(SessionCommands.interpolateArguments("ALL=$ARGUMENTS FIRST=$1 REST=$2", "alpha beta gamma")).toBe(
      "ALL=alpha beta gamma FIRST=alpha REST=beta gamma",
    )
    expect(SessionCommands.interpolateArguments("FILE=$1 DIR=$2 CONTENT=$3", "config.json src {key:value}")).toBe(
      "FILE=config.json DIR=src CONTENT={key:value}",
    )
    expect(SessionCommands.interpolateArguments("File=$1", '"two words" extra')).toBe("File=two words extra")
    expect(SessionCommands.interpolateArguments("No placeholders here", "plain extra input")).toBe(
      "No placeholders here\n\nplain extra input",
    )
    expect(SessionCommands.interpolateArguments("No placeholders here", "   ")).toBe("No placeholders here")
  })

  test("replaces out-of-range placeholders with empty text and inserts arguments literally", () => {
    // SAS-CM-07: missing / empty arguments and shell metacharacters in arguments.
    expect(SessionCommands.interpolateArguments("A=$1 B=$2 C=$3", "one")).toBe("A=one B= C=")
    expect(SessionCommands.interpolateArguments("A=$1 B=$2", "")).toBe("A= B=")
    expect(SessionCommands.interpolateArguments("run $1", "a; rm -rf /")).toBe("run a; rm -rf /")
  })

  test("executes command templates and shell interpolation in the owning session sandbox", async () => {
    const sessionID = Session.ID.make("ses_command_execute")
    const session = Session.Info.make({
      id: sessionID,
      projectID: Project.ID.global,
      cost: Money.USD.zero,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
      location: Location.Ref.make({ directory: AbsolutePath.make("/workspace/repo") }),
    })
    const calls: Array<{ sessionID: string; command: string; cwd?: string; hostWorkdir: string; timeoutMs?: number }> = []
    let submitted: { sessionID: string; text?: string } | undefined
    const actions: SessionCommands.RuntimeActions = {
      prompt: (input) =>
        Effect.sync(() => {
          submitted = input
        }).pipe(
          Effect.as(
            SessionInbox.User.make({
              id: SessionMessage.ID.create(),
              sessionID,
              time: { created: DateTime.makeUnsafe(0) },
              type: "user",
              payload: { text: input.text },
              delivery: "steer",
            }),
          ),
        ),
      switchAgent: () => Effect.void,
      switchModel: () => Effect.void,
      subagent: () => Effect.void,
    }
    const sandbox = {
      run: (input: SandboxProvider.RunInput) => {
        calls.push(input)
        return Effect.succeed({ exitCode: 0, output: "commit-123", timedOut: false })
      },
    }
    const command = SessionCommands.executable(
      session,
      SessionCommand.Definition.make({
        name: "review",
        template: "Commits:\n!`git log -1`\nReview $ARGUMENTS",
        hints: ["$ARGUMENTS"],
        source: "session",
      }),
      actions,
      sandbox,
    )

    await Effect.runPromise(
      command.execute({
        sessionID,
        prompt: { text: "alpha beta" },
        delivery: "steer",
      }),
    )
    expect(calls).toEqual([
      { sessionID, command: "git log -1", cwd: "/workspace", hostWorkdir: "/workspace/repo", timeoutMs: 30_000 },
    ])
    expect(submitted).toMatchObject({
      sessionID,
      text: "Commits:\ncommit-123\nReview alpha beta",
    })
  })

  test("does not treat command arguments as shell interpolation expressions", async () => {
    const sessionID = Session.ID.make("ses_command_argument_shell")
    const session = Session.Info.make({
      id: sessionID,
      projectID: Project.ID.global,
      cost: Money.USD.zero,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
      location: Location.Ref.make({ directory: AbsolutePath.make("/workspace/repo") }),
    })
    let shellRuns = 0
    let submitted = ""
    const actions: SessionCommands.RuntimeActions = {
      prompt: (input) =>
        Effect.sync(() => {
          submitted = input.text
        }).pipe(
          Effect.as(
            SessionInbox.User.make({
              id: SessionMessage.ID.create(),
              sessionID,
              time: { created: DateTime.makeUnsafe(0) },
              type: "user",
              payload: { text: input.text },
              delivery: "steer",
            }),
          ),
        ),
      switchAgent: () => Effect.void,
      switchModel: () => Effect.void,
      subagent: () => Effect.void,
    }
    const command = SessionCommands.executable(
      session,
      SessionCommand.Definition.make({ name: "echo", template: "Input: $ARGUMENTS", hints: ["$ARGUMENTS"], source: "session" }),
      actions,
      {
        run: () => {
          shellRuns++
          return Effect.succeed({ exitCode: 0, output: "unexpected", timedOut: false })
        },
      },
    )

    await Effect.runPromise(
      command.execute({ sessionID, prompt: { text: "!`touch /tmp/injected`" }, delivery: "steer" }),
    )
    expect(shellRuns).toBe(0)
    expect(submitted).toBe("Input: !`touch /tmp/injected`")
  })

  test("switches agent and model for regular commands", async () => {
    const sessionID = Session.ID.make("ses_command_selection")
    const session = Session.Info.make({
      id: sessionID,
      projectID: Project.ID.global,
      cost: Money.USD.zero,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
      location: Location.Ref.make({ directory: AbsolutePath.make("/workspace/repo") }),
    })
    const calls: string[] = []
    const actions: SessionCommands.RuntimeActions = {
      prompt: (input) =>
        Effect.sync(() => {
          calls.push(`prompt:${input.text}`)
        }).pipe(
          Effect.as(
            SessionInbox.User.make({
              id: SessionMessage.ID.create(),
              sessionID,
              time: { created: DateTime.makeUnsafe(0) },
              type: "user",
              payload: { text: input.text },
              delivery: "steer",
            }),
          ),
        ),
      switchAgent: (input) => Effect.sync(() => calls.push(`agent:${input.agent}`)),
      switchModel: (input) => Effect.sync(() => calls.push(`model:${input.model.providerID}/${input.model.id}`)),
      subagent: () => Effect.sync(() => calls.push("subagent")),
    }
    const command = SessionCommands.executable(
      session,
      SessionCommand.Definition.make({
        name: "plan-review",
        template: "Plan $ARGUMENTS",
        agent: "plan",
        model: {
          providerID: Provider.ID.make("provider"),
          model: Model.ID.make("model-id"),
        },
        hints: ["$ARGUMENTS"],
        source: "session",
      }),
      actions,
      { run: () => Effect.die(new Error("no shell interpolation expected")) },
    )

    await Effect.runPromise(command.execute({ sessionID, prompt: { text: "changes" }, delivery: "steer" }))
    expect(calls).toEqual(["agent:plan", "model:provider/model-id", "prompt:Plan changes"])
  })

  test("dispatches subagent commands without prompting the parent session", async () => {
    const sessionID = Session.ID.make("ses_command_subagent")
    const session = Session.Info.make({
      id: sessionID,
      projectID: Project.ID.global,
      cost: Money.USD.zero,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
      location: Location.Ref.make({ directory: AbsolutePath.make("/workspace/repo") }),
    })
    const calls: unknown[] = []
    const actions: SessionCommands.RuntimeActions = {
      prompt: () => Effect.die(new Error("subagent command must not prompt the parent")),
      switchAgent: () => Effect.die(new Error("subagent command must not switch the parent agent")),
      switchModel: () => Effect.die(new Error("subagent command must not switch the parent model")),
      subagent: (input) => Effect.sync(() => calls.push(input)),
    }
    const definition = SessionCommand.Definition.make({
      name: "analyze",
      template: "Analyze $ARGUMENTS",
      subagent: true,
      hints: ["$ARGUMENTS"],
      source: "session",
    })
    const command = SessionCommands.executable(session, definition, actions, {
      run: () => Effect.die(new Error("no shell interpolation expected")),
    })

    await Effect.runPromise(command.execute({ sessionID, prompt: { text: "the diff" }, delivery: "steer" }))
    expect(calls).toEqual([{ definition, text: "Analyze the diff", prompt: { text: "the diff" } }])
  })

  test("scans and reads command files through the session sandbox", async () => {
    const sessionID = Session.ID.make("ses_scan")
    const seen: string[] = []
    const sandbox = {
      enabled: true,
      run: (input: { sessionID: string; command: string; hostWorkdir: string; cwd?: string }) => {
        expect(input.sessionID).toBe(sessionID)
        expect(input.hostWorkdir).toBe("/host/repo")
        expect(input.cwd).toBe("/workspace")
        return Effect.succeed({
          exitCode: 0,
          output: [
            "/workspace/.opencode/commands/nested/review.md",
            "/workspace/.opencode/command/bad.md",
            "/workspace/.opencode/command/malformed.md",
            "/workspace/.opencode/command/../outside.md",
            "/host/escape.md",
          ]
            .map((path) => `${path}\t1000.0000000000\t0`)
            .join("\n"),
          timedOut: false,
        })
      },
      fileRead: (id: string, file: string) => {
        expect(id).toBe(sessionID)
        seen.push(file)
        if (file.endsWith("/bad.md")) return Effect.fail(new Error("read failed"))
        if (file.endsWith("/malformed.md")) return Effect.succeed("---\nnot valid metadata\n---\n")
        return Effect.succeed("---\ndescription: sandbox review\n---\nReview $ARGUMENTS")
      },
    }

    const commands = await Effect.runPromise(SessionCommands.scanSandbox(sessionID, "/host/repo", sandbox))
    expect(seen.sort()).toEqual([
      "/workspace/.opencode/command/bad.md",
      "/workspace/.opencode/command/malformed.md",
      "/workspace/.opencode/commands/nested/review.md",
    ])
    expect(commands.map((item) => [item.name, item.source, item.template])).toEqual([
      ["nested/review", "sandbox", "Review $ARGUMENTS"],
    ])
  })

  test("does not convert sandbox scan failures into an empty command list", async () => {
    const sessionID = Session.ID.make("ses_failed_scan")
    const sandbox = {
      enabled: true,
      run: () => Effect.succeed({ exitCode: 1, output: "sandbox unavailable", timedOut: false }),
      fileRead: () => Effect.succeed(null),
    }
    await expect(Effect.runPromise(SessionCommands.scanSandbox(sessionID, "/host/repo", sandbox))).rejects.toThrow(
      "Sandbox command scan failed: sandbox unavailable",
    )
  })

  test("reuses unchanged sandbox command definitions until a fingerprint or force changes them", async () => {
    const sessionID = Session.ID.make("ses_command_scan_incremental")
    const cache = new SandboxDefinitionCache<SessionCommands.Definition>()
    const hello = "/workspace/.opencode/commands/hello.md"
    let fingerprint = "1"
    let reads = 0
    const sandbox = {
      enabled: true,
      run: () => Effect.succeed({ exitCode: 0, output: `${hello}\t${fingerprint}\t10`, timedOut: false }),
      fileRead: () => {
        reads++
        return Effect.succeed("---\ndescription: Hello\n---\nSay $ARGUMENTS")
      },
    }
    const scan = () => Effect.runPromise(SessionCommands.scanSandbox(sessionID, "/host/repo", sandbox, { cache }))

    expect(await scan()).toHaveLength(1)
    expect(reads).toBe(1)
    // An unchanged fingerprint reuses the cached definition without touching the file again.
    await scan()
    expect(reads).toBe(1)
    // A rewritten file changes its fingerprint and is read again.
    fingerprint = "2"
    await scan()
    expect(reads).toBe(2)
    // `force` re-reads every current file even when the fingerprint is unchanged.
    await Effect.runPromise(SessionCommands.scanSandbox(sessionID, "/host/repo", sandbox, { cache, force: true }))
    expect(reads).toBe(3)
  })
})
