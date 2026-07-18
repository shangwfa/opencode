# SaaS 测试公共配置

> 本文档包含所有测试用例共享的环境配置、结果摘要和验收分层。

## 测试环境

- **容器镜像**：`opencode-saas-sandbox-test:v2fix`（SaaS 服务）+ `opencode-opensandbox:local`（sandbox 容器）
- **容器名**：`opencode-saas-test`
- **本地端口映射**：`localhost:14096 → 容器 4096`
- **PG 数据库**：经 `127.0.0.1:15432` 转发访问（容器通过 `host.docker.internal:15432`）。PG 用户随组合不同（组合 1/2 远端用 `app`，组合 3 本地用 `local`）。**运行用例前先加载环境 + 测试库**：
  ```bash
  source test-env.sh 3     # 组合号 1/2/3，默认 3 → $BASE/$PG_URL/$MODEL/$NO_PROXY
  source test-lib.sh       # jexec/pass/fail/new_sid/pgval 等测试函数
  ```
- **测试模型**：`zhipuai/glm-5.1`（`{"providerID":"zhipuai","modelID":"glm-5.1"}`）
- **Sandbox**：本地 OpenSandbox server `localhost:8080`（Docker runtime），PVC 模式（`OPENCODE_SANDBOX_VOLUME_TYPE=pvc`）
- **HTTP 代理**：宿主机若设 `http_proxy`/`https_proxy`，所有 curl 必须绕过本地地址——执行用例前先 `export NO_PROXY=localhost,127.0.0.1`（或每个 curl 加 `--noproxy '*'`）


## 回归测试结果摘要

全量验收状态以 [`99-acceptance-status.md`](./99-acceptance-status.md) 为准（持续更新）；自动化回归套件见 [`scripts/run-regression.py`](./scripts/run-regression.py)（batch 1-15）。

> 历史快照（2026-05-26 / 镜像 v11 `748fcb7eb`）：当时仅完成 T1.1-T1.3, T2.1-T2.6, T3.1-T3.2, T4.1-T4.2, T4.6-T4.7, T6.1, T7.2-T7.3, T7.5, T8.1-T8.2, T9.1-T9.2, T10.1，T5/T11-T13 待验证。这些用例后续已全部完成，详见 99 文档。
>
> 关键修复记录：`Flag.OPENCODE_DEFAULT_DIRECTORY` 需添加到 `packages/core/src/flag/flag.ts`（非 `packages/opencode`）。upstream 的 part type 为 `tool`（非 `tool-use`），响应结构含 `step-start`, `reasoning`, `tool`, `text`, `step-finish`。

### 消息结构说明

`POST /session/:sessionID/message` 的返回值是 **AI 最后一条消息**（通常是文字总结），而工具调用在**前一条消息**中。完整的消息流为：

```
💬 [N]   用户 prompt
🔧 [N+1] AI 工具调用（bash/write/read/edit 等，可能多个）
💬 [N+2] AI 文字总结 ← POST /message 返回的是这条
```

因此，仅解析 `POST /message` 的返回值无法验证工具是否被调用。验证工具调用过程需要查询 `GET /session/:sessionID/message` 获取完整消息列表。

### 通用验证函数

测试库 `test-lib.sh`（`source test-lib.sh` 加载）提供标准函数，所有用例应优先使用，避免重复代码和 JSON 解析踩坑：

| 函数 | 用法 | 说明 |
|---|---|---|
| `pass "T1.1"` / `fail "T1.1" "原因"` | 记录结果 | 自动计数 |
| `summary` | 用例末尾 | 打印汇总，返回码 0=全过 |
| `cmd \| jexec "表达式(d)"` | 解析 JSON 响应 | **内置 `strict=False`**，兼容含未转义控制字符的响应 |
| `new_sid` / `new_sid -k` / `new_sid -kb` | 创建 session | `-k`=keepAlive，`-kb`=keepAlive+立即建沙箱 |
| `pgval "SELECT ..."` | PG 查询单值 | 经 `$PG_URL`，无表头 |

> ⚠️ **JSON 解析必须用 `jexec`**：`/provider`、`/session/:id/message`、`/exec` 等响应可能含未转义控制字符，python 默认 `json.load` 会报 `Invalid control character`。若逻辑复杂必须用原生 python，务必 `json.load(sys.stdin, strict=False)`。

