import { Layer, ManagedRuntime } from "effect"
import { attach } from "./run-service"
import * as Observability from "@opencode-ai/core/observability"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { Database } from "@opencode-ai/core/database/database"
import { Flag } from "@opencode-ai/core/flag/flag"
import { RepositoryCache } from "@opencode-ai/core/repository-cache"
import { Bus } from "@/bus"

// SaaS PG mode: replace core Database.defaultLayer globally so that every
// module that does `Layer.provide(Database.defaultLayer)` transparently goes
// through PG instead of opening a local SQLite file.
// SaaS PG mode: register PG bridge layer as the default Database layer.
// The bridge wraps our PG drizzle instance to match core's Effect-based
// SQLite drizzle API (.get/.run/.all return Effect instead of Promise).
if (Flag.OPENCODE_DATABASE_URL) {
  const { pgDatabaseLayer } = await import("@/storage/db-core-bridge")
  Database.setDefaultLayer(pgDatabaseLayer)
  const { Database: SaasDb } = await import("@/storage/db")
  await SaasDb.initialize()
}

// Docker container mode: OpenSandbox server returns 127.0.0.1 endpoints
// (port-mapped on the host), but inside a container 127.0.0.1 points to
// the container itself. Rewrite to host.docker.internal so the container
// can reach the host's mapped ports.
if (process.env.OPENCODE_SANDBOX_ENDPOINT_REWRITE) {
  const [from, to] = process.env.OPENCODE_SANDBOX_ENDPOINT_REWRITE.split(":")
  if (from && to) {
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((input: any, init?: any) => {
      const url = typeof input === "string" ? input : input?.url ?? ""
      if (url.includes(from)) {
        const rewritten = url.replace(new RegExp(from.replace(/\./g, "\\."), "g"), to)
        const newInput = typeof input === "string" ? rewritten : new Request(rewritten, input)
        return originalFetch(newInput, init)
      }
      return originalFetch(input, init)
    }) as typeof globalThis.fetch
  }
}
import { Auth } from "@/auth"
import { Account } from "@/account/account"
import { Config } from "@/config/config"
import { Git } from "@/git"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Storage } from "@/storage/storage"
import { Snapshot } from "@/snapshot"
import { Plugin } from "@/plugin"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Provider } from "@/provider/provider"
import { ProviderAuth } from "@/provider/auth"
import { Agent } from "@/agent/agent"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Question } from "@/question"
import { Permission } from "@/permission"
import { Todo } from "@/session/todo"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionRunState } from "@/session/run-state"
import { SessionProcessor } from "@/session/processor"
import { SessionCompaction } from "@/session/compaction"
import { SessionRevert } from "@/session/revert"
import { SessionSummary } from "@/session/summary"
import { SessionPrompt } from "@/session/prompt"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { Command } from "@/command"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { Format } from "@/format"
import { InstanceLayer } from "@/project/instance-layer"
import { Project } from "@/project/project"
import { Vcs } from "@/project/vcs"
import { Workspace } from "@/control-plane/workspace"
import { Worktree } from "@/worktree"
import { Installation } from "@/installation"
import { ShareNext } from "@/share/share-next"
import { SessionShare } from "@/share/session"
import { Npm } from "@opencode-ai/core/npm"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"

export const AppLayer = Layer.mergeAll(
  Npm.defaultLayer,
  FSUtil.defaultLayer,
  Database.defaultLayer,
  Auth.defaultLayer,
  Account.defaultLayer,
  Config.defaultLayer,
  Git.defaultLayer,
  Storage.defaultLayer,
  Snapshot.defaultLayer,
  Plugin.defaultLayer,
  ModelsDev.defaultLayer,
  Provider.defaultLayer,
  ProviderAuth.defaultLayer,
  Agent.defaultLayer,
  Skill.defaultLayer,
  Discovery.defaultLayer,
  Question.defaultLayer,
  Permission.defaultLayer,
  Todo.defaultLayer,
  Session.defaultLayer,
  BackgroundJob.defaultLayer,
  RuntimeFlags.defaultLayer,
  EventV2Bridge.defaultLayer,
  SessionRunState.defaultLayer,
  SessionProcessor.defaultLayer,
  SessionCompaction.defaultLayer,
  SessionRevert.defaultLayer,
  SessionSummary.defaultLayer,
  SessionPrompt.defaultLayer,
  Instruction.defaultLayer,
  LLM.defaultLayer,
  LSP.defaultLayer,
  MCP.defaultLayer,
  McpAuth.defaultLayer,
  Command.defaultLayer,
  Truncate.defaultLayer,
  ToolRegistry.defaultLayer,
  Format.defaultLayer,
  Project.defaultLayer,
  Vcs.defaultLayer,
  Workspace.defaultLayer,
  Worktree.appLayer,
  Installation.defaultLayer,
  ShareNext.defaultLayer,
  SessionShare.defaultLayer,
).pipe(
  // SaaS: provide foundational services early so SaaS-injected layers
  // (SandboxProvider, SessionAgent.pgLayer, repo tools, etc.) can resolve
  // their transitive dependencies during parallel Layer.mergeAll construction.
  Layer.provideMerge(Bus.defaultLayer),
  Layer.provideMerge(SessionStatus.defaultLayer),
  Layer.provideMerge(RepositoryCache.defaultLayer),
  Layer.provideMerge(Git.defaultLayer),
  Layer.provideMerge(Database.defaultLayer),
  Layer.provideMerge(Ripgrep.defaultLayer),
  Layer.provideMerge(InstanceLayer.layer),
  Layer.provideMerge(Observability.layer),
)

// @ts-expect-error — upstream defaultLayer dependencies leak through; all services are provided at runtime
const rt = ManagedRuntime.make(AppLayer, { memoMap })
type Runtime = Pick<typeof rt, "runSync" | "runPromise" | "runPromiseExit" | "runFork" | "runCallback" | "dispose">

/** Services provided by AppRuntime — i.e. what an Effect run via AppRuntime.runPromise can yield. */
export type AppServices = ManagedRuntime.ManagedRuntime.Services<typeof rt>
const wrap = (effect: Parameters<typeof rt.runSync>[0]) => attach(effect as never) as never

export const AppRuntime: Runtime = {
  runSync(effect) {
    return rt.runSync(wrap(effect))
  },
  runPromise(effect, options) {
    return rt.runPromise(wrap(effect), options)
  },
  runPromiseExit(effect, options) {
    return rt.runPromiseExit(wrap(effect), options)
  },
  runFork(effect) {
    return rt.runFork(wrap(effect))
  },
  runCallback(effect) {
    return rt.runCallback(wrap(effect))
  },
  dispose: () => rt.dispose(),
}
