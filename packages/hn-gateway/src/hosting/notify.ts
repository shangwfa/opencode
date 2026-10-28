/**
 * 配置变更总线：PG LISTEN/NOTIFY 替代 Nacos 的订阅推送。
 *
 * - 写路径：管理面写表后同事务 `SELECT pg_notify('gateway_config_changed', payload)`
 * - 读路径：每个实例用独立 pg Client LISTEN 该通道，收到即回调失效内存缓存；
 *   断连自动重建，重建成功后先全量失效一次（弥补离线期间的变更）
 * - NOTIFY 在事务内发出时随事务提交（回滚则不通知），与原 Nacos「发布成功才可见」语义一致
 */
import { Client } from "pg"
import { logger } from "../logger.js"

export const CONFIG_CHANGE_CHANNEL = "gateway_config_changed"

export interface ConfigChange {
  /** 变更的表：apps | micro_apps | gray_features | configs | publishes */
  table: string
  /** 变更的行标识（appId / featureKey / config key），'*' 表示整表失效 */
  key: string
}

export class ConfigChangeBus {
  private client: Client | null = null
  private connecting: Promise<void> | null = null
  private stopped = false
  private readonly listeners = new Set<(change: ConfigChange) => void>()
  private readonly allListeners = new Set<() => void>()
  private connectOptions: { connectionString: string }

  constructor(connectOptions: { connectionString: string }) {
    this.connectOptions = connectOptions
  }

  /** 订阅具体变更（按表/键失效） */
  onChange(listener: (change: ConfigChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 订阅"需要全量失效"的事件（连接建立/重建时触发） */
  onInvalidateAll(listener: () => void): () => void {
    this.allListeners.add(listener)
    return () => this.allListeners.delete(listener)
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.client) {
      await this.client.end().catch(() => undefined)
      this.client = null
    }
  }

  private async connect(): Promise<void> {
    if (this.client || this.stopped) return
    if (this.connecting) return this.connecting

    this.connecting = (async () => {
      const client = new Client(this.connectOptions)
      client.on("notification", (msg) => {
        const change = parsePayload(msg.payload)
        if (change) {
          for (const listener of this.listeners) listener(change)
        } else {
          // 无法解析的 payload，保守全量失效
          for (const listener of this.allListeners) listener()
        }
      })
      client.on("error", (error) => {
        logger.error({ span: "notify:error", msg: "LISTEN 连接错误", error: String(error) })
      })
      client.on("end", () => {
        this.client = null
        if (!this.stopped) {
          logger.warn({ span: "notify:reconnect", msg: "LISTEN 连接断开，5s 后重建" })
          setTimeout(() => this.connect().catch(() => undefined), 5000)
        }
      })
      await client.connect()
      await client.query(`LISTEN ${CONFIG_CHANGE_CHANNEL}`)
      this.client = client
      // 重建后全量失效，弥补离线期间的变更
      for (const listener of this.allListeners) listener()
      logger.info({ span: "notify:ready", msg: `LISTEN ${CONFIG_CHANGE_CHANNEL} 就绪` })
    })().finally(() => {
      this.connecting = null
    })

    return this.connecting
  }

  /**
   * 发布变更通知。传入 drizzle 事务/连接的底层 client 时随事务提交；
   * 传 Pool 时立即发送（非事务场景）。
   */
  static async publish(
    executor: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
    change: ConfigChange,
  ): Promise<void> {
    await executor.query(`SELECT pg_notify($1, $2)`, [CONFIG_CHANGE_CHANNEL, JSON.stringify(change)])
  }
}

function parsePayload(payload: string | null | undefined): ConfigChange | null {
  if (!payload) return null
  try {
    const raw = JSON.parse(payload) as { table?: unknown; key?: unknown }
    if (typeof raw.table === "string" && typeof raw.key === "string") {
      return { table: raw.table, key: raw.key }
    }
    return null
  } catch {
    return null
  }
}
