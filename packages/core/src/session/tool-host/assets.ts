import fs from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { Effect, Schema } from "effect"
import type { SandboxProvider } from "../../sandbox/provider.js"

const Manifest = Schema.Struct({
  hash: Schema.String,
  files: Schema.Array(Schema.Struct({ name: Schema.String, hash: Schema.String, bytes: Schema.Int })),
})
const digest = (content: string) => createHash("sha256").update(content).digest("hex")
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
const failure = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)))

export const read = async () => {
  const directory = new URL("./artifacts/", import.meta.url)
  const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(
    await fs.readFile(new URL("manifest.json", directory), "utf8"),
  )
  if (digest(JSON.stringify(manifest.files)) !== manifest.hash)
    throw new Error("Session Tool artifact manifest hash mismatch")
  const files = await Promise.all(
    manifest.files.map(async (file) => {
      if (!/^session-tool-(host|worker|runtime)\.mjs$/.test(file.name))
        throw new Error("Invalid runtime artifact filename")
      const content = await fs.readFile(new URL(file.name, directory), "utf8")
      if (digest(content) !== file.hash || Buffer.byteLength(content) !== file.bytes)
        throw new Error(`Session Tool runtime artifact checksum mismatch: ${file.name}`)
      return { ...file, content }
    }),
  )
  if (files.length !== 3 || new Set(files.map((file) => file.name)).size !== 3)
    throw new Error("Session Tool runtime artifacts incomplete")
  return { hash: manifest.hash, files }
}

/** Runtime deployment follows session skills: materialize again after Sandbox replacement. */
export const materialize = Effect.fn("SessionToolHost.materialize")(function* (
  sandbox: SandboxProvider.Interface,
  sessionID: string,
) {
  const assets = yield* Effect.tryPromise({ try: read, catch: failure })
  const directory = `/workspace/.opencode/.session-tool-runtime/${assets.hash}`
  const marker = yield* sandbox.fileRead(sessionID, `${directory}/ready`).pipe(Effect.orElseSucceed(() => ""))
  if (marker === assets.hash) return directory
  const temporary = `${directory}.tmp-${randomUUID()}`
  yield* Effect.forEach(
    assets.files,
    (file) => sandbox.fileWrite(sessionID, `${temporary}/${file.name}`, file.content),
    { concurrency: 3, discard: true },
  )
  yield* sandbox.fileWrite(sessionID, `${temporary}/ready`, assets.hash)
  const command = `if [ -d ${quote(directory)} ]; then rm -rf ${quote(temporary)}; else mv ${quote(temporary)} ${quote(directory)}; fi`
  const result = yield* sandbox.run({
    sessionID,
    hostWorkdir: "/workspace",
    timeoutMs: 10_000,
    command: `flock -x ${quote(`${directory}.lock`)} -c ${quote(command)}`,
  })
  if (result.exitCode !== 0) return yield* Effect.fail(new Error("Session Tool runtime atomic publication failed"))
  return directory
})
