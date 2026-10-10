# V2 SaaS HITL 持久化与执行恢复技术方案

状态：用户已授权实施，已开始前置验证与共享可靠性基础改造；进展见第17节。第16节固定实施路线，第15节规定技术约束；前文与之冲突时以这两节为准。

## 1. 已确认需求与目标

1. SaaS 进程重启、崩溃或请求落到其他 pod 后，保留原问题与审批请求，用户继续回答原请求，不重复提问。
2. Permission `always` 仅授权当前 Session，PG 持久化，跨 pod 与重启后有效；不授权其他 Session。
3. PG 是权威状态源；本地 Deferred 仅用于等待，不作为待办、答案或决策的权威来源。
4. 沿用 V2 Form/Permission API、领域服务、工具调用上下文及事件投影体系，不恢复 V1 API。
5. 不承诺任意工具副作用 exactly-once；不得把批准当成命令执行成功，不默认重放危险操作。

非目标：审批人/会签、多级审批、超时自动放行、跨用户授权、任意 MCP 回调/任意 Code Mode 程序的透明检查点恢复。

## 2. 当前源码依据及 V1 借鉴范围

| 位置 | 当前机制 / 对方案的约束 |
|---|---|
| `packages/core/src/form.ts` | Location Cache + Deferred；pending 无限 TTL；ask 中断时 cancel；close 取消 pending。需要区分用户中断与服务关闭 |
| `packages/core/src/permission.ts` | pending Map；assert 等待；close reject；always 写项目级 PermissionSaved。需要持久化并改为 Session 授权 |
| `packages/schema/src/form.ts` | Form owner 允许 `global`；真实 Session Form 可加 FK，global 不能直接加 Session FK |
| `packages/core/src/tool/plugin/question.ts` | Form metadata 包含 question 标记、messageID/tool ID；question 明确 `codemode:false` |
| `packages/core/src/session/runner/llm.ts` | drain 开始会 settleStaleToolCalls，将 running/streaming tool 置失败；HITL 恢复必须先于该步骤并排除受保护工具 |
| `packages/core/src/session/execution/restart.ts` | 既有恢复假设 managed-server 已确认旧进程死亡；不能直接作为多 pod 全库恢复器 |
| `packages/server/src/session-stream.ts`、`packages/schema/src/form.ts` | session SSE 过滤顶层 sessionID；form.created 当前仅嵌套 form.sessionID，需修复 |
| `packages/core/src/permission/saved.ts`、`permission/sql.ts` | 已保存授权按 projectID，缺少 Session/用户维度；不得用于本需求的 always |
| `packages/core/AGENTS.md` | Bus 聚合锁是进程内锁；跨 pod 必须依靠 PG 事务和条件更新 |

参考分支：`feat/opencode-1.18.31` 的 `packages/opencode/src/hitl/{store,salvage,request.pg}.ts` 与 Question/Permission service。
复用思想：PG ledger、CAS、事务、数据库时间、owner lease、轮询、交付留痕、并发上限。
不沿用：owner 死亡即关闭 pending、V1 Part SQL、项目/用户跨 Session approved 缓存、V1 HTTP 路径。

## 3. 核心设计：三个不同的状态边界

必须分离：

- **用户决策状态**：未答、已答、取消/拒绝。owner 更换不改变决策。
- **执行所有权**：哪个 pod 有权接管该 Session 执行及交付关联结果。
- **交付状态**：答案/决策是否已被原工具等待器或恢复流程消费，是否已形成工具终态。

不能用单个 `closed` 字段同时表达三者。回复持久化成功意味着用户答案已保存，不意味着工具已执行或轮次已完成。

## 4. 数据模型

### 4.1 `hitl_request`（新表，统一协调，不统一业务实现）

建议字段：

| 字段 | 语义 |
|---|---|
| id | 沿用 frm_ / per_ ID；主键 |
| kind | form / permission |
| session_id | FK -> 当前 Session 表，删除级联；本阶段仅真实 Session 请求 |
| scope_key / user_id | 服务端确定的作用域、可信发起身份；不得从回复 body 指定 |
| payload | JSON：Form.Info 或 V2 Permission.Request；通过领域 schema 编解码 |
| decision | pending / answered / cancelled / approved / rejected |
| result | Form answer，或 permission decision/message；未答为空 |
| source | 服务端持久化的 messageID、tool ID、执行关联信息；不将 metadata 任意字段当可信恢复指令 |
| recovery_kind | question / permission / detached-form / unsupported；显式决定恢复策略 |
| delivery | waiting / ready / delivered / abandoned |
| delivery_reason | 用户取消、执行中断、恢复不支持、原操作状态不明等原因 |
| version | CAS 状态版本 |
| time_created / time_updated / time_decided / time_delivered | 数据库时钟时间戳 |

约束：kind/decision/result/delivery 合法组合 CHECK；Session FK；tool 关联唯一性或请求幂等键防同一恢复请求重复创建。
索引：Session+pending、作用域/身份+pending、Session+delivery、终态 retention。
数据库 JSON 列按当前 V2 schema/生成流程实现，不手工复制 V1 pgJsonb 包装。

### 4.2 Session 执行所有权

优先扩展现有 execution claim 的持久化边界，增加 owner、租约到期与单调 fencing epoch；若现有表无法承载，新增与现有 claim 一对一的 ownership 记录，不建立两套互不关联的执行 owner。

所有接管在 PG 内 CAS：只接管已过期的 owner，epoch 递增。续租和恢复提交均检查 owner+epoch。
HITL 请求不需要独立竞争 Session owner；恢复关联请求由 Session owner 处理。等待器登记可以留在内存，不能影响 PG 正确性。
普通用户 reply 不要求 Session ownership，只要求授权和请求 decision CAS。

### 4.3 `session_permission_approval`

字段：id、session_id FK、action、resource、source_request_id、创建时间；唯一键 session_id+action+resource。
always 的 CAS、approval 插入、匹配待办级联决策在同一事务完成。
本需求不向项目级 PermissionSaved 写入授权。

