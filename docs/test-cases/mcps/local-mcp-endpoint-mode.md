# Local MCP 沙箱 endpoint 双模式（直连 / OpenSandbox server 代理）

> 验证 SaaS 下 local MCP（沙箱内 supergateway 桥接形态）取 endpoint 的两种模式：**直连**（默认，`host:port` 直连沙箱地址）与 **OpenSandbox server 网关代理**（`{gateway}/sandboxes/{id}/proxy/{port}`，经 OpenSandbox server 转发，不暴露沙箱直连地址）。
>
> 开关定义：`OPENCODE_SANDBOX_MCP_SERVER_PROXY`（`packages/opencode/src/flag/flag.ts`，**缺省 `true`**，2026-09-07 由 false 改为默认走网关，跨网段部署安全；显式 `=false` 回到直连）；实现：`packages/opencode/src/tool/sandbox-provider.ts` `getEndpoint` 第三参 `opts.useServerProxy`。

## 开关矩阵与语义

| 模式 | `OPENCODE_SANDBOX_USE_SERVER_PROXY`（全局，SDK 层） | `OPENCODE_SANDBOX_MCP_SERVER_PROXY`（MCP 专属） | MCP endpoint 来源 | 沙箱其他通道（execd/files/commands） |
|---|---|---|---|---|
| A 纯直连 | `false` | `false` | `sb.getEndpointUrl(port)` → `http://<沙箱直连地址>:<port>` | 直连 |
| B MCP 强制网关 | `false` | `true` | `sb.sandboxes.getSandboxEndpoint(id, port, true)` → `http://<gateway>/sandboxes/{id}/proxy/{port}` | 直连 |
| C 全网关 | `true` | 任意 | 均为网关路径（`MCP_SERVER_PROXY=false` 时经 SDK `connectionConfig.useServerProxy` 回落到网关） | 网关 |

> ⚠️ 语义叠加（缺省 true 后）：不设 `MCP_SERVER_PROXY` = true（网关）；要验证纯直连必须显式 `MCP_SERVER_PROXY=false` **且** 全局 `USE_SERVER_PROXY=false`（两个开关同时 false）。生产部署在跨网段（server 与沙箱 pod 不互通）时保持缺省即可；同网络（本地 OpenSandbox / 组合 2、3）三种均可用。

## 前置条件

| 条件 | 说明 |
|---|---|
| SaaS 容器 | 镜像含 `MCP_ENDPOINT_SERVER_PROXY` 改动；本篇实测镜像 `opencode-saas-sandbox-test:mcp-proxy-t0906` |
| 组合 | 本地 PG + 远端沙箱（本地 PG=127.0.0.1:5432 local 用户，容器经 15432 转发；沙箱 API 经 `host.docker.internal:30040` → 172.18.32.15:30040） |
| 模型 | `Yd-DeepSeek/deepseek-v4-flash`（本地 PG 需已配置 provider auth） |
| 观察手段 | `docker logs opencode-saas-test | grep "sandbox endpoint resolved"`——MCP service 的 Effect 日志不进 docker logs（已知限制），endpoint 形态与调用成功与否均以此 + PG 断言为准 |

模式切换 = 重建容器（改两个 env），验证脚本对 A/B/C 通用：

```bash
SID=$(curl -sf -X POST "http://localhost:14096/session" -H 'Content-Type: application/json' \
  -d '{"title":"mcp-endpoint-mode"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
curl -sf -X POST "http://localhost:14096/session/$SID/mcps/create" -H 'Content-Type: application/json' \
  -d '{"name":"echo","type":"local","command":["npx","-y","@modelcontextprotocol/server-everything"]}' >/dev/null
BEFORE=$(psql "postgresql://local@127.0.0.1:5432/opencode" -tAc \
  "SELECT coalesce(max(time_created),0) FROM part WHERE session_id='$SID' AND data->>'tool'='execute'")
curl -s -m 180 -X POST "http://localhost:14096/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"必须使用 execute 工具，执行精确代码：return await tools.echo.echo({message: \"<模式标记>\"})"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}' >/dev/null
# 硬断言（勿信模型自然语言回复）
psql "postgresql://local@127.0.0.1:5432/opencode" -tAc \
  "SELECT data->'state' FROM part WHERE session_id='$SID' AND data->>'tool'='execute' AND time_created > $BEFORE ORDER BY time_created DESC LIMIT 1" \
  | python3 -c "import json,sys; s=json.load(sys.stdin); print(s['status'], s.get('output'), s.get('metadata',{}).get('toolCalls'))"
# endpoint 形态
docker logs opencode-saas-test 2>&1 | grep "sandbox endpoint resolved" | tail -3
```

---

## 用例

### T60.1 模式 A：纯直连 endpoint 形态与调用

`USE_SERVER_PROXY=false` + `MCP_SERVER_PROXY=false`。

**期望**：
- endpoint URL 为**直连形态**（非网关路径）：`url=http://<沙箱直连地址>:9100`
- execute 硬断言：`completed` + `Echo: direct-verify-ok` + `toolCalls=[{tool:"echo.echo",status:"completed"}]`

### T60.2 模式 B：MCP 强制网关（开关独立性）

