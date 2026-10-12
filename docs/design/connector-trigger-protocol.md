# Connector Trigger 接收、调度与恢复协议

> 设计规格，未实现。配套 `../connector-gateway-design.md`；覆盖webhook、poll、listener，不将上游maintenance当scheduler。

## 1. 固定决策：引擎持久结果 journal

仅保存SaaS原始body不能修复“引擎checkpoint已推进、SaaS输出未保存”的窗口。

对stateful webhook，要求引擎提供**受管接收与持久结果journal扩展**：同一引擎PG事务提交subscription checkpoint/subscription变更与完整规范化结果。SaaS异步导入journal到inbox/outbox；引擎内部事务不与SaaS连接池混用。

该扩展是新增需求，当前headless fetch并未证明支持。不得用现有receive自动保存checkpoint再写SaaS inbox冒充原子提交。需要维护版本化fork/上游扩展时，先提交最小补丁评审；不修改已安装npm包。无此扩展的stateful provider不启用生产投递；不把缺口隐藏成“将来优化”。

计划引擎私有表：managed_trigger_receipt（内部subscription ID、receipt ID、原始字节/相关header/query加密引用、body摘要、接收时间、验证状态、结果、结果摘要、checkpoint revision、lease epoch、ACK响应、导入确认）。唯一(subscription ID, receipt ID)。

## 2. 接收与原子提交

1. SaaS网关限制body/header大小、方法、速率，按binding映射内部subscription；保存原始字节，不先JSON重新编码。拒绝用户自报owner/session和未经映射的subscription。
2. 从provider可靠event ID生成receipt键；没有可靠ID时按provider定义指纹与去重窗口。签名头/身份未验证之前属于quarantine数据，不标记业务事件、不触发会话。
3. 引擎先持久化pending receipt，取得subscription逻辑租约/epoch并读取config、callbackSecret及checkpoint revision。重复receipt返回已有durable结果或处理中状态，不重复推进状态。
4. 执行签名/nonce/replay校验及provider receive。受管state接口将saveCheckpoint/saveSubscription暂存为working state，getter看到本次working state；**不提前落库**。
5. 受管receive不允许远端写副作用；需要远端读取/长工作时返回wake，转listener读取。要求该provider支持此边界，不支持则标记不支持安全受管接收。校验与归一化使用receipt持久化的接收时间，避免恢复时误用当前时间重新判定原签名。
6. PG短事务锁subscription并检查epoch、checkpoint/config revision、授权代际及receipt状态；原子写working checkpoint/subscription、规范化结果、校验结果和ACK响应。任何CAS失败均不提交，重新领取/处理。
7. 引擎事务提交之后才发送成功ACK或已生成的challenge响应。若超时/DB失败，按provider约定返回可重试失败；不能ACK后丢弃pending receipt。

逻辑租约覆盖归一化阶段，数据库事务只覆盖最终提交，不在人工等待/网络请求期间持有事务。provider.receive可能调用的所有state写入都必须被working state拦截；仅处理返回checkpoint字段不够。

如果provider本身把外部API写操作放在receive内，不能承诺该副作用与journal原子；需改为明确幂等的独立operation或拒绝该provider的受管接收模式。

## 3. 结果映射与HTTP响应

| 引擎结果 | SaaS行为 |
|---|---|
| event | 保存规范化outputs/dedupeKey，导入inbox/outbox；显式continue时按provider协议续处理 |
| wake | 写scheduler wake intent，唤醒listener，不把wake当用户事件 |
| ignored | 保存审计原因及状态，无会话投递；不能将ignored自动视为签名有效 |
| respond | 按provider要求返回challenge/status/body及允许的headers，无会话事件 |

ACK status/body/期限由provider profile固定，禁止上游结果携带admin cookie、内部token或任意敏感header。无显式校验结果/签名规则的provider不能标记verified。无签名provider必须经平台独立安全评审与额外不可猜capability策略，不默认接受。

GET挑战不套用“必须JSON body”规则，验证provider方法/体格式。超出引擎能力的协议在catalog标明不支持，不声称全provider兼容。

## 4. Journal 导入与备份恢复

导入worker按binding查journal，SaaS短事务中upsertinbox、写outbox或wake状态、记录engine journal ID/结果摘要。唯一(binding ID, engine journal ID, event序号)防重复；随后才确认导入。