## 5. 状态机与 API 幂等

Form：pending -> answered 或 cancelled；Permission：pending -> approved(once/always) 或 rejected。
owner lease 过期：**只改变执行 ownership，不改变 pending 决策**。
已决请求：waiting -> ready -> delivered；执行被用户中止或无法安全恢复时 -> abandoned，保留决策与原因。

- 相同答案/决策重复提交：204，结果不变；JSON 对象比较采用规范化比较，数组顺序按字段契约保留。
- 不同答案/决策、回复已取消请求：409。
- 不存在、非所属 Session、无权访问：使用统一的不存在语义，防枚举。
- Form 非法字段/非法答案：400，不修改请求版本和状态。
- 返回 204 前必须成功提交 PG；事务失败不宣称回答成功。

重复提交返回204是相对当前 Form“重复提交均409”的明确契约变更，须同步测试和文档。

## 6. 正常路径与跨 pod 通信

### 6.1 创建与等待

1. 校验 Session、可信身份、字段或权限规则，确定恢复类型及工具关联。
2. PG 事务登记请求；同 Session advisory/row lock 下检查 pending 总上限（建议默认10，Form+Permission 合计，避免 V1 文档与实现计数偏差）。
3. 事务完成后本地登记/读取等待器，并立即再读 PG 决策，覆盖“回复早于 Deferred 登记”的竞态。
4. 发布通知；等待期间轮询只读取状态，不将用户未答当超时失败。

### 6.2 回复

任意 pod 校验权限 -> PG CAS 决策 -> 提交 -> 发布通知。
owner 用约1秒轮询消费；LISTEN/NOTIFY 可选作为唤醒优化，丢通知不影响可靠性。
轮询按本地活跃等待 ID 批量查询，续租与决策轮询分开调度，避免仅“每30次迭代”导致长查询后租约失效。

### 6.3 事件可靠性

PG 是待办恢复来源。用户界面连接/重连 SSE 后必须重新 GET pending/详情，不能仅依赖 asked 事件。
创建/回复事件不得在未提交事务前发出；若要求提交后崩溃也能可靠通知，采用现有 durable event 事务机制或事务 outbox。
首阶段明确“不承诺 ephemeral SSE 补放”，不得把 ledger 持久化当作 SSE 已可靠重放。

## 7. 重启与执行恢复（关键依赖，不能后置）

### 7.1 服务关闭与用户中断必须分开

- shutdown / Location reload / pod eviction：撤销本地等待器，保留 pending 和已决结果，不发布用户 cancel/reject。
- 用户 interrupt：按现有中断语义停止轮次，将关联 pending Form cancelled、Permission rejected，明确原因；已提交决策不覆盖，未交付标 abandoned。
- 单独 Form DELETE：取消该 Form，沿用 question dismissal 的执行语义。
- Session DELETE：事务级防新请求插入，FK 清理；本地等待器被取消，任何 pod 后续操作均不可成功。
- detached Form：没有执行等待器，owner 不存在也仍可回复。

### 7.2 恢复顺序

1. 后台恢复调度器发现过期执行 owner，PG CAS 获取新 epoch；不能无条件调用现有全库 restart sweep。
2. 在恢复模型请求前枚举与遗留 tool 对应的 HITL。
3. question pending：等待原 Form 回复，原 Form ID不变；此工具不进入 settleStaleToolCalls。
4. question answered：依据原问题 input 和 answer 重建 QuestionTool 标准 output/content/metadata，经 V2 tool success 事件形成终态。
5. question cancelled：按 QuestionTool.CancelledError 对应的 V2终止语义收敛，不再等待。
6. Permission：按下一节判定，不把批准转换成 Tool.Success。
7. 其他遗留工具仍按现有恢复规则处理；关联 HITL 完成交付后再继续模型轮次。

消息更新、交付标记和 fencing 检查在同一 PG事务边界提交；采用现有事件投影路径，不独立 SQL 修改消息JSON。实施时需补充该跨进程事务能力，Bus 进程内 KeyedMutex不能替代它。

旧 owner 失租后必须停止后续调度；旧 epoch 的提交失败。已经发到沙箱/MCP 的外部副作用不能靠数据库 fencing 撤回，这是必须公开的限制。

## 8. Permission 恢复与副作用安全

授权请求与工具执行分为“授权等待 / 授权已获 / 操作派发 / 结果落库”阶段，并保存可识别的关联检查点。

- 原 Permission pending：保留请求ID，新 owner等待用户决策。
- reject：执行不派发；有反馈和无反馈维持V2当前差异。
- approve且能证明操作未派发：只有内置工具明确支持恢复适配器、恢复时再次校验最新deny和执行上下文后，才能继续原操作。
- 已派发或是否派发不明：禁止默认重试；通过沙箱operationID等已有能力查询原操作结果（仅支持可核实的执行），否则原tool标明确错误“操作结果未知，未自动重试”。
- 恢复适配器必须逐类注册，不能用捕获旧闭包或重调任意工具实现。可能重新触发多段权限检查，需以tool+授权阶段标识保持关联。

**Code Mode特别边界**：Permission可能在execute内部子工具调用中产生。Code Mode当前没有可持久化的解释器续执行检查点，不能承诺重启后继续原代码。原审批待办/用户决策仍保留；外层execute需明确收敛为“执行无法恢复”，不重放代码，不伪报成功。完整Code Mode透明续执行属独立项目；上线需在API/UI展示该恢复能力限制。

所以本方案保证“原待办与答案不丢”，question支持恢复后继续；不能声称“任意审批后原程序都透明续跑”。该范围必须在实现前确认。

## 9. Session always 的边界

