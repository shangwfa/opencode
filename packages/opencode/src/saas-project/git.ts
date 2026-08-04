export * as ProjectGit from "./git"

import { lookup } from "dns/promises"
import { mkdtemp, rm, writeFile, chmod } from "fs/promises"
import { isIP } from "net"
import os from "os"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"

export const Provider = Schema.Literals(["github", "gitlab", "generic"])
export type Provider = typeof Provider.Type

export const Auth = Schema.Union([
  Schema.Struct({ type: Schema.Literal("none") }),
  Schema.Struct({
    type: Schema.Literal("oauth"),
    accessToken: Schema.String,
    refreshToken: Schema.optional(Schema.String),
    expiresAt: Schema.optional(Schema.Number),
  }),
  Schema.Struct({ type: Schema.Literal("token"), token: Schema.String, username: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("basic"), username: Schema.String, password: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("ssh"),
    privateKey: Schema.String,
    passphrase: Schema.optional(Schema.String),
    hostFingerprint: Schema.String,
  }),
])
export type Auth = typeof Auth.Type

export const Remote = Schema.Struct({
  provider: Provider,
  url: Schema.String,
  host: Schema.String,
  path: Schema.String,
})
export type Remote = typeof Remote.Type

export class InvalidRemoteError extends Schema.TaggedErrorClass<InvalidRemoteError>()("SaasProject.InvalidRemote", {
  message: Schema.String,
}) {}

export class VerificationError extends Schema.TaggedErrorClass<VerificationError>()(
  "SaasProject.RepositoryVerification",
  {
    reason: Schema.Literals(["unauthorized", "not_found", "timeout", "unreachable", "host_denied", "host_key"]),
    message: Schema.String,
  },
) {}

const unsafe = /[\0\r\n]/
const scp = /^(?<user>[a-zA-Z0-9._-]+)@(?<host>[^:]+):(?<path>.+)$/

export function parse(provider: Provider, input: string): Effect.Effect<Remote, InvalidRemoteError> {
  return Effect.gen(function* () {
    if (input !== input.trim() || !input || input.startsWith("-") || unsafe.test(input)) {
      return yield* new InvalidRemoteError({ message: "Invalid repository URL" })
    }

    const match = scp.exec(input)
    const parsed = match?.groups
      ? { protocol: "ssh:", username: match.groups.user, host: match.groups.host, pathname: match.groups.path }
      : yield* Effect.try({
          try: () => {
            const url = new URL(input)
            return {
              protocol: url.protocol,
              username: url.username,
              host: url.hostname,
              pathname: url.pathname,
              password: url.password,
              search: url.search,
              hash: url.hash,
              port: url.port,
            }
          },
          catch: () => new InvalidRemoteError({ message: "Invalid repository URL" }),
        })

    if (!(["https:", "ssh:"] as string[]).includes(parsed.protocol)) {
      return yield* new InvalidRemoteError({ message: "Repository protocol must be HTTPS or SSH" })
    }
    if ("password" in parsed && (parsed.password || parsed.search || parsed.hash || parsed.port)) {
      return yield* new InvalidRemoteError({
        message: "Repository URL must not contain credentials, query, fragment, or port",
      })
    }
    if (parsed.protocol === "https:" && parsed.username) {
      return yield* new InvalidRemoteError({ message: "Repository URL must not contain credentials" })
    }
    if (parsed.protocol === "ssh:" && parsed.username && parsed.username !== "git") {
      return yield* new InvalidRemoteError({ message: "SSH repository user must be git" })
    }

    const host = parsed.host.toLowerCase()
    if (!host || (provider === "github" && host !== "github.com") || (provider === "gitlab" && host !== "gitlab.com")) {
      return yield* new InvalidRemoteError({ message: "Repository provider does not match host" })
    }
    const repositoryPath = parsed.pathname
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      .replace(/\.git$/, "")
    if (!repositoryPath || repositoryPath.split("/").some((part) => !part || part === "." || part === "..")) {
      return yield* new InvalidRemoteError({ message: "Invalid repository path" })
    }

    return Remote.make({
      provider,
      host,
      path: repositoryPath,
      url: parsed.protocol === "ssh:" ? `git@${host}:${repositoryPath}.git` : `https://${host}/${repositoryPath}.git`,
    })
  })
}

function deniedAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
  }
  const value = address.toLowerCase()
  return (
    value === "::1" ||
    value === "::" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe8") ||
    value.startsWith("fe9") ||
    value.startsWith("fea") ||
    value.startsWith("feb")
  )
}

