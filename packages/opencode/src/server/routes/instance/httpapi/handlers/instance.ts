import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import * as InstanceState from "@/effect/instance-state"
import { Format } from "@/format"
import { Global } from "@opencode-ai/core/global"
import { LSP } from "@/lsp/lsp"
import { Vcs } from "@/project/vcs"
import { SessionID } from "@/session/schema"
import { Skill } from "@/skill"
import { SandboxProvider } from "@/tool/sandbox-provider"
import { toSandboxPath } from "@/tool/sandbox-path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ApiVcsApplyError } from "../groups/instance"
import { markInstanceForDisposal } from "../lifecycle"

const sandboxVcsDiffCommand = (mode: Vcs.Mode, context: number | undefined, directory: string) => `node <<'NODE'
const child = require("child_process")
const mode = ${JSON.stringify(mode)}
const context = ${JSON.stringify(context ?? 2_147_483_647)}
const directory = ${JSON.stringify(directory)}
const maxBuffer = 10 * 1024 * 1024

function git(args) {
  return child.spawnSync("git", args, { encoding: "utf8", maxBuffer, cwd: directory || undefined })
}

function output(args) {
  const result = git(args)
  if (result.status !== 0 && !result.stdout) return undefined
  return result.stdout
}

function hasHead() {
  return git(["rev-parse", "--verify", "HEAD"]).status === 0
}

function defaultRef() {
  const symbolic = output(["symbolic-ref", "refs/remotes/origin/HEAD", "--short"])?.trim()
  if (symbolic) return symbolic
  const refs = output(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin", "refs/heads"])
    ?.split("\\n")
    .filter(Boolean) ?? []
  return refs.find((ref) => ref === "origin/main") ??
    refs.find((ref) => ref === "origin/master") ??
    refs.find((ref) => ref === "main") ??
    refs.find((ref) => ref === "master")
}

function mergeBase(ref) {
  return output(["merge-base", "HEAD", ref])?.trim()
}

function statusFromCode(code) {
  if (code.startsWith("A")) return "added"
  if (code.startsWith("D")) return "deleted"
  return "modified"
}

function parseNameStatus(text) {
  const parts = text.split("\\0").filter(Boolean)
  const out = []
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]
    if (code.startsWith("R") || code.startsWith("C")) {
      i++
      const file = parts[++i]
      if (file) out.push({ file, status: "modified" })
      continue
    }
    const file = parts[++i]
    if (file) out.push({ file, status: statusFromCode(code) })
  }
  return out
}

function untracked() {
  const parts = output(["status", "--porcelain=v1", "-z", "--untracked-files=all"])?.split("\\0").filter(Boolean) ?? []
  return parts.flatMap((entry) => entry.startsWith("?? ") ? [{ file: entry.slice(3), status: "added" }] : [])
}

function patchFor(item, ref) {
  if (item.status === "added" && !ref) {
    return output(["diff", "--no-ext-diff", "--no-index", "--unified=" + context, "/dev/null", item.file]) ?? ""
  }
  if (item.status === "added" && !output(["ls-files", "--", item.file])?.trim()) {
    return output(["diff", "--no-ext-diff", "--no-index", "--unified=" + context, "/dev/null", item.file]) ?? ""
  }
  return output(["diff", "--no-ext-diff", "--unified=" + context, ref, "--", item.file]) ?? ""
}

function counts(patch) {
  return patch.split("\\n").reduce((acc, line) => {
    if (line.startsWith("+++") || line.startsWith("---")) return acc
    if (line.startsWith("+")) acc.additions++
    if (line.startsWith("-")) acc.deletions++
    return acc
  }, { additions: 0, deletions: 0 })
}

function unique(items) {
  const seen = new Set()
  return items.filter((item) => {
    if (seen.has(item.file)) return false
    seen.add(item.file)
    return true
  }).sort((a, b) => a.file.localeCompare(b.file))
}

let ref
if (mode === "git") {
  ref = hasHead() ? "HEAD" : undefined
} else if (hasHead()) {
  const base = defaultRef()
  ref = base ? mergeBase(base) : undefined
}

if (mode === "branch" && !ref) {
  console.log("[]")
  process.exit(0)
}

const changed = ref ? parseNameStatus(output(["diff", "--name-status", "-z", ref, "--"]) ?? "") : []
const diffs = unique([...changed, ...untracked()]).map((item) => {
  const patch = patchFor(item, ref)
  return { file: item.file, patch, status: item.status, ...counts(patch) }
})

console.log(JSON.stringify(diffs))
NODE`