1. 权限评估沿用当前Agent+Session+turn policy，不重写整套规则引擎。
2. 当前Session approval只补充allow；显式deny优先，turn-scoped策略仍保持当前独占语义。
3. always仅作用于请求的save范围，不能把resources无条件扩大为通配符。
4. 同Session匹配待办可级联，但每项重新评估有效规则，deny项不放行。
5. 父、子、fork是不同Session：新增approval不复制、不隐式共享；父权限配置既有继承机制另行保持，不混入approval。
6. 项目级历史PermissionSaved可能扩大授权：需设计显式兼容策略，不删除用户原数据。建议SaaS模式停用项目级saved批准参与该路径，保留管理入口与数据；其他运行形态不悄悄改语义。
7. 撤销当前Session授权需要Session作用域列表/删除API或明确的配置操作；必须可审计，不能只允许加不允许撤。

## 10. 身份与隔离

用现有可信身份机制绑定Session访问权限，不能仅信任客户端任意x-user-id。
所有Form/Permission list/get/reply/cancel和approval管理均验证Session访问；跨Session请求ID不能操作。
根路径待办列表按可信用户及Location范围过滤；后台恢复拥有内部权限，不借用匿名用户身份。
若仓库当前身份机制不足，先补齐/确认边界；不能在HITL里另造一个可伪造身份系统。

## 11. API与SSE

保留现有/api/session/:id/form与permission端点。Form.Detail继续返回pending/answered/cancelled；内部abandoned与恢复原因通过明确的可选字段投影，避免新增closed破坏客户端。
Form创建事件建议增加顶层sessionID并保留form，更新Schema、发布方及契约测试；同时检查所有Form生产者，不能只修question。
持久化终态查询的保留期与原10分钟内存保留不同：建议30天终态保留，pending不按时间删除；这是显式契约调整。
新增Session approval列表/撤销端点须在Protocol定义，由Server校验Session授权，不能复用项目级permission/saved删除入口。
global Form暂不进入Session ledger，维持原实现且明确其非HA能力。

## 12. 模块布局与迁移

- `packages/core/src/hitl/`：公共PG repository、轮询协调、事务/CAS；不拥有Question/Permission业务格式。
- `form.ts` / `permission.ts`：领域状态映射、校验、正常等待与回复。
- `session/execution` / `session/runner`：ownership、恢复排序、HITL工具恢复适配器、终态投影。
- `permission/`：Session approval存储和规则参与方式。
- `schema` / `protocol` / `server`：契约与HTTP接线；Location节点在instance.ts注册，后台调度按正确的全局生命周期组织。
- 数据库通过仓库现有migration及生成schema流程变更；不修改依赖包。

首次部署无法恢复旧版本仅在内存中的待办；需排空旧pod活跃HITL或接受一次明确中断。混合新旧pod不能保证跨pod回复，应采用协调升级；不得宣称加表即可滚动无损。
回滚到纯内存旧版本会忽略新ledger，请先停止接收新HITL并处置pending，不删除ledger。

## 13. 实施顺序与验收门槛

1. 确认本文恢复范围、shutdown/interrupt差异、global Form、身份和历史saved策略，建立旧用例T1–T8到新测试的映射。
2. 先实现ownership/fencing、数据库事务和状态机单测；这是恢复前置，不独立宣称pendingHA完成。
3. 接入Form/Permission、Sessionapproval、跨pod读写和轮询；修复form.createdSSE。
4. 接入question恢复及安全的Permission恢复适配器；未支持路径明确错误收场。
5. Docker双pod + 独立PG完成全量验收后再上线。

测试矩阵：

| 类别 | 必测场景 |
|---|---|
| 正常问答 | 单问、多问、多选、空可选答案、自定义答案、非法答案、取消、行为分支产物 |
| CAS | 相同回复幂等、不同回复冲突、reply/cancel竞争、用户reply与接管并发 |
| 多pod | A发问B列出并回复A消费；A硬杀B接管原ID；A恢复后旧epoch不能提交 |
| 重启 | pending保留；已答未消费保留且交付一次；答案交付后重启不重复；恢复前不得settle原question |
| Permission | once、always、reject反馈、同Session级联、最新deny、审批后命令失败、派发状态不明不重放 |
| Code Mode | 默认开启时execute子工具审批、外层执行恢复限制、旧Runner连接失效、无重复副作用 |
| 授权边界 | 跨用户/跨Session拒绝；父子/fork不继承approval；always重启保持；撤销生效 |
| 生命周期 | 用户interrupt、Locationreload、shutdown、Session删除与创建/回复竞争、185s/330s长等待 |
| SSE/PG | form.created/replied/cancelled、permission事件、执行终态；原ID、决策、交付、epoch、approval、消息事件一致 |
| 故障 | PG断连、提交后通知前崩溃、续租失败、两pod同时接管、恢复事务回滚、终态retention |

恢复/全库claim测试必须使用专用`opencode-v2-test`，禁止共享开发库。E2E通过SaaS API，独立实时订阅会话SSE，按用例自动回答，每case落盘证据。未知/未覆盖不得计为PASS；仅“观察到pending丢失”不等于HA验收通过。

## 14. 尚需确认的实施决策

- 是否接受Code Mode/不支持恢复的Permission调用“保留用户决策但原操作明确失败、不自动重放”的首期范围？若要求所有原任务透明续跑，需要扩大为执行检查点与Runner协议持久化项目。
- 是否接受shutdown保留等待、用户interrupt取消等待、global Form首期不HA？
- 是否采用终态30天保留，以及回复同内容返回204的幂等契约？
- SaaS可信用户身份来源，以及项目级历史PermissionSaved停用参与该路径的兼容策略。

本文前两条产品需求已确认；上述实施边界未确认前不开始编码。

## 15. 二次技术审核：必须补齐的闭环

### 15.1 Ownership必须覆盖所有执行入口和出口（P0）

仅在restart中获取epoch不够。当前`SessionExecution`使用进程内coordinator；claim在started事件提交时写入，started的发布错误又可能被reportLifecycle吞掉后继续执行。新实现必须在drain前取得PG执行权，获取失败不得运行工具或模型。

普通resume/wake、恢复、子Session、手动控制项都遵守同一execution token。release、terminal事件、shutdown收尾、取消后台job、沙箱回收也必须检查token，不能让旧owner清掉新owner的claim或销毁仍在使用的沙箱。用户interrupt发到非owner pod时通过PG控制请求交由owner消费，不能调用本pod的coordinator后错误返回idle。

