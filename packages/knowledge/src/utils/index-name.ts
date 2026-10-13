/**
 * 索引名称工具函数
 * PostgreSQL索引名称只能包含字母、数字和下划线，且必须以字母或下划线开头
 */

/**
 * 规范化索引名称
 * @param name - 原始名称
 * @returns 规范化后的名称
 */
export function normalizeIndexName(name: string): string {
  // 将所有非字母数字字符替换为下划线
  let normalized = name.replace(/[^a-zA-Z0-9_]/g, '_')
  // 确保以字母或下划线开头
  if (normalized.length > 0 && /^[0-9]/.test(normalized)) {
    normalized = '_' + normalized
  }
  // 转换为小写（PostgreSQL会将未加引号的标识符转换为小写）
  normalized = normalized.toLowerCase()
  // 限制长度为63字符（PostgreSQL限制）
  if (normalized.length > 63) {
    normalized = normalized.substring(0, 63)
  }
  return normalized
}

/**
 * 获取知识库的索引名称
 * @param knowledgeBaseId - 知识库ID（可能已经包含kb_前缀）
 * @returns 规范化后的索引名称（格式：kb_<normalized_id>）
 */
export function getKnowledgeBaseIndexName(knowledgeBaseId: string): string {
  // 如果知识库ID已经包含kb_前缀，先移除
  const idWithoutPrefix = knowledgeBaseId.startsWith('kb_') 
    ? knowledgeBaseId.substring(3) 
    : knowledgeBaseId
  // 规范化ID
  const normalizedId = normalizeIndexName(idWithoutPrefix)
  // 加上kb_前缀
  return `kb_${normalizedId}`
}