确认丢失导致再次导入时命中唯一键，不再建第二条outbox；导入前pod死亡时journal结果仍在，可恢复。引擎不能在导入确认前删journal。清理只处理已确认且过保留期的记录；结果内容加密，设置最大积压与容量告警。

两套schema同PG时统一一致性备份；恢复后重新导入未确认journal，不仅恢复checkpoint。不能用“checkpoint已保存”代替结果备份。

## 5. Poll 与 Listener scheduler

增加connector_trigger_schedule：binding ID、类型poll/listener、config revision、checkpoint、checkpoint revision、next_run_at、interval、wake_seq/handled_wake_seq、lease owner/epoch/expiry、attempt、last_error、状态。每binding/type唯一。

调度步骤：

1. PG `FOR UPDATE SKIP LOCKED`领取到期或待wake任务，递增epoch，短事务提交lease；不持锁调用provider。
2. 校验长期订阅授权、resource generation、deadline/预算，将当前checkpoint显式传给引擎read。
3. poll返回events/checkpoint/hasMore；listener返回outputs/dedupeKey/checkpoint/hasMore。验证大小、JSON、去重键与页预算。
4. SaaS单个事务检查lease epoch和原checkpoint revision，写页级读取记录、每条event inbox/outbox、更新checkpoint与next_run_at。写事件失败不能推进checkpoint。
5. 同页结果重复提交按(binding,dedupeKey,配置代际)去重。listener一个page的dedupeKey关联该page输出；poll使用每event dedupeKey，不擅自以整个page键覆盖全部事件。
6. hasMore只在每轮页数/时间/预算允许时继续，否则立即安排下一轮；空页仍按provider契约更新checkpoint，防busy loop。
7. transient错误指数退避+jitter；permanent/auth错误暂停并告警；取消/租约过期不提交旧epoch。wake通过递增wake_seq登记，提交只确认本轮捕获的seq，不能吞掉执行中到达的新wake。

read型provider操作必须可安全重复；若内部read会提前修改持久checkpoint或执行远端写，须采用受管journal扩展/独立幂等operation，不接受“read名字意味着无副作用”的假设。

上游maintenance继续负责原订阅资源清理；SaaS scheduler负责poll/listener读取，职责不混用。

## 6. 会话投递

outbox携带稳定delivery ID、target session、规范化event版本和来源。worker逻辑租约/fencing控制领取，写入前重查长期grant和目标session状态。

会话接受API需在一个PG事务内完成 `(target_session,delivery_id)` 唯一去重登记与输入入队；重复请求返回原acceptance ID。若当前Session API不具备此原子边界，必须先扩展现有会话输入链，不直接绕过Bus写消息表。

运行会话排队，由原Session execution ownership消费；输入投递不自行启动并发turn。删除拒收并清理，暂停受限排队，死信重放重新授权。按binding排序键保证需要的顺序；队列上限/TTL作为平台策略，不无限保留。

fencing使旧worker不能提交outbox完成；目标幂等接受使旧worker迟到调用不能重复输入。外部事件导致的第三方Action副作用仍遵循execution幂等/ambiguous规则，不宣称跨系统exactly-once。

## 7. 故障注入验收

- receive working state计算后、journal提交前崩溃：checkpoint未推进，可安全恢复。
- checkpoint/journal共同提交后、HTTP ACK或SaaS导入前崩溃：恢复durable结果，不重新丢弃event。
- SaaS导入后、确认journal前崩溃：唯一键命中，只有一条outbox。
- poll读取后/提交前、分页中间崩溃：cursor与events不分离；双pod旧epoch不能覆盖新checkpoint。
- wake/listener并发、空页、hasMore超过预算、永久错误、challenge/respond全部覆盖。
- 会话接受后/outbox确认前崩溃：delivery去重，只有一次输入接受。

## 8. 实现落点

`core/connector/trigger-receipts.ts`管理gateway及journal导入，`trigger-scheduler.ts`管理poll/listener，`triggers.ts`负责所有权/长期授权，`trigger-delivery.ts`连接现有Session输入链。

受管引擎接收扩展位于上游维护的最小补丁/内部fork，表位于connector schema；SaaS表由core/sql迁移管理。特殊协议入口由server handler承载，schema/protocol仅暴露脱敏状态。

P0先验证引擎扩展与state接口兼容，P3按已通过provider矩阵灰度。身份来源、provider签名细节及既有Session输入接口仍需实际验证，但本文已经固定防丢失架构，不再提供不安全的“先自动checkpoint后写inbox”备选。