export interface Interface {
  readonly verify: (remote: Remote, auth: Auth) => Effect.Effect<void, VerificationError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SaasProjectGit") {}

type Options = {
  readonly allowPrivateHosts?: ReadonlySet<string>
  readonly timeoutMs?: number
  readonly command?: string
}

export function make(options: Options = {}): Interface {
  const verify = Effect.fn("ProjectGit.verify")(function* (remote: Remote, auth: Auth) {
    if (!options.allowPrivateHosts?.has(remote.host)) {
      const addresses = yield* Effect.tryPromise({
        try: () => lookup(remote.host, { all: true }),
        catch: () => new VerificationError({ reason: "unreachable", message: "Repository host could not be resolved" }),
      })
      if (addresses.some((item) => deniedAddress(item.address))) {
        return yield* new VerificationError({ reason: "host_denied", message: "Repository host is not allowed" })
      }
    }

    yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => prepareAuth(auth),
        catch: () =>
          new VerificationError({ reason: "unreachable", message: "Failed to prepare repository authentication" }),
      }),
      ({ env }) =>
        Effect.tryPromise({
          try: () => run(options.command ?? "git", remote.url, env, options.timeoutMs ?? 15_000),
          catch: (cause) => classify(cause),
        }),
      ({ directory }) =>
        directory ? Effect.promise(() => rm(directory, { recursive: true, force: true })) : Effect.void,
    )
  })
  return Service.of({ verify })
}

export function layer(options?: Options) {
  return Layer.succeed(Service, make(options))
}

export const live = layer()

async function prepareAuth(auth: Auth) {
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  }
  if (auth.type === "none") return { env, directory: undefined }

  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-git-auth-"))
  if (auth.type === "ssh") {
    const key = path.join(directory, "key")
    const knownHosts = path.join(directory, "known_hosts")
    await writeFile(key, auth.privateKey, { mode: 0o600 })
    await writeFile(knownHosts, auth.hostFingerprint, { mode: 0o600 })
    env.GIT_SSH_COMMAND = `ssh -i ${key} -o BatchMode=yes -o UserKnownHostsFile=${knownHosts} -o StrictHostKeyChecking=yes`
    if (auth.passphrase) env.SSH_ASKPASS_REQUIRE = "never"
    return { env, directory }
  }

  const askpass = path.join(directory, "askpass.sh")
  await writeFile(
    askpass,
    '#!/bin/sh\ncase "$1" in *Username*) printf "%s" "$OPENCODE_GIT_USERNAME" ;; *) printf "%s" "$OPENCODE_GIT_PASSWORD" ;; esac\n',
  )
  await chmod(askpass, 0o700)
  env.GIT_ASKPASS = askpass
  env.OPENCODE_GIT_USERNAME =
    auth.type === "basic" ? auth.username : auth.type === "token" ? (auth.username ?? "git") : "oauth2"
  env.OPENCODE_GIT_PASSWORD =
    auth.type === "basic" ? auth.password : auth.type === "token" ? auth.token : auth.accessToken
  return { env, directory }
}

async function run(command: string, url: string, env: Record<string, string>, timeoutMs: number) {
  const proc = Bun.spawn(
    [
      command,
      "-c",
      "credential.helper=",
      "ls-remote",
      "--symref",
      "--exit-code",
      url,
      "HEAD",
    ],
    {
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutMs)
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
  ])
  clearTimeout(timer)
  if (timedOut) throw new Error("Repository verification timed out")
  if (stdout.byteLength > 64 * 1024 || Buffer.byteLength(stderr) > 64 * 1024) {
    throw new Error("Repository verification output exceeded limit")
  }
  if (exitCode === 0 || exitCode === 2) return
  throw new Error(stderr.slice(0, 4096))
}

function classify(cause: unknown) {
  const message = cause instanceof Error ? cause.message.toLowerCase() : ""
  if (
    message.includes("authentication") ||
    message.includes("permission denied") ||
    message.includes("could not read username")
  ) {
    return new VerificationError({ reason: "unauthorized", message: "Repository authentication failed" })
  }
  if (message.includes("not found") || message.includes("does not exist")) {
    return new VerificationError({ reason: "not_found", message: "Repository was not found" })
  }
  if (message.includes("host key verification failed")) {
    return new VerificationError({ reason: "host_key", message: "Repository host key verification failed" })
  }
  if (message.includes("signal") || message.includes("timed out")) {
    return new VerificationError({ reason: "timeout", message: "Repository verification timed out" })
  }
  return new VerificationError({ reason: "unreachable", message: "Repository could not be reached" })
}
