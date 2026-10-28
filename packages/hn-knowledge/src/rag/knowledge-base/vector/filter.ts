/**
 * MongoDB 风格 metadata filter → PostgreSQL SQL 转换。
 *
 * 语义与 @mastra/pg 的 PGFilterTranslator / buildFilterQuery 对齐：
 * - 顶层字段简写 { field: value } ⇒ metadata#>>'{field}' = $n
 * - 操作符对象 { field: { $gt: 1 } }
 * - 逻辑操作符 $and / $or / $not / $nor（含嵌套）
 * - 数组操作符 $in / $nin / $all / $elemMatch / $size
 * - 其它：$eq $ne $gt $gte $lt $lte $exists $regex $contains
 * - 字段路径支持点号嵌套（a.b ⇒ metadata#>>'{a,b}'）
 */

export interface FilterBuildResult {
  /** 形如 "WHERE ..." 或 ""（无过滤条件时） */
  sql: string
  values: unknown[]
}

const parseJsonPathKey = (key: string): string => (key !== "" ? key.replace(/\./g, ",") : "")

function escapeLikePattern(str: string): string {
  return str.replace(/([%_\\])/g, "\\$1")
}

type OperatorFn = (key: string, paramIndex: number, value?: any) => { sql: string; needsValue: boolean; transformValue?: () => any }

const createBasicOperator =
  (symbol: string): OperatorFn =>
  (key, paramIndex) => {
    const jsonPathKey = parseJsonPathKey(key)
    return {
      sql: `CASE 
        WHEN $${paramIndex}::text IS NULL THEN metadata#>>'{${jsonPathKey}}' IS ${symbol === "=" ? "" : "NOT"} NULL
        ELSE metadata#>>'{${jsonPathKey}}' ${symbol} $${paramIndex}::text
      END`,
      needsValue: true,
    }
  }

const createNumericOperator =
  (symbol: string): OperatorFn =>
  (key, paramIndex, value) => {
    const jsonPathKey = parseJsonPathKey(key)
    const isNumeric = typeof value === "number" || (typeof value === "string" && !isNaN(Number(value)) && value.trim() !== "")
    if (isNumeric) {
      return {
        sql: `(metadata#>>'{${jsonPathKey}}')::numeric ${symbol} $${paramIndex}::numeric`,
        needsValue: true,
      }
    }
    return {
      sql: `metadata#>>'{${jsonPathKey}}' ${symbol} $${paramIndex}::text`,
      needsValue: true,
    }
  }

function buildElemMatchConditions(value: any, paramIndex: number): { sql: string; values: unknown[] } {
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("$elemMatch requires an object with conditions")
  }
  const conditions: string[] = []
  const values: unknown[] = []
  Object.entries(value).forEach(([field, val]) => {
    const nextParamIndex = paramIndex + values.length
    let paramOperator: string
    let paramKey: string
    let paramValue: any
    if (field.startsWith("$")) {
      paramOperator = field
      paramKey = ""
      paramValue = val
    } else if (typeof val === "object" && !Array.isArray(val)) {
      const [op, opValue] = Object.entries(val || {})[0] || []
      paramOperator = op as string
      paramKey = field
      paramValue = opValue
    } else {
      paramOperator = "$eq"
      paramKey = field
      paramValue = val
    }
    const operatorFn = FILTER_OPERATORS[paramOperator]
    if (!operatorFn) {
      throw new Error(`Invalid operator: ${paramOperator}`)
    }
    const result = operatorFn(paramKey, nextParamIndex, paramValue)
    const sql = result.sql.replaceAll("metadata#>>", "elem#>>")
    conditions.push(sql)
    if (result.needsValue) {
      values.push(paramValue)
    }
  })
  return {
    sql: conditions.join(" AND "),
    values,
  }
}

