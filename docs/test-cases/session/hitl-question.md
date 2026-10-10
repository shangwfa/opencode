# V2 Question / Form / Permission HITL 验收

> 本文已从 V1 SaaS 定制 HITL（`question` / `permission` 根端点、`hitl_request` 表、租约清扫）改写为当前 V2 API 与实现。V2 的 question 工具通过 **Form** 收集答案；Permission 是独立的授权请求。不要再运行本文旧版中的 `/prompt_async`、`/exec`、`/question`、`/permission/:id/reply`、`new_sid` 或 `hitl_request` SQL。
>
> **源码事实（2026-10-10，HITL 持久化七批实现后）**：PG SaaS 模式下 Form/Permission pending 写入 `hitl_request` 表并跨实例可见；执行有 `session_execution_lease` 租约与终态 fencing；question 恢复 barrier 在重启后继续等待原表单并把答案记为工具终态；停机不再把等待 HITL 的工具结算为失败。SQLite 本地模式仍是进程内存（无上述能力）。设计全貌见 [`/hitl-persistence-v2-design.md`](../../hitl-persistence-v2-design.md)。

## V2 接口与数据边界

所有请求使用 `http://localhost:14096` + Basic Auth `opencode:<OPENCODE_PASSWORD>`。

| 目的 | V2 API | 成功语义 |
|---|---|---|
| 创建会话 | `POST /api/session`，`{title,location:{directory:"/workspace"},model}` | 200，`data.id` |
| 模型轮次 | `POST /api/session/:id/prompt_stream`，`{text,metadata:{},delivery:"queue"}` | SSE 执行结果；终态 `session.execution.succeeded/failed/interrupted` |
| 实时过程 | `GET /api/session/:id/event` | SSE，执行期间订阅；观察 reasoning/tool/form/text/终态 |
| 待处理表单 | `GET /api/session/:id/form` | `{data: Form.Info[]}`，只含 pending |
| 表单详情 | `GET /api/session/:id/form/:formID` | `{data: Form.Detail}`，状态位于 `data.state.status` |
| 创建/回复/取消表单 | `POST /api/session/:id/form`；`POST .../:formID/reply` `{answer:{fieldKey:value}}`；`DELETE .../:formID` | 创建 200；回复/取消 204；无效答案 400；已结束再操作 409 |
| Permission 待办 | `GET /api/session/:id/permission` 或 `GET /api/permission/request` | pending Permission.Request 列表 |
| 请求授权/回复 | `POST /api/session/:id/permission` `{action,resources,save?,metadata?}`；`POST .../permission/:requestID/reply` `{decision:"once"|"always"|"reject",message?}` | ask 返回 `effect:"ask"`；回复 204 |
| Session 持久授权 | `GET /api/session/:id/permission/approval`；`DELETE .../approval/:approvalID` | 列表 200；撤销 204；只操作指定 Session |
| 消息树 | `GET /api/session/:id/message?order=asc` | PG 持久化的 user/assistant/tool 消息 |

### 运行、实时观察与清理

```bash
cd /Users/ruomu/code/opencode
source docs/test-cases/test-env.sh 3
source docs/test-cases/test-lib.sh
export PG_URL='postgresql://local@127.0.0.1:15432/opencode-v2-up'
node docs/test-cases/scripts/hitl-question-v2.mjs
```

脚本通过 SaaS HTTP API 驱动所有用例；模型轮次另行订阅 `GET /api/session/:sessionID/event`，实时打印思考摘要、工具、表单回复、文本及执行终态，并自动按字段类型生成合法答案。脚本会重启**专用本地容器** `opencode-saas-test` 验证进程重启边界；禁止将 `RESTART_CONTAINER` 指向共享/远端服务。结束时删除本轮 Session 并查 PG 零残留。完整流式规范见 [`../skills/streaming-output-spec.md`](../skills/streaming-output-spec.md)。

## V2 用例矩阵