示例：

```bash
source test-env.sh 3 && source test-lib.sh

# T1.1 健康检查
H=$(curl -s "$BASE/global/health" | jexec "d.get('healthy')")
[ "$H" = "True" ] && pass "T1.1" || fail "T1.1" "healthy=$H"

# T2.1 创建 session + PG 验证（一行搞定）
SID=$(new_sid)
[ "$(pgval "SELECT project_id FROM session WHERE id='$SID'")" = "global" ] && pass "T2.1" || fail "T2.1"

summary
```

工具调用验证函数（需手动 `source` 定义后使用）：

```bash
# send_and_verify: 发送消息并验证工具调用过程 + 最终结果
# 用法: send_and_verify $SID "prompt文本" "测试标签"
send_and_verify() {
  local sid=$1 prompt=$2 label=$3
  echo "=== $label ==="

  curl -s --max-time 120 -X POST "$BASE/session/$sid/message" \
    -H 'Content-Type: application/json' \
    -d "{\"parts\":[{\"type\":\"text\",\"text\":\"$prompt\"}],\"model\":$MODEL}" > /dev/null 2>&1

  # 注意 strict=False：消息响应可能含未转义控制字符
  curl -s "$BASE/session/$sid/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin, strict=False)
recent = msgs[-3:] if len(msgs) >= 3 else msgs
tools, texts = [], []
for m in recent:
    for p in m.get('parts', []):
        if p.get('type') == 'tool':
            t = p.get('tool', '?')
            s = p.get('state', {})
            status = s.get('status', '?')
            output = s.get('output', '')[:80] if s.get('output') else ''
            tools.append(f'{t}({status})')
        elif p.get('type') == 'text':
            texts.append(p.get('text', '')[:100])
print(f'  工具调用: {\"✅ \" + str(tools) if tools else \"❌ 无工具调用\"}')
print(f'  AI回复: {texts[-1] if texts else \"(空)\"}')
"
}
```

### API 路径速查

**基础消息与 Provider**

| 功能 | 正确路径 |
|---|---|
| 同步消息 | `POST /session/:sessionID/message` |
| 异步消息 | `POST /session/:sessionID/prompt_async` |
| 中断会话 | `POST /session/:sessionID/abort` |
| Session CRUD | `POST/GET/PATCH/DELETE /session`、`GET /session/:id`、`GET /session/status` |
| fork/children | `POST /session/:id/fork`、`GET /session/:id/children` |
| share/unshare | `POST /session/:id/share`、`DELETE /session/:id/share` |
| diff/revert | `GET /session/:id/diff`、`POST /session/:id/revert`、`POST /session/:id/unrevert` |
| Provider 列表 | `GET /provider` |
| Auth 凭据 | `PUT/DELETE /auth/:providerID` |
| 权限应答 | `POST /session/:id/permissions/:permissionID`（body `{response}`；复数路径） |

**Sandbox 执行与代理**

| 功能 | 正确路径 |
|---|---|
| Sandbox proxy | `/session/:sessionID/proxy/:port/*` |
| proxy 错误上报 | `GET /session/:id/proxy/:port/__errors`、`GET /session/:id/proxy-errors` |
| Sandbox 直连 endpoint | `GET /session/:sessionID/endpoint/:port` |
| 沙箱执行命令 | `POST /session/:sessionID/exec` |
| 异步执行命令 | `POST /session/:sessionID/exec/async` |
| 查询执行状态 | `GET /session/:sessionID/exec/:execId` |
| SSE 流式输出 | `GET /session/:sessionID/exec/:execId/stream` |
| 中断执行 | `POST /session/:sessionID/exec/:execId/kill` |
| 执行列表 | `GET /session/:sessionID/execs` |
| 设置 keepAlive | `POST /session/:sessionID/keep-alive` |
| 查询 keepAlive | `GET /session/:sessionID/keep-alive` |
| 销毁 sandbox | `POST /session/:sessionID/kill-sandbox` |
| 沙箱状态 | `GET /session/:sessionID/sandbox` |

**Session 级资源（复数路径，创建走 `/create`）**

