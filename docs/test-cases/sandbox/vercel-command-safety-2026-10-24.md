# Vercel 命令防重发、输出与取消

状态：本地 SDK/HTTP 测试及真实 VM 的 SDK smoke 通过；SaaS API、PG/SSE E2E 未执行。

## 问题复现与防护

原始 SDK 3.8.0 的 detached 提交在传输错误后重试两次，同一命令最多提交三次。测试保留原始行为作为对照，适配层通过公开 fetch 扩展点阻止同一次写请求重发，未修改依赖包源码。

| 用例 | 预期 | 本轮结果 |
|---|---|---|
| 原始 SDK 命令提交网络失败 | 复现三次底层请求，证明不能直接使用 | 通过（风险对照，不是接入验收） |
| 防护后网络失败、500、429 | 只发送一次，失败和不确定结果向上传递 | 通过 |
| 本地 HTTP 收到命令后断 socket | 提交一次，无隐式重新执行 | 通过 |
| 本地 HTTP 307 | 不向重定向目标重新提交 | 通过 |
| 两条内容相同的新命令 | 分别提交，不错误合并 | 通过 |
| GET resume=true 失败 | 不自动重复恢复 | 通过 |
| 普通只读元数据 GET 临时 503 | 保留只读重试 | 通过 |
| 128 KiB 日志、64 字节捕获上限 | 回调收到全部输出，返回前缀有界，完成后读取退出码 | 通过 |
| 中文截断、零捕获上限 | 无损坏字符，继续排空双流 | 通过 |
| 旧 VM/其他工作区引用取消 | 发起任何远端命令请求前拒绝 | 通过 |
| 错误 commandID 元数据 | 不观察错误任务、不发送 kill | 通过 |
| TERM 后正常结束 | 确认退出，不额外 KILL | 通过 |
| TERM 宽限过期 | KILL 后确认退出再返回 | 通过 |
| KILL 后查询失败 | 返回失败，不虚报取消成功 | 通过 |
| 调用方取消宽限等待 | 保留取消原因，不误判为应升级 KILL | 通过 |
| producer 持久化输出失败 | 错误传播，不重提执行 | 通过 |

命令：在 `packages/core` 下运行 `bun run test test/sandbox-vercel-transport.test.ts test/sandbox-vercel-command.test.ts test/sandbox-vercel-http.test.ts test/sandbox-vercel-sdk.test.ts`。测试代码含实际 SDK 的 HTTP 请求/响应断言，本地 HTTP 服务验证不是内存 transport 的替代描述。

## 后续真实环境验收要求

1. 独立 Vercel 项目执行 `script/vercel-sandbox-spike.ts`；显式 --live 并记录脱敏阶段证据。此脚本仅 SDK smoke，不是 SaaS E2E。
2. provider 接入后 SaaS 在 Docker 中启动，通过会话 API 执行；全程订阅 `GET /api/session/:sessionID/event`，按 `../skills/streaming-output-spec.md` 实时输出工具、文本、问答和执行状态。
3. 双 pod 取消与恢复须核对 PG 根会话绑定、命令记录、执行租约和运行代次；本轮内存引用校验不能替代。
4. 真实 VM 需确认 TERM/KILL 对后台子进程/进程组的实际效果，以及父会话中断时显式取消命令，而不只是关闭日志流。
5. 出现不确定提交时禁止模型/执行器自动重放；检查远端实际副作用次数。所有阶段分别检查结果、过程和 PG 数据。

用户后续提供凭据并批准默认 Sandbox 项目后，第 1 项 SDK smoke 已运行通过；结果见 `../../research/vercel-sandbox-p0-result-2026-10-24.json`。命令取消只验证本次 Node 任务，后台子进程/进程组、双 pod 与 SaaS API/PG/SSE 仍不能标记已通过。