`USE_SERVER_PROXY=false` + `MCP_SERVER_PROXY=true`。

**期望**：
- MCP endpoint 为**网关路径**（`/sandboxes/{id}/proxy/{port}`），而同会话沙箱 exec 通道（execd/commands）仍为直连（exec 正常）
- execute 硬断言：`completed` + `Echo: mixed-verify-ok`
- 该模式是本开关的核心价值：跨网段部署时仅 MCP 走网关，其余通道不受全局开关影响

### T60.3 模式 C：全网关（回归基线）

`USE_SERVER_PROXY=true` + `MCP_SERVER_PROXY=true`。

**期望**：
- endpoint 为网关路径
- execute 硬断言：`completed` + `Echo: proxy-verify-ok`

### T60.4 单测（确定性覆盖）

```bash
cd packages/opencode
bun test test/tool/sandbox-endpoint-proxy.test.ts
```

**期望**：3 pass（缺省直连不触发网关查询 / `useServerProxy=true` 网关 URL 按 `config.protocol` 拼 scheme / 同会话混合调用沙箱复用且互不污染）。该文件使用进程级 `mock.module`，须与其他 mock SDK 的测试分进程运行。

### T60.5 缺省值验证：不设开关

镜像含改动但不设 `OPENCODE_SANDBOX_MCP_SERVER_PROXY`（缺省 **true**，2026-09-07 变更）。

**期望**：不设开关 = 显式 true（endpoint 走网关）；5 处既有 `getEndpoint` 调用方（lsp/pty/plugin 等）不受影响。显式 `=false` 可回到直连（老部署兼容路径）。

## 测试矩阵

| 编号 | 模式 | 关键验证点 |
|---|---|---|
| T60.1 | A 纯直连 | endpoint=沙箱直连地址；MCP 调用成功 |
| T60.2 | B MCP 强制网关 | endpoint=网关路径；exec 通道仍直连；调用成功 |
| T60.3 | C 全网关 | endpoint=网关路径；调用成功 |
| T60.4 | 单测 | 三分支确定性断言 |
| T60.5 | 兼容 | 不设开关行为不变 |

## 复测记录

| 日期 | 环境 | 结果 |
|---|---|---|
| 2026-09-06 | 本地 PG + 远端沙箱，镜像 `mcp-proxy-t0906`，Yd-DeepSeek/deepseek-v4-flash | T60.1 ✅（`url=http://10.12.10.189:9100` 直连形态，`Echo: direct-verify-ok`）；T60.2 ✅（`url=http://host.docker.internal:30040/sandboxes/bc0270f6-…/proxy/9100` 网关形态 + 同容器全局直连下 exec 正常，`Echo: mixed-verify-ok`）；T60.3 ✅（`url=…/sandboxes/d3274fad-…/proxy/9100`，`Echo: proxy-verify-ok`）；T60.4 ✅ 3/3；T60.5 ✅（单测+typecheck+session-mcp 13/13 / lifecycle 21/21 无回归）。注：远端网关路径为 `/sandboxes/{id}/proxy/{port}`（与 SDK 类型注释的 `/port/` 前缀略有差异，属远端版本格式，不影响）；直连模式实测 `10.12.10.189`（K8s pod 网段）在本地容器可达——该网段当前内网互通，跨网段部署时直连模式预期不可达，应使用 B/C。 |
| 2026-09-06 | 同上（echo 之外的第二个 server：`npx -y @ant-design/cli mcp`，见 [`antd-mcp.md`](./antd-mcp.md) 双模式记录） | 模式 A ✅（endpoint `10.12.10.193:9100` 直连，`antd.antd_list\|completed` 返回真实组件数据）；模式 B ✅（endpoint 网关 `/sandboxes/{id}/proxy/9100`，`antd.antd_list\|completed` 返回 72 组件）。npx 首次下载预热后两种模式链路一致，无回归。 |
| 2026-09-07 | 本地 PG + 远端沙箱，镜像 `t0907-wsfix`（含 WS 文本帧修复），Yd-DeepSeek/deepseek-v4-flash | T60.1 ✅（`url=http://10.12.0.205:9100` 直连形态，`Echo: direct-verify-ok`）；T60.2 ✅（网关 `/sandboxes/e7153692-…/proxy/9100`，`Echo: mixed-verify-ok`，exec 通道正常）；T60.3 ✅（网关 `/sandboxes/028fbae2-…/proxy/9100`，`Echo: proxy-verify-ok`）；T60.4 ✅ 3/3；T60.5 ✅（true + 不设开关 → 网关 `/sandboxes/1660a30d-…/proxy/9100`，`Echo: compat-fallback-ok`）。**同日开关缺省值变更**：`MCP_SERVER_PROXY` 缺省 false → **true**（`flag.ts` `truthy` → `!falsy`，跨网段安全默认）；缺省验证 ✅（全局 false + 不设开关 → 仍网关 `/sandboxes/6a526a5f-…/proxy/9100`，`Echo: default-true-ok` completed）；mcp/ 18 fail 为 baseline（stash 对照一致），typecheck 59 无新增。直连（pod IP 10.12.x）当前内网互通仍可达，跨网段部署由缺省 true 兜底。 |
