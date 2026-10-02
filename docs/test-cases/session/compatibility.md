# 低优先级兼容回归

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。

## ⚠️ V1 路径已全部失效（2026-09-29 起）

本文档原先使用 V1 路径（`$BASE/session`、`$BASE/file`、`$BASE/find` …）。**V2 没有 V1 兼容层**，这些端点不存在。实测确认：

```bash
# 139 条 V2 路径全部带 /api/ 前缀，V1 路径 0 条
curl -s "$BASE/openapi.json" | python3 -c "
import json,sys; d=json.load(sys.stdin)
p=list(d['paths']); print('总路径数',len(p),'非 /api/ 前缀',len([x for x in p if not x.startswith('/api/')]))"
# -> 总路径数 139 非 /api/ 前缀 0
```

**注意**：直接 `curl $BASE/session` 会返回 **HTTP 200 + 前端 HTML**，那是 SPA fallback 页面，**不是 API 响应**。判定端点是否存在必须看 `content-type` 或响应体，不能只看状态码：

```bash
curl -s -H 'Accept: application/json' "$BASE/session" | head -c 20
# -> <!doctype html   ← SPA fallback，端点不存在
```

下面已按 V2 契约改写。编号保持 T14.1–T14.10 不变（原 T14.5 share/unshare 已移除，说明见该处）。

```bash
export BASE="${BASE:-http://localhost:14096}"
MODEL='{"id":"deepseek-v4-flash","providerID":"Yd-DeepSeek"}'
CURL_AUTH=()
if [[ -n "${OPENCODE_PASSWORD:-}" ]]; then
  CURL_AUTH=(-u "opencode:${OPENCODE_PASSWORD}")
fi
api(){ curl --fail-with-body -sS --noproxy '*' "${CURL_AUTH[@]}" "$@"; }

SID=$(api -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d "{\"title\":\"p2-base-test\",\"location\":{\"directory\":\"/workspace\"},\"model\":$MODEL}" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")
echo "SID: $SID"
```

## 十四、低优先级兼容回归

> 本节不是 SaaS 主验收，仅用于回归确认 OpenCode 基础能力在 V2 下未被 SaaS 改造间接破坏。

### T14.1 session 列表过滤

V1 的 `roots=true` / `start=0` 在 V2 已改为 `parentID` 与不透明 `cursor`。

```bash
api "$BASE/api/session?search=p2-base-test&limit=1" | python3 -m json.tool
api "$BASE/api/session?parentID=null&limit=5" | python3 -m json.tool
api "$BASE/api/session?limit=5" | python3 -m json.tool
```

**期望**：search 命中刚建的 session；`limit` 生效；`parentID=null` 只返回根 session；响应含 `cursor.previous` / `cursor.next`。

### T14.2 session 状态

V1 `GET /session/status`（含 busy/idle）已移除。V2 用 `GET /api/session/active`，**只列出正在运行的会话**，其余即空闲 —— 不要再用旧版 `is_busy` 查询参数。

```bash
api "$BASE/api/session/active" | python3 -m json.tool
```

**期望**：返回 `{data: {<sessionID>: {type: "running"}}}`；空闲时为 `{}`。

### T14.3 session fork 与 children

⚠️ **V2 的 fork 不写 `parent_id`**。子会话通过 `fork_session_id` 列记录来源，用 `parentID` 查询查不到它 —— `parentID` 语义只用于 subagent 父子关系。

```bash
api -X POST "$BASE/api/session/$SID/prompt" -H 'Content-Type: application/json' \
  -d '{"text":"回复 fork-base","metadata":{},"delivery":"queue"}' >/dev/null
api -X POST "$BASE/api/experimental/session/$SID/wait" -H 'Content-Type: application/json' -d '{}'

CHILD=$(api -X POST "$BASE/api/session/$SID/fork" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")
echo "CHILD: $CHILD"

# 关联关系只能从 PG 核对，API 侧查不到
psql "$PG_URL" -t -A -c "SELECT fork_session_id FROM session_v2 WHERE id='$CHILD'"
```

**期望**：fork 返回 child session；PG 中该 child 的 `fork_session_id == $SID` 且 `parent_id` 为空。

### T14.4 message 分页

V1 用 `X-Next-Cursor` 响应头 + `before=` 参数。**V2 不再用响应头**，游标在响应体的 `cursor.next` 里，且**不透明**（不能当偏移量拼）。

```bash
api "$BASE/api/session/$SID/message?order=asc&limit=1" | python3 -m json.tool
CUR=$(api "$BASE/api/session/$SID/message?order=asc&limit=1" \
  | python3 -c "import json,sys;print(json.load(sys.stdin).get('cursor',{}).get('next',''))")
[ -n "$CUR" ] && api "$BASE/api/session/$SID/message?limit=1&cursor=$CUR" | python3 -m json.tool
```

**期望**：`limit=1` 只返回 1 条；有更多数据时 `cursor.next` 非空，带上它能翻到下一页。`limit` 上限 200。

