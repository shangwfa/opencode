# Local MCP 沙箱 endpoint 双模式（直连 / OpenSandbox server 代理）

> **V2 状态（2026-09-28）**：V1 的 `packages/opencode/src/flag/flag.ts` 开关已迁移为 V2 `SandboxConfig`（`packages/core/src/sandbox/config.ts`）：`OPENCODE_SANDBOX_MCP_SERVER_PROXY`（**缺省 `true`**）仅作用于 Session local MCP 的桥接 endpoint（`SessionMcps.mcpUseServerProxy = useServerProxy || mcpServerProxy`），其余 endpoint 调用方（session preview proxy 等）继续跟随全局 `OPENCODE_SANDBOX_USE_SERVER_PROXY`，开关矩阵 A/B/C 语义与 V1 一致。V2 日志以 `session MCP endpoint resolved`（含 `url`/`useServerProxy`）为 endpoint 形态观察点。

## V2 执行记录 2026-10-08（当前代码全量重跑）

> **环境**：组合 3（本地 PG `opencode-v2-up` + 本地 OpenSandbox Docker runtime + 容器 `:14096`，镜像含 2026-10-05/07/08 全部 session-mcp 修复），模型 `Yd-GLM/glm-5.3-flash`。每模式 = 按 env 重建容器后完整验证。

| 用例 | 模式 | 结果 | 证据 |
|---|---|---|---|
| T60.1 | A 纯直连（`USE=false` + `MCP=false`） | ✅ | `url=http://192.168.31.176:52999/proxy/9100/mcp useServerProxy=false`（LAN 直连形态，无 `/sandboxes/{id}/` 段）；`Echo: direct-verify-ok` |
| T60.2 | B MCP 强制网关（`USE=false` + `MCP=true`） | ✅ | `url=http://host.docker.internal:8080/v1/sandboxes/{id}/proxy/9100/mcp useServerProxy=true`（网关形态）；`Echo: mixed-verify-ok`；同会话 shell/exec 通道正常（开关独立性） |
| T60.3 | C 全网关（`USE=true`） | ✅ | 网关形态；`Echo: proxy-verify-ok` |
| T60.5 | 缺省（`USE=false` + 不设 `MCP`） | ✅ | 缺省 true → 网关形态；`Echo: default-true-ok` |
| T60.4 | 单测 | ✅ | `packages/core/test/session-mcps.test.ts` 的 `SessionMcps MCP endpoint mode`（A/B/C/全网关回落矩阵），随 11 用例持续全过 |

**endpoint 形态判定规则（本地组合 3 实测）**：
- 直连：`http://<宿主 LAN IP>:<OpenSandbox server 端口>/proxy/<沙箱端口>/mcp`（无 sandbox id 段）；
- 网关：`http://host.docker.internal:8080/v1/sandboxes/<id>/proxy/<沙箱端口>/mcp`。

**执行注记**：MCP service 的结构化日志**不进 docker logs**（沿袭 V1 已知限制），落点为容器内 `/home/opencode/.local/share/opencode/log/opencode-local.log`（logfmt，`message="session MCP endpoint resolved"` 带 `url`/`useServerProxy` 字段）——endpoint 形态断言须从这里取。**本地 direct 可达性**：本轮 A 模式在 OrbStack 本地环境 direct 形态直接可用（9-28 记录的代理 TUN 污染 / eip 语义冲突问题当前未复现）；跨网段部署仍应使用 B/C 或保持缺省 true。

## V2 执行记录 2026-09-28

> **环境**：Docker `opencode-saas-mcp-v2:local`（`localhost:14099`）、PostgreSQL `opencode-v2-up`、本地 OpenSandbox（Docker runtime 0.2.2）、`Yd-DeepSeek/deepseek-v4-flash`。
>
> **结果**：T60.1–T60.5 全部通过。硬断言均以 `execute` 的 `metadata.toolCalls`（`echo.echo|completed`）+ 精确输出 `Echo: <marker>` 为准，endpoint 形态以 `session MCP endpoint resolved` 日志为准。

| 用例  | 模式           | 结果 | 证据                                                                                                                                                                            |
| ----- | -------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T60.1 | A 纯直连       | ✅   | `url=http://192.168.10.170:55701/proxy/9100/mcp useServerProxy=false`（LAN 直连形态）；`echo.echo\|completed`；`Echo: direct-verify-ok`                                         |
| T60.2 | B MCP 强制网关 | ✅   | `url=http://host.docker.internal:8080/v1/sandboxes/{id}/proxy/9100/mcp useServerProxy=true`（网关形态）；`Echo: mixed-verify-ok`；同会话 exec 通道独立正常（`exec-channel-ok`） |
| T60.3 | C 全网关       | ✅   | 网关形态同上；`Echo: proxy-verify-ok`                                                                                                                                           |
| T60.4 | 单测           | ✅   | 22/22：开关解析（缺省 true / 显式 false / true）+ A/B/C/全网关回落矩阵（`mcpUseServerProxy`）+ 桥接命令 quoting 回环                                                            |
| T60.5 | 缺省值         | ✅   | 不设 `OPENCODE_SANDBOX_MCP_SERVER_PROXY`（全局 false）→ `useServerProxy=true` 网关形态；`Echo: default-true-ok`                                                                 |

