# Vercel Sandbox P0：SDK 契约验证记录

日期：2026-10-24。状态：**本地契约、真实 SDK smoke 和 provider T19 接口验收已通过；P0 全量 Agent 验收尚未通过。**

后续接入：已注册 Vercel provider，T19.1–T19.6、Code Mode、Tool Host 和 Session 本地 MCP echo 均通过 Docker→Vercel→PG/SSE 真实链路验收。MCP 曾受 supergateway 握手限制，现已采用自研 HTTP 桥接替换。最终证据 `artifacts/vercel-agent-chain-20261024/final/`，报告见 [`../test-cases/sandbox/vercel-exec-api-2026-10-24.md`](../test-cases/sandbox/vercel-exec-api-2026-10-24.md)。以下为历史阶段记录；完整 MCP 协议、多客户端隔离及多 pod 并发仍未验收。

## 1. 本次交付范围

- 固定 `@vercel/sandbox@3.8.0`，记录在 `packages/core/package.json` 与 `bun.lock`。
- 新增 `packages/core/src/sandbox/vercel/client.ts`：严格 retrieve/resume、元数据查询不唤醒、返回固定当前 VM 的 Session 与 generation。
- 新增 `sandbox/vercel/transport.ts`：在 SDK 公开 fetch 扩展点按同一次 RequestInit 复用结果，阻止 SDK 重试再次发送写请求；包括可恢复 VM 的 GET resume=true。普通只读 GET 仍可重试。
- 新增 `sandbox/vercel/command.ts`：固定 VM 的低层提交、流式观察和取消；观察输出可通过 producer 回调完整落盘，内存仅保留调用方指定的 UTF-8 前缀。取消先 TERM、超时后 KILL，并等待确认退出。
- 新增实际 SDK + 注入 HTTP transport 的契约测试，不 mock SDK 方法来替代恢复行为验证。
- 新增显式 opt-in 的 SDK smoke 脚本，覆盖建沙箱、`/workspace` 写入、前台退出码、取消、有界日志收集、停止、严格恢复、文件与代次检查、资源清理请求。创建、恢复和清理均应用同一写请求防重发策略。
- SDK 阶段未注册 provider；后续已新增 `sandbox/vercel/provider.ts` 并接入 Session API，验收范围以 T19 报告为准。

版本选择：包仓库可获取 3.9.0，但项目 Bun 的 72 小时 minimum-release-age 规则拒绝安装该版本，因此选择已满足规则的 3.8.0，没有绕过供应链安全限制。临时下载的 3.9.0 只用于早期对照，不是测试基线。

## 2. 已复现的事实

| 事实 | 证据 |
|---|---|
| `get({resume:false})` 查询停止状态，不创建或恢复 | `sandbox-vercel-sdk.test.ts` 元数据用例，检查请求方法、project/team 与 resume 参数 |
| 严格恢复遇到 404、410 snapshot_not_found、403、429 不退回 create/delete | 同文件参数化恢复失败用例；410 是该版本 snapshot_not_found 分支的实际 HTTP 条件 |
| `getOrCreate` 的 onCreate 无法保护旧数据 | 同文件复现 GET → DELETE → POST → onCreate 抛错；删除先于回调 |
| `Sandbox` 高层方法可能自动恢复 | SDK `dist/sandbox.js` 的 withResume；适配层返回固定 Session，使数据操作不经该自动恢复路径 |
| stop 不等于 delete | 同文件停止用例，检查只发送 `/stop`，保留 name 和快照元数据 |
| 前台命令提交在传输失败后只发一次 | 同文件前台错误用例；SDK `dist/api-client/api-client.js` 的 wait 分支显式 retries=0 |
| **detached 提交在不确定传输失败后会重发** | 同文件 UNSAFE 用例，同一 `/cmd` POST 共发出 3 次；这是已复现风险，不是验收通过项 |
| 接入防重发 transport 后底层写请求仅发送一次 | `sandbox-vercel-transport.test.ts` 覆盖网络失败、500、429、创建、resume 及不同命令不合并；原始 SDK 风险用例继续保留 |
| 真实 HTTP 断连和 307 重定向不导致再次提交 | `sandbox-vercel-http.test.ts` 本地 TCP/HTTP 服务计数，已收到命令后断开 socket 或返回重定向，命令提交数均为 1，重定向目标收到 0 次请求 |
| 流式观察持续排空日志，不调用 SDK 累计输出方法 | `sandbox-vercel-command.test.ts`，128 KiB 流只保留 64 字节，producer 回调收到全部输出；另验中文截断和零捕获上限 |
| 取消不能凭发送成功就报完成 | 同文件覆盖 TERM 成功、超时 KILL、KILL 后无法确认退出、外部取消不冒充超时、已结束任务、旧代次与错误命令身份 |
| 固定 VM 的命令查询/kill 不经过高层 auto-resume | 同文件按 vm-1 查询并 kill 用例；SIGTERM 在线路上编码为 15 |
| 前台执行等待启动器结果，timeout=0 省略 SDK 字段 | 真实 T19 首轮发现服务端拒绝显式 0；同文件补回归，校验退出码 7、输出及 timeout 未发送 |

这些测试证明 SDK 请求和处理逻辑，不证明真实 VM 的状态、远端信号效果、网络可靠性或服务端计费行为。

## 3. 新发现及后续约束