| 功能 | 正确路径 |
|---|---|
| skills | `GET/DELETE /session/:id/skills`、`POST /session/:id/skills/create`、`DELETE /session/:id/skills/:name`、`POST /session/:id/skills/load` |
| agents | `GET/DELETE /session/:id/agents`、`POST /session/:id/agents/create`、`DELETE /session/:id/agents/:name` |
| agents-md | `GET/DELETE /session/:id/agents-md`、`POST /session/:id/agents-md/create` |
| mcps | `GET/DELETE /session/:id/mcps`、`POST /session/:id/mcps/create`、`DELETE /session/:id/mcps/:name` |
| tools | `GET/DELETE /session/:id/tools`、`POST /session/:id/tools/create`、`DELETE /session/:id/tools/:name` |
| commands | `GET/DELETE /session/:id/commands`、`POST /session/:id/commands/create`、`DELETE /session/:id/commands/:name` |
| plugins | `GET/DELETE /session/:id/plugins`、`POST /session/:id/plugins/create`、`DELETE /session/:id/plugins/:name` |
| .opencode 加载 | `POST /session/:id/dot-opencode/load` |
| 执行自定义命令 | `POST /session/:id/command` |

**实例与全局**

| 功能 | 正确路径 |
|---|---|
| 全局事件流 | `GET /global/event`（SSE） |
| 实例事件流 | `GET /event`（SSE，需 `x-opencode-directory`） |
| 健康检查 | `GET /global/health` |
| 全局配置 | `GET/PATCH /global/config`、`GET/PATCH /config` |
| 路径信息 | `GET /path` |
| 实例销毁 | `POST /instance/dispose`、`POST /global/dispose` |
| 文件/查找/VCS | `GET /file`、`GET /file/content`、`GET /find`、`GET /find/file`、`GET /find/symbol`、`GET /vcs/status` |


## 验收分层

SaaS 化验收按优先级分三层：

- **P0 SaaS 核心验收**：多 session 隔离、PVC 持久化（T38）、sandbox 生命周期（T12）、dev server proxy（T11）、PG 落库、provider 凭据（T3）、并发执行与并发安全修复回归（T6/T39）、会话级资源 CRUD 与隔离（T15/T16/T22/T32/T33/T35/T36）、会话级沙箱资源配置（T29）、路径泄露防护（PL/WF）。
- **P1 SaaS 稳定性**：错误恢复（T7/T13）、资源回收（T12/T30）、重启恢复、watchdog 兜底（T28）、限流/计费、proxy 错误上报、空闲沙箱定期回收（T30）。
- **P2 低优先级兼容回归**：原 OpenCode 基础 API smoke test（T1/T2/T4/T14），仅用于确认 SaaS 改造没有破坏基础能力，不作为 SaaS 主验收。

功能演进类章节（LSP T27、MCP T22/T40/T41、权限 T26、用户标识 T25、环境缓存 T23/T24、Goal T34、编排 T42、endpoint T17、工具调用 T18/T19/T20、资源 T29）按各自文档验收，分层映射见 [`99-acceptance-status.md`](./99-acceptance-status.md) 的分层总览。

当前设计约束：

- 不同 session 必须隔离。Session B 不应看到 Session A 的 `/workspace` 文件或后台进程。
- keepAlive 由 bash 工具是否以 `background:true` 启动决定。直接访问 sandbox proxy 不触发 keepAlive。
- 用户/租户、API 鉴权、用户与 session 的绑定关系、跨用户端口访问控制由外部服务负责，本服务只验证 session 维度的隔离与资源行为。
- 资源配额沿用默认 sandbox/runtime 限制，不在本用例集中单独验收自定义 CPU/内存/磁盘配额。
- 不覆盖老版本/本地数据迁移场景。

```bash
# 通用：定义 SID 变量
SID="ses_xxxxxxxxxxxxxxxxxxxx"
```

## 附录 A：Session 级资源通用 CRUD 检查清单

Session 级资源（skills / agents / mcps / tools / commands / plugins / agents-md）生命周期高度同构。各资源文档的通用部分按本清单验证，正文只保留资源特有参数与断言。

