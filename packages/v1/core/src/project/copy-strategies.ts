import { Effect } from "effect"
import path from "path"
import { AbsolutePath } from "../schema"
import { FSUtil } from "../fs-util"
import { Git } from "../git"
import { DirectoryUnavailableError, StrategyID, type Copy, type Strategy } from "./copy"

export function makeStrategies(input: {
  git: Git.Interface
  fs: FSUtil.Interface
  canonical: (directory: AbsolutePath) => Effect.Effect<AbsolutePath, DirectoryUnavailableError>
}): Map<StrategyID, Strategy> {
  const gitWorktree: Strategy = {
    id: StrategyID.make("git_worktree"),
    create: Effect.fn("ProjectCopy.GitWorktree.create")(function* (options) {
      const repository = yield* input.git.repo.discover(options.sourceDirectory)
      if (!repository) return yield* new DirectoryUnavailableError({ directory: options.sourceDirectory })
      yield* input.git.worktree.create({ repository, directory: options.directory })
      return { directory: yield* input.canonical(options.directory) }
    }),
    remove: Effect.fn("ProjectCopy.GitWorktree.remove")(function* (options) {
      const found = yield* input.git.repo.discover(options.directory)
      if (!found) return yield* new DirectoryUnavailableError({ directory: options.directory })
      yield* input.git.worktree.remove({ repository: found, directory: options.directory, force: options.force })
    }),
    list: Effect.fn("ProjectCopy.GitWorktree.list")(function* (directory) {
      const found = yield* input.git.repo.discover(directory)
      if (!found) return yield* new DirectoryUnavailableError({ directory })
      const entries = yield* input.git.worktree.list(found)
      return yield* Effect.forEach(entries, (entry) =>
        input.canonical(entry.directory).pipe(
          Effect.map((dir) => ({ directory: dir })),
          Effect.catchTag("ProjectCopy.DirectoryUnavailableError", () => Effect.succeed(undefined)),
        ),
      ).pipe(Effect.map((items) => items.filter((item): item is Copy => item !== undefined)))
    }),
    detect: Effect.fn("ProjectCopy.GitWorktree.detect")(function* (inputDirectory) {
      return yield* input.fs.isFile(path.join(inputDirectory, ".git"))
    }),
  }
  return new Map<StrategyID, Strategy>([[gitWorktree.id, gitWorktree]])
}
