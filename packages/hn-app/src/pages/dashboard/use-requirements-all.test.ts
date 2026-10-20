/**
 * 仪表盘查询层单测：loadAll 的成功/异常归一化 + 轮询间隔常量。
 * hook 的 React 行为（竞态丢弃、定时器）由页面端到端验证覆盖，此处只锁纯函数。
 */
import { describe, expect, it } from "vitest"
import type { AggregateRequirement } from "@/api/requirement/types"
import { DASHBOARD_REFRESH_MS, loadAll } from "./use-requirements-all"

const item = (id: string) => ({ id, title: id }) as unknown as AggregateRequirement

describe("dashboard/loadAll", () => {
  it("透传 repo 参数并返回条目", async () => {
    let got = ""
    const res = await loadAll(async (repo) => {
      got = repo ?? ""
      return [item("a"), item("b")]
    }, "https://gitlab.com/x/y")
    expect(got).toBe("https://gitlab.com/x/y")
    expect(res).toEqual({ ok: true, items: [item("a"), item("b")] })
  })

  it("repo 默认为空串（全部仓库）", async () => {
    let got: string | undefined = "unset"
    await loadAll(async (repo) => {
      got = repo
      return []
    })
    expect(got).toBe("")
  })

  it("抛错归一化为 ok:false + message", async () => {
    const res = await loadAll(async () => {
      throw new Error("加载需求列表失败")
    })
    expect(res).toEqual({ ok: false, error: "加载需求列表失败" })
  })

  it("非 Error 异常也能转成字符串", async () => {
    const res = await loadAll(async () => {
      throw "boom"
    })
    expect(res).toEqual({ ok: false, error: "boom" })
  })

  it("返回非数组时兜底为空数组", async () => {
    const res = await loadAll(async () => undefined as unknown as AggregateRequirement[])
    expect(res).toEqual({ ok: true, items: [] })
  })
})

describe("dashboard/轮询间隔", () => {
  it("默认 60s（与源 solid-query refetchInterval 一致）", () => {
    expect(DASHBOARD_REFRESH_MS).toBe(60_000)
  })
})