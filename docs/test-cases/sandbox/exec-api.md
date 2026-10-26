# V2 沙箱命令与 keep-alive API 验收

本文档只描述当前 V2 SaaS API。V2 不提供旧版 `/exec`、`/exec/async`、`/execs` 或 `exec_log`；命令通过 session shell API 执行，输出事件写入 session log。

测试服务和本地 PG 配置见 [`docs/local-test-env.md`](../../local-test-env.md)。以下脚本需要 Node.js、`psql`，且测试服务与 `PG_URL` 指向同一个 PG 数据库。

## API 契约

| 操作 | V2 endpoint | 预期 |
| --- | --- | --- |
| 创建 session | `POST /api/session` | 返回 `{ data: { id } }`；root session 默认异步启用 keep-alive 并 boot |
| 执行 shell 命令 | `POST /api/session/:sessionID/shell` | 请求 `{ command }`，成功返回 HTTP 204 |
| 读取命令事件 | `GET /api/experimental/session/:sessionID/log` | 包含 shell started/ended 事件及执行输出 |
| 设置 keep-alive | `POST /api/experimental/session/:sessionID/keep-alive` | `{ enabled, boot? }`；返回 `{ sessionID, keepAlive, sandboxId }` |
| 查询 keep-alive | `GET /api/experimental/session/:sessionID/keep-alive` | 返回 `{ sessionID, keepAlive }` |
| 查询运行中的 sandbox | `GET /api/session/:sessionID/sandbox` | 返回 `{ sessionID, sandboxId }`，未运行时 ID 为 `null` |
| 销毁 sandbox | `POST /api/session/:sessionID/kill-sandbox` | 返回 `{ sessionID, destroyed }`，保留 keep-alive 偏好 |

命令输出的 stdout/stderr 在 V2 shell log 中合并；命令历史和 `exec_log` 不属于此 API。

## T19.1 命令执行及事件持久化

运行 `exec-api-v2.mjs`。验证 HTTP 204、shell started/ended 事件、退出码、log 回放，以及 PG `session_message` 中命令、状态和退出码。命令应在 sandbox 的 `/workspace` 中执行。

## T19.2 root session 自动 boot 与 PG 状态

运行 `sandbox-keepalive-v2.mjs`。验证 root session 自动创建 sandbox，PG `sandbox` 行为 `state=running`、`keep_alive=true`，并验证 keep-alive GET、sandbox ID 查询和跨实例连接。

## T19.3 release、销毁与重建

同一脚本验证 `enabled=false` 会将偏好置为 false 并立即销毁 sandbox；再次设置 `enabled=true, boot=true` 会重新创建 sandbox。`kill-sandbox` 与 session 删除销毁 sandbox，但保留 keep-alive 偏好。

## T19.4 延迟启动

使用单独配置 `OPENCODE_SESSION_AUTO_KEEPALIVE=0` 的 V2 服务运行 `sandbox-keepalive-lazy-v2.mjs`。验证 `boot=false` 先写入 PG pending 行但不启动 sandbox；第一次 shell 命令才创建 sandbox，并继承 `keep_alive=true`。

## T19.5 shell 错误场景与 fork 生命周期

`exec-api-v2.mjs` 验证 shell 缺少 command 返回 HTTP 400、不存在的 session 返回 HTTP 404、命令 `exit 42` 的退出码写入 log。`sandbox-keepalive-v2.mjs` 验证 fork session 不自动 boot，第一次 shell 才创建 sandbox，删除 fork session 会销毁其 sandbox。

## T19.6 重启恢复与 idle-reap

运行 `sandbox-idle-reap-v2.mjs`。测试服务容器需设置 `OPENCODE_SANDBOX_IDLE_REAP_SEC=60`；脚本会先重启服务并验证运行中的 sandbox 通过 PG ID reconnect，再将 `time_updated` 置旧并再次重启，验证 idle-reap 销毁 sandbox、保持 `keep_alive=true`。

## 执行脚本

设置 `OPENCODE_PASSWORD`、`PG_URL`。`BASE` 指向默认自动 boot 的 V2 服务；可选 `BASE_SECONDARY` 指向共享同一 PG 的另一 V2 实例，用于跨实例 reconnect 验证。

