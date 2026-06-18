/**
 * LSP Manager — manages LSP server processes inside the sandbox container.
 *
 * Phase 1: TypeScript only. Runs `typescript-language-server --stdio` and
 * communicates via vscode-jsonrpc. All project files are under `/workspace`.
 *
 * This file MUST NOT import any opencode internals. It only uses Node.js
 * built-in modules and `vscode-jsonrpc`.
 */

import { ChildProcess, spawn } from "child_process"
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node"
import path from "path"
import fs from "fs"
import { pathToFileURL, fileURLToPath } from "url"

const FILE_CHANGE_CREATED = 1
const FILE_CHANGE_CHANGED = 2
const TEXT_DOCUMENT_SYNC_INCREMENTAL = 2
const INITIALIZE_TIMEOUT_MS = 45_000
const DIAGNOSTICS_REQUEST_TIMEOUT_MS = 3_000
const LSP_REQUEST_TIMEOUT_MS = 10_000
const WORKSPACE = process.env.LSP_WORKSPACE_ROOT ?? "/workspace"

type ServerStatus = "starting" | "running" | "error"

interface DocumentSymbol {
  name: string
  detail?: string
  kind: number
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  selectionRange: { start: { line: number; character: number }; end: { line: number; character: number } }
  children?: DocumentSymbol[]
}

interface WorkspaceSymbol {
  name: string
  kind: number
  location: {
    uri: string
    range: { start: { line: number; character: number }; end: { line: number; character: number } }
  }
}

const WORKSPACE_SYMBOL_KINDS = new Set([5, 6, 12, 11, 13, 14])
const WORKSPACE_SYMBOL_LIMIT = 10

interface Diagnostic {
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  severity?: number
  code?: string | number
  source?: string
  message: string
}

interface HoverContent {
  language?: string
  value: string
}

interface Location {
  uri: string
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
}

interface CallHierarchyItem {
  name: string
  kind: number
  detail?: string
  uri: string
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  selectionRange: { start: { line: number; character: number }; end: { line: number; character: number } }
}

interface CallHierarchyIncomingCall {
  from: CallHierarchyItem
  fromRanges: Array<{ start: { line: number; character: number }; end: { line: number; character: number } }>
}

interface CallHierarchyOutgoingCall {
  to: CallHierarchyItem
  fromRanges: Array<{ start: { line: number; character: number }; end: { line: number; character: number } }>
}

interface DocumentDiagnosticReport {
  items?: Diagnostic[]
  relatedDocuments?: Record<string, DocumentDiagnosticReport>
}

interface DiagnosticRegistration {
  id: string
  documentSelector?: Array<{ language?: string; scheme?: string; pattern?: string }>
  interFileDependencies?: boolean
  workspaceDiagnostics?: boolean
}

interface ServerCapabilities {
  textDocumentSync?: number | { change?: number }
  diagnosticProvider?: unknown
  [key: string]: unknown
}

interface HeldServer {
  id: string
  status: ServerStatus
  process: ChildProcess | null
  connection: ReturnType<typeof createMessageConnection> | null
  root: string
  capabilities: ServerCapabilities | null
  documents: Record<string, { version: number; text: string }>
  pushDiagnostics: Map<string, Diagnostic[]>
  pullDiagnostics: Map<string, Diagnostic[]>
  published: Map<string, { at: number; version?: number }>
  diagnosticListeners: Set<(input: { path: string }) => void>
  diagnosticRegistrations: Map<string, DiagnosticRegistration>
  registrationListeners: Set<() => void>
  initPromise: Promise<void> | null
  crashed: boolean
  spawnFailed: boolean
}

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".ets"])

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".ets": "typescript",
}

function getSyncKind(capabilities?: ServerCapabilities) {
  if (!capabilities) return
  const sync = capabilities.textDocumentSync
  if (typeof sync === "number") return sync
  return sync?.change
}

function endPosition(text: string) {
  const lines = text.split(/\r\n|\r|\n/)
  return {
    line: lines.length - 1,
    character: lines.at(-1)?.length ?? 0,
  }
}