执行token由受信任服务端上下文注入，不通过公共Form metadata传递。PG不可达或续租失败后停止新派发；恢复提交必须使用数据库时间和条件更新。租约TTL/续租/grace须配置并做故障测试，建议初值TTL60s、续租15s、接管grace30s，仅作为待压测参数。

### 15.2 恢复是每个执行的barrier，不是全库阻塞（P0）

恢复调度器批量领取后启动独立scoped等待任务，不能逐Session等待人类回答而阻塞其他Session恢复。每个执行按关联工具批量恢复，等待所有必要工具达到终态后才调用模型；未知遗留工具按现有规则失败，不能把整个assistant消息的非HITL内容覆盖。

source须有稳定执行标识/claim generation、assistantMessageID、tool ID、授权阶段ID以及payload版本。created epoch和当前owner epoch分开；接管后允许新epoch交付旧请求，不重新创建请求。正常tool终态和恢复tool终态走同一幂等事务边界，不仅恢复路径检查fencing。

### 15.3 Ledger与V2事件的事务规则（P0）

按统一顺序锁定Session聚合/ownership，再锁request，再写approval或tool终态；CAS失败必须让整个事件+projector+delivery事务回滚，不能提交一个无权交付的Tool.Success事件。事件序号分配也必须纳入PG聚合序列化，不能仅把ledger放入现有进程内锁。

正常路径由Form.reply保存答案后只唤醒等待器，不提前把delivery标delivered；工具终态提交成功才确认交付。detached-form无tool consumer，决策提交即完成该资源交付，不留永久ready行。reply与interrupt竞争以Session控制状态和request CAS共同决定；若reply先提交但随后interrupt已被接受，不允许再派发操作。

### 15.4 多pod SSE不能只修事件字段（P0）

当前Bus的live PubSub是进程内存。B接收reply后在B发布form.replied，订阅A的客户端不一定收到；A接管执行后，订阅B的客户端也可能看不到工具与终态。增加顶层sessionID只解决同pod过滤，不解决跨pod。

本功能依赖Session事件跨pod可观察：复用/补齐PG durable log tail及幂等游标桥接；HITL通知采用事务outbox或已确认可跨pod消费的durable事件路径。SSE可仍不保证断线补放，但连接期间应看到其他pod提交的相关事件，客户端重连后重新读pending。不得由每pod无限重复重发同一个事件。必须在A订阅/B回复以及B订阅/A执行两种组合验收。

### 15.5 恢复范围与已确认需求的差异不能隐含降级（P0）

“保留原问题继续回答”适用于question可以闭环；对默认Code Mode中的Permission，解释器上下文丢失后“仍可点批准但原execute失败”只是保存决策，不是恢复原审批操作。这是未获用户确认的范围降级，不能直接标需求完成。

实施前列出各类consumer恢复支持矩阵：question、原生shell/read/write/edit/patch、Code Mode子调用、MCP elicitation、websearch Form、detached-form。仅加question恢复会遗漏其他真实Session Form。
如果要求所有审批操作都继续，必须新增可恢复执行检查点/工具阶段协议；若首期仅question完整恢复，需用户明确接受其余类型的可见限制。不能用“源码里有operationID”推断支持查询或副作用去重，要逐provider API验证。

### 15.6 Session授权撤销与历史权限（P1）

approval保存来源可使用可空FK（request retention删除时SET NULL）或审计快照，不得因清理旧request级联删除长期always授权。retention只清delivery已最终收敛的终态行，answered但尚未交付不可删除。
撤销approval不是撤销正在执行的命令；执行前再次评估，已派发操作不承诺撤回。空save时always明确退化为once，API/审计须显示未新增持久授权。
Session approval以Session访问控制为授权边界，不强制只允许最初发起者回复，以免破坏协作会话；根列表按用户可访问Session集合过滤。可信身份和Session ACL现状需单独核验，不用user_id列替代ACL。

### 15.7 安全生命周期、保活和兼容（P1）

shutdown保留HITL时必须检查现有execution settled的destroyUnkeptSandbox副作用：不能一边保留恢复任务一边无条件回收其沙箱。支持恢复的等待保留现有sandbox activity/keepalive约定，父子共用沙箱由root管理；long-pending跨owner仍须验证沙箱存活/快照恢复。
Session move/reload、子Session后台completion、watchdog豁免、执行resume budget都需覆盖：正常等待人类不增加失败恢复次数或触发stall。待办无限保留不代表内存fiber无限占用；调度器应有并发/轮询批量上限，并提供单Session pending数量和payload大小限制。
升级前定义mixed-version capability门控；旧pod不能处理新HA请求。新API投影字段需要同步Schema/Protocol/SDK；数据库必须保留payload schema version，后续升级不能把旧问题解码失败后静默删除。

### 审核结论

PG ledger + Session作用域授权的方向正确，但完整HA实现是执行ownership、事务事件、跨pod流式观察与consumer恢复的联合改造，不是仅移植V1请求表。上述P0闭环未完成详细规格、恢复范围未确认前，不能认定方案已经OK或开始业务实现。

## 16. 按审核建议收敛的实施路线

### 16.1 不降低已确认需求

- 真实Session的问题与审批在重启后保持原ID、原字段和已提交决策；owner失效不转用户拒绝。
- Question回答后继续关联轮次，不重复发问。
- Permission恢复不仅保存决策，还需继续尚未派发且可恢复的原操作；已派发状态未知时遵守副作用安全原则，不冒险重试。
- Code Mode默认开启，不能用关闭Code Mode获得“全套通过”。其审批续执行能力作为独立前置验证，未支持前不得宣称整体需求完成。
- 全部真实Session Form生产者都进入恢复支持矩阵；global Form不因本方案被错误写入Session FK。
- always只作用于当前Session，deny优先；子Session/fork不继承新增approval。

### 16.2 先证明关键可行性，再展开业务改造

**阶段A：前置技术验证与细化规格**

