import { CommandExitError, Sandbox, type CommandStartOpts, type SandboxOpts } from "e2b"
import type { SandboxConfig } from "../config.js"

export interface Remote {
  readonly id: string
  readonly token: string | undefined
  start(command: string, opts: CommandStartOpts): Promise<{ pid: number; wait(): Promise<{ exitCode: number }> }>
  killCommand(pid: number): Promise<boolean>
  listCommands(): Promise<Array<{ pid: number }>>
  snapshot(name: string): Promise<string>
  extend(ms: number): Promise<void>
  stat(path: string): Promise<{ size: number; type?: string }>
  read(path: string): Promise<Uint8Array>
  write(path: string, data: string): Promise<unknown>
  mkdir(path: string): Promise<unknown>
  remove(path: string): Promise<unknown>
  list(path: string): Promise<Array<{ name: string; type?: string }>>
}

export interface Api {
  create(template: string, opts: SandboxOpts): Promise<Remote>
  connect(id: string): Promise<Remote>
  info(id: string): Promise<{ state: string; cpuCount?: number; memoryMB?: number }>
  find(intent: string): Promise<string[]>
  kill(id: string): Promise<boolean>
  snapshots(id: string): Promise<Array<{ snapshotId: string; names: string[] }>>
  deleteSnapshot(id: string): Promise<boolean>
}

function remote(sandbox: Sandbox): Remote {
  return {
    id: sandbox.sandboxId,
    token: sandbox.trafficAccessToken,
    start: async (command, opts) => {
      const handle = await sandbox.commands.run(command, { ...opts, background: true })
      return { pid: handle.pid, wait: async () => {
        try { return await handle.wait() } catch (error) {
          if (error instanceof CommandExitError) return { exitCode: error.exitCode }
          throw error
        }
      } }
    },
    killCommand: (pid) => sandbox.commands.kill(pid),
    listCommands: () => sandbox.commands.list(),
    snapshot: async (name) => (await sandbox.createSnapshot({ name, requestTimeoutMs: 300000 })).snapshotId,
    extend: (ms) => sandbox.setTimeout(ms),
    stat: (path) => sandbox.files.getInfo(path),
    read: (path) => sandbox.files.read(path, { format: "bytes" }),
    write: (path, data) => sandbox.files.write(path, data),
    mkdir: (path) => sandbox.files.makeDir(path),
    remove: (path) => sandbox.files.remove(path),
    list: (path) => sandbox.files.list(path),
  }
}

export function client(config: NonNullable<SandboxConfig.Config["aliyun"]>, requestTimeoutMs: number): Api {
  const connection = { apiKey: config.apiKey, apiUrl: config.apiUrl, domain: config.domain, requestTimeoutMs }
  // Static Snapshot opts do not publicly support apiUrl. Do not mutate the
  // process environment: regional deployments configure E2B_API_URL at startup.
  const snapshotConnection = () => {
    if ((process.env.E2B_API_URL || `https://api.${config.domain}`) !== config.apiUrl)
      throw new Error("Configure E2B_API_URL to match OPENCODE_ALIYUN_API_URL for static Snapshot APIs")
    return { apiKey: config.apiKey, domain: config.domain, requestTimeoutMs }
  }
  return {
    create: async (template, opts) => remote(await Sandbox.create(template, { ...connection, ...opts })),
    connect: async (id) => remote(await Sandbox.connect(id, connection)),
    info: (id) => Sandbox.getInfo(id, connection),
    kill: (id) => Sandbox.kill(id, connection),
    deleteSnapshot: (id) => Sandbox.deleteSnapshot(id, snapshotConnection()),
    snapshots: async (id) => {
      const pages = Sandbox.listSnapshots({ ...snapshotConnection(), sandboxId: id })
      const items: Array<{ snapshotId: string; names: string[] }> = []
      while (pages.hasNext) items.push(...await pages.nextItems())
      return items
    },
    find: async (intent) => {
      const pages = Sandbox.list({ ...connection, query: { metadata: { opencode_intent: intent } } })
      const ids: string[] = []
      while (pages.hasNext) ids.push(...(await pages.nextItems()).map((item) => item.sandboxId))
      return ids
    },
  }
}