```bash
OPENCODE_PASSWORD="$OPENCODE_PASSWORD" \
BASE=http://localhost:14106 \
PG_URL='postgresql://local@127.0.0.1:5432/opencode-v2-up' \
node docs/test-cases/scripts/exec-api-v2.mjs

OPENCODE_PASSWORD="$OPENCODE_PASSWORD" \
BASE=http://localhost:14106 \
BASE_SECONDARY=http://localhost:14107 \
PG_URL='postgresql://local@127.0.0.1:5432/opencode-v2-up' \
node docs/test-cases/scripts/sandbox-keepalive-v2.mjs

# 此服务须设置 OPENCODE_SESSION_AUTO_KEEPALIVE=0
OPENCODE_PASSWORD="$OPENCODE_PASSWORD" \
BASE=http://localhost:14107 \
PG_URL='postgresql://local@127.0.0.1:5432/opencode-v2-up' \
node docs/test-cases/scripts/sandbox-keepalive-lazy-v2.mjs

# 测试服务容器需设置 OPENCODE_SANDBOX_IDLE_REAP_SEC=60
OPENCODE_PASSWORD="$OPENCODE_PASSWORD" \
BASE=http://localhost:14107 \
PG_URL='postgresql://local@127.0.0.1:5432/opencode-v2-up' \
RESTART_CONTAINER=opencode-saas-v2-verify-secondary \
node docs/test-cases/scripts/sandbox-idle-reap-v2.mjs
```

这些脚本会检查 API 响应和 PG 状态，并在结束时删除测试 session。idle-reap 脚本会重启指定 Docker 容器两次，请勿将 `RESTART_CONTAINER` 指向非测试服务。

旧版依赖 `/exec`、`/exec/async` 或 `exec_log` 的 T19 用例不适用于 V2，不应作为当前服务的验收标准。

## 实测记录（2026-10-02）

环境：本地 Docker 双实例 + 本地 PG（`opencode-v2-up`）+ 本地 OpenSandbox（docker runtime）。标准实例跑 T19.1/2/5；`OPENCODE_SESSION_AUTO_KEEPALIVE=0` 实例跑 T19.4；`OPENCODE_SANDBOX_IDLE_REAP_SEC=60` 实例跑 T19.6。

| 用例 | 脚本 | 结果 |
|---|---|---|
| T19.1 命令执行及事件持久化 | `exec-api-v2.mjs` | PASS（HTTP 204、started/ended 事件、exit=42、400/404 校验、log 回放，6 断言） |
| T19.2 root session 自动 boot | `sandbox-keepalive-v2.mjs` | PASS（PG `running/keep_alive=true`、boot sandboxId 匹配） |
| T19.3 release、销毁与重建 | `sandbox-keepalive-v2.mjs` + T-SBG.2 | PASS（release 后 API/PG 均 false 且销毁；destroy→rebuild 新 sandboxId；kill 保留 keep_alive 偏好） |
| T19.4 延迟启动 | `sandbox-keepalive-lazy-v2.mjs`（`AUTO_KEEPALIVE=0` 实例） | PASS（boot=false 写 pending 行不启动；首次 shell 创建并继承 keep_alive=true） |
| T19.5 shell 校验与 fork | `exec-api-v2.mjs` + `sandbox-keepalive-v2.mjs` | PASS（fork 不自动 boot、首次 shell 创建、删除 fork 销毁其沙箱） |
| T19.6 idle-reap | `sandbox-idle-reap-v2.mjs`（`IDLE_REAP_SEC=60`，`RESTART_CONTAINER` 指向测试容器） | PASS（重启后按 PG ID reconnect；`time_updated` 置旧后回收销毁；keep_alive 保留） |

> 注意：脚本默认 `BASE`/`PG_URL` 指向旧端口，执行时需按 `docs/local-test-env.md` 显式传参。

## Vercel 环境实测（2026-10-24）

T19.1–T19.6 **PASS**：已接入 Vercel provider，在独立 Docker 双实例 → Vercel Sandbox → 专用 PG 链路运行原四份脚本，保留原断言，配套公共 SSE、PG 和远端清理复核。首次 timeout=0 错误已补回归修复并重跑通过。

报告及能力边界见 [`vercel-exec-api-2026-10-24.md`](./vercel-exec-api-2026-10-24.md)，原始证据在 `artifacts/vercel-t19-20261024/final/`。未重启现有服务；Code Mode/MCP/Tool Host 等完整 Agent 链路尚未支持或验收。上方 2026-10-02 的记录仍仅代表当时的 OpenSandbox 环境。

Agent 链路补测（2026-10-24）：公网 token 网关、Code Mode、Tool Host、Session 本地 MCP echo 均 PASS。MCP 曾被 supergateway 握手 400 阻塞，已通过自研 HTTP 桥接替换解除。最终证据为 `artifacts/vercel-agent-chain-20261024/final/`；详细范围和协议限制见 `vercel-exec-api-2026-10-24.md` 的“原生 HTTP MCP 桥接”一节。