| 编号 | 检查项 | 操作 | 通用期望 |
|---|---|---|---|
| G1 | 创建 + PG 持久化 | `POST /session/:id/<res>/create` | 200 + 返回对象；PG 对应表有记录且字段完整 |
| G2 | 列表合并 | `GET /session/:id/<res>` | 包含 G1 创建项；全局/内置同名项被 session 版本覆盖（如该资源有全局来源） |
| G3 | upsert 同名 | 再次 `POST .../create`（同名） | 200；列表 count=1；`time_created` 不变、`time_updated` 增大；PG 字段已更新 |
| G4 | 删除单个 | `DELETE /session/:id/<res>/:name` | 200/204；列表移除；PG 删除；全局同名项（如有）回退可见 |
| G5 | 清空全部 | `DELETE /session/:id/<res>` | 200/204；列表仅剩全局项（如有）；PG count=0；重复清空幂等 |
| G6 | 跨 session 隔离 | A/B 两 session 各建同名资源 | 各自列表互不可见对方项；PG 按 `session_id` 隔离 |
| G7 | 删除 session 级联 | `DELETE /session/:id` | PG 资源表 count=0（ON DELETE CASCADE）；再访问资源 API → 404 |
| G8 | 不存在 session | `POST .../create` / `GET` | create → 500（PG FK 拦截，`createAgent`/`createSkill`/`createMcp`/`createTool`/`createCommand` 无 requireSession）；list → 404（`requireSession`）。**已知差异**：`mcps` 与 `skills` 的 list 无 `requireSession`，返回 200 空数组（handlers/session.ts 实现层不一致）；`createPlugin`/`createAgentsMd` 有 requireSession → 404 |
| G9 | 输入校验 | 缺必填字段 / 非法枚举值 | 400（各资源必填字段与枚举见各自文档） |
| G10 | 并发 upsert | 5 并发 `create` 同名 | 全部 200；PG count=1（upsert 无竞态） |

约定：G1-G5 为单 session 基本生命周期；G6-G8 为隔离与清理；G9-G10 为健壮性。各文档用例 ID 到清单条目的映射在各自"结果汇总"中标注。

### 通用执行脚本模板

以下 bun 脚本覆盖 G1-G7（替换 `<RES>` 为资源名、`<PG_TABLE>` 为 PG 表名、`<PAYLOAD>` 为资源创建体）：

```js
const BASE = "http://localhost:14096"
const RES = "<RES>"            // skills | agents | mcps | tools | commands | plugins
const PAYLOAD = { name: "t-generic", /* ...资源必填字段... */ }

// G1 创建
const sid = (await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()).id
const created = await (await fetch(`${BASE}/session/${sid}/${RES}/create`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(PAYLOAD) })).json()
console.log("G1 created:", created.name ?? created.id)

// G2 列表
const list1 = await (await fetch(`${BASE}/session/${sid}/${RES}`)).json()
console.log("G2 in list:", list1.some(x => x.name === PAYLOAD.name))

// G3 upsert 同名
await fetch(`${BASE}/session/${sid}/${RES}/create`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ...PAYLOAD, description: "v2" }) })
const list2 = await (await fetch(`${BASE}/session/${sid}/${RES}`)).json()
console.log("G3 count=1:", list2.filter(x => x.name === PAYLOAD.name).length === 1)

// G4 删除单个
const del = await fetch(`${BASE}/session/${sid}/${RES}/${PAYLOAD.name}`, { method: "DELETE" })
console.log("G4 delete status:", del.status)

// G5 清空全部（先重建一项）
await fetch(`${BASE}/session/${sid}/${RES}/create`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(PAYLOAD) })
const clear = await fetch(`${BASE}/session/${sid}/${RES}`, { method: "DELETE" })
console.log("G5 clear status:", clear.status)

// G6 跨 session 隔离：对第二个 session 重复 G1，互查列表
// G7 级联：DELETE /session/:id 后查 PG 表 count=0
// G8 不存在 session：create → 500（FK，skill/agent/mcp/tool/command）；list → 404（agent/tool/command；mcps/skills 例外：200 空数组）；plugin/agents-md create → 404（requireSession）
// G9/G10 见各资源文档特有校验与并发用例
```

PG 验证统一使用 `pgval "SELECT ... FROM <PG_TABLE> WHERE session_id='$SID'"`（test-lib.sh）。

---


