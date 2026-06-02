# 前端使用 VCS Diff 接口

Code review 面板通过 `GET /vcs/diff` 拉取变更文件清单。

---

## 何时使用

| 场景 | 必传参数 | 是否传 `sessionID` |
|---|---|---|
| 沙箱 agent 修改了文件 | `directory`, `mode=git` | **是** |
| 本地 git 项目，无沙箱 | `directory`, `mode=git\|branch` | 否 |
| 对比远端分支变更 | `directory`, `mode=branch` | 否 |

**核心规则**：只要后端启用了沙箱（`OPENCODE_SANDBOX_ENABLED=true`）并且当前打开了某个 session，**必须**传 `sessionID`。否则拿到的是 host 目录的 git diff，文件找不到。

---

## 请求

```
GET /vcs/diff
  ?directory=<project path>     # 必填，project worktree
  &mode=git|branch              # 必填
  &sessionID=<session id>       # 沙箱环境下必填
  &context=<int>                # 可选，patch context 行数
```

后端优先级：

1. `sandbox.enabled && sessionID && SandboxProvider` → 在 `session` 沙箱 `/workspace` 内跑 `git diff` 并返回
2. 否则 → 走 host `vcs.diff(ctx.directory)`（本地或 worktree 内 git）

---

## 响应

```ts
type FileDiff = {
  file: string               // 仓库内相对路径
  patch?: string             // unified diff，无 context 行
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}
```

`[]` 表示工作区干净。

---

## 调用模板

直接走 `fetch`，**不要走 SDK**。SDK client 类型生成器目前没有 `sessionID` 字段，重新生成会引入无关 diff。

```ts
const fetchVcsDiff = async (mode: "git" | "branch") => {
  const url = new URL("/vcs/diff", sdk.url)
  url.searchParams.set("directory", sdk.directory)
  url.searchParams.set("mode", mode)
  if (params.id) url.searchParams.set("sessionID", params.id)

  const res = await (platform.fetch ?? fetch)(url, {
    headers: server.current?.http.password
      ? { Authorization: `Basic ${authTokenFromCredentials({...})}`
        : undefined,
  })
  if (!res.ok) throw new Error(`Failed to load VCS diff: ${res.status}`)
  return list(await res.json()) as FileDiff[]
}
```

完整实现见 `packages/app/src/pages/session.tsx:468-486`。

---

## Query Key 与缓存

`createQuery` 的 key 至少要包含 `sessionID`（以及 vcs 模式、project 路径、当前/默认 branch），否则切换会话会拿到上一会话的缓存。

```ts
const vcsKey = () => [
  "session-vcs",
  sdk.directory,
  params.id ?? "",                          // ← 关键
  sync.data.vcs?.branch ?? "",
  sync.data.vcs?.default_branch ?? "",
] as const

createQuery(() => ({
  queryKey: [...vcsKey(), mode],
  enabled: wantsReview() && sync.project?.vcs === "git",
  staleTime: Number.POSITIVE_INFINITY,      // 不主动过期
  gcTime: 60_000,
  queryFn: () => fetchVcsDiff(mode),
}))
```

`enabled` 条件：review 面板打开 + 项目是 git。

---

## 失效与刷新

`staleTime: Infinity` 意味着不会自动过期，必须手动 `invalidateQueries` 触发重拉。文件变化时统一调用：

```ts
const refreshVcs = debounce(
  () => void queryClient.invalidateQueries({ queryKey: vcsKey() }),
  100,
)
```

触发时机（与 vcs 相关的文件变化 / agent 完成 / branch SSE）都调一次，100ms debounce 防抖。

---

## 错误处理

沙箱内 `git diff` 失败时，后端会 `catch` 并回退到 host `vcs.diff`。前端 `queryFn` 仍然要 `.catch(() => [])`：

```ts
queryFn: () =>
  fetchVcsDiff(mode).catch((err) => {
    console.debug("[session-review] failed to load vcs diff", { mode, err })
    return []
  }),
```

避免单个 panel 渲染失败影响整个会话页面。