function dedupeDiagnostics(items: Diagnostic[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = JSON.stringify({
      code: item.code,
      severity: item.severity,
      message: item.message,
      source: item.source,
      range: item.range,
    })
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function getFilePath(uri: string): string | undefined {
  if (!uri.startsWith("file://")) return
  try {
    return fileURLToPath(uri)
  } catch {
    return
  }
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "")
}

function isTsFile(filePath: string): boolean {
  return TS_EXTENSIONS.has(path.extname(filePath))
}

function log(msg: string) {
  process.stderr.write(`[lsp-manager] ${msg}\n`)
}

function findTypescriptLanguageServer(): string | undefined {
  const ext = process.platform === "win32" ? ".cmd" : ""
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter)
  for (const dir of pathDirs) {
    const candidate = path.join(dir, `typescript-language-server${ext}`)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {}
  }

  let current = WORKSPACE
  while (true) {
    const candidate = path.join(current, "node_modules", ".bin", `typescript-language-server${ext}`)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {}
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  return
}

function findTsserverPath(): string | undefined {
  try {
    return require.resolve("typescript/lib/tsserver.js", { paths: [WORKSPACE] })
  } catch {}
  let current = WORKSPACE
  while (true) {
    const candidate = path.join(current, "node_modules", "typescript", "lib", "tsserver.js")
    try {
      fs.accessSync(candidate, fs.constants.R_OK)
      return candidate
    } catch {}
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return
}

const ROOT_MARKERS = [
  "tsconfig.json",
  "package.json",
  "package-lock.json",
  "bun.lockb",
  "bun.lock",
  "pnpm-lock.yaml",
  "yarn.lock",
]

function detectRoot(filePath: string): string {
  let dir = path.dirname(normalizePath(filePath))
  while (true) {
    for (const marker of ROOT_MARKERS) {
      if (fs.existsSync(path.join(dir, marker))) return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir || !dir.startsWith(WORKSPACE)) break
    dir = parent
  }
  return WORKSPACE
}

export class LspManager {
  private servers = new Map<string, HeldServer>()

  async ensureServer(filePath: string): Promise<string> {
    if (!isTsFile(filePath)) return ""
    const id = "typescript"
    let server = this.servers.get(id)

    if (!server) {
      server = this.createServer(id, filePath)
      this.servers.set(id, server)
    }

    if (server.crashed && !server.spawnFailed) {
      server.crashed = false
      // Clear stale document state so the restarted server gets fresh
      // didOpen notifications instead of didChange against documents it
      // has never seen (which tsserver silently ignores or errors on).
      server.documents = {}
      server.pushDiagnostics.clear()
      server.pullDiagnostics.clear()
      server.published.clear()
      server.initPromise = this.initializeServer(server)
    }

    if (server.initPromise) {
      try {
        await server.initPromise
      } catch {}
    }

    return id
  }

  async touchFile(filePath: string): Promise<number> {
    const normalized = normalizePath(filePath)
    const serverId = await this.ensureServer(normalized)
    if (!serverId) return 0

    const server = this.servers.get(serverId)
    if (!server || server.status !== "running" || !server.connection) return 0

    const conn = server.connection
    const existing = server.documents[normalized]

    try {
      const text = await fs.promises.readFile(normalized, "utf-8").catch(() => "")
      const extension = path.extname(normalized)
      const languageId = LANGUAGE_EXTENSIONS[extension] ?? "plaintext"

      if (existing !== undefined) {
        await conn.sendNotification("workspace/didChangeWatchedFiles", {
          changes: [{ uri: pathToFileURL(normalized).href, type: FILE_CHANGE_CHANGED }],
        })

        const syncKind = getSyncKind(server.capabilities ?? undefined)
        const next = existing.version + 1
        server.documents[normalized] = { version: next, text }

        await conn.sendNotification("textDocument/didChange", {
          textDocument: {
            uri: pathToFileURL(normalized).href,
            version: next,
          },
          contentChanges:
            syncKind === TEXT_DOCUMENT_SYNC_INCREMENTAL
              ? [
                  {
                    range: {
                      start: { line: 0, character: 0 },
                      end: endPosition(existing.text),
                    },
                    text,
                  },
                ]
              : [{ text }],
        })
        return next
      }

      await conn.sendNotification("workspace/didChangeWatchedFiles", {
        changes: [{ uri: pathToFileURL(normalized).href, type: FILE_CHANGE_CREATED }],
      })

      server.pushDiagnostics.delete(normalized)
      server.pullDiagnostics.delete(normalized)

      await conn.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: pathToFileURL(normalized).href,
          languageId,
          version: 0,
          text,
        },
      })

      server.documents[normalized] = { version: 0, text }
      return 0
    } catch (err) {
      log(`touchFile error: ${String(err)}`)
      return 0
    }
  }

  async getDiagnostics(filePath: string, wait: boolean = true): Promise<Record<string, Diagnostic[]>> {
    const normalized = normalizePath(filePath)
    const serverId = await this.ensureServer(normalized)
    if (!serverId) return {}

    const server = this.servers.get(serverId)
    if (!server || server.status !== "running" || !server.connection) return {}

    if (wait) {
      await this.touchFile(normalized)
      await this.waitForDocumentDiagnostics(normalized, 5000)
    }

    const result: Record<string, Diagnostic[]> = {}
    const collectForPath = (target: string) => {
      const push = server!.pushDiagnostics.get(target) ?? []
      const pull = server!.pullDiagnostics.get(target) ?? []
      const merged = dedupeDiagnostics([...push, ...pull])
      if (merged.length > 0) result[target] = merged
    }

    collectForPath(normalized)

    try {
      await this.requestPullDiagnostics(server, normalized, result)
    } catch {}

    return result
  }

  async waitForDocumentDiagnostics(filePath: string, timeoutMs: number = 5000): Promise<void> {
    const normalized = normalizePath(filePath)
    const serverId = await this.ensureServer(normalized)
    if (!serverId) return

    const server = this.servers.get(serverId)
    if (!server || server.status !== "running" || !server.connection) return

    const beforeAt = server.published.get(normalized)?.at ?? 0

    return new Promise<void>((resolve) => {
      let resolved = false
      const done = () => {
        if (!resolved) {
          resolved = true
          cleanup()
          resolve()
        }
      }

      const listener = (input: { path: string }) => {
        if (input.path === normalized) {
          const currentAt = server.published.get(normalized)?.at ?? 0
          if (currentAt > beforeAt) done()
        }
      }
      server.diagnosticListeners.add(listener)

      const timer = setTimeout(done, timeoutMs)

      this.requestPullDiagnostics(server, normalized, {}).then(() => {
        const pushDiags = server.pushDiagnostics.get(normalized) ?? []
        const pullDiags = server.pullDiagnostics.get(normalized) ?? []
        if (pushDiags.length > 0 || pullDiags.length > 0) done()
      }).catch(() => {})

      const cleanup = () => {
        clearTimeout(timer)
        server.diagnosticListeners.delete(listener)
      }
    })
  }

  async hover(filePath: string, line: number, character: number): Promise<{ contents: HoverContent[] | null }> {
    await this.touchFile(filePath)
    const normalized = normalizePath(filePath)
    const serverId = await this.ensureServer(normalized)
    if (!serverId) return { contents: null }

    const server = this.servers.get(serverId)
    if (!server || server.status !== "running" || !server.connection) return { contents: null }

    try {
      const result = await withTimeout<unknown>(
        server.connection.sendRequest("textDocument/hover", {
          textDocument: { uri: pathToFileURL(normalized).href },
          position: { line, character },
        }),
        LSP_REQUEST_TIMEOUT_MS,
      )

      if (!result) return { contents: null }

      const hover = result as { contents?: unknown }
      return { contents: normalizeHoverContents(hover.contents) }
    } catch {
      return { contents: null }
    }
  }

  async definition(filePath: string, line: number, character: number): Promise<{ locations: Location[] }> {
    await this.touchFile(filePath)
    return this.requestLocations("textDocument/definition", filePath, line, character)
  }

  async references(filePath: string, line: number, character: number): Promise<{ locations: Location[] }> {
    await this.touchFile(filePath)
    return this.requestLocationsWithParams("textDocument/references", filePath, line, character, {
      includeDeclaration: true,
    })
  }

  async implementation(filePath: string, line: number, character: number): Promise<{ locations: Location[] }> {
    await this.touchFile(filePath)
    return this.requestLocations("textDocument/implementation", filePath, line, character)
  }

  async prepareCallHierarchy(filePath: string, line: number, character: number): Promise<{ items: CallHierarchyItem[] }> {
    await this.touchFile(filePath)
    const normalized = normalizePath(filePath)
    const serverId = await this.ensureServer(normalized)
    if (!serverId) return { items: [] }

    const server = this.servers.get(serverId)
    if (!server || server.status !== "running" || !server.connection) return { items: [] }

    try {
      const result = await withTimeout<unknown[] | null>(
        server.connection.sendRequest("textDocument/prepareCallHierarchy", {
          textDocument: { uri: pathToFileURL(normalized).href },
          position: { line, character },
        }),
        LSP_REQUEST_TIMEOUT_MS,
      )

      if (!Array.isArray(result)) return { items: [] }
      return { items: result.filter(Boolean) as CallHierarchyItem[] }
    } catch {
      return { items: [] }
    }
  }

  async incomingCalls(filePath: string, line: number, character: number): Promise<{ calls: CallHierarchyIncomingCall[] }> {
    await this.touchFile(filePath)
    const normalized = normalizePath(filePath)
    const serverId = await this.ensureServer(normalized)
    if (!serverId) return { calls: [] }

    const server = this.servers.get(serverId)
    if (!server || server.status !== "running" || !server.connection) return { calls: [] }

    try {
      const items = await withTimeout<unknown[] | null>(
        server.connection.sendRequest("textDocument/prepareCallHierarchy", {
          textDocument: { uri: pathToFileURL(normalized).href },
          position: { line, character },
        }),
        LSP_REQUEST_TIMEOUT_MS,
      )

      if (!Array.isArray(items) || items.length === 0) return { calls: [] }

      const result = await withTimeout<unknown[] | null>(
        server.connection.sendRequest("callHierarchy/incomingCalls", { item: items[0] }),
        LSP_REQUEST_TIMEOUT_MS,
      )

      if (!Array.isArray(result)) return { calls: [] }
      return { calls: result.filter(Boolean) as CallHierarchyIncomingCall[] }
    } catch {
      return { calls: [] }
    }
  }

  async outgoingCalls(filePath: string, line: number, character: number): Promise<{ calls: CallHierarchyOutgoingCall[] }> {
    await this.touchFile(filePath)
    const normalized = normalizePath(filePath)
    const serverId = await this.ensureServer(normalized)
    if (!serverId) return { calls: [] }

    const server = this.servers.get(serverId)
    if (!server || server.status !== "running" || !server.connection) return { calls: [] }

    try {
      const items = await withTimeout<unknown[] | null>(
        server.connection.sendRequest("textDocument/prepareCallHierarchy", {
          textDocument: { uri: pathToFileURL(normalized).href },
          position: { line, character },
        }),
        LSP_REQUEST_TIMEOUT_MS,
      )

      if (!Array.isArray(items) || items.length === 0) return { calls: [] }

      const result = await withTimeout<unknown[] | null>(
        server.connection.sendRequest("callHierarchy/outgoingCalls", { item: items[0] }),
        LSP_REQUEST_TIMEOUT_MS,
      )

      if (!Array.isArray(result)) return { calls: [] }
      return { calls: result.filter(Boolean) as CallHierarchyOutgoingCall[] }
    } catch {
      return { calls: [] }
    }
  }

  async documentSymbol(filePath: string): Promise<{ symbols: DocumentSymbol[] }> {
    await this.touchFile(filePath)
    const normalized = normalizePath(filePath)
    const serverId = await this.ensureServer(normalized)
    if (!serverId) return { symbols: [] }

    const server = this.servers.get(serverId)
    if (!server || server.status !== "running" || !server.connection) return { symbols: [] }

    try {
      const result = await withTimeout<DocumentSymbol[] | null>(
        server.connection.sendRequest("textDocument/documentSymbol", {
          textDocument: { uri: pathToFileURL(normalized).href },
        }),
        LSP_REQUEST_TIMEOUT_MS,
      )

      return { symbols: Array.isArray(result) ? result : [] }
    } catch {
      return { symbols: [] }
    }
  }

  async workspaceSymbol(query: string): Promise<{ symbols: WorkspaceSymbol[] }> {
    const serverId = await this.ensureServer(path.join(WORKSPACE, "dummy.ts"))
    if (!serverId) return { symbols: [] }

    const server = this.servers.get(serverId)
    if (!server || server.status !== "running" || !server.connection) return { symbols: [] }

    try {
      const result = await withTimeout<unknown[]>(
        server.connection.sendRequest("workspace/symbol", { query }),
        LSP_REQUEST_TIMEOUT_MS,
      )

      if (!Array.isArray(result)) return { symbols: [] }

      const symbols = result
        .filter((item): item is { name: string; kind: number; location: { uri: string; range: WorkspaceSymbol["location"]["range"] } } =>
          typeof item === "object" && item !== null && "name" in item && "kind" in item && "location" in item
        )
        .filter((item) => WORKSPACE_SYMBOL_KINDS.has(item.kind))
        .slice(0, WORKSPACE_SYMBOL_LIMIT)
        .map((item) => ({ name: item.name, kind: item.kind, location: item.location }))

      return { symbols }
    } catch {
      return { symbols: [] }
    }
  }

  getStatus(): Array<{ id: string; status: ServerStatus }> {
    return [...this.servers.values()].map((s) => ({ id: s.id, status: s.status }))
  }

  async shutdown(): Promise<void> {
    const stops = [...this.servers.values()].map((server) => this.stopServer(server))
    await Promise.allSettled(stops)
    this.servers.clear()
  }

  private createServer(id: string, filePath: string): HeldServer {
    const root = detectRoot(filePath)
    const server: HeldServer = {
      id,
      status: "starting",
      process: null,
      connection: null,
      root,
      capabilities: null,
      documents: {},
      pushDiagnostics: new Map(),
      pullDiagnostics: new Map(),
      published: new Map(),
      diagnosticListeners: new Set(),
      diagnosticRegistrations: new Map(),
      registrationListeners: new Set(),
      initPromise: null,
      crashed: false,
      spawnFailed: false,
    }
    server.initPromise = this.initializeServer(server)
    return server
  }

  private async initializeServer(server: HeldServer): Promise<void> {
    const bin = findTypescriptLanguageServer()
    if (!bin) {
      log("typescript-language-server not found")
      server.status = "error"
      server.spawnFailed = true
      return
    }

    const tsserverPath = findTsserverPath()
    const initialization: Record<string, unknown> = {}
    if (tsserverPath) {
      initialization.tsserver = { path: tsserverPath }
    }

    log(`spawning: ${bin} --stdio (root=${server.root})`)

    const child = spawn(bin, ["--stdio"], {
      cwd: server.root,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    })

    server.process = child

    let spawnError = false
    child.on("error", (err) => {
      log(`process error: ${String(err)}`)
      spawnError = true
      server.status = "error"
      server.crashed = true
      server.spawnFailed = true
    })

    child.on("exit", (code) => {
      log(`process exited with code ${code}`)
      if (server.status !== "error") {
        server.status = "error"
        server.crashed = true
      }
    })

    child.stderr?.on("data", (d: Buffer) => {
      process.stderr.write(`[tsserver] ${d.toString()}`)
    })

    try {
      await this.runInitializeHandshake(server, child, initialization)
    } catch (err) {
      log(`initialize failed: ${String(err)}`)
      server.status = "error"
      server.crashed = true
      if (spawnError) server.spawnFailed = true
      try { server.connection?.dispose() } catch {}
      try { child.kill() } catch {}
    }
  }

  private async runInitializeHandshake(
    server: HeldServer,
    child: ChildProcess,
    initialization: Record<string, unknown>,
  ): Promise<void> {
    const stdout = child.stdout
    const stdin = child.stdin
    if (!stdout || !stdin) throw new Error("child process stdio not available")
    const connection = createMessageConnection(
      new StreamMessageReader(stdout),
      new StreamMessageWriter(stdin),
    )

    server.connection = connection

    connection.onNotification("textDocument/publishDiagnostics", (params: { uri: string; diagnostics: Diagnostic[]; version?: number }) => {
      const fp = getFilePath(params.uri)
      if (!fp) return
      const normalized = normalizePath(fp)
      server.pushDiagnostics.set(normalized, params.diagnostics)
      server.published.set(normalized, { at: Date.now(), version: params.version })
      for (const listener of server.diagnosticListeners) {
        try { listener({ path: normalized }) } catch {}
      }
    })

    connection.onRequest("window/workDoneProgress/create", () => null)
    connection.onRequest("workspace/configuration", () => [initialization])
    connection.onRequest("workspace/workspaceFolders", () => [
      { name: "workspace", uri: pathToFileURL(server.root).href },
    ])
    connection.onRequest("workspace/diagnostic/refresh", () => null)
    connection.onRequest("client/registerCapability", (params: unknown) => {
      const p = params as { registrations?: Array<{ id: string; method: string; registerOptions?: Record<string, unknown> }> }
      const registrations = Array.isArray(p.registrations) ? p.registrations : []
      for (const reg of registrations) {
        if (reg.method === "textDocument/diagnostic") {
          const opts = reg.registerOptions
          server.diagnosticRegistrations.set(reg.id, {
            id: reg.id,
            documentSelector: opts?.documentSelector as DiagnosticRegistration["documentSelector"],
            interFileDependencies: typeof opts?.interFileDependencies === "boolean" ? opts.interFileDependencies : undefined,
            workspaceDiagnostics: typeof opts?.workspaceDiagnostics === "boolean" ? opts.workspaceDiagnostics : undefined,
          })
        }
      }
      for (const listener of server.registrationListeners) {
        try { listener() } catch {}
      }
      return null
    })
    connection.onRequest("client/unregisterCapability", (params: unknown) => {
      const p = params as { unregistrations?: Array<{ id: string }> }
      const unregistrations = Array.isArray(p.unregistrations) ? p.unregistrations : []
      for (const unreg of unregistrations) {
        server.diagnosticRegistrations.delete(unreg.id)
      }
      for (const listener of server.registrationListeners) {
        try { listener() } catch {}
      }
      return null
    })

    connection.listen()

    const initResult = await withTimeout(
      connection.sendRequest<{ capabilities?: ServerCapabilities }>("initialize", {
        rootUri: pathToFileURL(server.root).href,
        processId: child.pid,
        workspaceFolders: [{ name: "workspace", uri: pathToFileURL(server.root).href }],
        initializationOptions: initialization,
        capabilities: {
          window: { workDoneProgress: true },
          workspace: {
            configuration: true,
            didChangeWatchedFiles: { dynamicRegistration: true },
            diagnostics: { refreshSupport: false },
          },
          textDocument: {
            synchronization: { didOpen: true, didChange: true },
            diagnostic: { dynamicRegistration: true, relatedDocumentSupport: true },
            publishDiagnostics: { versionSupport: false },
          },
        },
      }),
      INITIALIZE_TIMEOUT_MS,
    )

    server.capabilities = initResult.capabilities ?? null

    await connection.sendNotification("initialized", {})

    if (Object.keys(initialization).length > 0) {
      await connection.sendNotification("workspace/didChangeConfiguration", { settings: initialization })
    }

    server.status = "running"
    log("server initialized successfully")
  }

  private async requestPullDiagnostics(
    server: HeldServer,
    filePath: string,
    result: Record<string, Diagnostic[]>,
  ) {
    if (!server.connection) return

    const uri = pathToFileURL(filePath).href
    const textDocument = { uri }

    const requests: Promise<void>[] = []

    // Universal request (no identifier)
    requests.push(
      withTimeout<DocumentDiagnosticReport | null>(
        server.connection.sendRequest("textDocument/diagnostic", { textDocument }),
        DIAGNOSTICS_REQUEST_TIMEOUT_MS,
      )
        .then((report) => {
          if (!report) return
          this.mergePullReport(server, filePath, report, result)
        })
        .catch(() => {}),
    )

    // Per-identifier requests using registered capabilities
    for (const [regId, reg] of server.diagnosticRegistrations) {
      requests.push(
        withTimeout<DocumentDiagnosticReport | null>(
          server.connection.sendRequest("textDocument/diagnostic", {
            textDocument,
            identifier: regId,
            interFileDependencies: reg.interFileDependencies,
            workspaceDiagnostics: reg.workspaceDiagnostics,
          }),
          DIAGNOSTICS_REQUEST_TIMEOUT_MS,
        )
          .then((report) => {
            if (!report) return
            this.mergePullReport(server, filePath, report, result)
          })
          .catch(() => {}),
      )
    }

    await Promise.all(requests)
  }

  private mergePullReport(
    server: HeldServer,
    filePath: string,
    report: DocumentDiagnosticReport,
    result: Record<string, Diagnostic[]>,
  ) {
    if (Array.isArray(report.items) && report.items.length > 0) {
      const merged = dedupeDiagnostics([...(result[filePath] ?? []), ...report.items])
      if (merged.length > 0) result[filePath] = merged
      const stored = server.pullDiagnostics.get(filePath) ?? []
      server.pullDiagnostics.set(filePath, dedupeDiagnostics([...stored, ...report.items]))
    }

    for (const [relUri, related] of Object.entries(report.relatedDocuments ?? {})) {
      const fp = getFilePath(relUri)
      if (!fp || !Array.isArray(related.items)) continue
      const normalized = normalizePath(fp)
      const merged = dedupeDiagnostics([...(result[normalized] ?? []), ...related.items])
      if (merged.length > 0) result[normalized] = merged
      const stored = server.pullDiagnostics.get(normalized) ?? []
      server.pullDiagnostics.set(normalized, dedupeDiagnostics([...stored, ...related.items]))
    }
  }

  private async requestLocations(
    method: string,
    filePath: string,
    line: number,
    character: number,
  ): Promise<{ locations: Location[] }> {
    const normalized = normalizePath(filePath)
    const serverId = await this.ensureServer(normalized)
    if (!serverId) return { locations: [] }

    const server = this.servers.get(serverId)
    if (!server || server.status !== "running" || !server.connection) return { locations: [] }

    try {
      const result = await withTimeout<unknown>(
        server.connection.sendRequest(method, {
          textDocument: { uri: pathToFileURL(normalized).href },
          position: { line, character },
        }),
        LSP_REQUEST_TIMEOUT_MS,
      )

      return { locations: normalizeLocations(result) }
    } catch {
      return { locations: [] }
    }
  }

  private async requestLocationsWithParams(
    method: string,
    filePath: string,
    line: number,
    character: number,
    extraParams: Record<string, unknown>,
  ): Promise<{ locations: Location[] }> {
    const normalized = normalizePath(filePath)
    const serverId = await this.ensureServer(normalized)
    if (!serverId) return { locations: [] }

    const server = this.servers.get(serverId)
    if (!server || server.status !== "running" || !server.connection) return { locations: [] }

    try {
      const result = await withTimeout<unknown>(
        server.connection.sendRequest(method, {
          textDocument: { uri: pathToFileURL(normalized).href },
          position: { line, character },
          ...extraParams,
        }),
        LSP_REQUEST_TIMEOUT_MS,
      )

      return { locations: normalizeLocations(result) }
    } catch {
      return { locations: [] }
    }
  }

  private async stopServer(server: HeldServer): Promise<void> {
    if (server.connection) {
      try {
        await server.connection.sendRequest("shutdown")
        await server.connection.sendNotification("exit")
      } catch {}
      server.connection.end()
      server.connection.dispose()
    }
    if (server.process && !server.process.killed) {
      server.process.kill("SIGTERM")
      const forceKill = setTimeout(() => {
        if (server.process && !server.process.killed) {
          server.process.kill("SIGKILL")
        }
      }, 3000)
      server.process.once("exit", () => clearTimeout(forceKill))
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

function normalizeHoverContents(contents: unknown): HoverContent[] | null {
  if (!contents) return null

  if (typeof contents === "string") {
    return [{ value: contents }]
  }

  if (typeof contents === "object" && contents !== null && "kind" in contents) {
    const markup = contents as { kind: string; value: string }
    return [{ value: markup.value }]
  }

  if (typeof contents === "object" && contents !== null && "language" in contents) {
    const marked = contents as { language: string; value: string }
    return [{ language: marked.language, value: marked.value }]
  }

  if (Array.isArray(contents)) {
    const result: HoverContent[] = []
    for (const item of contents) {
      if (typeof item === "string") {
        result.push({ value: item })
      } else if (typeof item === "object" && item !== null && "kind" in item) {
        const markup = item as { kind: string; value: string }
        result.push({ value: markup.value })
      } else if (typeof item === "object" && item !== null && "language" in item) {
        const marked = item as { language: string; value: string }
        result.push({ language: marked.language, value: marked.value })
      }
    }
    return result.length > 0 ? result : null
  }

  return null
}

function normalizeLocations(response: unknown): Location[] {
  if (!response) return []

  if (Array.isArray(response)) {
    if (response.length === 0) return []
    const first = response[0]
    if (first && typeof first === "object" && "targetUri" in first) {
      return response.map((link) => ({
        uri: (link as { targetUri: string }).targetUri,
        range: (link as { targetSelectionRange: Location["range"] }).targetSelectionRange,
      }))
    }
    return response.filter(isLocationLike).map(toLocation)
  }

  if (isLocationLike(response)) {
    return [toLocation(response)]
  }

  return []
}

function isLocationLike(obj: unknown): obj is { uri: string; range: Location["range"] } {
  return typeof obj === "object" && obj !== null && "uri" in obj && "range" in obj
}

function toLocation(obj: { uri: string; range: Location["range"] }): Location {
  return { uri: obj.uri, range: obj.range }
}
