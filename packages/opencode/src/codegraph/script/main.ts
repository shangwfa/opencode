/**
 * Sandbox-side codegraph extraction script.
 *
 * Production path (server indexer):
 *   node main.ts full --root /workspace --out /tmp/cg.ndjson.gz --progress ...
 *   node main.ts full ... --incremental   # codegraph sync() + neighborhood export
 *   bun  main.ts stat --root /workspace --out /tmp/cg-stats.ndjson
 *
 * Legacy (unused by indexer — kernel-only extract without resolveReferences):
 *   bun main.ts index --root /workspace --out ... [--files ...]
 *
 * The sandbox never touches PG; the server streams ndjson back and persists.
 */

import * as fs from "fs"
import * as path from "path"
import { createRequire } from "module"

// full mode runs under `node` (node:sqlite) which executes this .ts as ESM —
// provide require for the codegraph SDK and built-ins. bun tolerates it too.
const require = createRequire(import.meta.url)

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

const FLAG_KEYS = new Set(["incremental", "done"])

const parseArgs = (argv: string[]) => {
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue
    const key = argv[i].slice(2)
    if (FLAG_KEYS.has(key)) {
      args[key] = "1"
    } else {
      args[key] = argv[i + 1] ?? ""
      i++
    }
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

  if (mode === "full") {
    await runFullAnalysis(root, args)
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

// ---------------------------------------------------------------------------
// full mode — complete codegraph analysis inside the sandbox.
//
// Runs codegraph's OWN local pipeline (node:sqlite index + full resolver +
// framework resolvers + name-matcher) so every edge codegraph can produce —
// cross-file calls, route→handler references, component usages, receiver
// method calls via local type inference — lands in the snapshot. The server
// then only persists; it never re-resolves without source.
//
// Exports (snake_case, matching store insert types):
//   {t:"file", path, content_hash, language, size, node_count, indexed_at, mtime_ms}
//   {t:"node", id, kind, name, qualified_name, file_path, ...}
//   {t:"edge", source, target, kind, metadata, line, col, provenance}
// ---------------------------------------------------------------------------

const NODE_KINDS = [
  "file", "module", "class", "struct", "interface", "trait", "protocol",
  "function", "method", "property", "field", "variable", "constant", "enum",
  "enum_member", "type_alias", "namespace", "parameter", "import", "export",
  "route", "component",
]

const runFullAnalysis = async (root: string, args: Record<string, string>) => {
  const outPath = args.out ?? "/tmp/cg-full.ndjson.gz"
  const progressPath = args.progress ?? "/tmp/cg-full-progress.json"

  const pkgPath = require.resolve(`${PLATFORM_PKG}/package.json`)
  const lib = path.join(path.dirname(pkgPath), "lib", "dist", "index.js")
  const cg = require(lib) as {
    CodeGraph: {
      initSync: (root: string) => any
      openSync: (root: string) => any
    }
  }

  const writeProgress = (p: object) => fs.writeFileSync(progressPath, JSON.stringify(p))
  writeProgress({ files_total: 0, files_done: 0, done: false })

  // initSync creates .codegraph/ + SQLite. Full rebuild clears a stale one;
  // incremental reuses it (only the changed files are re-indexed) so the SQLite
  // graph stays the latest and resolveReferences sees the whole repo.
  // Fresh checkout without .codegraph state cannot sync (openSync throws) —
  // fall back to a full build; the export below then dumps everything.
  const doIncremental = !!args.incremental && fs.existsSync(path.join(root, ".codegraph"))
  let graph: any
  if (doIncremental) {
    graph = cg.CodeGraph.openSync(root)
  } else {
    if (args.incremental) console.log("codegraph: no .codegraph state, incremental falls back to full build")
    try {
      fs.rmSync(path.join(root, ".codegraph"), { recursive: true, force: true })
    } catch { /* not present */ }
    graph = cg.CodeGraph.initSync(root)
  }

  let filesTotal = 0
  let changedFiles: string[] = []
  let filesRemoved = 0
  let isIncremental = doIncremental
  let deletionDowngrade = false
  if (doIncremental) {
    // codegraph's sync(): content-hash diff → indexFiles(changed) → resolve
    // ONLY the changed files' refs (getUnresolvedReferencesByFiles). The
    // SQLite graph stays fully current; we export just the changed files'
    // neighborhood below so the server replaces only that slice.
    // Deletions are special: removal can rebind callers in UNCHANGED files
    // (definitionDelta / orphan sweep), so the changed-file slice is
    // incomplete — fall through to a full export to converge PG without a
    // kernel re-parse of every file.
    const r = await graph.sync()
    changedFiles = (r.changedFilePaths ?? []) as string[]
    filesRemoved = (r as any).filesRemoved ?? 0
    filesTotal = changedFiles.length
    writeProgress({ files_total: filesTotal, files_done: filesTotal, done: false })
    console.log(`codegraph incremental: changed=${changedFiles.length} removed=${filesRemoved} (${changedFiles.slice(0, 3).join(", ")}...)`)
    if (filesRemoved > 0) {
      isIncremental = false // deletion → full PG dump from current SQLite state
      deletionDowngrade = true
    }
  }
  if (!doIncremental || !isIncremental) {
    if (deletionDowngrade) {
      // deletion path already synced the SQLite graph; skip indexAll, just dump
    } else {
      const idx = await graph.indexAll({ onProgress: (p: { files_total?: number; files_done?: number }) => {
        if (p.files_total) {
          filesTotal = p.files_total
          writeProgress({ files_total: p.files_total, files_done: p.files_done ?? 0, done: false })
        }
      }})
      if (!idx.success) throw new Error(`codegraph indexAll failed: ${JSON.stringify(idx.errors ?? {}).slice(0, 500)}`)
      const res = await graph.resolveReferences()
      console.log(`codegraph full: files=${idx.filesIndexed} resolved=${(res as any)?.resolved ?? "?"}`)
    }
  }

  const { createGzip } = require("zlib") as typeof import("zlib")
  const outFile = fs.createWriteStream(outPath)
  const gz = createGzip({ level: 6 })
  gz.pipe(outFile)
  const write = (rec: object) => gz.write(JSON.stringify(rec) + "\n")
  const now = Date.now()

  // files
  const crypto = require("crypto") as typeof import("crypto")
  if (isIncremental) {
    // Incremental: export only the changed files' neighborhood.
    //   - changed files (file records)
    //   - their nodes
    //   - edges where source OR target is a changed-file node
    // The server replaceFiles() deletes source/target∈file edges + reinserts,
    // which keeps cross-file in-edges correct (dropped when their target node
    // disappears, kept otherwise).
    const changedSet = new Set(changedFiles)
    const writeFile = (p: string) => {
      let mtimeMs = 0
      let hash = ""
      try {
        const st = fs.statSync(path.join(root, p))
        mtimeMs = Math.round(st.mtimeMs)
        hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, p))).digest("hex")
      } catch { /* deleted during run */ }
      write({ t: "file", path: p, content_hash: hash, language: "", size: 0, node_count: 0, indexed_at: now, mtime_ms: mtimeMs })
    }
    let nodeCount = 0
    let edgeCount = 0
    const changedNodeIds = new Set<string>()
    for (const p of changedFiles) {
      writeFile(p)
      const nodes = graph.getNodesInFile(p) as Array<Record<string, unknown>>
      for (const n of nodes) {
        changedNodeIds.add(n.id as string)
        nodeCount++
        write({ t: "node", id: n.id, kind: n.kind, name: n.name, qualified_name: n.qualifiedName, file_path: n.filePath, language: n.language, start_line: n.startLine, end_line: n.endLine, start_col: n.startColumn, end_col: n.endColumn, docstring: n.docstring ?? null, signature: n.signature ?? null, visibility: n.visibility ?? null, is_exported: n.isExported ? 1 : 0, is_async: n.isAsync ? 1 : 0, is_static: n.isStatic ? 1 : 0, is_abstract: n.isAbstract ? 1 : 0, decorators: n.decorators ?? null, type_parameters: n.typeParameters ?? null, return_type: n.returnType ?? null, time_updated: now })
      }
    }
    // edges where source OR target ∈ changed nodes (out + in).
    const seenEdges = new Set<string>()
    for (const id of changedNodeIds) {
      for (const e of graph.getOutgoingEdges(id) as Array<Record<string, unknown>>) {
        const key = `${e.source}|${e.target}|${e.kind}|${e.line ?? ""}`
        if (seenEdges.has(key)) continue
        seenEdges.add(key)
        edgeCount++
        write({ t: "edge", source: e.source, target: e.target, kind: e.kind, metadata: e.metadata ?? null, line: e.line ?? null, col: e.column ?? null, provenance: e.provenance ?? "resolver" })
      }
      for (const e of graph.getIncomingEdges(id) as Array<Record<string, unknown>>) {
        const key = `${e.source}|${e.target}|${e.kind}|${e.line ?? ""}`
        if (seenEdges.has(key)) continue
        seenEdges.add(key)
        edgeCount++
        write({ t: "edge", source: e.source, target: e.target, kind: e.kind, metadata: e.metadata ?? null, line: e.line ?? null, col: e.column ?? null, provenance: e.provenance ?? "resolver" })
      }
    }
    await new Promise<void>((resolve, reject) => {
      gz.end(() => outFile.end(() => resolve()))
      outFile.on("error", reject)
    })
    writeProgress({ files_total: nodeCount, files_done: nodeCount, done: true })
    console.log(`codegraph incremental: ${changedFiles.length} files, ${nodeCount} nodes, ${edgeCount} edges → ${outPath}`)
    graph.close()
    return
  }

  for (const f of graph.getFiles() as Array<{ path: string; language: string; size: number; node_count: number }>) {
    let mtimeMs = 0
    let hash = ""
    try {
      const st = fs.statSync(path.join(root, f.path))
      mtimeMs = Math.round(st.mtimeMs)
      hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, f.path))).digest("hex")
    } catch { /* deleted during run */ }
    write({ t: "file", path: f.path, content_hash: hash, language: f.language, size: f.size, node_count: f.node_count ?? 0, indexed_at: now, mtime_ms: mtimeMs })
  }

  // nodes (by kind — avoids N+1 per file)
  let nodeCount = 0
  for (const kind of NODE_KINDS) {
    const nodes = graph.getNodesByKind(kind) as Array<Record<string, unknown>>
    for (const n of nodes) {
      nodeCount++
      write({
        t: "node",
        id: n.id, kind: n.kind, name: n.name, qualified_name: n.qualifiedName,
        file_path: n.filePath, language: n.language,
        start_line: n.startLine, end_line: n.endLine, start_col: n.startColumn, end_col: n.endColumn,
        docstring: n.docstring ?? null, signature: n.signature ?? null, visibility: n.visibility ?? null,
        is_exported: n.isExported ? 1 : 0, is_async: n.isAsync ? 1 : 0, is_static: n.isStatic ? 1 : 0, is_abstract: n.isAbstract ? 1 : 0,
        decorators: n.decorators ?? null, type_parameters: n.typeParameters ?? null, return_type: n.returnType ?? null,
        time_updated: now,
      })
    }
  }

  // edges (outgoing from each node covers every edge once)
  let edgeCount = 0
  for (const kind of NODE_KINDS) {
    const nodes = graph.getNodesByKind(kind) as Array<{ id: string }>
    for (const n of nodes) {
      const edges = graph.getOutgoingEdges(n.id) as Array<Record<string, unknown>>
      for (const e of edges) {
        edgeCount++
        write({
          t: "edge",
          source: e.source, target: e.target, kind: e.kind,
          metadata: e.metadata ?? null, line: e.line ?? null, col: e.column ?? null,
          provenance: e.provenance ?? "resolver",
        })
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    gz.end(() => outFile.end(() => resolve()))
    outFile.on("error", reject)
  })
  writeProgress({ files_total: nodeCount, files_done: nodeCount, done: true })
  console.log(`codegraph full: ${nodeCount} nodes, ${edgeCount} edges → ${outPath}`)
  graph.close()
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(1)
})
