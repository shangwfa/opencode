/**
 * Sandbox-side codegraph extraction script (kernel-only, no wasm fallback).
 *
 * Runs INSIDE the sandbox via `bun main.ts index ...` (exec API). Reads source
 * files under --root, extracts via the codegraph Rust kernel, and writes an
 * ndjson snapshot (gzip) that the server streams back and persists to PG —
 * the sandbox never touches PG itself.
 *
 * Output records (one JSON object per line, snake_case to match the store's
 * insert types):
 *   {t:"file", path, content_hash, language, size, node_count, indexed_at, mtime_ms}
 *   {t:"node", id, kind, name, qualified_name, file_path, language, start_line, ...}
 *   {t:"edge", source, target, kind, metadata?, line?, col?, provenance?}
 *   {t:"ref",  from_node_id, reference_name, reference_kind, line, col, file_path, language}
 *
 * Usage:
 *   bun main.ts index --root /workspace --out /tmp/cg.ndjson.gz \
 *                     --progress /tmp/cg-progress.json [--files /tmp/cg-files.json]
 *   bun main.ts stat  --root /workspace --out /tmp/cg-stats.ndjson
 *
 *   index: full extraction (or --files: re-extract only those paths).
 *   stat:  fast filesystem sweep emitting one line per source file:
 *          {"t":"stat", "path":..., "size":..., "mtime_ms":...} — used by the
 *          server to diff against the codegraph_file ledger without reading
 *          file contents (git status is never trusted: it is blind to
 *          committed changes after pull/checkout).
 */

import * as fs from "fs"
import * as path from "path"

// The per-platform bundle carries the Rust kernel (lib/kernel/*.node) and the
// compiled extraction API. Resolved by platform so the same script runs on a
// dev mac (darwin-arm64) and in the sandbox (linux-x64).
const PLATFORM_PKG = `@colbymchenry/codegraph-${process.platform}-${process.arch}`

type Upstream = {
  initGrammars: () => Promise<void>
  extractFromSource: (filePath: string, source: string, language?: string, frameworkNames?: string[]) => any
  detectFrameworks?: (context: unknown) => Array<{ name?: string }>
  scanDirectory: (root: string) => string[]
  hashContent: (content: string) => string
  isSourceFile: (p: string) => boolean
  getKernel?: () => Promise<unknown>
}

const loadExtraction = (): Upstream => {
  const pkgPath = require.resolve(`${PLATFORM_PKG}/package.json`)
  const entry = path.join(path.dirname(pkgPath), "lib", "dist", "extraction", "index.js")
  const ex = require(entry) as Upstream
  // Framework detection lives in resolution/frameworks (extraction doesn't
  // re-export it). Attach it so the extractor can run framework extractors.
  if (!ex.detectFrameworks) {
    try {
      const fw = require(path.join(path.dirname(pkgPath), "lib", "dist", "resolution", "frameworks", "index.js")) as {
        detectFrameworks?: (context: unknown) => Array<{ name?: string }>
      }
      if (fw.detectFrameworks) ex.detectFrameworks = fw.detectFrameworks
    } catch {
      /* framework detection unavailable — extraction still works */
    }
  }
  return ex
}

const MAX_FILE_SIZE = 1024 * 1024

const parseArgs = (argv: string[]) => {
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1] ?? ""
    i++
  }
  return args
}