1. 核验可信身份/Session ACL和现有PG事务、聚合事件序号、执行claim边界，形成具体改动清单。
2. 验证现有Runner断线行为、子工具请求标识及沙箱operation查询能力；区分“SaaS重启但Runner存活”和“Runner也死亡”两种恢复情形。
3. 为Code Mode选择有实证的恢复协议：若Runner可保留活跃程序，则设计重新连接、owner握手、pending子调用重新关联和结果去重；若不支持，先设计安全可持久化检查点。不能通过重跑任意代码替代续执行。
4. 定义ownership token的传播和全部写入/派发边界、锁顺序、可重试交付键、payload版本以及支持矩阵。

阶段A的出口是可执行规格与针对性验证证据，不是只加表或把风险改名为非目标。若Runner死亡后的通用程序恢复需明显扩大项目范围，记录证据与影响，再讨论，不悄悄缩减需求。

**阶段B：共享可靠性基础**

实现PG ownership/lease/fencing、Session聚合事务序列化、跨pod唤醒/中断控制、事件跨pod可观察，以及ledger repository。任何pod不能绕过PG执行权进入drain；失租后的结果提交、release和沙箱回收必须被拒绝。

**阶段C：领域业务接入**

接入Form/Permission durable状态、幂等回复、Session approval、撤销与最新权限重评估；修复form.created关联。正常工具交付与恢复交付共享同一事务路径。

**阶段D：恢复适配与生命周期**

Question标准结果重建、各内置工具授权阶段恢复、Code Mode恢复协议及其他Session Form消费者接入。shutdown/reload保留等待，用户interrupt显式终止；将HITL恢复barrier放在stale-tool收敛前。

**阶段E：完整验收与发布**

专用PG、双SaaS容器、默认Code Mode开启；按原T1–T8编号建立映射逐项验证，不以新增38条断言替代旧功能覆盖。覆盖断线、硬杀、并发接管、已答未消费、跨podSSE和副作用未知状态。每项有API/SSE/PG证据，清理仅限本轮专用资源；完成版本门控与回滚演练后才能发布。

### 16.3 明确的一致性与兼容选择

- Session执行ownership是唯一恢复权来源，HITL不建立第二套独立owner。
- 回复成功仅表示PG接受了决策；交付确认和操作结果分别记录。
- 数据库轮询是可靠性基础，通知仅优化延迟；SSE跨pod观察需有PG提交后的事件来源，不依赖单pod内存广播。
- pending不按用户等待时间自动过期；最终已交付/已明确放弃的终态才进入retention，建议默认30天、配置化。该建议必须落实为契约测试，不能删除未交付答案。
- 相同回复采用204幂等成功，不同决策409；Form取消同样按终态决策判定幂等，不与重复创建冲突混同。
- 旧项目级PermissionSaved数据不删除；SaaS路径不将其当作当前Session的always授权。显式用户/管理员配置仍按既有规则源处理，不能误删合法的权限配置。
- 采用协调升级，旧pod不接收新协议执行；schema新增保持可回滚，未完成的ledger不能静默遗弃。

### 16.4 推进边界

本次用户确认的是按审核建议与最佳实践推进，不是批准未列明的产品范围降级、外部服务变更或生产发布。实现时保持最小必要改动；若发现执行基础改造超出已记录范围，先补充设计与复现证据再讨论。当前工作区其他未提交工作流不得覆盖、回滚或一并提交。

## 17. 第一批实施与验证记录

### 已实现

- Form生产者统一发布顶层sessionID，保留嵌套form；线协议新增字段可选，兼容旧事件消费，实际生产者输出由Core回归测试约束。Promise SDK同步该单字段变化。此修改只修复同pod关联，不宣称跨podSSE已经完成。
- DatabasePg提供事务级聚合锁，Bus单条/批量事件提交、replay、remove、log-owner变更均在事务内取得同一PG advisory lock。包含聚合首次创建、事务回滚；SQLite路径保持原行为。此锁不是Session执行ownership，不替代后续lease/fencing。
- 更新Core AGENTS.md，明确PG聚合锁边界及不保护绕过Bus的直接写入。

### 复现与回归依据

- `packages/core/test/bus-pg-concurrency.test.ts`：两个独立Bus与PG连接并发混合发布20次（27个事件）。修复前复现event插入冲突，修复后序号0–26唯一连续；另覆盖回滚后另一实例可提交、其他聚合不被锁阻塞。专用`opencode-v2-test`端口15432，3项通过。
- Core Bus/Form/Session事件路由定向回归76项通过；Server Session SSE/过滤回归20项通过，其中新增HTTP创建Form并实时订阅Session SSE的关联与隔离用例；Schema Form事件/manifest回归9项通过。
- MCP扩大回归曾出现7项失败。临时仅撤去本批自己添加的5个源文件改动，运行MCP基线复现其中6项失败（协议超时、Code Mode缺少沙箱、权限等待），随后恢复本批改动。另1项重连失败单独重测通过，仍按间歇性问题记录，不宣称全MCP套件通过。未stash/reset用户改动。
- SDK生成器产生大量已有契约漂移；只保留本次Form字段的生成结果，其余本次生成差异已撤去，未覆盖原有用户工作。

### Runner核验与未完成项

`packages/containers/sandbox/opt/codemode-runner.ts:81–91,222–227`显示active execution属于单socket；socket.close会abort并拒绝pending调用。此为源码核验，尚不是动态Runner续执行验证。不能实现为仅新socket重连；需要执行注册表、owner握手、请求结果关联/去重及取消协议改造，Runner也死亡的场景另需检查点设计。

本批尚未完成：PG执行ownership/fencing、HITL ledger、Session always授权、跨podSSE、工具/Code Mode恢复协议，以及Docker双pod API/SSE/PG全量E2E。当前测试的HTTP服务器为测试fixture，不是Docker SaaS，不把它计为部署验收。现有运行容器无源码挂载，未将旧镜像结果用作当前改动验证。

## 18. 第二批实施：Session授权作用域与持久化

### 已落地

