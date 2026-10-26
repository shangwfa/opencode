# Vercel 云端并发与模型 Code Mode 补验（2026-10-26）

## 环境与范围

- 两个 Docker SaaS Pod：`opencode-vercel-t19-audit-a/b`，端口 15150/15151，共享独立 PG `opencode-v2-vercel-audit-e2e-test`。
- 镜像 `opencode-saas:vercel-audit-e2e-20261026`，包含本次审查修复后的源码，后端为真实 Vercel Sandbox；空闲回收阈值 60 秒，Code Mode executor 配置为 sandbox。
- 模型：`deepseek/deepseek-flash`。未输出或入库云凭据与模型凭据。
- 全程订阅两个 Pod 的公共会话 SSE；现有 wrapper 自动应答 pending 表单，并按 API、事件、PG 核验及清理。

## F：真实模型 / Code Mode / 跨 Pod MCP

执行器：`sandbox-vercel-session-mcp-t22.mjs`，`MCP_T22_STAGE=F`，经 `sandbox-vercel-t19.mjs` 包装；子会话共享根沙箱，配置 `EXPECT_SANDBOX=0`。

**4 项业务断言全部通过，wrapper passed**：

1. Pod A 的 slowEcho 执行期间，Pod B 开始子会话执行；慢调用完成，无 MCP 调用错误。
2. 两个 Pod 共享一个健康 bridge，PID `950 → 950`。
3. ambiguous 工具写入后断开：只调用一次、仅一条副作用记录、错误不自动重放。
4. 死亡 stdio 在下一次派发前恢复，下一次 echo completed，bridge PID 改变。

公共 SSE 共记录 5 次 `execute` 调用开始，真实嵌套 MCP 调用与结果均由模型轮次产生。事件顺序交叉验证：slowEcho running 序号 96，Pod B 子会话 execution.started 序号 107，slowEcho success 序号 109，证明另一 Pod 开始执行时慢调用尚未结束（不是仅在结束后串行验证）。此处不声称 Pod B 的 echo 已在慢调用结束前完成。

证据：`artifacts/vercel-audit-e2e-20261026/F/{result.json,t22-F-report.json,events.json,overlap.json}`。

## 回收竞争与端口网关

新增执行器 `sandbox-vercel-multipod-race.mjs`，同样经公共 SSE wrapper 驱动。

**4 项业务断言全部通过，wrapper passed**：

1. Pod A/B 并发注册 8081/8082 的真实公网 token 网关，分别返回对应端口的服务内容；另一 Pod 再次解析后均保持可达。
2. PG 行锁阻塞 sandbox 行，两个 sweep 在旧活动水位上读取并尝试 claim；实际观察到 2 个 UPDATE 等待锁。提交新的活动水位后，两个旧 claim 均未停止实例，云端与 PG 保持同一 running generation。
3. 再次阻塞 2 个回收 claim，经原生 Vercel SDK 对该测试实例执行真实 stop/resume，确认快照创建和新 generation；锁内提交真实新 generation 后，旧扫描未停止新实例。
4. 竞争前后通过两个 SaaS Pod 的 shell API 读到原工作区标记。

第三项是 **PG + 云端 SDK 故障注入**，不冒称 stop/resume 是经 SaaS 生命周期 API 执行。它专门验证扫描候选对已经替换的实际 VM 不能生效。两个 Pod 的服务日志均没有 statement/lock timeout 或生命周期回收失败警告，避免将“等待超时没停机”误当成 CAS 保护生效。

证据：`artifacts/vercel-audit-e2e-20261026/race2/{checks.json,result.json,events.json}`。首跑 `race/` 因新执行器误读 endpoint JSON 层级而失败，未进入回收竞争；修正为顶层 directUrl 后重跑通过，失败证据保留。

## 清理

- PG：session_v2=0、session_mcps=0、sandbox_command=0、非 destroyed 或 remote_name 非空的绑定=0。
- 原生 SDK 查询本轮三个测试 workspace 名称，均 404。
- 默认不物理删除快照的配置下，删除 workspace 后按名称查询快照为空，但项目快照目录仍存在本轮代次产生的 3 个孤儿快照。按已记录的 4 个测试 generation/sourceSessionId 精确删除这 3 个快照；再次全目录扫描，本轮代次的非 deleted 快照为 0，未删除其他代次资源。
- 两个测试容器已停止，独立测试库与镜像保留。相关脚本 oxlint 通过；本轮未修改产品代码。

证据：`cloud-cleanup.json`、`orphan-snapshot-cleanup.json`、`pg-cleanup.json`、`docker-a/b.log`，均在 `artifacts/vercel-audit-e2e-20261026/` 下。

本轮补齐此前“未跑 Vercel 云端并发 E2E、未重跑模型 Code Mode 轮次”的边界；不扩展为 Vercel 全功能或所有后端完整验收。
