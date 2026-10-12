# Connector 内部引擎、凭证与出站适配规格

> 设计规格，未实现。配套主方案与调用/Trigger协议；所有秘密和引擎原始接口为私有。

## 1. Adapter 边界

引擎提供类型化connection管理、token管理、action/proxy执行、trigger读/受管接收与文件操作。不导出供handler任意path调用的通用fetch。

每次调用携带服务端ExecutionAuthority：SaaS execution ID、真实actor/session、用途、resource generation、policy fingerprint、deadline和执行lease epoch。authority来自PG与可信调用context，不从action input、headers或provider结果生成。

用宿主异步上下文把authority与本进程runtime.fetch绑定；再通过上游providerHttpDispatch关联runtime execution ID和稳定connection ID。调用进程/worker携带的是可从PG验证的authority，不依赖接收HTTP请求的pod内存。

回调必须核验实际dispatch connection/service与授权operation匹配。缺少authority拒绝第三方出站；必要系统operation如credential_validation/OAuth/cleanup有独立受审计authority，不走全局allow fallback。

## 2. 私有引擎凭证记录

新增connector_engine_credential：id、resource ID/generation、engine token ID、secret密文、key version、purpose、canonical policy digest、policy schema version、generation、state、last_used_at、retire_after、lease epoch/expiry、provider binding引用。

purpose分action、proxy、trigger_subscription，禁止跨用途复用。唯一活跃策略槽键为(resource generation,purpose,policy digest,policy schema version)；rotation用generation区分，active槽以约束/CAS保证一条。触发token额外关联长期订阅授权生命周期。

policy digest来自排序去重后的单连接allowedActions/blockedActions/allowedProxies/allowedTriggers及稳定engine connection ID等完整有效规则；不能仅用grant/binding整数revision当缓存键。不同会话相同实际引擎策略可以复用私有token，SaaS实时gate仍分别校验其不同授权来源。

没有权限时不创建token；上游空集合代表不限的字段不得用于表达拒绝。no_auth单独受SaaS显式服务授权约束，不混入其他连接token。

### 2.1 生命周期

creating → active → retiring → revoked；另有failed/reconciliation_required。

1. PG短事务领取策略槽创建lease，生成稳定operation ID；双pod其他调用等待/重查，不各自无限创建。
2. 经私有管理adapter创建engine token，用系统标记的operation ID作为可对账名称；创建后立即把token secret加密保存并CAS激活。
3. 若引擎创建成功、SaaS保存失败，token secret不能从哈希恢复：将该operation查到的孤儿token全部吊销，重新创建，不能把unknown视为active。
4. 相同策略槽存在active凭证时复用；rotation激活新generation后旧记录retiring，禁止领取新执行引用。
5. 凭证没有上游TTL，业务过期由SaaSgate/dispatch保证；retire_after只表示可回收时间，不是引擎原生expiry。

新增credential使用引用（credential ID, execution/subscription ID, lease epoch, deadline）。worker开始使用前在事务内检查active并登记引用；结束释放，崩溃由deadline/epoch对账。retiring后不发新引用，清理必须检查引用与长期订阅绑定。超过期限的hung调用先取消/标记结果不确定，再吊销，不无限保留。

共享token的一个grant撤销不自动吊销所有仍合法调用的凭证；实时授权在dispatch控制。废弃策略槽、全部依赖消失或强制轮换才统一退休。trigger_subscription凭证不能被一般action缓存清理误删；先停止订阅并完成/放弃provider清理，再解除长期引用。

## 3. 出站 admission 与撤销线性化

上游已有providerHttpDispatch的beforeAttempt/onDispatch/bindAuthority接口，本规格复用，不新造沙箱网络通道。

beforeAttempt用于限流排队、预算和初步校验；**onDispatch**紧邻transport，是最终commitment点。它使用短PG事务：

1. 核验execution租约epoch、状态、deadline、真实resource/connection映射与当前授权。
2. 按固定顺序锁本次依赖的deployment/resource授权屏障、主体epoch、grant/binding/父继承授权行；所有授权新增/修改/撤销也必须锁对应屏障，避免新deny插入的phantom遗漏。撤销修改同一锁集合中的相应行，membership版本参见下节。
3. 再读取授权有效状态并检查approval摘要/resourceGeneration；写唯一dispatch commitment（SaaS execution ID+engine attempt ID）及配额扣减。
4. 事务提交才允许transport。CAS、授权或配额失败时拒绝，不返回全权限permit。