1. **原始 SDK detached 的默认重试阻止直接映射后台任务。** 现通过公开 fetch 扩展点防止同一 SDK 请求重发；SDK 自身仍可能等待重试退避，但底层不重新提交。此保证依赖固定 3.8.0 的请求对象复用行为，升级必须重跑原始 SDK 对照和防护测试；不等于服务端 exactly-once，不防止调用方另发一轮新命令。
2. SDK 前台 runCommand 会累计 stdout/stderr（`dist/session.js`），即使提供 Writable 也并非零缓存。新增低层 start + observe 用 detached 句柄逐条读取 logs，绕开该累计路径；observe 等待完成才能向上层报告退出码，不能把 start 当成 RunInput.detached 的直接实现。捕获前缀有界不代表 SDK 单条日志帧已经设置大小上限，真实大文件/异常帧仍待验证。
3. `getCommand` 也存在高层 auto-resume；跨 pod 取消应使用固定代次 Session 并结合 PG 校验，不能在新 VM 上寻找旧 cmdId。
4. stop/delete/kill 等请求的默认重试和清理结果仍需逐项分析。SDK smoke 的 deleteOrphanSnapshots 是异步清理请求，不能报告为已完成存储 GC。
5. CommandRef 校验的是沙箱 name 和固定 VM 代次，并核对远端返回的 commandID；**不代替 PG 执行租约、根会话归属和 CAS 校验**。调用方取消前仍必须确认持久化所有权。observe 的取消只结束观察，真正终止任务须显式 cancel；不能假设关闭日志连接会结束远端命令。

## 4. 已执行检查与阻塞

本地测试命令在 `packages/core` 下执行：

```bash
bun run test test/sandbox-vercel-sdk.test.ts test/sandbox-vercel-transport.test.ts test/sandbox-vercel-command.test.ts test/sandbox-vercel-http.test.ts test/sandbox-vercel-spike.test.ts test/sandbox-config.test.ts
bun run typecheck
```

本轮最终结果：**61 tests passed / 0 failed / 194 assertions**（包括既有 sandbox-config 回归）。Core typecheck 通过；10 个相关 TypeScript 文件 oxlint 为 0 warnings / 0 errors。未修改 npm 依赖源码。使用项目测试执行器隔离环境及临时目录。

首次环境检查时凭据未配置。随后用户提供访问凭据并明确批准使用 `vercel-sandbox-default-project` 创建测试资源；凭据仅保存在仓库外的临时私有文件（目录 0700、文件 0600），未写入仓库或验证产物。真实 SDK smoke 已运行，见下节；Docker SaaS API/PG/SSE E2E 仍未执行。

### 4.1 真实 SDK smoke 结果

脱敏结果：`vercel-sandbox-p0-result-2026-10-24.json`。8 个阶段均通过：

| 阶段 | 耗时 |
|---|---|
| 创建（2 vCPU、持久化、无公开端口） | 2373 ms |
| `/workspace` 创建及写入 | 665 ms |
| 前台退出码 | 330 ms |
| 命令取消及退出确认 | 1261 ms |
| 日志限长并完整排空 | 1191 ms |
| 停止产生快照，元数据查询不唤醒 | 2341 ms |
| 严格恢复 | 1096 ms |
| 文件内容保留且 VM 代次变化 | 461 ms |

以上是单次样本，不是性能分位数或服务 SLA。脚本 finally 已请求删除；额外只读复核确认该 sandbox 返回 HTTP 404，按名称查询的快照列表为空。这证明 API 可见资源已清理，不证明底层物理存储 GC 已完成。

额外实测：Snapshot.list 的 limit=100 返回 HTTP 400，服务端错误明确要求 limit <= 50；改为 limit=20 后查询成功。后续分页不得从 SDK 的 number 类型推断出任意上限可用。

## 5. 安全运行 SDK smoke

脚本：`packages/core/script/vercel-sandbox-spike.ts`。

先在执行环境安全配置 `VERCEL_TOKEN`、`VERCEL_TEAM_ID`、`VERCEL_PROJECT_ID`，指向独立测试项目；不要将 token 放入命令行、文档或提交。

在 `packages/core` 下运行：

```bash
bun run script/vercel-sandbox-spike.ts --live --project "$VERCEL_PROJECT_ID" --output ./artifacts/vercel-p0/result.json
```

- 没有 --live 不发送请求；project 必须与环境一致，output 必填。缺少必要条件返回 blocked，退出码 2。
- 会产生账单资源：2 vCPU、120 秒运行 timeout、持久化开启、最多保留一份快照（一天过期），不开放公共端口，egress deny-all。
- 实时打印脱敏阶段及耗时，结果标记 `scope=sdk-smoke-only`。退出码 0 仅表示本脚本覆盖项通过，不代表 P0 全通过。
- finally 请求删除本次唯一随机名称及 marker 归属匹配的沙箱与孤立快照；创建响应丢失时仅 retrieve 对账，不重复 create。清理失败会标记失败，需按结果中的名称人工检查；异步存储 GC 仍需复核。

## 6. P0 剩余验收（均未宣称完成）

- 真实 API smoke 已通过（远端 kill、stop 快照和恢复代次）；完整 P0 仍须完成下列项目。
- 自定义 VCR 镜像及完整工具链验证。
- runner、Tool Host、MCP bridge 的 HTTP/WS 认证实现与真实连接验证，两个以上 MCP 的端口容量验证。
- 真实 VM 的有界输出、后台子进程/进程组取消效果及不确定提交处理；本地已覆盖请求级防重发，不把它等同远端全链路验收。
- 大文件/Range、配额/限流、实际启动耗时和费用。
- P1 接入后的双 pod、PG 租约/generation、API 与 SSE 流式 E2E；这不是 SDK smoke 可以替代的验证。

P0 门槛通过后再将 provider 接入会话路由。当前不能把 OPENCODE_SANDBOX_PROVIDER=vercel 当作可用配置。
