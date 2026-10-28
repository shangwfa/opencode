/**
 * 结构化 JSON 日志（对齐原网关 ELK 字段：span/traceId/domain/reqPath/duration…）。
 * 控制台 + 按日轮转文件（GATEWAY_LOG_FILE=off 关闭；默认 log/ 目录、保留 14 天，
 * 对齐原 winston-daily-rotate-file 语义）。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { getLogLevel } from "./config/env.js"

export interface LogFields {
  span?: string
  traceId?: string
  domain?: string
  reqPath?: string
  duration?: number
  error?: string
  [key: string]: unknown
}

type Level = "debug" | "info" | "warn" | "error"

const LEVEL_WEIGHT: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
let minWeight = LEVEL_WEIGHT[getLogLevel()]

export function setLogLevel(level: Level): void {
  minWeight = LEVEL_WEIGHT[level]
}

function write(level: Level, msg: string, fields: LogFields = {}): void {
  if (LEVEL_WEIGHT[level] < minWeight) return
  const record = {
    level,
    time: new Date().toISOString(),
    service: "hn-gateway",
    msg,
    ...fields,
  }
  const line = JSON.stringify(record)
  if (level === "error") console.error(line)
  else if (level === "warn") console.warn(line)
  else console.log(line)
  appendToRotatedFile(line)
}

// ── 按日轮转文件（轻量实现，避免 winston 重依赖）──

const RETENTION_DAYS = 14
let lastCleanupDay = ""

function logDir(): string | null {
  if (process.env["GATEWAY_LOG_FILE"] === "off") return null
  return process.env["GATEWAY_LOG_DIR"] || "log"
}

function appendToRotatedFile(line: string): void {
  const dir = logDir()
  if (!dir) return
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const day = new Date().toISOString().slice(0, 10)
    appendFileSync(join(dir, `application-${day}.log`), line + "\n")
    if (lastCleanupDay !== day) {
      lastCleanupDay = day
      cleanupRotatedLogs(dir)
    }
  } catch {
    // 文件写入失败不影响主流程
  }
}

/** 清理超过保留期（14 天）的旧日志文件（导出便于测试） */
export function cleanupRotatedLogs(dir: string): void {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  const today = new Date().toISOString().slice(0, 10)
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const match = /^application-(\d{4}-\d{2}-\d{2})\.log$/.exec(name)
    if (!match) continue
    const fileTime = new Date(`${match[1]}T00:00:00Z`).getTime()
    if (fileTime < cutoff && name !== `application-${today}.log`) {
      try {
        unlinkSync(join(dir, name))
      } catch {
        // 忽略删除失败
      }
    }
  }
}

export const logger = {
  debug: (fieldsOrMsg: LogFields | string, maybeMsg?: string) =>
    emit("debug", fieldsOrMsg, maybeMsg),
  info: (fieldsOrMsg: LogFields | string, maybeMsg?: string) => emit("info", fieldsOrMsg, maybeMsg),
  warn: (fieldsOrMsg: LogFields | string, maybeMsg?: string) => emit("warn", fieldsOrMsg, maybeMsg),
  error: (fieldsOrMsg: LogFields | string, maybeMsg?: string) => emit("error", fieldsOrMsg, maybeMsg),
}

function emit(level: Level, fieldsOrMsg: LogFields | string, maybeMsg?: string): void {
  if (typeof fieldsOrMsg === "string") write(level, fieldsOrMsg)
  else {
    const { msg, ...rest } = fieldsOrMsg
    write(level, maybeMsg ?? (msg as string) ?? "", rest as LogFields)
  }
}