### 本地环境问题记录（根因与处理，均有实测依据）

1. **代理 TUN 污染 direct endpoint host**：OpenSandbox server 的 `_resolve_bind_ip` 以 UDP 探测 `8.8.8.8` 出口 IP，代理 TUN（`198.18.0.1`）劫持默认路由后 direct endpoint 变为 `198.18.0.1:<port>/proxy/<n>`——宿主/容器均不可达（socket closed），SDK execd readiness 卡死、`get or create sandbox timed out after 90s`。关闭 TUN 后 direct 恢复 `192.168.10.170:<port>/proxy/<n>`，全模式通过。跨网段部署（直连预期不可达）应使用 B/C。
2. **OpenSandbox 0.2.2 的 eip 语义冲突（本地形态差异）**：`server.eip` 在 direct 分支被强拼 `:<port>`、在 server-proxy 分支被当作完整外网 base（丢端口），且 OrbStack ingress 占用宿主 80 端口——本机无法一段配置同时验证 direct 与 eip 形 proxy；本次 T60.1 的早期证据（eip=`192.168.215.1` 时 `url=http://192.168.215.1:53363/proxy/9100/mcp`，`Echo: direct-verify-ok`）与无 eip 阶段的 B/C/缺省记录可交叉印证，最终以 TUN 关闭后的干净环境全量重跑为准。
3. **测试期临时配置已恢复**：`~/.sandbox.toml` 曾临时加 `[server].eip`（备份 `~/.sandbox.toml.bak-t60`），测试后已还原并重启 opensandbox-server。

> 验证 SaaS 下 local MCP（沙箱内 supergateway 桥接形态）取 endpoint 的两种模式：**直连**（默认，`host:port` 直连沙箱地址）与 **OpenSandbox server 网关代理**（`{gateway}/sandboxes/{id}/proxy/{port}`，经 OpenSandbox server 转发，不暴露沙箱直连地址）。
>
> 开关定义：`OPENCODE_SANDBOX_MCP_SERVER_PROXY`（`packages/opencode/src/flag/flag.ts`，**缺省 `true`**，2026-09-07 由 false 改为默认走网关，跨网段部署安全；显式 `=false` 回到直连）；实现：`packages/opencode/src/tool/sandbox-provider.ts` `getEndpoint` 第三参 `opts.useServerProxy`。

## 开关矩阵与语义

| 模式           | `OPENCODE_SANDBOX_USE_SERVER_PROXY`（全局，SDK 层） | `OPENCODE_SANDBOX_MCP_SERVER_PROXY`（MCP 专属） | MCP endpoint 来源                                                                                  | 沙箱其他通道（execd/files/commands） |
| -------------- | --------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------ |
| A 纯直连       | `false`                                             | `false`                                         | `sb.getEndpointUrl(port)` → `http://<沙箱直连地址>:<port>`                                         | 直连                                 |
| B MCP 强制网关 | `false`                                             | `true`                                          | `sb.sandboxes.getSandboxEndpoint(id, port, true)` → `http://<gateway>/sandboxes/{id}/proxy/{port}` | 直连                                 |
| C 全网关       | `true`                                              | 任意                                            | 均为网关路径（`MCP_SERVER_PROXY=false` 时经 SDK `connectionConfig.useServerProxy` 回落到网关）     | 网关                                 |

> ⚠️ 语义叠加（缺省 true 后）：不设 `MCP_SERVER_PROXY` = true（网关）；要验证纯直连必须显式 `MCP_SERVER_PROXY=false` **且** 全局 `USE_SERVER_PROXY=false`（两个开关同时 false）。生产部署在跨网段（server 与沙箱 pod 不互通）时保持缺省即可；同网络（本地 OpenSandbox / 组合 2、3）三种均可用。

## 前置条件

| 条件      | 说明 |
| --------- | ---- |
| SaaS 容器 | 含 V2 `SessionMcps.mcpUseServerProxy` 实现（当前镜像即含） |
| 组合      | 组合 3（本地 PG `opencode-v2-up` + 本地 OpenSandbox Docker runtime） |
| 模型      | `Yd-GLM/glm-5.3-flash` |
| 观察手段  | endpoint 形态以服务日志 `session MCP endpoint resolved`（含 `url`/`useServerProxy`）为准；调用成功以 context 的 completed 工具 part + `Echo: <marker>` 精确输出为准 |

模式切换 = 重建容器（改两个 env）。通用验证（V2 契约）：

```js
// 1) 创建 session + keep-alive + 沙箱预热 everything（npm install -g）
// 2) 注册：POST /api/session/:id/mcps {name:"echo", config:{type:"local", command:["npx","-y","@modelcontextprotocol/server-everything"]}}
// 3) 轮次：POST /api/session/:id/prompt_stream {text:"必须使用 execute 工具，执行精确代码：return await tools.echo.echo({message: \"<模式标记>\"})", model}
// 4) 硬断言（勿信模型自然语言）：context 中 completed 工具 part 输出含 `Echo: <模式标记>`
// 5) endpoint 形态：docker logs opencode-saas-test | grep "session MCP endpoint resolved" | tail
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
cd packages/core && bun test test/session-mcps.test.ts   # "SessionMcps MCP endpoint mode"
```

