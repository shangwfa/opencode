import { wikiCollections } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'

/** 集合存在则返回行，否则 null（供路由做 404 分支）。 */
export async function getCollectionOr404(collectionId: string) {
  const [collection] = await db.select().from(wikiCollections).where(eq(wikiCollections.id, collectionId)).limit(1)
  return collection ?? null
}
