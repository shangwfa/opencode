/**
 * 时间衰减配置文件
 *
 * 用于控制搜索结果中时间权重的衰减策略
 * 可以通过修改此文件来调整衰减参数，无需修改代码
 */

import type { TimeDecayConfig } from '../utils/time-decay.js'

/**
 * 当前激活的时间衰减策略
 *
 * 可选值：
 * - 'conservative': 保守策略（低权重、慢衰减）- 适合稳定的技术文档（当前配置）
 * - 'balanced': 平衡策略（中等权重、中等衰减）- 适合一般知识库
 * - 'aggressive': 激进策略（高权重、快衰减）- 适合频繁更新的业务文档
 * - 'custom': 自定义策略（需要在 customConfig 中配置）
 */
export const CURRENT_TIME_DECAY_STRATEGY: 'conservative' | 'balanced' | 'aggressive' | 'custom' =
  'conservative'

/**
 * 自定义衰减配置
 * 仅当 CURRENT_TIME_DECAY_STRATEGY 设置为 'custom' 时生效
 */
export const customTimeDecayConfig: TimeDecayConfig = {
  /** 最高权重（0-1之间） */
  maxBonus: 0.08,
  /** 半衰期天数 */
  halfLifeDays: 30,
  /** 最小阈值，低于此值返回0 */
  minThreshold: 0.005
}

/**
 * 是否启用时间衰减
 *
 * 设置为 false 可以完全禁用时间权重，仅依赖相关性评分
 */
export const ENABLE_TIME_DECAY = true

/**
 * 获取当前激活的衰减配置
 *
 * @returns 当前使用的衰减配置
 *
 * @example
 * ```typescript
 * import { getActiveTimeDecayConfig } from './config/time-decay.config.js'
 *
 * const config = getActiveTimeDecayConfig()
 * console.log(`最高权重: ${config.maxBonus}, 半衰期: ${config.halfLifeDays}天`)
 * ```
 */
export function getActiveTimeDecayConfig(): TimeDecayConfig {
  // 如果禁用时间衰减，返回零配置
  if (!ENABLE_TIME_DECAY) {
    return {
      maxBonus: 0,
      halfLifeDays: 1,
      minThreshold: 0
    }
  }

  // 根据策略返回对应配置
  switch (CURRENT_TIME_DECAY_STRATEGY) {
    case 'conservative':
      return {
        maxBonus: 0.05,
        halfLifeDays: 90,
        minThreshold: 0.002
      }

    case 'balanced':
      return {
        maxBonus: 0.08,
        halfLifeDays: 30,
        minThreshold: 0.005
      }

    case 'aggressive':
      return {
        maxBonus: 0.12,
        halfLifeDays: 15,
        minThreshold: 0.01
      }

    case 'custom':
      return customTimeDecayConfig

    default:
      // 默认使用平衡策略
      return {
        maxBonus: 0.08,
        halfLifeDays: 30,
        minThreshold: 0.005
      }
  }
}

/**
 * 不同文档类型的专用配置
 *
 * 针对不同类型的文档使用不同的衰减策略
 * 在 rerank 时可以根据文档类型动态选择配置
 */
export const DocumentTypeConfigs = {
  /** API 文档：慢衰减，低权重（稳定内容） */
  api: {
    maxBonus: 0.05,
    halfLifeDays: 90,
    minThreshold: 0.002
  } as TimeDecayConfig,

  /** 产品文档：中等衰减，中等权重 */
  product: {
    maxBonus: 0.08,
    halfLifeDays: 45,
    minThreshold: 0.005
  } as TimeDecayConfig,

  /** 新闻公告：快衰减，高权重（时效性强） */
  news: {
    maxBonus: 0.15,
    halfLifeDays: 7,
    minThreshold: 0.01
  } as TimeDecayConfig,

  /** 操作指南：慢衰减，低权重 */
  guide: {
    maxBonus: 0.05,
    halfLifeDays: 120,
    minThreshold: 0.002
  } as TimeDecayConfig
} as const

/**
 * 根据文档类型获取衰减配置
 *
 * @param docType 文档类型（api | product | news | guide）
 * @returns 对应的衰减配置
 *
 * @example
 * ```typescript
 * import { getTimeDecayConfigByDocType } from './config/time-decay.config.js'
 *
 * const config = getTimeDecayConfigByDocType('api')
 * // { maxBonus: 0.05, halfLifeDays: 90, minThreshold: 0.002 }
 * ```
 */
export function getTimeDecayConfigByDocType(
  docType: keyof typeof DocumentTypeConfigs
): TimeDecayConfig {
  return DocumentTypeConfigs[docType] || getActiveTimeDecayConfig()
}

/**
 * A/B 测试配置
 *
 * 用于支持多版本衰减策略的A/B测试
 */
export const ABTestConfigs = {
  /** 版本 A：原始分段策略（对照） */
  versionA: {
    name: '分段策略',
    description: '原始的分段式加分（7天10%, 30天5%）',
    type: 'legacy' as const
  },

  /** 版本 B：指数衰减 - 平衡策略 */
  versionB: {
    name: '指数衰减-平衡',
    description: '指数衰减，8%最高权重，30天半衰期',
    type: 'exponential' as const,
    config: {
      maxBonus: 0.08,
      halfLifeDays: 30,
      minThreshold: 0.005
    } as TimeDecayConfig
  },

  /** 版本 C：指数衰减 - 保守策略 */
  versionC: {
    name: '指数衰减-保守',
    description: '指数衰减，5%最高权重，90天半衰期',
    type: 'exponential' as const,
    config: {
      maxBonus: 0.05,
      halfLifeDays: 90,
      minThreshold: 0.002
    } as TimeDecayConfig
  }
} as const

/**
 * A/B 测试流量分配
 *
 * 控制不同版本的流量分配比例（总和应为 1.0）
 */
export const ABTestTrafficAllocation = {
  versionA: 0.1, // 10% 流量使用原始策略
  versionB: 0.7, // 70% 流量使用指数衰减-平衡策略
  versionC: 0.2  // 20% 流量使用指数衰减-保守策略
} as const

/**
 * 根据 A/B 测试配置获取衰减策略
 *
 * @param userId 用户ID（用于确定分配到哪个版本）
 * @returns A/B 测试版本配置
 *
 * @example
 * ```typescript
 * import { getABTestVersion } from './config/time-decay.config.js'
 *
 * const version = getABTestVersion('user-123')
 * console.log(version.name) // "指数衰减-平衡"
 * ```
 */
export function getABTestVersion(userId: string): keyof typeof ABTestConfigs {
  // 简单的哈希分配（生产环境可以使用更复杂的算法）
  const hash = userId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
  const ratio = (hash % 100) / 100

  if (ratio < ABTestTrafficAllocation.versionA) {
    return 'versionA'
  } else if (ratio < ABTestTrafficAllocation.versionA + ABTestTrafficAllocation.versionB) {
    return 'versionB'
  } else {
    return 'versionC'
  }
}
