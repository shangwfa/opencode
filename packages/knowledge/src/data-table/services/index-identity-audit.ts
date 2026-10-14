import { getKnowledgeBaseIndexName } from "../../utils/index-name.js"

export interface IndexOwner {
  domain: "data-table" | "rag"
  id: string
  indexName?: string | null
}

/** 只分析注册表身份，不读取／修改向量内容；空 indexName 沿用当前实现的默认计算。 */
export function findIndexCollisions(owners: IndexOwner[]) {
  const groups = new Map<string, IndexOwner[]>()
  for (const owner of owners) {
    const name = owner.indexName || getKnowledgeBaseIndexName(owner.id)
    const group = groups.get(name) ?? []
    group.push(owner)
    groups.set(name, group)
  }
  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([indexName, group]) => ({ indexName, owners: group }))
    .sort((a, b) => a.indexName.localeCompare(b.indexName))
}