| 编号 | 场景与断言 | 持久化/过程证据 |
|---|---|---|
| F1 | 创建 Form；ID 为 `frm_`；Session 列表和详情均可见，状态 pending | HTTP API |
| F2 | required/options 校验：不在 options 中的答案返回 400；合法回复返回 204，详情变 answered，pending 列表移除 | HTTP API + Form state |
| F3 | 已 answered 再回复返回 409；DELETE 取消返回 204，详情变 cancelled | HTTP API |
| F4 | 多字段 select + multiselect + optional 空值可提交，答案原样回读 | HTTP API |
| F5 | 另一 Session 的 Form 不出现在当前 Session 列表 | HTTP API，按 sessionID 隔离 |
| Q1 | AI 必须调用 `question` 工具澄清；SSE 实时看到 question tool 开始；测试自动回复；AI 按答案创建目标文件 | Session SSE + `message` tool part + 沙箱产物 |
| Q2 | Form 的回答传回模型并影响后续行为；tool part / assistant 文本均核对答案 | PG `session_message` + HTTP 消息树 |
| P1 | Session 配置 `bash/* -> ask`；Permission API 产生 ask；待办可见；once 回复 204 后从 pending 列表移除 | HTTP API + permission SSE（若订阅该 session） |
| L1 | pending Form 与 Permission 在服务存活时静置 185 秒仍可见 | HTTP API + `hitl_request` 行 |
| R1 | 重启专用容器：Session 与消息历史仍存在；pending Form/Permission 从 ledger 恢复原 ID，原 ID 详情 pending，且可在重启后按原 ID 结算（回复 204） | HTTP API + PG `session_v2` / `session_message` / `hitl_request` |
| C1 | 删除测试 Session 后 PG `session_v2` 零残留 | PG |

### E2E 自动答题策略

Form 列表仅返回 pending 表单。答案结构是以 field `key` 为键的对象：string/select 选首个 option value；boolean 取 true；number/integer 取 default/minimum；multiselect 取首个 option 数组；external 不自动填写。测试只自动答复中性问题；业务拒绝/取消用例必须显式给出拒绝答案，不能一概自动放行。

## 已知实现边界与问题记录

1. **Pending 持久化（PG SaaS）**：Form/Permission pending 由 `hitl_request` ledger 持久化，任意 pod 可回复，owner 轮询消费；停机保留待办、不发布用户取消。SQLite 本地部署仍是进程内存（重启即失），与本矩阵 R1 的 PG 行为不同。
2. **SSE `form.created` 同 pod 关联已修复**：生产者发布顶层 `sessionID`；跨 pod 实时扇出经 PG LISTEN/NOTIFY（>7500 字节事件跳过，远端依赖重连读 pending）。
3. **恢复语义**：question 重启后继续等待原表单并把答案记为 `tool.success`；Permission 批准不重放原操作（明确 not-executed 失败），拒绝收敛 `permission.rejected`；Code Mode execute 无检查点，按失败收敛。
4. **V1 文档结论不适用于当前 V2**：旧 API、跨实例 PG CAS、answered-lost 回填、`always` 写入 `session.permission`、用户维度隔离等属于旧 SaaS 定制实现。当前 PG SaaS 的 `always` 写入 `session_permission_approval`（当前 Session 作用域），不消费或新增项目级 `PermissionSaved`；SQLite 路径保留项目级兼容语义。

## 原 V1 用例（T1–T8）到当前矩阵的映射

原 V1 SaaS 套件的能力点在 V2 中的对应关系（未逐字移植，语义重新落位）：

| V1 用例 | V2 对应 | 状态 |
|---|---|---|
| T1 问答回合（question 创建/回复/继续） | F1–F3 + Q1–Q2 | ✅ 本矩阵 |
| T2 答案持久化与回读 | F2 + PG 消息树断言 | ✅ 本矩阵 |
| T3 多实例回复（跨 pod CAS） | R1 原理结算 + 双容器 `hitl-session-approval-api.mjs` 跨 pod 授权 + `hitl-recovery-e2e.mjs` B 回复 | ✅ 另两套脚本 |
| T4 owner 崩溃后接管（租约） | `session-execution-lease-pg.test.ts` 双 pod 租约接管 | ✅ 单测/集成 |
| T5 重启恢复原待办 | R1（ledger 恢复）+ `hitl-recovery-e2e.mjs`（恢复继续执行） | ✅ 本矩阵 + E2E |
| T6 always 授权持久化与隔离 | `hitl-session-approval-api.mjs` 26 项 | ✅ 专用脚本 |
| T7 拒绝/取消级联 | F3 取消 + Permission reject（permission.test.ts + E2E） | ✅ 单测 + 本矩阵 |
| T8 用户维度待办隔离 | 未按 V1 的 user_id 模型移植；V2 以 Session 归属与访问控制为边界 | ⚠️ 设计边界（见设计文档第10节） |

## 最近执行记录

执行后在此追加日期、服务镜像/版本、PG 组合、模型、各 case 结果、SSE 关键事件、PG 查询与清理情况。结果以脚本逐条 `PASS/FAIL` 和 `RESULT` 为准；失败需区分产品、模型、测试器及环境原因，修复后重跑。

### 2026-10-10：V2 定向套件重跑（非原 T1–T8 全量验收）

