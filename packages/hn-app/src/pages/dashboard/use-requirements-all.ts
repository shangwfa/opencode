/**
 * 仪表盘数据加载（harness requirements-v2 aggregate API）。
 *
 * 设计：把「拉取 + 校验」做成可单测的纯函数 loadAll(fetchImpl, repo)，
 * hook 只负责 useState / 定时器 / 竞态丢弃，便于无 React 环境测试。
 * 项目未引入 react-query（源项目用 solid-query），故手写等价的最小实现：
 * repo 变化立即重拉；autoRefresh 开启时按 intervalMs 轮询；终态错误不轮询。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { fetchRequirementsV2All } from "@/api/requirement"
import type { AggregateRequirement } from "@/api/requirement/types"
import { hnApi, type HnRequirement } from "@/lib/base-api"
import { usingBaseServer } from "@/lib/session-source"

export const DASHBOARD_REFRESH_MS = 60_000

export type LoadResult =
  | { ok: true; items: AggregateRequirement[] }
  | { ok: false; error: string }

/** 拉取入口（默认走 harness API，可注入以便测试） */
export type RequirementsFetcher = (targetGitlab?: string) => Promise<AggregateRequirement[]>

/**
 * 网关模式：把 hn-base-server 的需求映射成仪表盘使用的 AggregateRequirement。
 * 字段差异：created_at ← timeCreated、target_gitlab ← repoUrl、creator_nick_name ← ownerName。
 */
export function fromGateway(row: HnRequirement): AggregateRequirement {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    created_at: new Date(row.timeCreated).toISOString(),
    updated_at: new Date(row.timeUpdated).toISOString(),
    target_gitlab: row.repoUrl ?? "",
    creator_uuid: row.ownerId,
    creator_nick_name: row.ownerName ?? row.ownerEmail ?? "",
    opencode_session_id: "",
    workflow_id: "",
    version: "v2",
    ...(row.priority ? { priority: row.priority as AggregateRequirement["priority"] } : {}),
    ...(row.kind ? { kind: row.kind as AggregateRequirement["kind"] } : {}),
  } as AggregateRequirement
}

/** 从网关拉取需求（失败时抛错，由 loadAll 归一化） */
async function loadFromGateway(): Promise<AggregateRequirement[]> {
  const res = await hnApi.requirements()
  return (res.items ?? []).map(fromGateway)
}

export async function loadAll(
  fetcher: RequirementsFetcher = fetchRequirementsV2All,
  repo = "",
): Promise<LoadResult> {
  try {
    const items = usingBaseServer() ? await loadFromGateway() : await fetcher(repo)
    return { ok: true, items: Array.isArray(items) ? items : [] }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export type DashboardQueryState = {
  items: AggregateRequirement[]
  loading: boolean
  error: string
  /** 已成功加载过（用于区分「首屏加载中」与「空数据」） */
  loaded: boolean
}

export function useRequirementsAll(repo: string, autoRefresh: boolean) {
  const [state, setState] = useState<DashboardQueryState>({
    items: [],
    loading: true,
    error: "",
    loaded: false,
  })
  // 请求序号：只采纳最后一次请求的结果，避免快速切仓库时旧响应覆盖新数据
  const seq = useRef(0)

  const load = useCallback(async () => {
    const mine = ++seq.current
    setState((s) => ({ ...s, loading: true, error: "" }))
    const result = await loadAll(fetchRequirementsV2All, repo)
    if (mine !== seq.current) return
    if (result.ok) {
      setState({ items: result.items, loading: false, error: "", loaded: true })
    } else {
      // 加载失败：保留既有数据（源项目 query 同样保留上一次成功结果）
      setState((s) => ({ ...s, loading: false, error: result.error }))
    }
  }, [repo])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!autoRefresh) return
    const timer = setInterval(() => void load(), DASHBOARD_REFRESH_MS)
    return () => clearInterval(timer)
  }, [autoRefresh, load])

  return { ...state, reload: load }
}