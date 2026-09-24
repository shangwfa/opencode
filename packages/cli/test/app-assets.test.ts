import { expect, mock, test } from "bun:test"
import { Effect, FileSystem } from "effect"
import { PlatformError, SystemError } from "effect/PlatformError"
import { stat as nodeStat, readdir } from "node:fs/promises"
import { load } from "../src/app-assets"

const root = new URL("../../app/dist/", import.meta.url).pathname

const notFound = (method: string, path: string) =>
  new PlatformError(new SystemError({ _tag: "NotFound", module: "FileSystem", method, pathOrDescriptor: path }))

const runWith = (impl: Partial<FileSystem.FileSystem>) =>
  Effect.provide(load(), FileSystem.layerNoop(impl)).pipe(Effect.runPromiseExit) as Promise<
    ExitLike<Readonly<Record<string, string | Uint8Array>>>
  >

type ExitLike<A> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly cause: { readonly failures: () => unknown[] } }

// The SaaS image and fresh checkouts run from source without a built web UI.
// A missing dist must degrade to an empty asset map instead of failing
// ServerProcess startup (which takes down every business request).
test("missing app dist degrades to empty assets with a warning", async () => {
  const warn = mock((_message: string) => {})
  const original = console.warn
  console.warn = warn as unknown as typeof console.warn
  try {
    const exit = await runWith({
      readDirectory: () => Effect.fail(notFound("readDirectory", root)),
    })
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value["index.html"]).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain(root.replace(/\/$/, ""))
  } finally {
    console.warn = original
  }
})

// Transport-level failures (permissions, I/O errors) stay loud: swallowing
// them could mask a broken deployment behind "empty" assets.
test("non-NotFound readDirectory errors still fail the load", async () => {
  const exit = await runWith({
    readDirectory: () =>
      Effect.fail(
        new PlatformError(
          new SystemError({ _tag: "PermissionDenied", module: "FileSystem", method: "readDirectory", pathOrDescriptor: root }),
        ),
      ),
  })
  expect(exit._tag).toBe("Failure")
})

const asInfo = (type: "Directory" | "File") => ({ type }) as unknown as FileSystem.File.Info

// With the repo-built dist present, source assets keep serving the UI.
const haveDist = await Bun.file(`${root}index.html`).exists()
;(haveDist ? test : test.skip)("built dist exposes index.html", async () => {
  const exit = await runWith({
    readDirectory: (path, options) =>
      Effect.tryPromise({
        try: async () => await readdir(path, options as { recursive?: boolean }),
        catch: (cause) =>
          new PlatformError(
            new SystemError({
              _tag: cause instanceof Error && "code" in cause && cause.code === "ENOENT" ? "NotFound" : "Unknown",
              module: "FileSystem",
              method: "readDirectory",
              pathOrDescriptor: path,
              cause,
            }),
          ),
      }),
    stat: (path) =>
      Effect.map(
        Effect.tryPromise({
          try: async () => await nodeStat(path),
          catch: (cause) =>
            new PlatformError(
              new SystemError({
                _tag: cause instanceof Error && "code" in cause && cause.code === "ENOENT" ? "NotFound" : "Unknown",
                module: "FileSystem",
                method: "stat",
                pathOrDescriptor: path,
                cause,
              }),
            ),
        }),
        (info) => asInfo(info.isDirectory() ? "Directory" : "File"),
      ),
  })
  expect(exit._tag).toBe("Success")
  if (exit._tag !== "Success") return
  const index = exit.value["index.html"]
  expect(typeof index).toBe("string")
  expect((index as string).length).toBeGreaterThan(0)
})
