import z from "zod"
import * as path from "path"
import { Effect } from "effect"
import { Tool } from "./tool"
import { Bus } from "../bus"
import { FileWatcher } from "../file/watcher"
import { Instance } from "../project/instance"
import { Patch } from "../patch"
import { createTwoFilesPatch, diffLines } from "diff"
import { assertExternalDirectoryEffect } from "./external-directory"
import { trimDiff } from "./edit"
import { LSP } from "../lsp"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import DESCRIPTION from "./apply_patch.txt"
import { File } from "../file"
import { Format } from "../format"
import { toSandboxPath } from "./sandbox-path"
import { SandboxProvider } from "./sandbox-provider"

const PatchParams = z.object({
  patchText: z.string().describe("The full patch text that describes all changes to be made"),
})

export const ApplyPatchTool = Tool.define(
  "apply_patch",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* AppFileSystem.Service
    const format = yield* Format.Service
    const bus = yield* Bus.Service
    const sandboxProvider = yield* SandboxProvider.Service

    const run = Effect.fn("ApplyPatchTool.execute")(function* (params: z.infer<typeof PatchParams>, ctx: Tool.Context) {
      if (!params.patchText) {
        return yield* Effect.fail(new Error("patchText is required"))
      }

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

      const fileChanges: Array<{
        filePath: string
        oldContent: string
        newContent: string
        type: "add" | "update" | "delete" | "move"
        movePath?: string
        diff: string
        additions: number
        deletions: number
      }> = []

      let totalDiff = ""

      // ── Sandbox mode ──
      if (ctx.sandbox !== null) {
        const sb = yield* Effect.tryPromise({ try: () => ctx.sandbox!, catch: (e) => new Error(String(e)) }).pipe(Effect.orDie)

        for (const hunk of hunks) {
          const filePath = path.resolve(Instance.directory, hunk.path)
          yield* assertExternalDirectoryEffect(ctx, filePath)
          const sandboxPath = toSandboxPath(filePath, Instance.directory)

          switch (hunk.type) {
            case "add": {
              const oldContent = ""
              const newContent =
                hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
              const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

              let additions = 0
              let deletions = 0
              for (const change of diffLines(oldContent, newContent)) {
                if (change.added) additions += change.count || 0
                if (change.removed) deletions += change.count || 0
              }

              fileChanges.push({ filePath, oldContent, newContent, type: "add", diff, additions, deletions })
              totalDiff += diff + "\n"
              break
            }

            case "update": {
              const oldContent = yield* Effect.tryPromise({
                try: () => sb.files.readFile(sandboxPath) as Promise<string>,
                catch: () => new Error(`apply_patch verification failed: Failed to read file to update: ${filePath}`),
              }).pipe(Effect.orDie)

              let newContent = oldContent
              try {
                const fileUpdate = Patch.deriveNewContentsFromChunks(filePath, hunk.chunks)
                newContent = fileUpdate.content
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

              const movePath = hunk.move_path ? path.resolve(Instance.directory, hunk.move_path) : undefined
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
              })
              totalDiff += diff + "\n"
              break
            }

            case "delete": {
              const contentToDelete = yield* Effect.tryPromise({
                try: () => sb.files.readFile(sandboxPath) as Promise<string>,
                catch: (error) => new Error(`apply_patch verification failed: ${error}`),
              }).pipe(Effect.orDie)
              const deleteDiff = trimDiff(createTwoFilesPatch(filePath, filePath, contentToDelete, ""))
              const deletions = contentToDelete.split("\n").length

              fileChanges.push({ filePath, oldContent: contentToDelete, newContent: "", type: "delete", diff: deleteDiff, additions: 0, deletions })
              totalDiff += deleteDiff + "\n"
              break
            }
          }
        }

        const files = fileChanges.map((change) => ({
          filePath: change.filePath,
          relativePath: path.relative(Instance.worktree, change.movePath ?? change.filePath).replaceAll("\\", "/"),
          type: change.type,
          patch: change.diff,
          additions: change.additions,
          deletions: change.deletions,
          movePath: change.movePath,
        }))

        const relativePaths = fileChanges.map((c) => path.relative(Instance.worktree, c.filePath).replaceAll("\\", "/"))
        yield* ctx.ask({
          permission: "edit",
          patterns: relativePaths,
          always: ["*"],
          metadata: { filepath: relativePaths.join(", "), diff: totalDiff, files },
        })

        const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []
        for (const change of fileChanges) {
          const sandboxPath = toSandboxPath(change.filePath, Instance.directory)
          switch (change.type) {
            case "add":
              yield* Effect.tryPromise({
                try: () => sb.files.writeFiles([{ path: sandboxPath, data: change.newContent }]),
                catch: (e) => new Error(`Sandbox write failed: ${String(e)}`),
              }).pipe(Effect.orDie)
              updates.push({ file: change.filePath, event: "add" })
              break
            case "update":
              yield* Effect.tryPromise({
                try: () => sb.files.writeFiles([{ path: sandboxPath, data: change.newContent }]),
                catch: (e) => new Error(`Sandbox write failed: ${String(e)}`),
              }).pipe(Effect.orDie)
              updates.push({ file: change.filePath, event: "change" })
              break
            case "move":
              if (change.movePath) {
                const sandboxMovePath = toSandboxPath(change.movePath, Instance.directory)
                yield* Effect.tryPromise({
                  try: () => sb.files.writeFiles([{ path: sandboxMovePath, data: change.newContent }]),
                  catch: (e) => new Error(`Sandbox write failed: ${String(e)}`),
                }).pipe(Effect.orDie)
                yield* sandboxProvider.runInSession(ctx.sessionID, `rm -f "${sandboxPath}"`, { timeoutSeconds: 10 }).pipe(Effect.catchCause(() => Effect.void))
                updates.push({ file: change.filePath, event: "unlink" })
                updates.push({ file: change.movePath, event: "add" })
              }
              break
            case "delete":
              yield* sandboxProvider.runInSession(ctx.sessionID, `rm -f "${sandboxPath}"`, { timeoutSeconds: 10 }).pipe(Effect.catchCause(() => Effect.void))
              updates.push({ file: change.filePath, event: "unlink" })
              break
          }
        }

        for (const update of updates) {
          yield* bus.publish(FileWatcher.Event.Updated, update)
        }

        const summaryLines = fileChanges.map((change) => {
          if (change.type === "add") return `A ${path.relative(Instance.worktree, change.filePath).replaceAll("\\", "/")}`
          if (change.type === "delete") return `D ${path.relative(Instance.worktree, change.filePath).replaceAll("\\", "/")}`
          return `M ${path.relative(Instance.worktree, change.movePath ?? change.filePath).replaceAll("\\", "/")}`
        })
        let output = `Success. Updated the following files:\n${summaryLines.join("\n")}`

        return {
          title: output,
          metadata: { diff: totalDiff, files, diagnostics: {} },
          output,
        }
      }

      // ── Local mode ──
      for (const hunk of hunks) {
        const filePath = path.resolve(Instance.directory, hunk.path)
        yield* assertExternalDirectoryEffect(ctx, filePath)

        switch (hunk.type) {
          case "add": {
            const oldContent = ""
            const newContent =
              hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, newContent)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            fileChanges.push({ filePath, oldContent, newContent, type: "add", diff, additions, deletions })
            totalDiff += diff + "\n"
            break
          }

          case "update": {
            const stats = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!stats || stats.type === "Directory") {
              return yield* Effect.fail(
                new Error(`apply_patch verification failed: Failed to read file to update: ${filePath}`),
              )
            }

            const oldContent = yield* afs.readFileString(filePath)
            let newContent = oldContent

            try {
              const fileUpdate = Patch.deriveNewContentsFromChunks(filePath, hunk.chunks)
              newContent = fileUpdate.content
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

            const movePath = hunk.move_path ? path.resolve(Instance.directory, hunk.move_path) : undefined
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
            })
            totalDiff += diff + "\n"
            break
          }

          case "delete": {
            const contentToDelete = yield* afs
              .readFileString(filePath)
              .pipe(Effect.catch((error) => Effect.fail(new Error(`apply_patch verification failed: ${error}`))))
            const deleteDiff = trimDiff(createTwoFilesPatch(filePath, filePath, contentToDelete, ""))
            const deletions = contentToDelete.split("\n").length

            fileChanges.push({ filePath, oldContent: contentToDelete, newContent: "", type: "delete", diff: deleteDiff, additions: 0, deletions })
            totalDiff += deleteDiff + "\n"
            break
          }
        }
      }

      const files = fileChanges.map((change) => ({
        filePath: change.filePath,
        relativePath: path.relative(Instance.worktree, change.movePath ?? change.filePath).replaceAll("\\", "/"),
        type: change.type,
        patch: change.diff,
        additions: change.additions,
        deletions: change.deletions,
        movePath: change.movePath,
      }))

      const relativePaths = fileChanges.map((c) => path.relative(Instance.worktree, c.filePath).replaceAll("\\", "/"))
      yield* ctx.ask({
        permission: "edit",
        patterns: relativePaths,
        always: ["*"],
        metadata: { filepath: relativePaths.join(", "), diff: totalDiff, files },
      })

      const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []
      for (const change of fileChanges) {
        const edited = change.type === "delete" ? undefined : (change.movePath ?? change.filePath)
        switch (change.type) {
          case "add":
            yield* afs.writeWithDirs(change.filePath, change.newContent)
            updates.push({ file: change.filePath, event: "add" })
            break
          case "update":
            yield* afs.writeWithDirs(change.filePath, change.newContent)
            updates.push({ file: change.filePath, event: "change" })
            break
          case "move":
            if (change.movePath) {
              yield* afs.writeWithDirs(change.movePath!, change.newContent)
              yield* afs.remove(change.filePath)
              updates.push({ file: change.filePath, event: "unlink" })
              updates.push({ file: change.movePath, event: "add" })
            }
            break
          case "delete":
            yield* afs.remove(change.filePath)
            updates.push({ file: change.filePath, event: "unlink" })
            break
        }

        if (edited) {
          yield* format.file(edited)
          yield* bus.publish(File.Event.Edited, { file: edited })
        }
      }

      for (const update of updates) {
        yield* bus.publish(FileWatcher.Event.Updated, update)
      }

      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        yield* lsp.touchFile(target, true)
      }
      const diagnostics = yield* lsp.diagnostics()

      const summaryLines = fileChanges.map((change) => {
        if (change.type === "add") return `A ${path.relative(Instance.worktree, change.filePath).replaceAll("\\", "/")}`
        if (change.type === "delete") return `D ${path.relative(Instance.worktree, change.filePath).replaceAll("\\", "/")}`
        return `M ${path.relative(Instance.worktree, change.movePath ?? change.filePath).replaceAll("\\", "/")}`
      })
      let output = `Success. Updated the following files:\n${summaryLines.join("\n")}`

      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        const block = LSP.Diagnostic.report(target, diagnostics[AppFileSystem.normalizePath(target)] ?? [])
        if (!block) continue
        const rel = path.relative(Instance.worktree, target).replaceAll("\\", "/")
        output += `\n\nLSP errors detected in ${rel}, please fix:\n${block}`
      }

      return {
        title: output,
        metadata: { diff: totalDiff, files, diagnostics },
        output,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: PatchParams,
      execute: (params: z.infer<typeof PatchParams>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
