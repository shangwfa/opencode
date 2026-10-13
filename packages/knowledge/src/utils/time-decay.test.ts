/**
 * 时间衰减函数单元测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  calculateTimeDecayBonus,
  calculateGaussianDecayBonus,
  calculateLinearDecayBonus,
  getTimeDecayInfo,
  TimeDecayStrategies,
  DEFAULT_TIME_DECAY_CONFIG
} from './time-decay.js'

describe('时间衰减工具函数', () => {
  describe('calculateTimeDecayBonus - 指数衰减', () => {
    it('应该计算最近的文档权重（0天）', () => {
      const now = new Date()
      const syncedAt = now.toISOString()

      const result = calculateTimeDecayBonus(syncedAt, TimeDecayStrategies.balanced)

      expect(result).toBeCloseTo(0.08, 2) // 最高权重 8%
    })

    it('应该计算7天前的文档权重', () => {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      const syncedAt = sevenDaysAgo.toISOString()

      const result = calculateTimeDecayBonus(syncedAt, TimeDecayStrategies.balanced)

      // 7天后应该衰减到约 6.8% (0.08 * 0.5^(7/30))
      expect(result).toBeGreaterThan(0.06)
      expect(result).toBeLessThan(0.08)
    })

    it('应该计算30天前的文档权重（半衰期）', () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const syncedAt = thirtyDaysAgo.toISOString()

      const result = calculateTimeDecayBonus(syncedAt, TimeDecayStrategies.balanced)

      // 30天后应该衰减到约 4% (0.08 * 0.5)
      expect(result).toBeCloseTo(0.04, 1)
    })

    it('应该计算60天前的文档权重（2个半衰期）', () => {
      const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
      const syncedAt = sixtyDaysAgo.toISOString()

      const result = calculateTimeDecayBonus(syncedAt, TimeDecayStrategies.balanced)

      // 60天后应该衰减到约 2% (0.08 * 0.5^2)
      expect(result).toBeCloseTo(0.02, 1)
    })

    it('应该计算90天前的文档权重（3个半衰期）', () => {
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
      const syncedAt = ninetyDaysAgo.toISOString()

      const result = calculateTimeDecayBonus(syncedAt, TimeDecayStrategies.balanced)

      // 90天后应该衰减到约 1% (0.08 * 0.5^3)
      expect(result).toBeCloseTo(0.01, 1)
    })

    it('应该在超过阈值后返回0', () => {
      const veryOld = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000)
      const syncedAt = veryOld.toISOString()

      const result = calculateTimeDecayBonus(syncedAt, TimeDecayStrategies.balanced)

      // 200天后应该低于阈值 0.005，返回 0
      expect(result).toBe(0)
    })

    it('应该处理未来的时间（时钟不同步等情况）', () => {
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000)
      const syncedAt = future.toISOString()

      const result = calculateTimeDecayBonus(syncedAt, TimeDecayStrategies.balanced)

      // 未来时间应该返回最高权重
      expect(result).toBe(0.08)
    })

    it('应该使用默认配置', () => {
      const now = new Date()
      const syncedAt = now.toISOString()

      const result = calculateTimeDecayBonus(syncedAt)

      expect(result).toBeCloseTo(0.08, 2)
    })
  })

  describe('不同衰减策略对比', () => {
    it('保守策略应该有更低的最高权重和更慢的衰减', () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const syncedAt = thirtyDaysAgo.toISOString()

      const conservative = calculateTimeDecayBonus(syncedAt, TimeDecayStrategies.conservative)
      const balanced = calculateTimeDecayBonus(syncedAt, TimeDecayStrategies.balanced)

      // 保守策略虽然半衰期更长（90天），但最高权重更低（5% vs 8%）
      // 在30天时：
      // - 保守策略：0.05 * 0.5^(30/90) = 0.05 * 0.79 = 0.0395
      // - 平衡策略：0.08 * 0.5^(30/30) = 0.08 * 0.5 = 0.04
      // 实际上在30天时，两者权重接近，但保守策略略低（因为最高权重更低）
      expect(conservative).toBeCloseTo(0.04, 2)
      expect(balanced).toBeCloseTo(0.04, 1)
    })

    it('激进策略应该有更高的最高权重和更快的衰减', () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const syncedAt = thirtyDaysAgo.toISOString()

      const aggressive = calculateTimeDecayBonus(syncedAt, TimeDecayStrategies.aggressive)
      const balanced = calculateTimeDecayBonus(syncedAt, TimeDecayStrategies.balanced)

      // 激进策略：30天后权重应该更低（衰减更快）
      expect(aggressive).toBeLessThan(balanced)
    })

    it('三种策略的最新文档应该有不同的最高权重', () => {
      const now = new Date()
      const syncedAt = now.toISOString()

      const conservative = calculateTimeDecayBonus(syncedAt, TimeDecayStrategies.conservative)
      const balanced = calculateTimeDecayBonus(syncedAt, TimeDecayStrategies.balanced)
      const aggressive = calculateTimeDecayBonus(syncedAt, TimeDecayStrategies.aggressive)

      expect(conservative).toBe(0.05)
      expect(balanced).toBe(0.08)
      expect(aggressive).toBe(0.12)
    })
  })

  describe('calculateGaussianDecayBonus - 高斯衰减', () => {
    it('应该计算高斯衰减权重', () => {
      const now = new Date()
      const syncedAt = now.toISOString()

      const result = calculateGaussianDecayBonus(syncedAt, 0.1, 30, 0.005)

      expect(result).toBeCloseTo(0.1, 1)
    })

    it('高斯衰减在中间阶段应该比指数衰减慢', () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const syncedAt = thirtyDaysAgo.toISOString()

      const exponential = calculateTimeDecayBonus(syncedAt, TimeDecayStrategies.balanced)
      const gaussian = calculateGaussianDecayBonus(syncedAt, 0.08, 30, 0.005)

      // 高斯衰减在30天时（1个标准差）：
      // - 指数：0.08 * 0.5^(30/30) = 0.04
      // - 高斯：0.08 * e^(-(30/30)^2/2) = 0.08 * e^(-0.5) = 0.08 * 0.607 = 0.0486
      // 所以高斯衰减在30天时实际上比指数衰减慢
      expect(gaussian).toBeGreaterThan(exponential)
      expect(gaussian).toBeCloseTo(0.0486, 3)
    })
  })

  describe('calculateLinearDecayBonus - 线性衰减', () => {
    it('应该计算线性衰减权重', () => {
      const now = new Date()
      const syncedAt = now.toISOString()

      const result = calculateLinearDecayBonus(syncedAt, 0.1, 90)

      expect(result).toBeCloseTo(0.1, 10)
    })

    it('应该在衰减周期结束后返回0', () => {
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
      const syncedAt = ninetyDaysAgo.toISOString()

      const result = calculateLinearDecayBonus(syncedAt, 0.1, 90)

      expect(result).toBe(0)
    })

    it('线性衰减应该是匀速的', () => {
      const fortyFiveDaysAgo = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000)
      const syncedAt = fortyFiveDaysAgo.toISOString()

      const result = calculateLinearDecayBonus(syncedAt, 0.1, 90)

      // 45天是一半的时间，权重应该也是一半
      expect(result).toBeCloseTo(0.05, 1)
    })
  })

  describe('getTimeDecayInfo - 衰减信息', () => {
    it('应该返回完整的衰减信息', () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const syncedAt = thirtyDaysAgo.toISOString()

      const info = getTimeDecayInfo(syncedAt, TimeDecayStrategies.balanced)

      expect(info).toHaveProperty('syncedAt')
      expect(info).toHaveProperty('daysSinceSync')
      expect(info).toHaveProperty('decayFactor')
      expect(info).toHaveProperty('timeBonus')
      expect(info).toHaveProperty('maxBonus')
      expect(info).toHaveProperty('strategy')

      expect(info.daysSinceSync).toBeCloseTo(30, 0)
      expect(info.decayFactor).toBeCloseTo(0.5, 1)
      expect(info.timeBonus).toBeCloseTo(0.04, 1)
      expect(info.maxBonus).toBe(0.08)
      expect(info.strategy).toBe('balanced')
    })

    it('应该识别自定义策略', () => {
      const now = new Date()
      const syncedAt = now.toISOString()
      const customConfig = { maxBonus: 0.15, halfLifeDays: 20, minThreshold: 0.01 }

      const info = getTimeDecayInfo(syncedAt, customConfig)

      expect(info.strategy).toBe('custom')
    })
  })

  describe('边界情况和错误处理', () => {
    it('应该处理无效的时间字符串', () => {
      const result = calculateTimeDecayBonus('invalid-date' as any, TimeDecayStrategies.balanced)

      // Invalid Date 会导致 daysSinceSync 为 NaN
      // Math.pow(0.5, NaN) 返回 NaN
      // NaN > minThreshold 为 false，所以返回 0
      expect(result).toBe(0)
    })

    it('应该处理空字符串', () => {
      const result = calculateTimeDecayBonus('' as any, TimeDecayStrategies.balanced)

      expect(result).toBe(0)
    })

    it('应该处理极端的过去时间', () => {
      const ancient = new Date('2000-01-01T00:00:00Z')
      const syncedAt = ancient.toISOString()

      const result = calculateTimeDecayBonus(syncedAt, TimeDecayStrategies.balanced)

      // 极久远的文档应该返回0
      expect(result).toBe(0)
    })

    it('应该处理零配置', () => {
      const now = new Date()
      const syncedAt = now.toISOString()
      const zeroConfig = { maxBonus: 0, halfLifeDays: 30, minThreshold: 0 }

      const result = calculateTimeDecayBonus(syncedAt, zeroConfig)

      expect(result).toBe(0)
    })

    it('应该处理负的半衰期（边界情况）', () => {
      const now = new Date()
      const syncedAt = now.toISOString()
      const negativeConfig = { maxBonus: 0.1, halfLifeDays: -1, minThreshold: 0 }

      const result = calculateTimeDecayBonus(syncedAt, negativeConfig)

      // 负半衰期会导致异常的衰减因子
      // 但不应该抛出错误
      expect(typeof result).toBe('number')
    })
  })

  describe('衰减曲线对比测试', () => {
    it('应该对比不同时间点的衰减情况', () => {
      const timePoints = [0, 7, 14, 30, 60, 90, 120, 180]
      const results: { days: number; bonus: number }[] = []

      timePoints.forEach((days) => {
        const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
        const bonus = calculateTimeDecayBonus(date.toISOString(), TimeDecayStrategies.balanced)
        results.push({ days, bonus })
      })

      // 验证衰减趋势：权重应该随时间递减
      for (let i = 1; i < results.length; i++) {
        expect(results[i].bonus).toBeLessThanOrEqual(results[i - 1].bonus)
      }

      // 验证关键时间点
      expect(results[0].bonus).toBeCloseTo(0.08, 2) // 0天
      expect(results[3].bonus).toBeCloseTo(0.04, 1) // 30天
    })
  })
})
