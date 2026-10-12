# Connector 调用、授权与审批协议

> 设计规格，未实现。与 `../connector-gateway-design.md` 配套；本文规定主要缺口的处理方式，不证明现有接口已支持。
>
> **范围注记（会话级）**：本期没有用户/组织模型，可信主体是**会话资源域 + 实际调用会话**，actorID 即会话执行主体（会话ID/资源域主会话ID）。本文 §1 的 Identity Adapter、§2 的 user/organization/project grant 分支**本期不启用**，仅作为未来用户级演进口径保留；本期生效分支只有 session。会话间默认隔离，A 会话不能访问 B 会话的连接。

## 1. 入口与可信上下文

执行入口分为 agent_tool 与 direct_user。MCP 是 agent_tool 的传输方式，不是独立授权主体。

| 字段 | 权威来源 |
|---|---|
| actorID / 身份来源 | 会话级：实际调用 sessionID 及其资源域（服务端 SessionTable 校验）；未来用户级由可信 Identity Adapter 提供 |
| sessionID | Tool.Context 的真实调用会话，经 session ownership 验证，不采用父资源 owner 替代 |
| agent / messageID / callID | SaaS Tool 叶子的 canonical invocation context |
| executionID | SaaS 在幂等登记事务中生成 |
| resourceID / actionID / validatedInput | 授权域解析稳定资源并按固定版本 schema 验证 |
| inputDigest / resourceGeneration / policyFingerprint | 服务端计算，不能从请求或 `_meta` 采信 |
| approvalID / permissionSource | 现有 Permission 路径及 connector 审批记录 |

Canonical input：采用固定版本 JSON canonicalization 后计算 SHA-256。实现采用有标准测试向量的 RFC 8785/JCS 实现，不临时用 JSON.stringify 当跨入口规范；仅接受合法、有限且在限制范围内的 JSON。schema 默认值在摘要前应用，验证后的快照不可变；秘密输入加密保存，摘要不公开到低信任日志。

摘要覆盖 resourceID、resourceGeneration、actionID、schema版本和完整validatedInput；别名先解析，执行中不能重新解析成另一资源。输入包含文件引用时绑定文件稳定ID/内容版本，不能审批后替换文件内容。

普通 API不能传入可信 agent/message/call context，不能用已有会话 token 自行创建一个“已批准的工具调用”。内部调用只由受信进程代码生成上下文；插件/沙箱请求均不能调用证明签发管理面。

## 2. grant 的确定性合并规则

对一次操作与一个 resource，先查当前有效的、匹配 actor 或实际调用会话的 grant。**本期只有 session 分支生效**（user/organization/project 分支为未来口径，见范围注记）：

1. revoked 或过期 grant 不参与 allow/deny 计算，撤销/过期表示取消该条 grant，另有独立有效 deny 才能明确禁止。
2. session 分支：验证调用会话属于该 resource 的资源域（服务端 SessionTable/SessionResourceOwner 校验）与显式绑定；子会话继承父绑定子集并与当前父有效绑定取交集。未来 user/organization/project 分支需实时验证成员/角色，成员查询超时/不确定时拒绝，不使用无限期旧缓存。
3. 同一resource的适用 allow取并集，适用 deny取并集，`G = union(allow) - union(deny)`。deny作用于该resource的本次主体，任何管理角色都没有隐式绕过。
4. `E = deploymentAllow ∩ G ∩ sessionBinding ∩ agentPermission - allApplicableDenies`。deployment未配置也不自动等于全权限；平台要显式选择可开放服务/动作集。
5. agent_tool必须有实际session binding；子会话继承需标记parent来源，并实时与当前父有效绑定取交集。direct_user（管理面直接执行）不强制session binding，但必须有资源域内有效grant与执行策略，不能冒充agent权限。
6. proxy/trigger分别合并独立规则；action授权不自动授予proxy/trigger。no_auth操作使用显式的服务级授权资源，不伪造空connection allowlist。
7. 不同resource永远不合并action集合生成引擎token。空E拒绝；发现工具只展示候选/可用信息，不将“待人工批准”误报成部署已禁止。

会话资源域的管理操作（创建/删除/授权）同样需要显式会话归属校验与审计，不能通过一次执行请求自我提权。

policyFingerprint对规范化的有效策略、主体/实际会话、binding及父继承依赖、resourceGeneration、部署策略版本计算（未来用户级再纳入成员关系版本）。单条整数revision不是策略全局标识；撤销时序边界见引擎适配规格。

## 3. 执行状态机与幂等

状态：registered → pending_approval → approved → dispatching → succeeded/failed/ambiguous；另有rejected、expired、cancelled。registered无需人工审批时直接转approved，但仍记录自动授权依据。

唯一键：agent_tool为真实session+messageID+callID+规范化操作序号；direct_user为actor+client idempotency key+resource/action。两入口还支持服务端签发的共同executionID，只有校验上下文和摘要相同才能复用。不同工具调用即使参数相同也不擅自合并。

步骤：

