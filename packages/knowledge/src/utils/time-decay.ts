/**
 * 时间衰减工具函数
 * 用于计算基于时间衰减的权重分数
 * 参考 Elasticsearch decay functions 实现
 */

/**
 * 时间衰减配置接口
 */
export interface TimeDecayConfig {
  /** 最高权重（0-1之间） */
  maxBonus: number
  /** 半衰期天数 */
  halfLifeDays: number
  /** 最小阈值，低于此值返回0 */
  minThreshold: number
}

/**
 * 时间衰减策略预设
 */
export const TimeDecayStrategies = {
  /** 保守策略：低权重、慢衰减（适合稳定的技术文档） */
  conservative: {
    maxBonus: 0.05,
    halfLifeDays: 90,
    minThreshold: 0.002
  } as TimeDecayConfig,

  /** 平衡策略：中等权重、中等衰减（推荐，适合一般知识库） */
  balanced: {
    maxBonus: 0.08,
    halfLifeDays: 30,
    minThreshold: 0.005
  } as TimeDecayConfig,

  /** 激进策略：高权重、快衰减（适合频繁更新的业务文档） */
  aggressive: {
    maxBonus: 0.12,
    halfLifeDays: 15,
    minThreshold: 0.01
  } as TimeDecayConfig
} as const

/**
 * 默认配置（平衡策略）
 */
export const DEFAULT_TIME_DECAY_CONFIG = TimeDecayStrategies.balanced

/**
 * 计算指数衰减权重
 *
 * 使用指数衰减公式：score = maxBonus × (1/2)^(daysSinceSync / halfLifeDays)
 *
 * @param syncedAt ISO 8601 格式的时间字符串
 * @param config 衰减配置
 * @returns 衰减后的权重分数（0-config.maxBeta）
 *
 * @example
 * ```typescript
 * // 使用默认配置
 * const bonus = calculateTimeDecayBonus('2025-01-01T00:00:00Z')
 *
 * // 使用自定义配置
 * const bonus = calculateTimeDecayBonus('2025-01-01T00:00:00Z', {
 *   maxBonus: 0.1,
 *   halfLifeDays: 30,
 *   minThreshold: 0.005
 * })
 *
 * // 使用预设策略
 * const bonus = calculateTimeDecayBonus(
 *   '2025-01-01T00:00:00Z',
 *   TimeDecayStrategies.balanced
 * )
 * ```
 */
export function calculateTimeDecayBonus(
  syncedAt: string,
  config: TimeDecayConfig = DEFAULT_TIME_DECAY_CONFIG
): number {
  const { maxBonus, halfLifeDays, minThreshold } = config

  // 解析同步时间
  const syncDate = new Date(syncedAt)
  const now = new Date()

  // 计算距离同步的天数
  const daysSinceSync = (now.getTime() - syncDate.getTime()) / (1000 * 60 * 60 * 24)

  // 边界情况：未来时间（时钟不同步等）
  if (daysSinceSync < 0) {
    return maxBonus
  }

  // 指数衰减公式：(1/2)^(天数/半衰期)
  const decayFactor = Math.pow(0.5, daysSinceSync / halfLifeDays)
  const timeBonus = maxBonus * decayFactor

  // 阈值截断：太小的权重忽略不计
  return timeBonus > minThreshold ? timeBonus : 0
}

/**
 * 计算高斯衰减权重（替代方案）
 *
 * 使用高斯衰减公式：score = maxBonus × e^(-(days/σ)^2 / 2)
 *
 * @param syncedAt ISO 8601 格式的时间字符串
 * @param maxBonus 最高权重
 * @param sigma 标准差（控制衰减速度）
 * @param minThreshold 最小阈值
 * @returns 衰减后的权重分数
 *
 * @example
 * ```typescript
 * const bonus = calculateGaussianDecayBonus('2025-01-01T00:00:00Z', 0.1, 30, 0.005)
 * ```
 */
export function calculateGaussianDecayBonus(
  syncedAt: string,
  maxBonus: number = 0.08,
  sigma: number = 30,
  minThreshold: number = 0.005
): number {
  const syncDate = new Date(syncedAt)
  const now = new Date()
  const daysSinceSync = (now.getTime() - syncDate.getTime()) / (1000 * 60 * 60 * 24)

  if (daysSinceSync < 0) {
    return maxBonus
  }

  // 高斯衰减公式：e^(-(x/σ)^2 / 2)
  const decayFactor = Math.exp(-Math.pow(daysSinceSync, 2) / (2 * Math.pow(sigma, 2)))
  const timeBonus = maxBonus * decayFactor

  return timeBonus > minThreshold ? timeBonus : 0
}

/**
 * 计算线性衰减权重（简化方案）
 *
 * 使用线性衰减公式：score = maxBonus × max(0, 1 - days/decayPeriod)
 *
 * @param syncedAt ISO 8601 格式的时间字符串
 * @param maxBonus 最高权重
 * @param decayPeriod 衰减周期（天数）
 * @returns 衰减后的权重分数
 *
 * @example
 * ```typescript
 * const bonus = calculateLinearDecayBonus('2025-01-01T00:00:00Z', 0.1, 90)
 * ```
 */
export function calculateLinearDecayBonus(
  syncedAt: string,
  maxBonus: number = 0.08,
  decayPeriod: number = 90
): number {
  const syncDate = new Date(syncedAt)
  const now = new Date()
  const daysSinceSync = (now.getTime() - syncDate.getTime()) / (1000 * 60 * 60 * 24)

  if (daysSinceSync < 0) {
    return maxBonus
  }

  // 线性衰减公式：max(0, 1 - x/period)
  const decayFactor = Math.max(0, 1 - daysSinceSync / decayPeriod)
  const timeBonus = maxBonus * decayFactor

  return timeBonus
}

/**
 * 获取衰减配置信息（用于调试和监控）
 *
 * @param syncedAt ISO 8601 格式的时间字符串
 * @param config 衰减配置
 * @returns 衰减信息对象
 *
 * @example
 * ```typescript
 * const info = getTimeDecayInfo('2025-01-01T00:00:00Z')
 * console.log(info)
 * // {
 * //   syncedAt: '2025-01-01T00:00:00Z',
 * //   daysSinceSync: 25,
 * //   decayFactor: 0.56,
 * //   timeBonus: 0.045,
 * //   strategy: 'balanced'
 * // }
 * ```
 */
export function getTimeDecayInfo(
  syncedAt: string,
  config: TimeDecayConfig = DEFAULT_TIME_DECAY_CONFIG
): {
  syncedAt: string
  daysSinceSync: number
  decayFactor: number
  timeBonus: number
  maxBonus: number
  strategy: string
} {
  const { maxBonus, halfLifeDays } = config

  const syncDate = new Date(syncedAt)
  const now = new Date()
  const daysSinceSync = (now.getTime() - syncDate.getTime()) / (1000 * 60 * 60 * 24)

  const decayFactor = Math.pow(0.5, daysSinceSync / halfLifeDays)
  const timeBonus = calculateTimeDecayBonus(syncedAt, config)

  // 识别策略名称
  const strategyName =
    config === TimeDecayStrategies.conservative
      ? 'conservative'
      : config === TimeDecayStrategies.balanced
        ? 'balanced'
        : config === TimeDecayStrategies.aggressive
          ? 'aggressive'
          : 'custom'

  return {
    syncedAt,
    daysSinceSync: Math.round(daysSinceSync * 100) / 100,
    decayFactor: Math.round(decayFactor * 10000) / 10000,
    timeBonus: Math.round(timeBonus * 10000) / 10000,
    maxBonus,
    strategy: strategyName
  }
}
