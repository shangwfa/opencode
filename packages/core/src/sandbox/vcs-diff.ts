export * as SandboxVcsDiff from "./vcs-diff.js"

/**
 * Builds the command that computes a Vcs.FileDiff[] inside a session sandbox.
 *
 * The V2 `/api/vcs/diff` route is location-scoped and runs git on the server's
 * own filesystem, which cannot see sandbox-mounted repositories. When a request
 * carries a sessionID, the handler runs this script through the session's
 * sandbox instead, with the session's directory as the git cwd — the same
 * contract the V1 exec-based diff had.
 *
 * Modes mirror the local git adapter:
 * - `working`: HEAD (when present) to the working copy, untracked included
 * - `branch`: merge-base(base) to the working copy, untracked included
 * - `committed`: merge-base(base) to HEAD, working copy untouched
 *
 * Output is a single JSON line of `{file, patch, status, additions, deletions}`
 * rows on stdout, or `{"error": string}` when no review base can be resolved.
 * Git stderr is discarded so the merged sandbox output stays parseable.
 */
export function vcsDiffCommand(input: {
  readonly mode: "working" | "branch" | "committed"
  readonly base?: string
  readonly context?: number
  readonly directory: string
}): string {
  return `node <<'NODE'
const child = require("child_process")
const mode = ${JSON.stringify(input.mode)}
const baseArg = ${JSON.stringify(input.base ?? null)}
const context = ${JSON.stringify(input.context ?? 3)}
const directory = ${JSON.stringify(input.directory)}
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
  return parts.flatMap((entry) => {
    if (!entry.startsWith("?? ")) return []
    const file = entry.slice(3)
    // git worktree / nested-repo directories appear as "dir/" — skip, they are not file diffs
    if (file.endsWith("/")) return []
    return [{ file, status: "added" }]
  })
}

function patchFor(item, ref, target) {
  if (item.status === "added" && !ref) {
    return output(["diff", "--no-ext-diff", "--no-index", "--unified=" + context, "/dev/null", item.file]) ?? ""
  }
  if (item.status === "added" && !target && !output(["ls-files", "--", item.file])?.trim()) {
    return output(["diff", "--no-ext-diff", "--no-index", "--unified=" + context, "/dev/null", item.file]) ?? ""
  }
  return output(["diff", "--no-ext-diff", "--unified=" + context, ...(ref ? [ref] : []), ...(target ? [target] : []), "--", item.file]) ?? ""
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
let target
if (mode === "working") {
  ref = hasHead() ? "HEAD" : undefined
} else if (hasHead()) {
  const base = baseArg ?? defaultRef()
  ref = base ? mergeBase(base) : undefined
  if (mode === "branch" && !ref) {
    console.log(JSON.stringify({ error: base ? "No merge base available for " + base : "No review base available" }))
    process.exit(0)
  }
  if (mode === "committed") target = "HEAD"
} else if (mode === "committed") {
  console.log("[]")
  process.exit(0)
}

const changed = ref ? parseNameStatus(output(["diff", "--no-ext-diff", "--no-renames", "--name-status", "-z", ref, ...(target ? [target] : []), "--"]) ?? "") : []
const items = target ? unique([...changed]) : unique([...changed, ...untracked()])
const diffs = items.map((item) => {
  const patch = patchFor(item, ref, target)
  return { file: item.file, patch, status: item.status, ...counts(patch) }
})

console.log(JSON.stringify(diffs))
NODE`
}
