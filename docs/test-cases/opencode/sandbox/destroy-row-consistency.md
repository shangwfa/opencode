# Sandbox 行不得在远端容器消失后永久停留 running（回归）

## 缺陷

会话的沙箱容器先行消失（运维直接删容器、OpenSandbox GC 等）后，调用 `kill-sandbox`：

- HTTP 返回 `200`、`{"destroyed": true}`
- 但 PG `sandbox` 行**永远停留 `state='running'`**

真实触发记录（2026-10-01）：3 个沙箱容器被清理后删除其会话，`kill-sandbox` 均返回 200，行仍为 `running`，最终只能手工 `UPDATE sandbox SET state='destroyed'` 修正。后续同样的孤儿行反复出现。

### 根因

`packages/core/src/sandbox/provider.ts` 的 `destroySandbox` 重连分支：

1. `Sandbox.connect` 失败被包装为 `new Error(\`Sandbox reconnect failed: ${String(cause)}\`)` —— 原始异常被**字符串化**，`SandboxApiException.statusCode`（404）丢失；
2. `if (!remote) return` —— 重连失败直接返回，`markDestroyed(sessionID)` 永远不执行。

于是「沙箱真不存在」（应结算行）与「网络故障」（应保留行待重试）两种情况走同一条提前返回路径，前者造成永久脏行。

### 修复

`packages/core/src/sandbox/provider.ts`：

- 新增 `remoteSandboxGone(error)`：沿 `cause` 链识别确定性"已不存在"判定（`statusCode === 404` 或 `Sandbox ... not found` 消息）；传输类失败（`fetch failed`、`ECONNREFUSED`、5xx）返回 false。
- 重连包装保留原始异常：`new Error(msg, { cause })`。
- 重连失败且判定「已不存在」→ `destroyed = true`，继续走 `markDestroyed` + `toolGate.destroyed`；未知/传输失败维持原行为（提前返回，行保留待重试）。
- 两处 `kill()` 失败（缓存路径与重连路径）经 `killResult` 同样把 404 视为已销毁。

## 单测

```bash
cd packages/core && bun test test/sandbox-provider.test.ts
```

`remoteSandboxGone` 覆盖：包装后的 404、无状态码的显式 not-found 消息、传输/5xx 不判定、非沙箱类 404 消息（`File not found`）不判定。

## 服务级 E2E

Docker 中的 SaaS 服务 + 本地 PG + 真实 OpenSandbox（`docs/test-cases/scripts/` 场景，脚本内联于验证记录）：

1. 建会话，经 API 起 shell 引导真实沙箱，确认 PG `running` 行；
2. 绕过 SaaS 直接 `DELETE /v1/sandboxes/:id`（模拟容器消失）；
3. 调 SaaS `POST /api/session/:sid/kill-sandbox`；
4. 核对 PG。

| 断言 | 结果 |
|---|---|
| kill-sandbox 返回 | 200 `{"destroyed":true}` |
| PG 行状态 | **`destroyed`**（修复前停留 `running`） |
| 二次 kill 幂等 | 200，仍 `destroyed` |
| 会话清理后 | 0 条 running 残留 |

## 边界

- 传输故障（OpenSandbox 不可达、5xx）**不**结算行：沙箱可能仍在远端，结算会泄漏容器。该分支维持旧行为，等待下次删除或回收流程。
- 本缺陷与「会话删除时的沙箱清理」共用 `destroySandbox` 路径，修复对两处同时生效。
