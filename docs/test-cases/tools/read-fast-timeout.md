# V2 Read 快速返回与超时能力边界

## 已实现与已验证

T-RFT.1（正常路径）由 [`scripts/tools-v2-e2e.mjs`](../scripts/tools-v2-e2e.mjs) 覆盖：预置小文本文件后调用 read，检查 tool part `completed` 且内容包含预期文本。

T-RFT.2（kill Sandbox 后恢复）由同一脚本的 T18.10a 覆盖 Sandbox kill 后再次执行工具并检查 PG 状态；这只能验证销毁/重建路径，不是 files API 请求挂死的故障注入测试。

`SandboxProvider.fileStat`、`fileRead`、`fileReadBytes` 现在都有独立的 files API 请求预算，默认每次 15 秒，并在 timeout 时重试 1 次。可通过 `OPENCODE_SANDBOX_FILES_TIMEOUT_SECONDS` 和 `OPENCODE_SANDBOX_FILES_TIMEOUT_RETRIES` 配置（重试次数允许设为 0）。只有 timeout 会重试；普通 API 错误及 404 不会重试，timeout 本身不销毁 Sandbox。请求通过 SDK 的 `ConnectionConfig.fetch` 发出并传入 AbortSignal，超时会取消底层 HTTP 请求。

单测/传输故障注入：`packages/core/test/sandbox-files-timeout.test.ts` 对实际 OpenSandbox SDK 连接和挂起的 `/files/download` HTTP 请求做故障注入，验证在预算内返回 typed timeout 且服务端观测到客户端取消；`packages/core/test/sandbox-provider.test.ts` 覆盖 timeout 重试、重试耗尽、取消次数，以及 404/普通错误不重试；`packages/core/test/sandbox-config.test.ts` 覆盖默认值、环境变量和无效值回退。

## 服务级故障注入 E2E（已通过）

[`scripts/read-files-timeout-v2-e2e.mjs`](../scripts/read-files-timeout-v2-e2e.mjs) 配合 [`scripts/opensandbox-files-fault-proxy.mjs`](../scripts/opensandbox-files-fault-proxy.mjs) 在 **opencode SaaS 容器 + PG + 真实 OpenSandbox** 上注入挂起的 files endpoint，连续两次运行 `0 failed assertion(s)`：

| 断言 | 证据 |
|---|---|
| Read tool part 持久化 timeout | tool part `status=error`，`Sandbox files getFileInfo timed out after 2s` |
| 挂起请求被客户端取消 | 代理观测 `hits === aborted`（attempt + retry 各一次） |
| timeout 触发一次重试 | `attempts >= 2` |
| timeout 不销毁/替换 Sandbox | 前后 Sandbox ID 一致 |
| PG 落库 timeout tool part | `session_message` 中匹配到 timeout part |
| timeout 后 Sandbox 仍可用 | 同一 Sandbox 执行 shell `exit=0` |
| PG 保留原 running Sandbox | `count(*)=1` |

故障代理要点：SaaS 容器通过 `OPENCODE_SANDBOX_DOMAIN` 指向代理；代理把 OpenSandbox 返回的 `endpoint`（`127.0.0.1:8080/sandboxes/<id>/proxy/44772`）改写为容器可达地址（`FAULT_PROXY_ADVERTISE`，如 `host.docker.internal:8081`），并按 `/sandboxes/<id>/(proxy|port)/44772/files/(info|download)` 匹配目标 `path` 后保留响应不返回，交由 SaaS 的 AbortSignal 取消。

运行前置：SaaS 容器需设置 `OPENCODE_SANDBOX_FILES_TIMEOUT_SECONDS` / `..._RETRIES`，`OPENCODE_SANDBOX_USE_SERVER_PROXY=true`，且 `OPENCODE_SANDBOX_DOMAIN` 指向故障代理。命令示例：

```bash
FAULT_PROXY_HOST=0.0.0.0 FAULT_PROXY_PORT=8081 \
FAULT_PROXY_ADVERTISE=host.docker.internal:8081 \
OPENSANDBOX_UPSTREAM=http://127.0.0.1:8080 \
  node docs/test-cases/scripts/opensandbox-files-fault-proxy.mjs

OPENCODE_PASSWORD="$OPENCODE_PASSWORD" \
PG_URL='postgresql://local@127.0.0.1:5432/opencode-v2-up' \
BASE=http://127.0.0.1:14096 FAULT_PROXY=http://127.0.0.1:8081 \
  node docs/test-cases/scripts/read-files-timeout-v2-e2e.mjs
```


运行方法、认证、PG 表结构和脚本清理见 [`tool-calls.md`](./tool-calls.md)。

## 能力边界

超时重试耗尽后将错误返回调用方，不主动销毁 Sandbox；是否销毁应交由后续健康检查或独立 Sandbox 生命周期流程决定。挂起注入已覆盖传输取消、timeout helper 及通过 SaaS API + PG + 真实 Sandbox 的服务级断言（见上）；仍不能用 Sandbox kill 后重建替代。

## Watchdog 边界

Session watchdog 中断的是超预算的活跃执行，不是 read files API 的专属 timeout。其实现和测试位于 `packages/core/src/session/watchdog.ts` 及 `packages/core/test/session-watchdog.test.ts`。如果需要 watchdog API E2E，应由可控长时间 shell 执行构造独立 Session 场景，并核对 tool part 的 `Tool execution interrupted` 与 Session 恢复；不能用历史 V1 `part` 查询或无样本跳过来宣称测试通过。
