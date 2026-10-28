/**
 * 幂等初始化：schema + 全部表 + 索引。
 *
 * CREATE SCHEMA IF NOT EXISTS 在并发初始化时存在 pg_namespace 竞态
 * （duplicate key violates unique constraint），schema 已存在（42P06）
 * 或竞态冲突（23505）均视为成功（同 packages/knowledge 的处理）。
 */
import type { Pool, PoolClient } from "pg"

export async function ensurePgSchema(executor: PoolClient | Pool, schemaName: string): Promise<void> {
  try {
    await executor.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`)
  } catch (error: any) {
    if (error.code !== "23505" && error.code !== "42P06") throw error
  }
}

/** 表 DDL：全部幂等（IF NOT EXISTS），schema 名已由 env 层校验为合法标识符 */
export function tableDdls(schemaName: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${schemaName}.apps (
      app_id     varchar(255) PRIMARY KEY,
      domain     varchar(255) NOT NULL,
      base_route varchar(255) NOT NULL DEFAULT '',
      config     jsonb NOT NULL,
      enabled    boolean NOT NULL DEFAULT TRUE,
      version    integer NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS apps_domain_route_idx
      ON ${schemaName}.apps (domain, base_route)`,
    `CREATE TABLE IF NOT EXISTS ${schemaName}.gray_features (
      feature_key varchar(255) PRIMARY KEY,
      config      jsonb NOT NULL,
      version     integer NOT NULL DEFAULT 1,
      updated_at  timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS ${schemaName}.micro_apps (
      app_id      varchar(255) PRIMARY KEY,
      name        varchar(255) NOT NULL,
      baseroute   varchar(255) NOT NULL DEFAULT '',
      url         varchar(512) NOT NULL,
      micro_version varchar(255) NOT NULL DEFAULT '',
      iframe      boolean NOT NULL DEFAULT FALSE,
      destroy     boolean NOT NULL DEFAULT FALSE,
      config      jsonb NOT NULL DEFAULT '{}',
      enabled     boolean NOT NULL DEFAULT TRUE,
      row_version integer NOT NULL DEFAULT 1,
      updated_at  timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS ${schemaName}.configs (
      key        varchar(255) PRIMARY KEY,
      value      jsonb NOT NULL,
      version    integer NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS ${schemaName}.publishes (
      id              varchar(255) PRIMARY KEY,
      app_id          varchar(255) NOT NULL,
      env             varchar(64) NOT NULL,
      publish_version varchar(255) NOT NULL,
      status          varchar(32) NOT NULL DEFAULT 'running',
      operator        varchar(255),
      detail          jsonb NOT NULL DEFAULT '{}',
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS ${schemaName}.report_events (
      id         bigserial PRIMARY KEY,
      app_id     varchar(255),
      trace_id   varchar(128) NOT NULL,
      level      varchar(32) NOT NULL DEFAULT 'error',
      message    text,
      payload    jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS report_events_trace_idx
      ON ${schemaName}.report_events (trace_id, created_at)`,
  ]
}

export async function ensureGatewayTables(executor: PoolClient | Pool, schemaName: string): Promise<void> {
  await ensurePgSchema(executor, schemaName)
  for (const ddl of tableDdls(schemaName)) {
    await executor.query(ddl)
  }
}