const main = async () => {
  const mode = process.argv[2]
  const args = parseArgs(process.argv.slice(3))
  const root = args.root ?? "/workspace"

  if (mode === "stat") {
    const outPath = args.out ?? "/tmp/cg-stats.ndjson"
    const ex = loadExtraction()
    const files = ex.scanDirectory(root)
    const out = fs.createWriteStream(outPath)
    for (const rel of files) {
      try {
        const st = fs.statSync(path.join(root, rel))
        if (st.size > MAX_FILE_SIZE) continue
        out.write(JSON.stringify({ t: "stat", path: rel, size: st.size, mtime_ms: Math.round(st.mtimeMs) }) + "\n")
      } catch {
        /* raced deletion — skip */
      }
    }
    await new Promise<void>((resolve) => out.end(() => resolve()))
    console.log(`codegraph stat: ${files.length} files → ${outPath}`)
    return
  }

  if (mode !== "index") {
    console.error(`unknown mode: ${mode}`)
    process.exit(2)
  }
  const outPath = args.out ?? "/tmp/cg.ndjson.gz"
  const progressPath = args.progress ?? "/tmp/cg-progress.json"

  const ex = loadExtraction()

  const writeProgress = (p: object) => fs.writeFileSync(progressPath, JSON.stringify(p))
  writeProgress({ files_total: 0, files_done: 0, done: false })

  // Kernel-only policy: a missing/unloadable kernel is a hard error, never a
  // silent wasm downgrade (product decision for the SaaS extractor).
  if (ex.getKernel) {
    const kernel = await ex.getKernel()
    if (!kernel) {
      console.error("codegraph kernel failed to load — refusing to run without it")
      process.exit(3)
    }
  }

  await ex.initGrammars()

  const files: string[] = args.files
    ? (JSON.parse(fs.readFileSync(args.files, "utf-8")) as string[]).filter((f) => ex.isSourceFile(f))
    : ex.scanDirectory(root)

  // Detect frameworks (Express/Rails/NestJS/React/…) so framework extractors
  // (route nodes, component refs, middleware) run after the tree-sitter pass.
  // detect() only consults the file system, which the sandbox has.
  let frameworkNames: string[] = []
  if (ex.detectFrameworks) {
    const fwContext = {
      getNodesInFile: () => [],
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
      getAllFiles: () => files,
      getProjectRoot: () => root,
      fileExists: (p: string) => { try { return fs.existsSync(path.join(root, p)) } catch { return false } },
      readFile: (p: string) => { try { return fs.readFileSync(path.join(root, p), "utf-8") } catch { return null } },
      listDirectories: (p: string) => {
        try {
          const dir = p === "." || p === "" ? root : path.join(root, p)
          return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
        } catch { return [] }
      },
    }
    try {
      frameworkNames = ex.detectFrameworks(fwContext).map((r: { name?: string }) => r.name ?? "")
      if (frameworkNames.length > 0) console.log(`detected frameworks: ${frameworkNames.join(", ")}`)
    } catch (err) {
      console.error(`framework detection failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Grammar set must cover every language we will parse; load lazily per file
  // is kernel-fast (no wasm), but unsupported files are skipped up front.
  writeProgress({ files_total: files.length, files_done: 0, done: false })

  const outFile = fs.createWriteStream(outPath)
  const { createGzip } = require("zlib") as typeof import("zlib")
  const gz = createGzip({ level: 6 })
  gz.pipe(outFile)
  const write = (rec: object) => gz.write(JSON.stringify(rec) + "\n")

  let done = 0
  let lastProgressAt = 0
  for (const rel of files) {
    const abs = path.join(root, rel)
    try {
      const stat = fs.statSync(abs)
      if (stat.size > MAX_FILE_SIZE) {
        done++
        continue
      }
      const content = fs.readFileSync(abs, "utf-8")
      const result = ex.extractFromSource(rel, content, undefined, frameworkNames)
      const nodes = result.nodes ?? []
      write({
        t: "file",
        path: rel,
        content_hash: ex.hashContent(content),
        language: nodes[0]?.language ?? "unknown",
        size: stat.size,
        node_count: nodes.length,
        indexed_at: Date.now(),
        mtime_ms: Math.round(stat.mtimeMs),
      })
      for (const n of nodes)
        write({
          t: "node",
          id: n.id,
          kind: n.kind,
          name: n.name,
          qualified_name: n.qualifiedName,
          file_path: n.filePath,
          language: n.language,
          start_line: n.startLine,
          end_line: n.endLine,
          start_col: n.startColumn,
          end_col: n.endColumn,
          docstring: n.docstring ?? null,
          signature: n.signature ?? null,
          visibility: n.visibility ?? null,
          is_exported: n.isExported ? 1 : 0,
          is_async: n.isAsync ? 1 : 0,
          is_static: n.isStatic ? 1 : 0,
          is_abstract: n.isAbstract ? 1 : 0,
          decorators: n.decorators ?? null,
          type_parameters: n.typeParameters ?? null,
          return_type: n.returnType ?? null,
          time_updated: Date.now(),
        })
      for (const e of result.edges ?? [])
        write({
          t: "edge",
          source: e.source,
          target: e.target,
          kind: e.kind,
          metadata: e.metadata ?? null,
          line: e.line ?? null,
          col: e.column ?? null,
          provenance: e.provenance ?? null,
        })
      for (const r of result.unresolvedReferences ?? [])
        write({
          t: "ref",
          from_node_id: r.fromNodeId,
          reference_name: r.referenceName,
          reference_kind: r.referenceKind,
          line: r.line,
          col: r.column,
          file_path: r.filePath ?? rel,
          language: r.language ?? nodes[0]?.language ?? "unknown",
        })
    } catch (err) {
      // Per-file failure must not abort the snapshot; the server reconciles by
      // file ledger (a file without a "file" record stays at its old state).
      console.error(`extract failed: ${rel}: ${err instanceof Error ? err.message : String(err)}`)
    }
    done++
    if (Date.now() - lastProgressAt > 1000) {
      lastProgressAt = Date.now()
      writeProgress({ files_total: files.length, files_done: done, done: false })
    }
  }

  await new Promise<void>((resolve, reject) => {
    gz.end(() => {
      outFile.end(() => resolve())
    })
    outFile.on("error", reject)
  })
  writeProgress({ files_total: files.length, files_done: done, done: true })
  console.log(`codegraph extractor: ${done} files → ${outPath}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(1)
})
