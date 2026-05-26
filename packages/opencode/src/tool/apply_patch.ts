import * as path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Bus } from "../bus"
import { FileWatcher } from "../file/watcher"
import { InstanceState } from "@/effect/instance-state"
import { Patch } from "../patch"
import { createTwoFilesPatch, diffLines } from "diff"
import { assertExternalDirectoryEffect } from "./external-directory"
import { trimDiff } from "./edit"
import { LSP } from "@/lsp/lsp"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import DESCRIPTION from "./apply_patch.txt"
import { File } from "../file"
import { Format } from "../format"
import * as Bom from "@/util/bom"
import { toSandboxPath } from "./sandbox-path"
import { SandboxProvider } from "./sandbox-provider"

export const Parameters = Schema.Struct({
  patchText: Schema.String.annotate({ description: "The full patch text that describes all changes to be made" }),
})

export const ApplyPatchTool = Tool.define(
  "apply_patch",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* AppFileSystem.Service
    const format = yield* Format.Service
    const bus = yield* Bus.Service
    const readFile = (filePath: string, ctx: Tool.Context, instance: { directory: string }) =>
      ctx.sandbox !== null
        ? Effect.gen(function* () {
            const sb: any = yield* Effect.tryPromise({ try: () => ctx.sandbox!, catch: (e) => new Error(String(e)) })
            return yield* Effect.tryPromise({
              try: () => sb.files.readFile(toSandboxPath(filePath, instance.directory)) as Promise<string>,
              catch: () => new Error(`File not found: ${filePath}`),
            })
          })
        : Bom.readFile(afs, filePath).pipe(Effect.map((s) => Bom.join(s.text, s.bom)))

    const writeFile = (filePath: string, content: string, ctx: Tool.Context, instance: { directory: string }) =>
      ctx.sandbox !== null
        ? Effect.gen(function* () {
            const sb: any = yield* Effect.tryPromise({ try: () => ctx.sandbox!, catch: (e) => new Error(String(e)) })
            yield* Effect.tryPromise({
              try: () => sb.files.writeFiles([{ path: toSandboxPath(filePath, instance.directory), data: content }]),
              catch: () => new Error(`Failed to write file: ${filePath}`),
            })
          })
        : afs.writeWithDirs(filePath, content)

    const removeFile = (filePath: string, ctx: Tool.Context, instance: { directory: string }) =>
      ctx.sandbox !== null
        ? Effect.gen(function* () {
            const svc = yield* Effect.serviceOption(SandboxProvider.Service)
            if (svc._tag === "Some") {
              yield* svc.value.runInSession(ctx.sessionID, `rm -f "${toSandboxPath(filePath, instance.directory)}"`, { timeoutSeconds: 10 }).pipe(Effect.catchCause(() => Effect.void))
            }
          })
        : afs.remove(filePath)

    const statFile = (filePath: string, ctx: Tool.Context, instance: { directory: string }) =>
      ctx.sandbox !== null
        ? (Effect.gen(function* () {
            const sb: any = yield* Effect.tryPromise({ try: () => ctx.sandbox!, catch: (e) => new Error(String(e)) })
            const content = yield* Effect.tryPromise({
              try: () => sb.files.readFile(toSandboxPath(filePath, instance.directory)) as Promise<string>,
              catch: () => undefined as string | undefined,
            })
            return content !== undefined ? ({ type: "File" } as const) : undefined
          }) as Effect.Effect<{ type: "File" } | undefined>)
        : (afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined))) as Effect.Effect<
            { type: "File" } | { type: "Directory" } | undefined
          >)

    const run = Effect.fn("ApplyPatchTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (!params.patchText) {
        return yield* Effect.fail(new Error("patchText is required"))
      }

      // Parse the patch to get hunks
      let hunks: Patch.Hunk[]
      try {
        const parseResult = Patch.parsePatch(params.patchText)
        hunks = parseResult.hunks
      } catch (error) {
        return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
      }

      if (hunks.length === 0) {
        const normalized = params.patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
        if (normalized === "*** Begin Patch\n*** End Patch") {
          return yield* Effect.fail(new Error("patch rejected: empty patch"))
        }
        return yield* Effect.fail(new Error("apply_patch verification failed: no hunks found"))
      }

      const instance = yield* InstanceState.context

      // Validate file paths and check permissions
      const fileChanges: Array<{
        filePath: string
        oldContent: string
        newContent: string
        type: "add" | "update" | "delete" | "move"
        movePath?: string
        diff: string
        additions: number
        deletions: number
        bom: boolean
      }> = []

      let totalDiff = ""

      for (const hunk of hunks) {
        const filePath = path.resolve(instance.directory, hunk.path)
        yield* assertExternalDirectoryEffect(ctx, filePath)

        switch (hunk.type) {
          case "add": {
            const oldContent = ""
            const newContent =
              hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
            const next = Bom.split(newContent)
            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, next.text))

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, next.text)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            fileChanges.push({
              filePath,
              oldContent,
              newContent: next.text,
              type: "add",
              diff,
              additions,
              deletions,
              bom: next.bom,
            })

            totalDiff += diff + "\n"
            break
          }

          case "update": {
            // Check if file exists for update
            const stats = yield* statFile(filePath, ctx, instance)
            if (!stats || stats.type === "Directory") {
              return yield* Effect.fail(
                new Error(`apply_patch verification failed: Failed to read file to update: ${filePath}`),
              )
            }

            let oldContent: string
            let bom: boolean
            if (ctx.sandbox !== null) {
              oldContent = yield* readFile(filePath, ctx, instance)
              bom = false
            } else {
              const source = yield* Bom.readFile(afs, filePath)
              oldContent = source.text
              bom = source.bom
            }
            let newContent = oldContent

            // Apply the update chunks to get new content
            try {
              const rawContent = ctx.sandbox !== null ? oldContent : Bom.join(oldContent, bom)
              const fileUpdate = Patch.deriveNewContentsFromChunks(filePath, hunk.chunks, rawContent)
              newContent = fileUpdate.content
              bom = ctx.sandbox !== null ? false : fileUpdate.bom
            } catch (error) {
              return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
            }

            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, newContent)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            const movePath = hunk.move_path ? path.resolve(instance.directory, hunk.move_path) : undefined
            yield* assertExternalDirectoryEffect(ctx, movePath)

            fileChanges.push({
              filePath,
              oldContent,
              newContent,
              type: hunk.move_path ? "move" : "update",
              movePath,
              diff,
              additions,
              deletions,
              bom,
            })

            totalDiff += diff + "\n"
            break
          }

          case "delete": {
            let contentToDelete: string
            let deleteBom: boolean
            if (ctx.sandbox !== null) {
              contentToDelete = yield* (readFile(filePath, ctx, instance) as Effect.Effect<string, Error>).pipe(
                Effect.catch((error: any) =>
                  Effect.fail(
                    new Error(
                      `apply_patch verification failed: ${error instanceof Error ? error.message : String(error)}`,
                    ),
                  ),
                ),
              )
              deleteBom = false
            } else {
              const source = yield* Bom.readFile(afs, filePath).pipe(
                Effect.catch((error) =>
                  Effect.fail(
                    new Error(
                      `apply_patch verification failed: ${error instanceof Error ? error.message : String(error)}`,
                    ),
                  ),
                ),
              )
              contentToDelete = source.text
              deleteBom = source.bom
            }
            const deleteDiff = trimDiff(createTwoFilesPatch(filePath, filePath, contentToDelete, ""))

            const deletions = contentToDelete.split("\n").length

            fileChanges.push({
              filePath,
              oldContent: contentToDelete,
              newContent: "",
              type: "delete",
              diff: deleteDiff,
              additions: 0,
              deletions,
              bom: deleteBom,
            })

            totalDiff += deleteDiff + "\n"
            break
          }
        }
      }

      // Build per-file metadata for UI rendering (used for both permission and result)
      const files = fileChanges.map((change) => ({
        filePath: change.filePath,
        relativePath: path.relative(instance.worktree, change.movePath ?? change.filePath).replaceAll("\\", "/"),
        type: change.type,
        patch: change.diff,
        additions: change.additions,
        deletions: change.deletions,
        movePath: change.movePath,
      }))

      // Check permissions if needed
      const relativePaths = fileChanges.map((c) => path.relative(instance.worktree, c.filePath).replaceAll("\\", "/"))
      yield* ctx.ask({
        permission: "edit",
        patterns: relativePaths,
        always: ["*"],
        metadata: {
          filepath: relativePaths.join(", "),
          diff: totalDiff,
          files,
        },
      })

      // Apply the changes
      const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []

      for (const change of fileChanges) {
        const edited = change.type === "delete" ? undefined : (change.movePath ?? change.filePath)
        const content = ctx.sandbox !== null ? change.newContent : Bom.join(change.newContent, change.bom)
        switch (change.type) {
          case "add":
            yield* writeFile(change.filePath, content, ctx, instance)
            updates.push({ file: change.filePath, event: "add" })
            break

          case "update":
            yield* writeFile(change.filePath, content, ctx, instance)
            updates.push({ file: change.filePath, event: "change" })
            break

          case "move":
            if (change.movePath) {
              yield* writeFile(change.movePath!, content, ctx, instance)
              yield* removeFile(change.filePath, ctx, instance)
              updates.push({ file: change.filePath, event: "unlink" })
              updates.push({ file: change.movePath, event: "add" })
            }
            break

          case "delete":
            yield* removeFile(change.filePath, ctx, instance)
            updates.push({ file: change.filePath, event: "unlink" })
            break
        }

        if (edited) {
          if (ctx.sandbox === null && (yield* format.file(edited))) {
            yield* Bom.syncFile(afs, edited, change.bom)
          }
          yield* bus.publish(File.Event.Edited, { file: edited })
        }
      }

      // Publish file change events
      for (const update of updates) {
        yield* bus.publish(FileWatcher.Event.Updated, update)
      }

      // Notify LSP of file changes and collect diagnostics
      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        yield* lsp.touchFile(target, "document")
      }
      const diagnostics = yield* lsp.diagnostics()

      // Generate output summary
      const summaryLines = fileChanges.map((change) => {
        if (change.type === "add") {
          return `A ${path.relative(instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        if (change.type === "delete") {
          return `D ${path.relative(instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        const target = change.movePath ?? change.filePath
        return `M ${path.relative(instance.worktree, target).replaceAll("\\", "/")}`
      })
      let output = `Success. Updated the following files:\n${summaryLines.join("\n")}`

      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        const block = LSP.Diagnostic.report(target, diagnostics[AppFileSystem.normalizePath(target)] ?? [])
        if (!block) continue
        const rel = path.relative(instance.worktree, target).replaceAll("\\", "/")
        output += `\n\nLSP errors detected in ${rel}, please fix:\n${block}`
      }

      return {
        title: output,
        metadata: {
          diff: totalDiff,
          files,
          diagnostics,
        },
        output,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
