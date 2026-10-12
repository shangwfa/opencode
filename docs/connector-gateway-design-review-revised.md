# Connector Gateway 修订版复审

> 日期：2026-10-10；对象：`docs/connector-gateway-design.md` 修订版。
> 结论：架构方向可以保留，可以进入 P0 对接/技术验证；**还不能作为已定稿的实现规格直接进入 P1/P2/P3**。
> 本次只做文档与源码静态核验，未运行服务、未复现业务故障、未修改主方案或业务代码。
> 上游路径相对 `~/code/open-connector`，SaaS 路径相对当前仓库。

## 1. 已修正的问题

初版的 Basic 身份误用、connection name/ID 混淆、空白名单语义、上游 token TTL/JWT scope 假设、管理 API 原样暴露、PG 自动迁移假设，均已在修订版明确纠正。

职责分层、owner/grant/binding 分离、内部引擎、独立 schema 与迁移、默认拒绝、统一执行入口、长期订阅授权和至少一次投递，方向合理。

但“列为技术门禁”不等于已经给出实施设计。以下问题需要补充协议或状态机，不能仅再加一句“需要验证”。

## 2. P0：MCP 授权缺少完整且可信的调用上下文

**文档位置**：§7.1、§8.1、§8.2、§10。

能力凭证只有 subject/session/revision 等身份，执行策略却要求 agent/tool 权限与审批。实际调用属于哪个 agent、哪个消息、哪个 Tool Call、采用什么有效权限、审批绑定哪些参数，尚未定义可信传递方式。仅由客户端传 `agent` 或 MCP `_meta` 不能成为授权依据。

**源码依据**：

- `packages/core/src/tool/mcp.ts:42-53` 在工具叶子执行 `Permission.assert`，使用 context 中的 sessionID、agent、messageID、call ID；随后 MCP callback 只拿到 args/sessionID。
- `packages/core/src/mcp/client.ts:272-281` 目前只通过 `_meta["ai.opencode/sessionID"]` 发送 session ID。
- `packages/core/src/tool/AGENTS.md` 明确 registry 不承担执行授权，叶子持有 Permission.Service，不能另造 registry 授权回调。

**风险**：若 SaaS MCP facade 只凭会话 Bearer 放行，直接 tools/call 无法证明走过该 agent 的审批；若所有入口再次弹出同样审批，则可能出现双重审批和缺少事件 source。native 路径也不能仅凭 sessionID 就声称完整权限上下文已满足。

**补充设计**：

1. 定义服务端构造的 InvocationContext：actor、真实 session、agent、messageID、callID、execution ID、有效权限版本。
2. Tool 叶子按现有 Permission 机制检查；明确 connector 动作级审批如何复用/扩展，而非依赖 registry 过滤。
3. MCP 每次敏感调用附短期、签名的调用授权证明，绑定 action/resource、输入摘要、call ID 和 audience；或者采用同等可信的服务端 invocation lookup。普通可修改 `_meta` 不算证明。
4. facade 验证证明并重查实时 grant；重试使用同 execution ID，不消费成第二次调用。
5. 直接 HTTP 用户执行使用独立管理授权/审批路径，不假装来自 agent Tool Call。发现调用仅需受限身份，执行调用需完整上下文。

**验收**：用合法会话 token 直接构造未审批 tools/call、替换输入、冒充另一 agent/子会话、重放授权证明，全部按明确规则拒绝或幂等返回；MCP/native 不重复审批。

## 3. P0：引擎 checkpoint 与 SaaS inbox 尚未形成防丢失闭环

**文档位置**：§11.2。

现有流程从“验证签名”直接跳到 SaaS inbox/outbox 事务，没有说明如何调用上游 receive、映射其结果，以及上游自己先持久化 checkpoint 后 SaaS 入库失败如何恢复。

**源码依据**：

- `src/triggers/subscriptions.ts:241-260` 调 provider `receive`，如果返回 checkpoint，就先保存上游状态，再返回结果。
- 同文件 `:127-141` 提供立即保存 checkpoint/subscription 的回调。
- `src/triggers/common/integration.ts:55-76` 的接收结果不只有 event，还包含 wake、ignored、respond。

**风险**：若 provider 通过 checkpoint 丢弃已处理的事件，上游状态已推进而 SaaS 尚未持久化 outputs，重复回调可能不能重建事件。这是可见的设计窗口，是否发生需按 provider 故障注入验证，不能声称所有 provider 都已存在丢失故障。

**补充设计**：

- 区分原始 receipt、验证状态、规范化事件和会话投递记录；原始 receipt 保存原始字节及签名相关头，敏感内容加密，设置容量与保留期限。
- 定义何时响应 webhook ACK，以及 challenge/respond 必须同步返回哪些 status/body/header。
- 对可能改变 checkpoint 的引擎 receive，采用不提前提交状态的接口、延迟 checkpoint commit，或能将规范化结果与 checkpoint 原子持久化的扩展；仅重放原始 body 并不足以保证所有 stateful provider 可恢复。
- 未通过该门禁的 provider 不启用事件投递；不能把所有结果强制转换成一条“用户消息”。

**验收**：在上游 checkpoint 保存后、SaaS inbox 提交前杀掉 pod，验证不会静默丢失；覆盖 event/wake/ignored/respond 及 challenge HTTP 响应。

## 4. P1：声称全量 Triggers，但遗漏 poll/listener 调度

**文档位置**：§1、§11，数据模型 §5.1。