- 新增canonical `SessionPermissionApproval` schema、repository与`session_permission_approval`表。Session FK删除级联；Session/action/resource唯一约束；request审计引用不作为FK，避免后续request retention删除授权。
- PG SaaS默认只读取当前Session的approval，不再读写项目级PermissionSaved；旧数据不删除。SQLite本地模式保留项目级兼容语义，测试可显式选择scope，不通过可信用户身份尚未核实的字段伪造隔离。
- always仅持久化请求save范围；once/空save不创建授权；同Session匹配pending才参与自动批准。显式deny在回复前及等待恢复后重查，变更deny的请求返回403且不保存新approval。
- 新增`GET /api/session/:sessionID/permission/approval`与`DELETE /api/session/:sessionID/permission/approval/:id`。撤销条件含Session归属且幂等；运行中操作不承诺撤回；走现有Session middleware与审计路径。
- 同步Promise/Effect SDK新增路径、Info与403响应，并核对生成器新输出中的对应部分；不纳入已有其他契约漂移。
- 迁移、registry、schema.gen、schema.json与PG schema dump一起生成；生成前基线与生成后的migration check均通过。

### 验证

- Core Permission/Form/Bus/Session路由定向回归：193通过；Server Session SSE/路由：20通过；PG独立连接授权持久化与Bus并发：4通过；Schema新契约与manifest：11通过；SDK新增路径/日期解码/拒绝错误：2通过。
- Core、Server、Schema、Client类型检查均通过。并行Core/Server build曾超时，改为串行重跑通过；不把超时轮次记为类型检查PASS。
- SDK扩大回归有3项既有失败（分组列表、公共Session契约、Effect日期输入）。用生成前快照复测这3项仍失败，然后恢复本批精确变更；不得将全SDK套件写成通过。
- 当前工作区构建`opencode-saas-hitl-approval:local`，两个独立Docker SaaS连接专用`opencode-v2-test`。最终26项API/SSE/PG验收通过：跨pod授权读取与评估、其他/子/fork隔离、deny优先、撤销、容器重启及清理。
- 镜像内9个关键实现文件与工作区SHA256一致。测试订阅各会话SSE并实时输出，保存HTTP/SSE/PG完整证据：`/private/var/folders/zk/8qd0lv657wn8kvpp__hwjj400000gn/T/opencode/hitl-session-approval-f8f26fa1-bc0b-482b-93b0-a4c3f30ed463`。
- 补测发现空Session不能fork（400/empty_session），修正用例先经Agent切换API创建正式历史后重测通过，不直接写PG消息。

### 仍需接入的可靠性边界

本批完成的是Session授权的作用域、持久存储与正常API路径，不是完整Permission恢复。pending仍在内存；授权写入、durable用户决策、级联决策的同事务提交须在ledger接入时闭环。尚未验证提交后通知前崩溃等故障，不将它们标为PASS。

测试只驱动控制面API，沙箱禁用，不运行模型/Code Mode；不得作为默认Code Mode工具审批或恢复验收依据。未修改其他用户工作流，未生产发布，当前改动尚未提交。

下一阶段依赖仍为PG执行ownership/lease/fencing、跨pod控制与事件通路，然后接入HITL ledger、交付事务和恢复barrier；“重启后保留原问题并继续执行”整体尚未实现。

## 19. 第三批实施：PG 执行租约与 fencing

### 已落地

- 新增`session_execution_lease`表（Session FK级联）与`SessionExecutionLease`模块：单事务内insert(epoch 0)+条件update完成获取/续约/接管，epoch按行单调；`releaseFenced`按owner+epoch条件删除；`holds`供清扫预过滤。
- `SessionExecution`接入：PostgreSQL方言在drain前必须取得租约，获取失败映射为`Session.ExecutionLeaseUnavailableError`并使该次执行失败，不再吞掉started发布失败；租约续期fiber失租时中断本地执行；终态事件的commit内做fenced释放，失租导致事务回滚，旧owner不能发布接管者的轮次终态；shutdown中断保留claim但总是释放租约。非owner跳过终态发布、jobs取消与沙箱销毁。SQLite路径行为不变。
- `SessionRestart`清扫在PG上先用`holds`过滤仍在租约中的Session，避免对其他存活pod的会话累计resume次数并注入续跑提示；执行准入的租约获取仍是最终守卫。
- `SessionRunCoordinator.started`允许以E失败：准入失败必须使执行失败，不得记录后继续。
- 迁移、schema.gen、schema.json、pg-schema.sql同步生成，`migration --check`通过。

### 验证

- 新增`session-execution-lease-pg.test.ts`（专用`opencode-v2-test`）：模块语义（互斥、过期接管epoch递增、fenced renew/release拒绝、held快照）与双独立Database/Bus「pod」集成（B在租约内被拒且不进入执行；租约过期B接管后A续租失败并停止；终态仅由B发布一次succeeded；started A/B各一次；claim释放；holds清空）全部通过。
- PG上`session-execution.test.ts`全量通过（含此前手工清理的一次共享库残留会话导致的既有失败复现记录）；SQLite定向回归616项通过。类型检查通过。
- `session-move`4项与`session-remove`1项失败经基线复测（还原本批改动后同样失败）确认是既有问题，与本批无关，不计为本批回归。

### 边界与下一步

- 本批建立的是执行所有权与终态fencing，不包含HITL pending持久化、跨pod中断控制请求、跨pod SSE，以及已答未消费交付。旧owner已派发的沙箱/MCP副作用仍无法用数据库fencing撤回（第8节限制不变）。
- 多pod同时清扫同一失租Session的竞争由准入租约兜底：后到者获取失败即退出，仅产生日志。
- 双Docker SaaS上以真实模型轮次验证租约接管尚未执行；当前证据来自双实例单元/集成测试，不将其计为部署验收。

## 20. 第四批实施：HITL pending 持久化 ledger 与跨 pod 回复

### 已落地

