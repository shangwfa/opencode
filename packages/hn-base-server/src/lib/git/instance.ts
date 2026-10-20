/**
 * 加载 Git 实例 + 解密凭据 + 构造客户端（供多个路由复用）。
 */
import { eq } from "drizzle-orm"
import type { DB } from "../../db/index.js"
import { gitCredential, gitProviderInstance } from "../../db/schema.js"
import { decryptSecret } from "../crypto.js"
import { errors } from "../errors.js"
import { createGitClient } from "./client.js"
import type { GitProviderClient, GitProviderType } from "./types.js"

export type LoadedGit = {
  instance: typeof gitProviderInstance.$inferSelect
  token: string
  client: GitProviderClient
}

export async function loadGitInstance(db: DB, instanceId: string): Promise<LoadedGit> {
  const rows = await db.select().from(gitProviderInstance).where(eq(gitProviderInstance.id, instanceId)).limit(1)
  const instance = rows[0]
  if (!instance) throw errors.notFound("git_provider")

  const creds = await db
    .select()
    .from(gitCredential)
    .where(eq(gitCredential.providerInstanceId, instanceId))
    .limit(1)
  const cred = creds[0]
  if (!cred) throw errors.internal("Git 凭据缺失")

  let token: string
  try {
    token = decryptSecret(cred.secretEncrypted)
  } catch {
    throw errors.internal("Git 凭据解密失败（密钥可能已轮换）")
  }

  const client = createGitClient(instance.type as GitProviderType, {
    baseUrl: instance.baseUrl,
    apiBaseUrl: instance.apiBaseUrl,
    token,
  })
  return { instance, token, client }
}