const FILTER_OPERATORS: Record<string, OperatorFn> = {
  $eq: createBasicOperator("="),
  $ne: createBasicOperator("!="),
  $gt: createNumericOperator(">"),
  $gte: createNumericOperator(">="),
  $lt: createNumericOperator("<"),
  $lte: createNumericOperator("<="),
  // Array Operators
  $in: (key, paramIndex) => {
    const jsonPathKey = parseJsonPathKey(key)
    return {
      sql: `(
        CASE
          WHEN jsonb_typeof(metadata->'${jsonPathKey}') = 'array' THEN
            EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(metadata->'${jsonPathKey}') as elem
              WHERE elem = ANY($${paramIndex}::text[])
            )
          ELSE metadata#>>'{${jsonPathKey}}' = ANY($${paramIndex}::text[])
        END
      )`,
      needsValue: true,
    }
  },
  $nin: (key, paramIndex) => {
    const jsonPathKey = parseJsonPathKey(key)
    return {
      sql: `(
        CASE
          WHEN jsonb_typeof(metadata->'${jsonPathKey}') = 'array' THEN
            NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(metadata->'${jsonPathKey}') as elem
              WHERE elem = ANY($${paramIndex}::text[])
            )
          ELSE metadata#>>'{${jsonPathKey}}' != ALL($${paramIndex}::text[])
        END
      )`,
      needsValue: true,
    }
  },
  $all: (key, paramIndex) => {
    const jsonPathKey = parseJsonPathKey(key)
    return {
      sql: `CASE WHEN array_length($${paramIndex}::text[], 1) IS NULL THEN false 
            ELSE (metadata#>'{${jsonPathKey}}')::jsonb ?& $${paramIndex}::text[] END`,
      needsValue: true,
    }
  },
  $elemMatch: (key, paramIndex, value) => {
    const { sql, values } = buildElemMatchConditions(value, paramIndex)
    const jsonPathKey = parseJsonPathKey(key)
    return {
      sql: `(
        CASE
          WHEN jsonb_typeof(metadata->'${jsonPathKey}') = 'array' THEN
            EXISTS (
              SELECT 1 
              FROM jsonb_array_elements(metadata->'${jsonPathKey}') as elem
              WHERE ${sql}
            )
          ELSE FALSE
        END
      )`,
      needsValue: true,
      transformValue: () => values,
    }
  },
  // Element Operators
  $exists: (key) => {
    const jsonPathKey = parseJsonPathKey(key)
    return {
      sql: `metadata ? '${jsonPathKey}'`,
      needsValue: false,
    }
  },
  // Logical Operators（key 位置传入的是已拼好的 SQL 片段）
  $and: (key) => ({ sql: `(${key})`, needsValue: false }),
  $or: (key) => ({ sql: `(${key})`, needsValue: false }),
  $not: (key) => ({ sql: `NOT (${key})`, needsValue: false }),
  $nor: (key) => ({ sql: `NOT (${key})`, needsValue: false }),
  // Regex Operators
  $regex: (key, paramIndex) => {
    const jsonPathKey = parseJsonPathKey(key)
    return {
      sql: `metadata#>>'{${jsonPathKey}}' ~ $${paramIndex}`,
      needsValue: true,
    }
  },
  $contains: (key, paramIndex, value) => {
    const jsonPathKey = parseJsonPathKey(key)
    let sql: string
    if (Array.isArray(value)) {
      sql = `(metadata->'${jsonPathKey}') ?& $${paramIndex}`
    } else if (typeof value === "string") {
      sql = `metadata->>'${jsonPathKey}' ILIKE '%' || $${paramIndex} || '%' ESCAPE '\\'`
    } else {
      sql = `metadata->>'${jsonPathKey}' = $${paramIndex}`
    }
    return {
      sql,
      needsValue: true,
      transformValue: () => (Array.isArray(value) ? value.map(String) : typeof value === "string" ? escapeLikePattern(value) : value),
    }
  },
  $size: (key, paramIndex) => {
    const jsonPathKey = parseJsonPathKey(key)
    return {
      sql: `(
      CASE
        WHEN jsonb_typeof(metadata#>'{${jsonPathKey}}') = 'array' THEN 
          jsonb_array_length(metadata#>'{${jsonPathKey}}') = $${paramIndex}
        ELSE FALSE
      END
    )`,
      needsValue: true,
    }
  },
}

