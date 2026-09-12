# 会话卡死案例分析:write 工具 pending 挂死(LLM 参数流中断)

- 会话:`ses_f70e676f1ffehnORNn7AawX6aE`(开发商品仓库管理功能,dyn-orchestrator)
- 日期:2026-09-11
- 环境:本地容器 opencode-saas-test + PG(15432 TCP 转发)

## 现象

任务执行到创建 `ProductList.vue` 时卡死,无报错、无输出,持续 97+ 分钟未恢复。

## 时间线

| 时间 | 事件 |
|---|---|
| 14:13:30 | 父会话创建(dyn-orchestrator) |
| 14:15:18 | 子会话 @explore 完成 |
| 14:23:56 | 子会话 @dyn-spec 完成需求澄清 |
| 14:27:37 ~ 14:28:23 | 父会话正常执行:todowrite / read ×2 / bash mkdir 全部成功 |
| 14:28:31 | reasoning: "Now let me create the ProductList.vue component." |
| 14:28:32 | **write 工具 part 创建,`status=pending`、`input={}`** |
| 14:28:56 | 消息被标记 `time.completed`(LLM 流结束) |
| 14:28:32 之后 | 永久挂起,无任何恢复 |

## 排查证据(SQL,详见 session-diagnostic-guide.md)

```sql
-- 1. 卡住的 part:pending + 空 input + 空 raw
SELECT jsonb_pretty(data) FROM part WHERE id = 'prt_08f274dfa0014ZiGTXlZSUcz5J';
-- {"tool":"write","state":{"raw":"","input":{},"status":"pending"},"callID":"call_8222892e80d94bc3b505ca88"}

-- 2. exec_log 无该 write 的执行记录(当时工具链路在 exec_log 完全无记录,后已修复)
SELECT * FROM exec_log WHERE session_id = 'ses_f70e676f1ffehnORNn7AawX6aE' AND time_started > 1789107900000;

-- 3. permission 表无该 callID 的审批记录 → 未走到 ctx.ask
SELECT 1 FROM permission WHERE data::text LIKE '%call_8222892e80d94bc3b505ca88%';  -- 空

-- 4. sandbox 正常:state=running,心跳持续更新 → 排除 sandbox 故障
SELECT id, state, to_timestamp(time_updated/1000) FROM sandbox
WHERE session_id = 'ses_f70e676f1ffehnORNn7AawX6aE';
```

## 根因

**LLM 流式响应中 tool-call 的参数流(input_json_delta)未送达**,框架层面无兜底:

1. `session.next.tool.input.started` 事件到达 → part 以 `pending` + `input=""` 落库(message-updater.ts:249)
2. 参数 delta 与 `session.next.tool.input.ended` **从未到达** → input 永远为空
3. LLM 流结束,消息标记 completed,但工具调用从未进入执行队列(无 `tool.called`,part 未变 running,无 `time.ran`)
4. run 循环等待一个永远不会执行的 write 调用 → 整个会话挂死

## 为什么现有保护全部失效

| 保护机制 | 默认值 | 为何未触发 |
|---|---|---|
| `FILE_WRITE_TIMEOUT`(write.ts:24) | 60s | 工具从未开始执行,超时逻辑挂在 execute 内部 |
| LLM stall 保护(`OPENCODE_LLM_STALL_TIMEOUT_SEC`) | 300s | 只监控 LLM token 流;此处流已正常结束(t_completed 有值) |
| Runner 陈旧 run 接管(`OPENCODE_SESSION_STALE_RUN_SEC`) | 1800s | 待确认是否覆盖「pending 工具未执行」场景,实测 97 分钟未接管 |
| `failUnsettledTools` 流结束兜底(llm.ts:357) | — | `hostedOnly=true` 时只处理 provider 执行的工具;write 连 tool-call 都未完成(`called=false`)被跳过 |

## 排除项(易混淆点)

- **不是权限审批卡住**:权限「发起申请」只发 SSE 事件(Event.Asked,permission/index.ts)不落库;「回复」才写 exec_log(`permission-respond`)。若卡审批,part 应为 running 且 event 流有 Asked 无 Replied。
- **不是 sandbox 故障**:sandbox running 且心跳正常,此前 read/bash 均成功。

## 已落地修复(2026-09-11/12)

1. **exec_log 观测盲区修复**(`packages/opencode/src/session/tool-exec-log.ts`):监听 SaaS V1 `message.part.updated` 事件(processor.ts 的 tool part 状态机),每个工具调用在 pending 时插入 `source=tool-call` 行(status=running),running/completed/error 收敛终态。挂载于 httpapi 路由层与 AppLayer。挂死调用表现为「running 且 time_finished IS NULL」,一查即现。审计加固(2026-09-12 审查后):行键改为 `tool-<partID>`(callID 仅保证单响应内唯一,跨会话复用会串写);所有状态均为幂等 upsert 且按 `session_id + status=running` 守卫——迟到/重放终态不回改已 settle 行,终态事件可自行恢复建行;写入走有界队列(容量 1024,单消费者后台落库),`events.publish` 不再等 PG;`command.input` 单层 JSON(超限降级为 `truncated` 字符串)。
2. **根因兜底 — SaaS V1 链路**(`packages/opencode/src/session/processor.ts` cleanup):原逻辑只处理 `running` 残留,参数流丢失的 `pending` 工具被跳过 → 永久挂死。现改为 pending 也置 error(`Tool call interrupted before arguments were received`),run 正常收尾。**这是生产实际生效的修复**。
3. **根因兜底 — core V2 链路**(`packages/core/src/session/runner/publish-llm-event.ts`):同构缺陷(流结束 `hostedOnly` 跳过未 called 工具)同步修复,上游 V2 runner 架构切换后生效。

对应验证:单测 `packages/core/test/session-runner-fail-unsettled.test.ts`(7 用例)、`packages/opencode/test/session/tool-exec-log.test.ts`(10 用例,V1 PartUpdated 事件 + 跨会话隔离/终态单调/恢复建行)、`packages/opencode/test/session/processor-tool-input-stream.test.ts`(V1 pending-never-called 回归,撤修复即红);集成用例 `docs/test-cases/agents/session-exec-log.md` T17.28(全链路记录+挂死签名 SQL)、T17.29(正常回合无残留)、T17.30(abort 兜底收敛)——镜像 `t0912-toolexeclog` 本地 PG+远程沙箱实测全过。

## 剩余 TODO

1. **run 级兜底**:确认 stale run 接管(`OPENCODE_SESSION_STALE_RUN_SEC`)覆盖「消息 completed 但存在未 settle 的 tool part」状态
2. 网关侧排查 claude.shadow-rpa.net 对 tool_use 参数块的透传完整性(Yd-DeepSeek/deepseek-v4-flash)

## 相关文件

- `packages/core/src/session/runner/publish-llm-event.ts` — tool part 状态机与流结束兜底
- `packages/core/src/session/message-updater.ts` — pending → error 状态迁移
- `packages/opencode/src/tool/write.ts` — write 工具(60s 超时,仅覆盖执行阶段)
- `packages/opencode/src/session/tool-exec-log.ts` — 工具调用 exec_log 记录(本次新增)
- `docs/guides/session-diagnostic-guide.md` — 通用诊断流程
- `docs/test-cases/agents/session-exec-log.md` — exec_log 审计用例库(T17 系列)