- 环境：组合 3；`opencode-saas-test`（`opencode-saas-restart-fix:local`，重启前后 healthy）；PG `opencode-v2-up`；模型 `Yd-DeepSeek/deepseek-v4-flash`。
- 脚本：`docs/test-cases/scripts/hitl-question-v2.mjs`；**38 项 PASS，0 项 FAIL**。
- 覆盖：Form create/list/get、答案校验与状态转换、重复提交冲突、cancel、多字段/多选/可选空答案、Session 隔离；真实 question tool 触发表单并自动回答；SSE 过程、tool part、assistant 答复、沙箱文件内容；Permission ask/once；185 秒 pending 存活；重启后 Session 与 PG 消息保留而内存 pending 丢失；两条测试 Session 均从 PG 清理为 0。
- SSE 实况：收到 `session.execution.started`、reasoning、question/write 工具生命周期、`form.replied`、assistant text、`session.execution.succeeded`。**没有观察到 `form.created`**，因此该事件的 per-session 实时推送仍是未验收问题（见上文边界 #2），其余 Q1/Q2 路径通过。
- PG 证据：测试 Session 的 `session_message` 有 6 条记录；重启后仍可查询；测试结束 `session_v2` 对两条专用测试 Session 的计数均为 0。当前 PG 的 `to_regclass('public.hitl_request')` 为空，符合当前 V2 源码边界。
- 期间修正：V2 Form 取消端点实测为 `DELETE /api/session/:id/form/:formID`；旧文档里的 cancel POST 不适用。

### 2026-10-10：HITL 持久化实现后全量重跑（新镜像）

- 环境：`opencode-saas-test` 重建为含七批实现的镜像（`opencode-saas-hitl-e2e:local`）；PG `opencode-v2-up`；模型 `Yd-DeepSeek/deepseek-v4-flash`。
- 脚本：`docs/test-cases/scripts/hitl-question-v2.mjs`（R1 断言已更新为 ledger 恢复语义）；**42 项 PASS，0 FAIL**。
- 新增覆盖：R1 重启后 pending Form/Permission 从 `hitl_request` 恢复原 ID、原 ID 详情 pending、原 ID 可结算（回复 204）；L1 185 秒存活在新代码（watchdog 豁免 question）下复验通过。
- 期间修正测试器三处大小写敏感断言（模型本轮选项输出为 `Python` 首字母大写）与 `session.execution.succeeded` SSE 时序竞争（加 15 秒宽容等待）；均为测试器问题，非产品缺陷。
- 恢复继续执行的端到端验收（真实模型、跨 pod 回复、产物核验）见 `hitl-recovery-e2e.mjs` 13 项 PASS，记录于设计文档第 23 节。

### 2026-10-10：Session always 双容器验收

- 脚本：`docs/test-cases/scripts/hitl-session-approval-api.mjs`。须设置 `PG_URL`（专用 `opencode-v2-test`）、`OPENCODE_PASSWORD`、`HITL_APPROVAL_RESTART_CONTAINER=opencode-saas-hitl-approval-a`。默认 A/B 地址分别为 `http://127.0.0.1:14270`、`http://127.0.0.1:14271`，可用 `HITL_APPROVAL_URL_A/B` 覆盖。
- 环境：当前工作区构建镜像 `opencode-saas-hitl-approval:local`；两个专用 Docker SaaS；共享 PG `opencode-v2-test`，端口15432；此套件只测控制面授权，不运行模型或 Code Mode，不计为 execute/工具恢复验收。未影响现有其他测试容器。
- 结果：最终镜像26项通过。A保存always，B读取并立即放行同Session；其他/子/fork Session不共享；once不持久化；显式deny优先；pending期间更新deny后回复返回403且无授权落库；跨Session撤销不生效；正确撤销跨pod立即生效；A容器重启后授权仍有效；Session SSE事件不串流；本轮Session与授权零残留。
- 实时订阅各测试Session SSE，逐事件输出asked/replied、权限更新等；每轮落盘HTTP响应、SSE事件、PG查询与结果，不只保存最终PASS。
- 期间发现并修正用例前置条件：空Session fork返回400 `empty_session`；改为通过Agent切换API产生正式历史后重测，fork隔离通过，未直接改写PG消息绕过事件投影。
- 仍未验收：跨pod pending回复、重启后原问题恢复、交付CAS/ownership、Code Mode续执行、跨podSSE。这些不是本套件的PASS项。
- 最终证据目录：`/private/var/folders/zk/8qd0lv657wn8kvpp__hwjj400000gn/T/opencode/hitl-session-approval-f8f26fa1-bc0b-482b-93b0-a4c3f30ed463`（`http.json`、`events.json`、`pg.json`、`result.json`）。镜像内9个关键实现文件与工作区SHA256一致；这轮是当前改动验证，不沿用旧镜像结论。