方案只定义 provider callback 流程，没有轮询计划、checkpoint、分页、读取任务租约、backoff 和调度恢复。上游 maintenance 不是轮询器，此处不能沿用维护线程填补。

**源码依据**：`src/triggers/trigger-runner.ts:110-117` 的 read 分别调用 poll 和 listener；`common/poll.ts:9-19` 有 checkpoint/events/dedupeKey/hasMore；`common/integration.ts:20-29` 有 listener page 与 intervalMs。

**补充设计**：增加 trigger 类型与 scheduler 状态，至少定义 next_run_at、checkpoint、lease epoch、错误分类/退避、hasMore 分页预算。读取后“事件 inbox/outbox + 新 checkpoint”必须形成可恢复提交，不能先推进游标再记录事件。wake 结果进入 listener 读取队列。

**验收**：poll/listener/webhook 各一个 provider，双 pod竞争读取、分页中断恢复、空页、相同去重键、长轮询取消。完成前把“全量”标为目标，不是该期交付事实。

## 5. P1：撤销与出站请求的时序承诺过强

**文档位置**：§5.3、§7.1、§10。

PG gate 检查后，旧内部 token 仍可被已经进入引擎的调用使用；一个 action 可包含多次 transport/重定向/重试。撤销后只拒新 facade 请求，不自动阻止它们继续出站。所谓“立即拒绝”需要定义线性化点。

**源码依据**：上游 `src/core/provider-http-dispatch.ts:21-30,38-63` 提供 beforeAttempt、onDispatch、bindAuthority 等出站 admission 扩展；runtime options 已允许 providerHttpDispatch 注入。

**补充设计**：建立 SaaS execution 与上游 runtime execution ID 的可信关联，在适用的每次 transport attempt admission 检查 resource/auth revision、deadline 与限额；定义 dispatch commitment 为不可撤回边界。列明非 HTTP/未覆盖 transport 的限制。撤销后的新 commitment 拒绝，已 commitment 的请求可完成并审计。不要以客户端 headers/input 构造 dispatch authority。

**验收**：action 第一跳后撤销，再发起第二跳/重定向/重试，按约定拒绝；并发撤销/commitment 的顺序可由 PG记录解释，不保证撤回已发送请求。

## 6. P1：内部 token 生命周期与表设计缺项

**文档位置**：§5.1、§7.1-7.2。

文档提出加密保存 token 引用、按单连接+策略版本复用，但没有对应记录、唯一键、并发创建、轮换与回收状态。多个 grant/binding 可以拥有相同整数 revision，却具有不同允许集；“connection+revision”不能当全局唯一的策略缓存键。

**补充设计**：增加私有 engine credential 记录/操作状态，键至少包含稳定 resource、策略规范化摘要、用途、schema版本。token Secret加密存储不进入 wire contract。定义创建并发claim、失败补偿、绑定旧grant的token回收、清理与活跃调用竞争；trigger token作为独立用途，不能被一般缓存回收误删。

**验收**：同连接不同会话权限、相同revision不同策略、双pod同时创建、创建成功后PG失败、撤销后清理与长订阅并存。

## 7. P1：grant 合并与审批状态机仍不明确

**文档位置**：§5.2、§10。

同一连接可能同时授予 user、organization、project、session。文档只写“该连接有效 grant”，未定义多个 allow、deny、过期grant和组织退组如何计算，不能仅靠集合交集符号推出唯一实现。

审批在幂等claim之前也有问题：相同请求可以同时产生两份待审批记录；审批通过后缺少输入/resource版本绑定，难以证明批准的就是实际执行的请求。

**补充设计**：

- 明确同层 allow如何合并、有效 deny覆盖范围、管理员例外是否存在、membership何时重新查询，以及用户直接执行和agent执行是否都要求session绑定。
- 状态机采用幂等请求登记 → pending_approval → approved/rejected/expired → dispatching → succeeded/failed/ambiguous；审批绑定不可变请求摘要和resource身份，资源替换/权限变化触发重新检查，不能编辑已批准输入。
- 普通执行幂等claim不是长期事务；人工审批等待期间不持有PG锁或transaction。

**验收**：多grant冲突、退组、审批期间撤销、参数修改、双提交/双批准、pod重启后审批恢复。

## 8. P2：异步 Action 生命周期未明确

上游 `src/core/types.ts:256-265` 与 `src/server/api/runtime-api.ts:125-138` 暴露 followUpActions、asyncLifecycle（start/status/cancel）。修订版未说明是否只原样提供这些Action，还是平台负责长期任务编排。

无需第一期建设新任务引擎，但应明确：首次调用成功可能只表示provider任务已创建；status/cancel逐次授权并关联同owner/resource；会话取消不等于远端job取消；是否自动poll、如何持久化remote job关联与限额。否则统一execution的succeeded可能被误解为远端业务已完成。

## 9. 实施建议

优先补充三个小型规格，而不是继续泛化扩展整个方案：

1. **调用与审批协议**：完整InvocationContext、MCP授权证明、grant解析与执行状态机。
2. **Trigger接收/调度协议**：receipt/normalized event/checkpoint、ACK、poll/listener和会话幂等投递。
3. **内部引擎适配规格**：token持久化/缓存键、dispatch admission、缺失扩展点与最小PoC。

身份adapter的实际宿主、上游包装形态与核心扩展点仍是实施门禁。达到这些门禁后才定稿P1/P2/P3；目前可以做P0研究验证，不宜承诺完整实现只需按文件清单落代码。