export const instanceHandlers = HttpApiBuilder.group(InstanceHttpApi, "instance", (handlers) =>
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const command = yield* Command.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const skill = yield* Skill.Service
    const vcs = yield* Vcs.Service

    const dispose = Effect.fn("InstanceHttpApi.dispose")(function* () {
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return true
    })

    const getPath = Effect.fn("InstanceHttpApi.path")(function* () {
      const ctx = yield* InstanceState.context
      const wt = ctx.worktree === "/" ? "/" : toSandboxPath(ctx.worktree, ctx.worktree)
      return {
        home: Global.Path.home,
        state: Global.Path.state,
        config: Global.Path.config,
        worktree: wt,
        directory: toSandboxPath(ctx.directory, ctx.worktree === "/" ? ctx.directory : ctx.worktree),
      }
    })

    const getVcs = Effect.fn("InstanceHttpApi.vcs")(function* () {
      const [branch, default_branch] = yield* Effect.all([vcs.branch(), vcs.defaultBranch()], {
        concurrency: "unbounded",
      })
      return { branch, default_branch }
    })

    const getVcsStatus = Effect.fn("InstanceHttpApi.vcsStatus")(function* () {
      return yield* vcs.status()
    })

    const getVcsDiff = Effect.fn("InstanceHttpApi.vcsDiff")(function* (ctx: {
      query: { mode: Vcs.Mode; context?: number; sessionID?: SessionID }
    }) {
      if (Flag.OPENCODE_SANDBOX_ENABLED && ctx.query.sessionID) {
        const instanceCtx = yield* InstanceState.context
        const sandbox = yield* Effect.serviceOption(SandboxProvider.Service)
        if (sandbox._tag === "Some") {
          const result = yield* sandbox.value
            .runInSession(ctx.query.sessionID, sandboxVcsDiffCommand(ctx.query.mode, ctx.query.context, instanceCtx.directory), {
              timeoutSeconds: 30,
            })
            .pipe(Effect.catch(() => Effect.succeed(undefined)))
          const stdout = result?.logs.stdout.map((line: { text: string }) => line.text).join("").trim()
          if (stdout) {
            const parsed = yield* Effect.try({
              try: () => JSON.parse(stdout) as Vcs.FileDiff[],
              catch: () => undefined,
            }).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (parsed) return parsed
          }
        }
      }
      return yield* vcs.diff(ctx.query.mode, { context: ctx.query.context })
    })

    const getVcsDiffRaw = Effect.fn("InstanceHttpApi.vcsDiffRaw")(function* () {
      return yield* vcs.diffRaw()
    })

    const applyVcs = Effect.fn("InstanceHttpApi.vcsApply")(function* (ctx: { payload: Vcs.ApplyInput }) {
      return yield* vcs.apply(ctx.payload).pipe(
        Effect.mapError(
          (error) =>
            new ApiVcsApplyError({
              name: "VcsApplyError",
              data: {
                message: error.message,
                reason: error.reason,
              },
            }),
        ),
      )
    })

    const getCommand = Effect.fn("InstanceHttpApi.command")(function* () {
      return yield* command.list()
    })

    const getAgent = Effect.fn("InstanceHttpApi.agent")(function* () {
      return yield* agent.list()
    })

    const getSkill = Effect.fn("InstanceHttpApi.skill")(function* () {
      return yield* skill.all()
    })

    const getLsp = Effect.fn("InstanceHttpApi.lsp")(function* () {
      return yield* lsp.status()
    })

    const getFormatter = Effect.fn("InstanceHttpApi.formatter")(function* () {
      return yield* format.status()
    })

    return handlers
      .handle("dispose", dispose)
      .handle("path", getPath)
      .handle("vcs", getVcs)
      .handle("vcsStatus", getVcsStatus)
      .handle("vcsDiff", getVcsDiff)
      .handle("vcsDiffRaw", getVcsDiffRaw)
      .handle("vcsApply", applyVcs)
      .handle("command", getCommand)
      .handle("agent", getAgent)
      .handle("skill", getSkill)
      .handle("lsp", getLsp)
      .handle("formatter", getFormatter)
  }),
)
