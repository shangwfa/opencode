/**
 * 幂等创建 PostgreSQL schema。
 *
 * CREATE SCHEMA IF NOT EXISTS 在并发初始化时存在 pg_namespace 竞态
 * （duplicate key value violates unique constraint "pg_namespace_nspname_index"），
 * schema 已存在（42P06）或竞态冲突（23505）均视为成功。
 */
import type { Pool, PoolClient } from "pg"

export async function ensurePgSchema(executor: PoolClient | Pool, schemaName: string): Promise<void> {
  try {
    await executor.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`)
  } catch (error: any) {
    if (error.code !== "23505" && error.code !== "42P06") throw error
  }
}
