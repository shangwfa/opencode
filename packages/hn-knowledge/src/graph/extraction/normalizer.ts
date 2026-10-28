import type { CombinedExtraction, ExtractedTriplet } from './schemas.js'

/** 将同义关系收敛到稳定的业务关系名。未知关系保留，避免丢失事实。 */
const RELATION_ALIASES: Record<string, string> = {
  '核心功能': '包含',
  '功能包括': '包含',
  '拥有功能': '包含',
  '包括': '包含',
  '最新版本为': '版本为',
  '当前版本为': '版本为',
  '版本是': '版本为',
  '竞品': '竞争对手',
  '竞争产品': '竞争对手',
  '对比': '对比对象',
  '核心特点': '核心能力',
  '主要能力': '核心能力',
  '主要特点': '核心能力',
  '能力包括': '核心能力',
}

export function normalizeEntityName(name: string): string {
  // 剥离 markdown 残留（**加粗**、# 标题、- 列表符）与收尾标点，避免"**06 知识"这类脏实体名
  return name
    .trim()
    .replace(/^[*#>\-•·\s]+/, '')
    .replace(/[*#>\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeRelationName(relation: string): string {
  const normalized = relation.trim().replace(/\s+/g, '')
  return RELATION_ALIASES[normalized] || normalized
}

/**
 * 清洗 LLM 输出：合并同名实体、统一关系名、去除悬空/自环/重复三元组。
 * 事实冲突不在这里删除，交给时间冲突处理器保留并标记历史。
 */
export function normalizeExtraction(extraction: CombinedExtraction): CombinedExtraction {
  const entitiesByName = new Map<string, CombinedExtraction['entities'][number]>()
  const aliases = new Map<string, string>()

  for (const entity of extraction.entities) {
    const name = normalizeEntityName(entity.name)
    if (!name) continue
    const key = name.toLocaleLowerCase()
    aliases.set(key, name)
    const existing = entitiesByName.get(key)
    if (!existing) {
      entitiesByName.set(key, { ...entity, name })
      continue
    }
    if ((entity.description || '').length > (existing.description || '').length) {
      existing.description = entity.description
    }
  }

  const tripletsByKey = new Map<string, ExtractedTriplet>()
  for (const triplet of extraction.triplets) {
    const sourceKey = normalizeEntityName(triplet.source).toLocaleLowerCase()
    const targetKey = normalizeEntityName(triplet.target).toLocaleLowerCase()
    const source = aliases.get(sourceKey)
    const target = aliases.get(targetKey)
    const relation = normalizeRelationName(triplet.relation)
    const confidence = Math.max(0, Math.min(1, Number(triplet.confidence) || 0))
    if (!source || !target || !relation || source === target) continue

    const normalized: ExtractedTriplet = {
      ...triplet,
      source,
      target,
      relation,
      confidence,
    }
    const key = `${source.toLocaleLowerCase()}|${relation}|${target.toLocaleLowerCase()}`
    const existing = tripletsByKey.get(key)
    if (!existing || normalized.confidence > existing.confidence) {
      tripletsByKey.set(key, normalized)
    }
  }

  return {
    entities: [...entitiesByName.values()],
    triplets: [...tripletsByKey.values()],
  }
}