- 新增`hitl_request`表（`packages/core/src/hitl/sql.ts`，Session FK级联）与`HitlLedger` repository（`packages/core/src/hitl/ledger.ts`）：`register`幂等登记（已决行不被覆盖）、`decide`按`decision='pending'`CAS settle、`pending`/`get`/`states`查询。迁移、schema.gen、schema.json、pg-schema.sql同步生成并通过`migration --check`。
- Form接入（PG dialect启用，SQLite保持纯内存）：真实Session的create/ask登记pending；任意pod的reply/cancel在本地miss时从ledger恢复请求、校验答案后CAS settle，冲突返回AlreadySettled；owner侧每`OPENCODE_HITL_POLL_MS`（默认1s）轮询本地pending，消费其他pod提交的决策并唤醒本地等待者（不重复发布公共事件）；`get/state/list`从ledger恢复，重启后pending待办可见；进程close只唤醒本地等待者，保留durable pending且不发布用户cancel。MCP elicitation的`global` owner不写ledger。
- Permission接入同模式：create登记、任意pod回复（once/always→approved，reject→rejected含message）CAS先行、owner轮询消费并在owner侧执行同Session级联（reject级联同样落ledger）；重启后`list/forSession`从ledger恢复；close保留durable pending仅本地失败等待者。
- 语义对齐第7.1节：进程关闭（shutdown/Location reload）保留待办；用户显式reply/cancel才落终态。

### 验证

- 新增`hitl-ledger-pg.test.ts`（专用`opencode-v2-test`，4项通过）：A挂起表单B可见并回复、A轮询唤醒、双端重复回复均AlreadySettled、ledger行状态与list收敛；服务图关闭后pending保留、重建后恢复并可回复；global表单不落ledger；Permission once回复唤醒assert、A关闭后durable pending由B恢复并拒绝。
- SQLite定向回归（form/permission/mcp/bus 251项通过）确认非PG路径行为不变；MCP剩余6项失败与本仓既有基线一致（第一批已复现记录），非本批回归。
- PG全组（ledger/审批/Bus并发/执行租约）通过；Core类型检查与migration check通过。

### 边界与下一步

- 本批实现“待办不丢 + 任意pod可回复 + owner轮询消费”。尚未完成：已答未消费的答案在执行恢复时重建工具结果（恢复barrier）、跨pod中断控制请求、跨pod SSE事件扇出（回复pod发布的事件不会出现在owner pod的订阅流上）、重复相同回复的204幂等契约（当前保持409，与既有API/测试一致；契约切换需同步SDK与文档）、Code Mode审批恢复。
- 轮询间隔为env可调的初始值（默认1s）；LISTEN/NOTIFY提速未实现，可靠性不依赖通知。
- Form回复发布事件仍在回复pod：跨pod SSE属第15.4节独立工作，未随本批交付。

## 21. 第五批实施：question 执行恢复 barrier

### 已落地

- `Form.Interface.awaitSettled(id)`：本地缺失时从ledger恢复请求；已终态立即返回，pending阻塞等待`Deferred`（owner轮询在第四批已实现消费）。`restore`对已决行复活已完成的entry，使重复回复可被分类而非404。
- `QuestionTool.answeredResult`：抽出live executor成功分支的答案→`{output, content, metadata}`映射，恢复与live路径共享同一语义。
- 新增`session/runner/question-recovery.ts`：PG dialect下，按`metadata.tool.id`从durable ledger找到原form，`awaitSettled`阻塞等待（任意pod回复均可），然后按结果发布规范终态事件——answered→`session.tool.success`（含答案文本与metadata），cancelled→`session.tool.failed(aborted)`（与dismissal语义一致）。无关联行返回false。
- `settleStaleToolCalls`接入barrier：running的question tool先走恢复；恢复不了（无ledger行/恢复失败NotFound）才按既有aborted失败收敛。streaming的question（模型尚未完成参数生成）不恢复，按失败收敛后模型重新发问。恢复的`tool.success`进入消息树后，既有restart resume流程的模型轮次从答案继续，不再重复提问。
- watchdog默认豁免列表加入`question`：question本就是等待人类，watchdog中断它等于替用户取消提问；恢复等待与live等待同样不应被120s预算杀掉（配置`OPENCODE_WATCHDOG_EXEMPT_TOOLS`仍可覆盖）。

### 验证

- 新增`question-recovery-pg.test.ts`（专用库，2项通过）：模拟死亡现场（running tool part+durable pending form）——恢复方阻塞等待，B pod回复后发布`tool.success`，消息树part变completed且内容含答案；取消路径part变error(aborted)；无ledger关联的running question返回false由失败收敛处理。消息行通过直接插入`session_message`构造，`time.ran`/`metadata`等字段经schema探针校验。
- 回归：SQLite组292项通过（form/permission/bus/session-execution；MCP既有6项基线失败不变）；watchdog 9项通过；PG全组（recovery/ledger/approval/Bus并发/租约/execution）共55项通过；Core类型检查与`git diff --check`通过。测试内嵌消息行使用与`permission.test.ts`相同的`SessionMessage.Info` encode→拆列方式构造，保证与真实投影兼容。

### 边界与下一步

- 恢复等待位于drain开头的barrier：恢复执行在settle处阻塞直到用户回答（这正是"保留问题继续等待"语义）；租约续期fiber（第三批）保持执行存活，租约失租时watchdog式中断同样会终止恢复等待并跳过终态发布。
- Permission的执行恢复未随本批交付：pending审批可跨pod回复并唤醒等待者（第四批），但重启后没有等待者的审批tool part仍按aborted收敛；"批准≠执行成功、未知副作用不重放"的恢复适配器仍是后续工作（第8节）。
- Code Mode子调用审批、跨pod SSE扇出、双容器真实模型E2E仍未实现。

## 22. 第六批实施：Permission 审批恢复与跨 pod 事件扇出

### 已落地