> **已移除用例**：原 T14.5 share/unshare 已删除。V2 无 share 端点、`Session.Info` 也无 share 字段（openapi 实测 139 条路径中 0 条含 share），属云端 Web 产品能力，SaaS 服务端不提供。DB 中 `session_v2.share_url` 为历史遗留列，无 API 读写。
>
> **官方文档印证**（2026-09-29，[V2 配置文档](https://opencode.ai/v2/docs/config#sharing)）：`share` 配置项被接受但**「session sharing is not supported yet」** —— 与实测一致，确认移除该用例而非补实现是正确的。

### T14.6 diff / revert / unrevert

V2 把 V1 的 `revert`/`unrevert` 拆成**三段式**：`revert/stage` → 应用 → `revert/commit`，并新增 `revert/clear` 取消暂存。diff 也不再用 `messageID=`，改用 `from`/`to` 指定轮次区间。

```bash
# 先产生一处真实文件变更
api -X POST "$BASE/api/session/$SID/prompt" -H 'Content-Type: application/json' \
  -d '{"text":"用 write 工具在 /workspace 创建 diff-test.txt，内容 diff-test","metadata":{},"delivery":"queue"}' >/dev/null
api -X POST "$BASE/api/experimental/session/$SID/wait" -H 'Content-Type: application/json' -d '{}'

api "$BASE/api/session/$SID/diff" | python3 -m json.tool
MSG=$(api "$BASE/api/session/$SID/message?order=desc&limit=20" \
  | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];print(next(m['id'] for m in d if m['type']=='user'))")

api -X POST "$BASE/api/session/$SID/revert/stage" -H 'Content-Type: application/json' \
  -d "{\"messageID\":\"$MSG\",\"files\":true}" | python3 -m json.tool
api -X DELETE "$BASE/api/session/$SID/revert" -H 'Content-Type: application/json' | python3 -m json.tool
```

**期望**：diff 返回该轮次改动的文件；`revert/stage` 返回 revert 边界；`DELETE /revert` 清除暂存。⚠️ 已知行为：`/workspace` 不是 git 仓库时 diff 可能返回空数组 —— 这不代表接口故障。

### T14.7 file API

V1 的 `?path=&sessionID=` 全部改为 **session-scoped 路径参数**。

```bash
api "$BASE/api/session/$SID/fs/list?path=/workspace" | python3 -m json.tool
api "$BASE/api/session/$SID/fs/read/diff-test.txt" | python3 -m json.tool
api "$BASE/api/session/$SID/fs/find?query=diff-test" | python3 -m json.tool
```

**期望**：列出沙箱文件、读回文件内容、按模式查找。⚠️ 路径必须落在 `/workspace` 内，越界返回 404（`handlers/session-fs.ts:25`）。

### T14.8 find API

V1 的 `/find/file`、`/find/symbol` 在 V2 已并入 fs 组。⚠️ **参数名是 `query` 不是 `pattern`**；传 `pattern` 会得到 HTTP 400 `Missing key at ["query"]`。**V2 无 symbol 搜索端点**（LSP 未接线到该层）。

```bash
api "$BASE/api/session/$SID/fs/find?query=diff-test" | python3 -m json.tool
api "$BASE/api/fs/find?query=diff-test" | python3 -m json.tool
```

**期望**：两个 find 均返回匹配列表。沙箱不可达时错误冒泡为 defect（500），不是 400。

### T14.9 VCS API

V2 **有** `/api/vcs` 端点组，实例级与 session 级都有。⚠️ `mode` 的合法枚举是 **`working` / `branch` / `committed`**，**没有 `git`** —— V1 文档写的 `mode=git` 从一开始就是非法值（V2 返回 400）。

```bash
api "$BASE/api/vcs" | python3 -m json.tool
api "$BASE/api/vcs/status" | python3 -m json.tool
api "$BASE/api/vcs/diff?mode=working" | python3 -m json.tool   # 或 branch / committed
api "$BASE/api/session/$SID/vcs/diff?mode=working" | python3 -m json.tool
```

**期望**：`/api/vcs` 返回 `{data:{branch:{}}}`（`/workspace` 非 git 仓库故为空）；`status` 与 `diff` 返回空数组；`mode=git` 返回 HTTP 400 `Expected Vcs.Mode`。

### T14.10 agent/skill/command 列表

skill/command 在 V2 改为 **session-scoped**，且所有列表响应都包在 `{data: [...]}` 信封里（不是裸数组）。

```bash
api "$BASE/api/agent" | python3 -m json.tool | head -40
api "$BASE/api/session/$SID/skills" | python3 -m json.tool | head -40
api "$BASE/api/command" | python3 -m json.tool | head -40
api "$BASE/api/session/$SID/commands" | python3 -m json.tool | head -40
```

**期望**：四个接口的 `.data` 均为数组，不报错。

---

## 结果汇总

### 2026-09-29 V2 复测（镜像 `9d86bde786-t4` + `opencode-opensandbox:local` `7057c941ec64`，本地 PG + 本地沙箱）

> **前置结论**：本文档 V1 路径**全部失效**。139 条 V2 路径中 `/api/` 前缀外为 0 条；`curl $BASE/session` 返回的 HTTP 200 是 **SPA HTML 页面**而非 API。判定端点存在必须看 `content-type`，只看状态码会被 fallback 骗过。

| 用例 | 状态 | 说明 |
|------|------|------|
| T14.1 | ✅ | search 命中；`limit=1` 生效；`parentID=null` 只返回根 session；响应含 `cursor` |
| T14.2 | ✅ | `/api/session/active` 返回 `{data:{}}`；语义为「只列运行中」，无 busy/idle 全量状态 |
| T14.3 | ✅ | fork 返回 child；PG 中 child 的 `fork_session_id==$SID`、`parent_id` 为空。**`parentID=$SID` 查询返回空** |
| T14.4 | ✅ | `limit=1` 返回 1 条；`cursor.next` 非空且可翻页；确认已无 `X-Next-Cursor` 响应头 |
| T14.5 | — | **已移除**：V2 无 share 能力，非缺陷而是范围外（详见该节说明） |
| T14.6 | ✅ | diff HTTP 200；`revert/stage` 200 + `DELETE revert` 204 三段式可用；V1 的 `POST /revert` 已 404 |
| T14.7 | ✅ | `fs/list` 返回 `[{"path":"diff-test.txt","type":"file"}]`；`fs/read` 读回 `diff-test`；越界路径 404 |
| T14.8 | ✅ | session 级与 instance 级 find 均可用；**参数是 `query` 不是 `pattern`**；V2 无 symbol 端点 |
| T14.9 | ✅ | `/api/vcs`、`/api/vcs/status`、三种 `mode` 的 `/api/vcs/diff`、session 级 `vcs/diff` 全部可用；`mode=git` 返回 400 |
| T14.10 | ✅ | 四个列表 `.data` 均为数组；数量 agent=7、skills=2、command=2、session-commands=2 |

**共 33 条断言 PASS，0 FAIL。** T14.5 已移除，不计入统计。

### 本轮修正的三处文档错误

首轮按 openapi 猜测改写时写错了三处，均由实测纠正：

| 用例 | 我最初写的（错） | 实测正确行为 |
|---|---|---|
| T14.3 | 「fork 已建立 parent-child 关联，`parentID` 能查到」 | fork **不写** `parent_id`，只能从 PG 的 `fork_session_id` 核对 |
| T14.8 | 参数 `?pattern=` | 参数是 **`?query=`**；传 `pattern` 得 400 `Missing key at ["query"]` |
| T14.9 | 「V2 无 `/api/vcs*` 端点组」 | V2 **有** 6 条 vcs 路径；且 `mode` 枚举是 `working/branch/committed`，**没有 `git`** |

> 教训：`openapi.json` 能确认端点**是否存在**，但确认不了**参数名、枚举值和响应结构**。这三项必须实测。

### 与 V1 记录的差异

| 用例 | V1 行为 | V2 行为 |
|---|---|---|
| 路径 | `/session`、`/file`、`/find`、`/vcs` | 全部 `/api/...`；**无兼容层**，V1 请求命中 SPA fallback 返回 HTML 200 |
| 响应结构 | 裸数组/裸对象 | 统一信封 `{data: ..., location?}` |
| T14.2 | `/session/status` 返回 active/idle/busy 全量状态 | `/api/session/active` **只列运行中**，其余即空闲 |
| T14.3 | children 独立端点 | 无 children 端点；fork 关联只在 PG 的 `fork_session_id`，`parentID` 仅用于 subagent |
| T14.4 | `X-Next-Cursor` 响应头 + `before=` | body 内 `cursor.next`，不透明游标 |
| T14.5 | `POST/DELETE /share` 可用 | 无端点 → **用例已移除** |
| T14.6 | `revert` / `unrevert` | `revert/stage` / `revert/commit` / `DELETE revert` 三段式 |
| T14.8 | 有 `find/symbol`；参数 `pattern` | 无 symbol 端点；参数 `query` |
| T14.9 | `mode=git` | `mode` 枚举 `working`/`branch`/`committed` |

> 结论：基础能力在 V2 下无功能性回归。share（原 T14.5）已确认 V2 不提供，用例移除。

### 历史记录（V1 时期，保留备查）

> **复测记录（2026-09-16，镜像 `person-model-connect`，本地 PG + 远端 K8s 沙箱）：T14.1–T14.10 全部通过**。与更早记录的差异：T14.3 fork 后 `children` 由空变 1（上游 v1.18.29+ 建立关联）；T14.5 返回 session 对象而非 `{url}`；T14.7 沙箱随 session 自动启动；T14.8/T14.9 由 400 变为可返回；T14.10 agent 由 1 项增至 7 项。

