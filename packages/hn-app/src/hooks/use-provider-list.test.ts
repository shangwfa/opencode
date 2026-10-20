import { describe, expect, it } from "vitest"
import {
  isFreeModel,
  pickFirstModel,
  selectAvailableModels,
  toDisplayModel,
  type NormalizedProvider,
  type NormalizedProviderList,
  type ProviderModelInfo,
} from "./use-provider-list"

function provider(id: string, models: Record<string, Partial<ProviderModelInfo>>): NormalizedProvider {
  return { id, name: id, models: models as Record<string, ProviderModelInfo> }
}

function list(connected: string[], all: NormalizedProvider[]): NormalizedProviderList {
  return { connected, all }
}

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 24 * 3600 * 1000).toISOString()

describe("isFreeModel", () => {
  const oc = provider("opencode", {})

  it("opencode provider 无 cost → 免费", () => {
    expect(isFreeModel(oc, { id: "a" })).toBe(true)
  })

  it("opencode provider input=0 → 免费", () => {
    expect(isFreeModel(oc, { id: "a", cost: { input: 0, output: 0 } })).toBe(true)
  })

  it("opencode provider input>0 → 不免费", () => {
    expect(isFreeModel(oc, { id: "a", cost: { input: 2, output: 8 } })).toBe(false)
  })

  it("非 opencode provider 即使 0 成本也不免费（源语义）", () => {
    const poe = provider("poe", {})
    expect(isFreeModel(poe, { id: "a", cost: { input: 0, output: 0 } })).toBe(false)
  })
})

describe("toDisplayModel", () => {
  it("去掉 (latest) 后缀并置 latest 标记", () => {
    const oc = provider("opencode", {})
    const model = toDisplayModel(oc, { id: "a", name: "Model A (latest)" })
    expect(model.displayName).toBe("Model A")
    expect(model.latest).toBe(true)
  })

  it("无 name 时回落 id", () => {
    const oc = provider("opencode", {})
    expect(toDisplayModel(oc, { id: "bare" }).displayName).toBe("bare")
  })
})

describe("selectAvailableModels", () => {
  it("已连接 provider 全量展示", () => {
    const groups = selectAvailableModels(
      list(["yd"], [provider("yd", { m1: { id: "m1", name: "M1" }, m2: { id: "m2", name: "M2" } })]),
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].connected).toBe(true)
    expect(groups[0].models.map((m) => m.id)).toEqual(["m1", "m2"])
  })

  it("未连接的 opencode 只出免费模型，其它 provider 不出现", () => {
    const groups = selectAvailableModels(
      list([], [
        provider("opencode", {
          free1: { id: "free1", name: "Free1", cost: { input: 0, output: 0 } },
          paid1: { id: "paid1", name: "Paid1", cost: { input: 2, output: 8 } },
          nocost: { id: "nocost", name: "NoCost" },
        }),
        provider("poe", { p1: { id: "p1", name: "Poe1", cost: { input: 0, output: 0 } } }),
      ]),
    )
    expect(groups.map((g) => g.provider.id)).toEqual(["opencode"])
    expect(groups[0].connected).toBe(false)
    expect(groups[0].models.map((m) => m.id).sort()).toEqual(["free1", "nocost"])
  })

  it("release_date 超过 6 个月的旧版本隐藏，family 内最新且 6 个月内显示", () => {
    const groups = selectAvailableModels(
      list(["yd"], [
        provider("yd", {
          old: { id: "old", name: "Old", family: "gpt", release_date: iso(200) },
          fresh: { id: "fresh", name: "Fresh", family: "gpt", release_date: iso(10) },
        }),
      ]),
    )
    expect(groups[0].models.map((m) => m.id)).toEqual(["fresh"])
  })

  it("无 release_date 的模型默认显示", () => {
    const groups = selectAvailableModels(list(["yd"], [provider("yd", { m: { id: "m", name: "M" } })]))
    expect(groups[0].models.map((m) => m.id)).toEqual(["m"])
  })

  it("deprecated 模型已在上游归一化阶段过滤（此处仅确认不抛错）", () => {
    const groups = selectAvailableModels(
      list(["yd"], [provider("yd", { m: { id: "m", name: "M", status: "deprecated" } })]),
    )
    expect(groups).toHaveLength(1)
  })

  it("分组顺序：已连接 provider 在前，OpenCode 免费模型在后", () => {
    const groups = selectAvailableModels(
      list(
        ["yd"],
        [
          provider("opencode", { f: { id: "f", name: "F", cost: { input: 0, output: 0 } } }),
          provider("yd", { a: { id: "a", name: "A" } }),
        ],
      ),
    )
    expect(groups.map((g) => g.provider.id)).toEqual(["yd", "opencode"])
    expect(pickFirstModel(list(["yd"], [
      provider("opencode", { f: { id: "f", name: "F", cost: { input: 0, output: 0 } } }),
      provider("yd", { a: { id: "a", name: "A" } }),
    ]))).toEqual({ providerID: "yd", modelID: "a" })
  })

  it("providers 为空 → 空分组", () => {
    expect(selectAvailableModels(null)).toEqual([])
  })
})

describe("pickFirstModel", () => {
  it("取第一个已连接 provider 的第一个模型", () => {
    const picked = pickFirstModel(
      list(["yd"], [provider("yd", { a: { id: "a", name: "A" }, b: { id: "b", name: "B" } })]),
    )
    expect(picked).toEqual({ providerID: "yd", modelID: "a" })
  })

  it("无连接 provider → 退回第一个免费模型", () => {
    const picked = pickFirstModel(
      list([], [provider("opencode", { f: { id: "f", name: "F", cost: { input: 0, output: 0 } } })]),
    )
    expect(picked).toEqual({ providerID: "opencode", modelID: "f" })
  })

  it("无任何可用模型 → undefined", () => {
    expect(pickFirstModel(list([], []))).toBeUndefined()
  })
})