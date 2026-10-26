# Session MCP 双向交互验收（2026-10-24）

## 结论

Session MCP 已接通标准 `sampling/createMessage` 和 `elicitation/create`，不是仅声明 capability 或透传请求。

- 真实 Docker SaaS → Vercel Sandbox → stdio MCP → SaaS Form/模型 → MCP 响应：五场景通过。
- 75 秒人工审批等待：通过，禁止把工具失败后的模型重试计作通过。
- 原有 Code Mode、Tool Host、普通 MCP 三链路：通过。
- PG 专项：15 pass / 0 fail；本地关联回归：133 pass / 1 fail，515 assertions。
- Core/Server typecheck、变更文件及执行器 lint、diff whitespace 检查通过。
- 本轮十个测试沙箱及其快照经远端只读复核全部清理；独立测试容器已删除，原 `opencode-saas` 保持 healthy，未重启。

唯一未通过的回归是 `packages/core/test/mcp.test.ts` 的 modern protocol / `exposes every connection operation`，5000ms 超时；本任务开始前的基线已存在，未以 skip 隐藏。

## 实现边界

1. 桥接把反向请求送到所属 POST SSE，不向 GET 通知流广播。正向 ID 重映射，反向使用不透明一次性 ID；接受 JSON-RPC result/error POST 并还原 stdio ID。
2. 同一交互连接串行执行工具，使用本地实际调用的 sessionID 归属，不能信任服务自报的 `_meta`。父、子会话仍共享资源 owner 的连接。
3. 超时、断开和取消会结算待处理请求；取消正在运行的 stdio 调用后不复用该子进程，避免迟到反向请求被归到下一个调用者。Session 工具失败只淘汰连接，不自动重放 `tools/call`。
4. Sampling 使用会话所选模型，最多 4096 output tokens；只传 MCP 提供的消息和 systemPrompt，不附加会话历史、不向 MCP 提供模型凭据。支持 temperature/stopSequences；请求执行前及结果返回前分别经会话 Form 审批，拒绝/取消返回 JSON-RPC `-1`。
5. 仅声明基础 `sampling: {}`。未实现的 tools/context 子能力不声明；收到相应参数返回 `-32602`，不静默忽略。文本输出；文本、图像、音频输入映射到 LLM，最终取决于会话模型支持的模态。
6. Elicitation 复用现有字段映射和 durable Form：accept 返回内容，decline 不强求填写业务字段，取消返回 cancel，空 schema 仍需同意。URL 模式只确认授权，不把同意解释为外部流程完成。
7. Session Form 走现有 PG HITL ledger 和公共 SSE，审批可由其它 pod 经同一 API 结算；本轮未做双 pod 并发初始化/恢复的真实压测。
8. 本次接入对象是 **Session MCP**；Location/global MCP 保留原有交互路径，没有改成会话采样。

## 发现与修复

- 执行器曾误用取消接口；改为 `DELETE /api/session/:sessionID/form/:formID` 后完整重测。
- PG `payload`/`result` 为 JSON 文本；后检先解析再断言，并保留 `pg.json`。
- 延迟审批复现 Runner 断连；仅补 WS 心跳后仍遇到等待超时；再补 POST SSE 注释心跳后，同样 75 秒延迟通过。现在 Runner 每 15 秒发 WS control ping，桥接 POST SSE 每 15 秒发注释心跳，关闭时清理 timer。
- 回归还复现了后台 catalog 先发现 session expiry、工具只收到 `Connection closed` 的竞态；客户端将已确认过期连接的该关闭错误归为 SessionExpiredError。对应原有重连回归随后通过。

## 证据与复跑

证据根目录：`artifacts/vercel-mcp-interactions-20261024/`。

| 目录/文件 | 内容 |
| --- | --- |
| `final/` | 最终五场景、原始公共 SSE、每轮模型事件、表单决策、PG 后检及清理 |
| `slow1/`、`slow2/`、`slow3/` | 延迟审批的复现、单通道保活复测及最终通过证据 |
| `chain/` | 三条原有真实模型链路回归 |
| `cleanup-verification.json` | 十个沙箱/快照的远端只读清理复核 |
| `checks/`、`summary.json` | 单测、PG、类型检查和 lint 证据汇总 |

执行器：`docs/test-cases/scripts/mcp-interactions-v2.mjs`，通过 `sandbox-vercel-t19.mjs` 包装器运行，创建会话后先订阅公共 SSE，再触发模型。使用独立测试 PG 和独立 Docker 容器；不要在原服务上复跑。延迟场景额外设置 `MCP_SCENARIO=sampling_probe`、`MCP_APPROVAL_DELAY_MS=75000`。

最终测试镜像：`opencode-saas:vercel-mcp-final-20261024`。Vercel 镜像已包含新版 Runner 资产；若部署到 OpenSandbox，需同步重建含该 Runner 的沙箱镜像，本轮没有替换现有 OpenSandbox 镜像。

标准依据：MCP [Sampling](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling)、[Elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)、[Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)，以及当前仓库使用的 MCP Client/Core 2.0.0 类型和实现。