**期望**：A/B/C 矩阵与全网关回落全过（`mcpUseServerProxy = useServerProxy || mcpServerProxy` 的四组合 + 缺省语义）。V1 的 `packages/opencode/test/tool/sandbox-endpoint-proxy.test.ts` 已随代码迁移：endpoint 实现层在 `packages/core/src/sandbox/provider.ts`（`getSandboxEndpoint`），开关决策层即本用例组。

### T60.5 缺省值验证：不设开关

镜像含改动但不设 `OPENCODE_SANDBOX_MCP_SERVER_PROXY`（缺省 **true**，2026-09-07 变更）。

**期望**：不设开关 = 显式 true（endpoint 走网关）；5 处既有 `getEndpoint` 调用方（lsp/pty/plugin 等）不受影响。显式 `=false` 可回到直连（老部署兼容路径）。

## 测试矩阵

| 编号  | 模式           | 关键验证点                                   | 本轮结果 |
| ----- | -------------- | -------------------------------------------- | -------- |
| T60.1 | A 纯直连       | endpoint=沙箱直连地址；MCP 调用成功          | ✅ 2026-10-08 |
| T60.2 | B MCP 强制网关 | endpoint=网关路径；exec 通道仍直连；调用成功 | ✅ 2026-10-08 |
| T60.3 | C 全网关       | endpoint=网关路径；调用成功                  | ✅ 2026-10-08 |
| T60.4 | 单测           | A/B/C/全网关回落矩阵确定性断言              | ✅ 2026-10-08 |
| T60.5 | 兼容           | 不设开关（缺省 true）行为                    | ✅ 2026-10-08 |

## 复测记录

| 日期       | 环境                                                                                                         | 结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-06 | 本地 PG + 远端沙箱，镜像 `mcp-proxy-t0906`，Yd-DeepSeek/deepseek-v4-flash                                    | T60.1 ✅（`url=http://10.12.10.189:9100` 直连形态，`Echo: direct-verify-ok`）；T60.2 ✅（`url=http://host.docker.internal:30040/sandboxes/bc0270f6-…/proxy/9100` 网关形态 + 同容器全局直连下 exec 正常，`Echo: mixed-verify-ok`）；T60.3 ✅（`url=…/sandboxes/d3274fad-…/proxy/9100`，`Echo: proxy-verify-ok`）；T60.4 ✅ 3/3；T60.5 ✅（单测+typecheck+session-mcp 13/13 / lifecycle 21/21 无回归）。注：远端网关路径为 `/sandboxes/{id}/proxy/{port}`（与 SDK 类型注释的 `/port/` 前缀略有差异，属远端版本格式，不影响）；直连模式实测 `10.12.10.189`（K8s pod 网段）在本地容器可达——该网段当前内网互通，跨网段部署时直连模式预期不可达，应使用 B/C。                                                                                                   |
| 2026-09-06 | 同上（echo 之外的第二个 server：`npx -y @ant-design/cli mcp`，见 [`antd-mcp.md`](./antd-mcp.md) 双模式记录） | 模式 A ✅（endpoint `10.12.10.193:9100` 直连，`antd.antd_list\|completed` 返回真实组件数据）；模式 B ✅（endpoint 网关 `/sandboxes/{id}/proxy/9100`，`antd.antd_list\|completed` 返回 72 组件）。npx 首次下载预热后两种模式链路一致，无回归。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2026-09-07 | 本地 PG + 远端沙箱，镜像 `t0907-wsfix`（含 WS 文本帧修复），Yd-DeepSeek/deepseek-v4-flash                    | T60.1 ✅（`url=http://10.12.0.205:9100` 直连形态，`Echo: direct-verify-ok`）；T60.2 ✅（网关 `/sandboxes/e7153692-…/proxy/9100`，`Echo: mixed-verify-ok`，exec 通道正常）；T60.3 ✅（网关 `/sandboxes/028fbae2-…/proxy/9100`，`Echo: proxy-verify-ok`）；T60.4 ✅ 3/3；T60.5 ✅（true + 不设开关 → 网关 `/sandboxes/1660a30d-…/proxy/9100`，`Echo: compat-fallback-ok`）。**同日开关缺省值变更**：`MCP_SERVER_PROXY` 缺省 false → **true**（`flag.ts` `truthy` → `!falsy`，跨网段安全默认）；缺省验证 ✅（全局 false + 不设开关 → 仍网关 `/sandboxes/6a526a5f-…/proxy/9100`，`Echo: default-true-ok` completed）；mcp/ 18 fail 为 baseline（stash 对照一致），typecheck 59 无新增。直连（pod IP 10.12.x）当前内网互通仍可达，跨网段部署由缺省 true 兜底。 |
