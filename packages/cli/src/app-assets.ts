import { Effect, FileSystem, Option } from "effect"
import { readFileSync } from "node:fs"
import path from "node:path"
import { brotliDecompressSync } from "node:zlib"
import { OPENCODE_LOCAL } from "./version"

export type AssetMap = Readonly<Record<string, string | Uint8Array>>
type EncodedAssetMap = Readonly<Record<string, string>>

export const load = Effect.fn("cli.app-assets.load")(function* () {
  const embedded = yield* Effect.tryPromise(() => import("virtual:opencode-app-assets")).pipe(Effect.option)
  if (Option.isSome(embedded) && (Object.keys(embedded.value.default).length > 0 || !OPENCODE_LOCAL))
    return lazy(embedded.value.default, (key) =>
      brotliDecompressSync(Buffer.from(embedded.value.default[key]!, "base64")),
    )
  if (!OPENCODE_LOCAL) return yield* Effect.fail(new Error("Web UI assets are missing from the CLI build"))
  return yield* sourceAssets()
})

// A missing dist only disables the web UI (fresh checkouts, slim images); the
// API surface must stay up, so degrade to an empty asset map instead of
// failing ServerProcess startup.
const isNotFound = (error: unknown) =>
  error instanceof Error && "reason" in error && (error as { reason: { _tag?: string } }).reason?._tag === "NotFound"

const sourceAssets = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = path.resolve(import.meta.dirname, "../../app/dist")
  const files = yield* fs.readDirectory(root, { recursive: true }).pipe(
    Effect.catchIf(isNotFound, () =>
      Effect.sync(() => {
        console.warn(`web UI assets not found at ${root}; serving API without a UI`)
        return <readonly string[]>[]
      }),
    ),
  )
  const assets = Object.fromEntries(
    (yield* Effect.forEach(
      files.filter((file) => !file.endsWith(".map")),
      Effect.fnUntraced(function* (file) {
        const target = path.join(root, file)
        if ((yield* fs.stat(target)).type === "Directory") return
        return [file, target] as const
      }),
      { concurrency: "unbounded" },
    )).filter((asset) => asset !== undefined),
  )
  return lazy(assets, (key) => readFileSync(assets[key]!))
})

function lazy(assets: EncodedAssetMap, load: (key: string) => Uint8Array): AssetMap {
  // Immutable browser caching makes retaining decompressed copies in the server unnecessary.
  return new Proxy(
    {},
    {
      get: (_, key) => {
        if (typeof key !== "string" || assets[key] === undefined) return
        const body = load(key)
        return isText(key) ? Buffer.from(body).toString() : body
      },
    },
  )
}

function isText(file: string) {
  return file === "_headers" || /\.(?:css|html|js|json|svg|txt|webmanifest|xml)$/.test(file)
}
