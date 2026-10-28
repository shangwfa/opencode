/**
 * 策略装配：backend-gray(50) → user-enterprise(100) → network(150) → percent(175)。
 * 请求头 version 在 manager 内优先处理。
 */
import { GrayReleaseStrategyManager } from "./manager.js"
import { BackendGrayStrategy } from "./backend-gray.js"
import { UserEnterpriseStrategy } from "./user-enterprise.js"
import { NetworkStrategy } from "./network.js"
import { PercentStrategy } from "./percent.js"

export const strategyManager = new GrayReleaseStrategyManager([
  new BackendGrayStrategy(),
  new UserEnterpriseStrategy(),
  new NetworkStrategy(),
  new PercentStrategy(),
])