1. 验证身份、资源、schema与初步grant。
2. PG短事务插入registered和不可变快照；同key同摘要返回已有execution，不再次提问；同key不同摘要409拒绝。
3. Tool叶子捕获Permission.Service，使用canonical source `{type:tool,messageID,id:callID}`。工具级可见性过滤不是授权。
4. 根据动作、资源及有效策略形成一个复合permission/approval决策：含工具准入与动作风险。禁止MCP通用叶子先弹一份、facade再弹一份相同确认。
5. pending_approval关联稳定executionID与approvalID；等待期间不持有PG锁/事务。通过/拒绝/过期采用CAS，actor、审批摘要、resourceGeneration必须匹配。
6. approved之后、首次dispatch前重新校验grant和资源代际。授权失效拒绝；操作快照不得编辑。权限或风险策略变化需要重新审批时建立新审批代际，旧proof失效。
7. worker取得execution租约/epoch后调用引擎；结果按epoch提交。首次dispatch后崩溃不得直接重发不幂等操作，转ambiguous并对账。

普通MCP继续复用现有McpTool叶子；**受管connector MCP工具使用connector专用叶子**，完成同一registered/Permission/approval准备过程后走MCP transport，不改变普通MCP权限语义。不另造可执行entry或registry授权callback，仍注册完整Tool.Info，Permission在叶子执行。

direct_user人工审批采用平台用户审批API/事件，不能伪造Tool source；已批准用户直接执行与agent调用不互相借用审批记录。

恢复：PG execution/approval是权威状态；Permission交互的关联/答案持久化适配必须通过PoC。进程死亡后resume同execution，不自动批准、不重新创建第二份提问。拒绝/取消/defect按现有工具中断规则传播，不用catchCause吞掉。

## 4. MCP 身份凭证与调用证明

会话capability建议TTL 15m，用于认证及发现；不能单独授权execute_action。

工具叶子完成上述准备后，为approved execution签发**短期调用证明**（建议60s）：

- 固定issuer/audience/version、jti、iat/exp。
- actorID、真实sessionID、agent、messageID/callID、executionID、approvalGeneration。
- resourceID/generation、actionID、inputDigest、policyFingerprint。

proof通过受管transport附在保留的MCP metadata中，不进入工具arguments、模型内容、PG MCP公开配置或SSE。metadata的安全性来自签名与PG记录校验，不来自字段名字；签发能力只在受信SaaS工具叶子可达。

facade验证session capability和proof主体一致，加载PG execution校验所有绑定字段、approved状态及当前grant，再CAS领取执行。不得信任普通 `_meta.ai.opencode/sessionID`、agent字符串或声称已批准的client参数。

proof重放规则：同execution同摘要只读取状态/结果，不启动第二次执行；不同参数/主体拒绝。首次受理时必须未过期；已受理execution的恢复不因proof后来过期自动重发。新的proof仅能由仍合法的内部调用为同execution重签。

native在进程内直接传可信InvocationContext，仍执行相同PG校验/领取，不需要把proof序列化走网络。code-mode通过Tool叶子构造context；runner不得生成proof。

MCP首次支持范围固定为认证发现和五个工具；敏感tools/call不支持无请求ID的通知执行，不接受未经逐项证明的batch，显式拒绝未知方法。不承诺支持任意外部MCP客户端直接执行；外部用户使用direct_user API，未来独立设计外部MCP审批。

## 5. 异步 Action 的最小闭环

P2不引入自动远端job调度器。start/status/cancel均作为独立Action逐次授权，读取上游asyncLifecycle仅作受限引导，不能自动扩大权限。

增加connector_remote_job：owner、resource/generation、remote job ID（必要时加密）、start execution ID、允许的status/cancel Action IDs、provider状态与更新时间。provider有明确schema映射才创建记录，不从任意文本猜任务ID。

execution.succeeded表示该次HTTP/Action调用成功，不表示远端job完成；结果分别表达callStatus与remoteJobStatus。status/cancel必须验证同owner/resource并有当前授权，cancel动作不因为创建过job就天然允许。

会话停止不自动取消远端job；显式cancel才发provider请求。连接删除/授权撤销保留最小job审计并禁用新操作。自动poll属于后续可选编排，要另行配置周期、授权与预算。

## 6. 强制验收

- 会话token单独调用execute拒绝；伪造agent/session、篡改参数/文件版本/proof、跨audience拒绝。
- 同key双pod登记只产生一份审批；同execution/proof重放只产生一次领取。
- 修改已批准输入、审批期间撤销/退组、父绑定撤销，不能继续dispatch。
- native/MCP/code-mode采用同一Permission与审批决策，不重复提问；direct_user不能冒充Tool source。
- pod重启恢复pending approval与approved execution；dispatch后未知结果不盲目重发。
- async start成功与remote完成状态分开；status/cancel越权拒绝。

## 7. 实现落点与依赖

`core/connector/invocation.ts`构造/验证上下文，`authorization.ts`合并grant，`execution.ts`管理PG状态机，`approval.ts`桥接既有Permission，`capability.ts`签发proof，`remote-jobs.ts`管理远端job关联。

受管MCP在`core/session/mcps.ts`/`core/mcp/client.ts`扩展每调用的内部transport metadata；connector专用Tool叶子不对普通MCP新增通用授权callback。schema/protocol只暴露脱敏execution/approval/job契约，不导出内部proof或秘密引用。

以上均为计划接口。身份adapter、既有审批持久化、MCP metadata传递仍必须经PoC证明，不能用客户端填字段替代。