- `Permission.Interface.awaitSettled(id)`：已决行直接映射`{reply, message?}`；pending从ledger恢复后阻塞等待本地Deferred（owner轮询消费），decline语义映射reject。
- 恢复模块泛化为`QuestionRecovery.settleTool`：先匹配`source.id`关联的permission行——reject→`tool.failed(permission.rejected)`（含反馈）；approve且非question→`tool.failed(aborted)`，消息明确"审批已记录但操作未执行，不自动重放"；question+approve继续等待form（复刻live执行顺序：assert先于ask）。任何running工具part都会尝试该barrier，不再限question。
- 边界锁定：无HITL关联的running工具（含Code Mode execute，无持久化检查点）返回false，按既有aborted失败收敛；测试显式覆盖execute场景。
- 跨pod事件扇出：`DatabasePg.eventFanout`暴露`sql.listen`/`sql.notify`（专用LISTEN连接，不要求wal_level=logical）；Bus在`notify`尾部把事件序列化后NOTIFY到共享channel（payload>7500字节跳过并记日志），各pod LISTEN后注入本地live/typed PubSub，按event id去重本进程回声；远端注入不触发listeners/projectors（发布进程已执行）。通知是尽力而为：丢失只影响远端实时可见性，不影响PG权威与轮询收敛。

### 验证

- 新增`bus-fanout-pg.test.ts`（双pod）：B发布的ephemeral事件出现在A订阅流、本进程恰好投递一次（回声去重）、durable事件同样扇出。期间发现`sql.subscribe`要求wal_level=logical（本地/多数托管PG不满足），改用`sql.listen`探测验证后定型。
- `question-recovery-pg.test.ts`扩展至3项：新增Permission恢复（approve→aborted not-executed、reject→permission.rejected含反馈、原assert等待者被B pod回复唤醒）与execute不恢复断言。
- 回归：PG全组7文件55项通过；SQLite组269项通过（MCP既有6项基线失败不变）；Core类型检查、格式化、`git diff --check`通过。

### 剩余工作

- 双Docker SaaS + 真实模型的端到端验收（重启容器后原question继续等待、跨pod回复、轮次从答案继续、SSE跨pod可见）——需重建镜像并跑完整E2E脚本，当前改动未提交。
- 恢复适配器的工具级重放（shell等可证明未派发的操作）仍按设计文档第8节为后续项目；重复回复204幂等契约切换未做。
- 跨pod扇出对超大payload事件（>7500字节）不投递，SSE客户端依赖重连后的pending读取。

## 23. 第七批实施：优雅停机保留待办与端到端验收

### 已落地

- E2E首轮暴露真实缺口：`docker restart`是优雅停机（SIGTERM），`step.ts`的location-close路径把等待HITL的tool part结算为aborted（"Interaction cancelled because the location shut down"），恢复barrier只处理running part，导致重启后模型重新提问。
- 修复`step.ts`：`isLocationClosed()`时不再结算任何tool part——decline的`failTool`、`failUnsettledTools(TOOLS_INTERRUPTED)`与hosted结果缺失的兜底全部跳过。停机遗留的running part统一交给下一个owner的`settleStaleToolCalls`（HITL先走barrier，非HITL按既有aborted收敛，行为不变）。claim在shutdown中断路径已保留，与第七节语义对齐：停机不产生用户可见的取消/失败。

### 端到端验收（双Docker SaaS + 真实模型 + 专用PG）

- 脚本：`docs/test-cases/scripts/hitl-recovery-e2e.mjs`（`HITL_E2E_RESTART_CONTAINER`仅允许专用容器；失败保留现场供查证）。
- 结果：**13项全部PASS**。完整链路：A发起必澄清任务→真实模型调用question→A容器重启→B pod看到同一pending表单（跨pod ledger）→B回复→A恢复执行**从答案继续**并创建`/workspace/greeting.txt`（模型输出确认"chose hello"）→消息树question part终态completed且含答案→PG ledger answered→重复回复409→本轮Session/HITL零残留。
- SSE证据同时验证跨pod扇出：B实时收到A的`usage.updated`等事件；`form.created`/`form.replied`/`session.execution.succeeded`全程可观察。
- 期间诊断：首轮失败通过`event`表version-2的`tool.failed`行定位到step.ts停机结算路径（证据：`Interaction cancelled because the location shut down`），修复后复跑通过；两轮失败现场的Session残留已从专用库清除，共享库既有残留导致的偶发失败已复现确认与本批无关。

### 回归

- `session-execution`/`question-recovery`（PG+SQLite）、Core类型检查、格式化、`git diff--check`全部通过。E2E专用容器已销毁，本轮零残留。

### 全量回归与既有失败基线（2026-10-10）

- 全仓套件：Schema 83/0；Server 121 pass + 1 项（AGENTS 声明的既有环境失败，还原改动复现一致）；Client 165 pass + 4 项既有（含 `import-boundaries`，还原改动复现一致）；Protocol/CLI 类型检查通过；Core 全量 5969 pass / 30 fail。
- Core 30 项失败经双轮全量对照（还原本批全部 core 改动后基线跑 66 fail）归因：25 项两轮都失败=既有（MCP 6、move 4、Tool 5、config 迁移、shell 解析、watcher、OAuth、models 分页、pty、trigger、env 隔离、title 等）；5 项仅本轮失败均为间歇/顺序敏感（MCP reconnect 单跑通过、Copilot 三轮各挂不同子集、OAuth 单跑通过、session-create `still emits shell ended` 全文件模式 45/45 通过）——**结论：本批改动无 Core 回归**。
- 陷阱记录：`bun test --only-failures` 按缓存只重跑失败用例，缺同文件环境会制造假失败（session-create 曾被误判稳定失败）；归因必须以全文件/全量模式为准。

### 实现范围总结

至此设计文档第16节路线的P0/P1落地：PG聚合锁、执行租约/fencing、HITL ledger（跨pod回复+owner轮询）、question/permission恢复barrier（批准不重放）、停机保留待办、Session作用域always授权、跨pod事件扇出、双容器真实模型E2E。剩余明示边界：Code Mode子调用恢复协议（首期明确失败收敛）、重复回复204幂等契约、工具级重放适配器、跨pod中断控制请求。全部改动未提交。