撤销的安全承诺明确为：**撤销事务提交后，不能产生依赖已撤销授权的新dispatch commitment；已经commitment的请求可能仍发送/完成。** commitment与实际网络发送之间不能与外部API建立原子事务，因此该窗口也属于不可保证撤回的边界，不用“立即撤回所有请求”措辞。

每次HTTP retry/redirect/new request分别admit；commitment后反馈是best-effort审计，transport_error不表示provider未执行，不直接返还预算或盲目重试。响应未知转ambiguous并对账。

### 3.1 外部成员关系的撤销边界

**本期（会话级）不适用**：会话资源域的授权行全在本 PG，撤销在同一 PG 事务生效于之后的新 commitment，无外部 membership 传播延迟。

以下为未来用户级模型口径：平台 membership 不在本 PG 时，不能宣称 PG 锁实现跨身份系统的即时撤销。要求 Identity Adapter 提供可验证的 auth epoch 及有序撤销通知；SaaS 维护 `connector_authority_epoch` 投影，dispatch 事务锁/检查对应 epoch。平台通知提交本 PG 之后适用上述 commitment 承诺；dispatch 还实时查询成员状态，身份服务超时/通知流超出允许延迟则 fail-closed。若平台无法提供撤销接口，必须明确有界传播延迟，不承诺跨系统即时撤销。

### 3.2 未覆盖 transport

provider如通过SDK、SMTP/IMAP、WebSocket等绕过该HTTP hook，不能因此声称拥有同样逐attempt控制。P0建立provider/transport覆盖矩阵；未覆盖的敏感写能力默认不启用，补对应受信adapter或单独限定安全契约后才能开放。

providerHttpDispatch不暴露完整path/body，细粒度proxy约束在私有proxy adapter与redirect校验实现，不能错误地说仅用hook就能检查全部请求参数。

## 4. 幂等、结果与异步 job

adapter使用SaaS execution ID派生内部幂等key并绑定resource/action/inputDigest，用上游HTTP/API允许的幂等入口传递，不从客户端原key直接跨资源域复用。上游幂等返回结果仍经过当前owner/grant检查。

adapter区分not_dispatched、响应已知、transport_unknown；服务端崩溃无法证明not_dispatched时按unknown处理。业务成功、该次Action成功、远端async job完成为不同状态，具体见调用协议。

provider日志/raw response只存受限秘密/审计域，wire结果执行脱敏和文件URL转换；相同结果不能跨资源返回。

## 5. 必要扩展与上游引入决策

| 能力 | 当前依据/缺口 | 实施方式 |
|---|---|---|
| scoped token/API操作 | 已有存储runtime token，秘密只创建时返回 | 外围类型化adapter+SaaS加密记录/补偿 |
| dispatch admission | 已有providerHttpDispatch options | 先外围注入；验证async context与各transport覆盖 |
| 受管MCP proof | 当前client仅传session metadata | SaaS core受管transport扩展，不改普通MCP协议授权 |
| checkpoint/result原子journal | 现有receive可提前保存状态 | 必须新增引擎受管接收扩展，不假装已有 |
| poll/listener read | 已有read/checkpoint/page契约 | SaaS scheduler，读副作用provider单独验证 |
| Session delivery去重 | 当前尚未核验事务接口 | 复用并最小扩展既有Session输入链 |

固定策略：P1/P2优先官方固定版本包做外围集成；P3 stateful Trigger依赖受管接收扩展。在P0形成最小fork/上游PR补丁及兼容测试方案，用户确认维护形态后才实施补丁；不因为文档列了扩展就擅自修改依赖。

## 6. 验收与实施落点

新增core/connector/engine-credentials.ts、dispatch.ts及私有表/authority epoch投影；connector包仅接受宿主提供的dispatch callbacks，不依赖core的Session/Permission。调用链与表约束见主方案。

强制测试：同resource相同整数revision不同策略不串token；双pod创建只激活一个槽；秘密落库失败可回收孤儿；长期trigger与action回收隔离；第一跳后撤销阻止第二跳commitment；撤销与commit并发顺序可由记录解释；会话删除后授权/凭证不可再用；proxy路径/redirect与非HTTP覆盖矩阵。（membership/身份服务fail-closed为未来用户级测试项。）

这些是设计规定，运行正确性需Docker/API/PG及故障注入验证；任何PoC失败不能以全权限fallback放行。