/** 通用的条件构建（values 收集由调用方管理参数下标） */
function createConditionBuilder(options: { leadingParams: number[] }) {
  const values: unknown[] = [...options.leadingParams]

  function buildCondition(key: string, value: any): string {
    if (["$and", "$or", "$not", "$nor"].includes(key)) {
      return handleLogicalOperator(key, value)
    }
    if (!value || typeof value !== "object") {
      values.push(value)
      return `metadata#>>'{${parseJsonPathKey(key)}}' = $${values.length}`
    }
    const [[operator, operatorValue] = []] = Object.entries(value)
    if (operator === "$not") {
      const entries = Object.entries(operatorValue as Record<string, unknown>)
      const conditions = entries
        .map(([nestedOp, nestedValue]) => {
          if (!FILTER_OPERATORS[nestedOp]) {
            throw new Error(`Invalid operator in $not condition: ${nestedOp}`)
          }
          const operatorFn = FILTER_OPERATORS[nestedOp]
          const operatorResult = operatorFn(key, values.length + 1, nestedValue)
          if (operatorResult.needsValue) {
            values.push(nestedValue)
          }
          return operatorResult.sql
        })
        .join(" AND ")
      return `NOT (${conditions})`
    }
    const operatorFn = FILTER_OPERATORS[operator as string]
    if (!operatorFn) {
      throw new Error(`Invalid operator: ${operator}`)
    }
    const operatorResult = operatorFn(key, values.length + 1, operatorValue)
    if (operatorResult.needsValue) {
      const transformedValue = operatorResult.transformValue ? operatorResult.transformValue() : operatorValue
      if (Array.isArray(transformedValue) && operator === "$elemMatch") {
        values.push(...(transformedValue as unknown[]))
      } else {
        values.push(transformedValue)
      }
    }
    return operatorResult.sql
  }

  function handleLogicalOperator(key: string, value: any): string {
    if (key === "$not") {
      const entries = Object.entries(value as Record<string, unknown>)
      const conditions = entries.map(([fieldKey, fieldValue]) => buildCondition(fieldKey, fieldValue)).join(" AND ")
      return `NOT (${conditions})`
    }
    if (!value || value.length === 0) {
      switch (key) {
        case "$and":
        case "$nor":
          return "true" // Empty $and/$nor match everything
        case "$or":
          return "false" // Empty $or matches nothing
        default:
          return "true"
      }
    }
    const joinOperator = key === "$or" || key === "$nor" ? "OR" : "AND"
    const conditions = (value as unknown[])
      .map((f) => {
        const entries = Object.entries((f || {}) as Record<string, unknown>)
        if (entries.length === 0) return ""
        const [firstKey, firstValue] = entries[0] || []
        if (["$and", "$or", "$not", "$nor"].includes(firstKey)) {
          return buildCondition(firstKey, firstValue)
        }
        return entries.map(([k, v]) => buildCondition(k, v)).join(` ${joinOperator} `)
      })
      .join(` ${joinOperator} `)
    const operatorFn = FILTER_OPERATORS[key]
    return operatorFn(conditions, 0, value).sql
  }

  return { buildCondition, values }
}

/**
 * 向量检索过滤（参数 $1 = minScore, $2 = topK 由调用方占用）
 */
export function buildFilterQuery(filter: Record<string, any> | undefined, minScore: number, topK: number): FilterBuildResult {
  const { buildCondition, values } = createConditionBuilder({ leadingParams: [minScore, topK] })
  if (!filter) {
    return { sql: "", values }
  }
  const conditions = Object.entries(filter)
    .map(([key, value]) => buildCondition(key, value))
    .filter(Boolean)
    .join(" AND ")
  return { sql: conditions ? `WHERE ${conditions}` : "", values }
}

/**
 * 删除前过滤（无 minScore / topK 占位参数）
 */
export function buildDeleteFilterQuery(filter: Record<string, any> | undefined): FilterBuildResult {
  const { buildCondition, values } = createConditionBuilder({ leadingParams: [] })
  if (!filter) {
    return { sql: "", values }
  }
  const conditions = Object.entries(filter)
    .map(([key, value]) => buildCondition(key, value))
    .filter(Boolean)
    .join(" AND ")
  return { sql: conditions ? `WHERE ${conditions}` : "", values }
}
