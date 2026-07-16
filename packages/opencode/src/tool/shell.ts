import { Effect, Option } from "effect"
import os from "os"
import * as Tool from "./tool"
import path from "path"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { fileURLToPath } from "url"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@/shell/shell"
import { ShellID } from "./shell/id"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { SessionPluginRuntime } from "@/plugin/session-plugin-runtime"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"
import { toSandboxCwd } from "./sandbox-path"
import { SandboxProvider } from "./sandbox-provider"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

type Chunk = {
  text: string
  size: number
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (
  ctx: Tool.Context,
  scan: Scan,
  input: { command: string; description: string },
) {
  if (scan.dirs.size > 0) {
    const directories = Array.from(scan.dirs)
    const globs = directories.map((dir) => {
      if (process.platform === "win32") return FSUtil.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {
        command: input.command,
        description: input.description,
        directories,
        patterns: globs,
      },
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {
      command: input.command,
      description: input.description,
    },
  })
})

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

const MAX_TIMEOUT_MS = 5 * 60 * 1000
const COMMAND_NOT_FOUND_RE = /command not found|No such file or directory/i

function checkCommandNotFound(text: string): string | undefined {
  const m = text.match(COMMAND_NOT_FOUND_RE)
  if (m) {
    const line = text.trim().split("\n").find((l) => COMMAND_NOT_FOUND_RE.test(l))
    return line ?? m[0]
  }
}

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FSUtil.Service
    const trunc = yield* Truncate.Service
    const flags = yield* RuntimeFlags.Service
    const defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000

    const runSandbox = Effect.fn("ShellTool.runSandbox")(function* (
      sandboxProvider: SandboxProvider.Interface,
      input: {
        command: string
        cwd: string
        timeout: number
        description: string
        background?: boolean | undefined
      },
      ctx: Tool.Context,
    ) {
      let output = ""
      let expired = false

      yield* ctx.metadata({
        metadata: { output: "", description: input.description },
      })

      const fullCommand = input.background
        ? `cd ${input.cwd} && ( nohup sh -c '${input.command.replace(/'/g, "'\\''")}' </dev/null > /tmp/opencode-bg-${ctx.callID ?? Date.now()}.log 2>&1 & ) && echo "started background"`
        : `cd ${input.cwd} && ${input.command}`

      const result = input.background
        ? yield* sandboxProvider.runDetached(
            ctx.sandboxSessionID ?? ctx.sessionID,
            fullCommand,
            { timeoutSeconds: Math.ceil((input.timeout + 5000) / 1000) },
            {
              onStdout: (msg: { text: string }) => {
                output += msg.text
                ctx.metadata({ metadata: { output: output.slice(-MAX_METADATA_LENGTH), description: input.description } })
              },
              onStderr: (msg: { text: string }) => {
                const cmdErr = checkCommandNotFound(msg.text)
                if (cmdErr) throw new Error(`Command failed: ${cmdErr}`)
                output += msg.text
                ctx.metadata({ metadata: { output: output.slice(-MAX_METADATA_LENGTH), description: input.description } })
              },
            },
            ctx.abort,
          )
        : yield* Effect.gen(function* () {
            const sb = yield* Effect.tryPromise({
              try: () => ctx.sandbox!,
              catch: (e) =>
                new Error(`Initialization failed: ${e instanceof Error ? e.message : String(e)}`),
            })
            return yield* sandboxProvider.runInSession(
              ctx.sandboxSessionID ?? ctx.sessionID,
              fullCommand,
              { timeoutSeconds: Math.ceil((input.timeout + 5000) / 1000) },
              {
                onStdout: (msg: { text: string }) => {
                  output += msg.text
                  ctx.metadata({
                    metadata: { output: output.slice(-MAX_METADATA_LENGTH), description: input.description },
                  })
                },
                onStderr: (msg: { text: string }) => {
                  const cmdErr = checkCommandNotFound(msg.text)
                  if (cmdErr) throw new Error(`Command failed: ${cmdErr}`)
                  output += msg.text
                  ctx.metadata({
                    metadata: { output: output.slice(-MAX_METADATA_LENGTH), description: input.description },
                  })
                },
              },
              ctx.abort,
            )
          })

      if (input.background) yield* sandboxProvider.keepAlive(ctx.sandboxSessionID ?? ctx.sessionID)

      const exitCode = result.exitCode ?? null
      if (exitCode === null) expired = true

      const meta: string[] = []
      if (expired) meta.push(`bash tool terminated command after exceeding timeout ${Math.min(input.timeout, MAX_TIMEOUT_MS)} ms.`)
      if (meta.length > 0) output += "\n\n<bash_metadata>\n" + meta.join("\n") + "\n</bash_metadata>"

      return {
        title: input.description,
        metadata: { output: output.slice(-MAX_METADATA_LENGTH), exit: exitCode, description: input.description },
        output,
      }
    })

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return FSUtil.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && FSUtil.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return FSUtil.normalizePath(path.resolve(root, FSUtil.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
    ) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
      }
      const shellKind = ShellID.toKind(Shell.name(shell))

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

        if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
          for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            yield* Effect.logInfo("resolved path", { arg, resolved })
            if (!resolved || containsPath(resolved, instance)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      return scan
    })

    const plugin = yield* Plugin.Service
    const sessionPlugins = yield* Effect.serviceOption(SessionPluginRuntime.Service)

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      const sessionExtra = Option.isSome(sessionPlugins)
        ? yield* sessionPlugins.value.acquire(ctx.sessionID).pipe(
            Effect.flatMap((runtime) => runtime.trigger("shell.env", { cwd, sessionID: ctx.sessionID, callID: ctx.callID }, { env: {} })),
          )
        : { env: {} }
      return {
        ...process.env,
        ...extra.env,
        ...sessionExtra.env,
      }
    })

    const run = Effect.fn("ShellTool.run")(function* (
      sandboxProvider: SandboxProvider.Interface,
      input: {
        command: string
        cwd: string
        timeout: number
        description: string
        background?: boolean | undefined
      },
      ctx: Tool.Context,
    ) {
      let output = ""
      let expired = false

      yield* ctx.metadata({
        metadata: { output: "", description: input.description },
      })

      const fullCommand = input.background
        ? `cd ${input.cwd} && ( nohup sh -c '${input.command.replace(/'/g, "'\\''")}' </dev/null > /tmp/opencode-bg-${ctx.callID ?? Date.now()}.log 2>&1 & ) && echo "started background"`
        : `cd ${input.cwd} && ${input.command}`

      const result = input.background
        ? yield* sandboxProvider.runDetached(
            ctx.sandboxSessionID ?? ctx.sessionID,
            fullCommand,
            { timeoutSeconds: Math.ceil((input.timeout + 5000) / 1000) },
            {
              onStdout: (msg: { text: string }) => {
                output += msg.text
                ctx.metadata({ metadata: { output: output.slice(-MAX_METADATA_LENGTH), description: input.description } })
              },
              onStderr: (msg: { text: string }) => {
                const cmdErr = checkCommandNotFound(msg.text)
                if (cmdErr) throw new Error(`Command failed: ${cmdErr}`)
                output += msg.text
                ctx.metadata({ metadata: { output: output.slice(-MAX_METADATA_LENGTH), description: input.description } })
              },
            },
            ctx.abort,
          )
        : yield* Effect.gen(function* () {
            const sb = yield* Effect.tryPromise({ try: () => ctx.sandbox!, catch: (e) => new Error(`Initialization failed: ${e instanceof Error ? e.message : String(e)}`) })
            return yield* sandboxProvider.runInSession(
              ctx.sandboxSessionID ?? ctx.sessionID,
              fullCommand,
              { timeoutSeconds: Math.ceil((input.timeout + 5000) / 1000) },
              {
                onStdout: (msg: { text: string }) => {
                  output += msg.text
                  ctx.metadata({ metadata: { output: output.slice(-MAX_METADATA_LENGTH), description: input.description } })
                },
                onStderr: (msg: { text: string }) => {
                  const cmdErr = checkCommandNotFound(msg.text)
                  if (cmdErr) throw new Error(`Command failed: ${cmdErr}`)
                  output += msg.text
                  ctx.metadata({ metadata: { output: output.slice(-MAX_METADATA_LENGTH), description: input.description } })
                },
              },
              ctx.abort,
            )
          })

      if (input.background) yield* sandboxProvider.keepAlive(ctx.sandboxSessionID ?? ctx.sessionID)

      const exitCode = result.exitCode ?? null
      if (exitCode === null) expired = true

      const meta: string[] = []
      if (expired) meta.push(`bash tool terminated command after exceeding timeout ${Math.min(input.timeout, MAX_TIMEOUT_MS)} ms.`)
      if (meta.length > 0) output += "\n\n<bash_metadata>\n" + meta.join("\n") + "\n</bash_metadata>"

      return {
        title: input.description,
        metadata: { output: output.slice(-MAX_METADATA_LENGTH), exit: exitCode, description: input.description },
        output,
      }
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(name, process.platform, limits, defaultTimeoutMs)
        yield* Effect.logInfo("shell tool using shell", { shell })

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = params.timeout ?? defaultTimeoutMs
              const ps = Shell.ps(shell)
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
                : instanceCtx.directory
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx)
                  if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
                  yield* ask(ctx, scan, params as any)
                }),
              )

              const sandboxProviderOpt = yield* Effect.serviceOption(SandboxProvider.Service)
              if (sandboxProviderOpt._tag === "None") throw new Error("Execution environment not available")
              const sandboxProvider = sandboxProviderOpt.value
              const sandboxCwd = toSandboxCwd(params.workdir, instanceCtx.directory)
              return yield* runSandbox(
                sandboxProvider,
                {
                  command: params.command,
                  cwd: sandboxCwd,
                  timeout,
                  description: (params as any).description ?? params.command,
                  background: params.background,
                },
                ctx,
              ).pipe(Effect.orDie)
            }),
        }
      })
  }),
)
