# V1 / 当前V2沙箱生命周期深度复核

> 以下是第二轮修改前的核对记录。已授权修复及最新验证见[第二轮对齐结果](./sandbox-lifecycle-v1-alignment-round2-2026-10-04.md)，不要把下面的待修复描述当作最新源码行为。

## 对比边界与结论

- V1固定提交：`152c8587db67195b707b581aa41bf50b4fe6a9e2`，分支`feat/opencode-1.18.31`。
- V2：HEAD `fa4c537e639bfdea4558292c2444fe75849f00ff` **加当前未提交的五项修复**；不把HEAD源码当成已修改后的工作区。
- 本轮只分析、最小函数验证和写报告，没有进一步修改业务代码、故障注入共享服务、提交或推送。其他工作区变动，包括`packages/cli/src/version.ts`，不归入此次修改。
- V1路径以下简写为`packages/opencode/src/…`；V2为`packages/core/src/…`，server另列。行号对应本次读取的内容。

**结论：不能简单选V1或V2整体替换。当前V2应保留恢复失败拒绝冷启动、创建租约及更严格的代际约束；V1在后台异常隔离、非保活snapshot回合连续性和快照404收敛方面有需要补齐的逻辑。五项修复解决了明确分支，不代表全生命周期等价。**

重要纠正：**V1本身已经有PG持久快照销毁/刷新队列、续租、fencing及崩溃接管**，见`tool/sandbox-provider.ts:2073–2128,2133–2141`。不能把“有队列、有租约”统称为V2独有改进；比较重点应是状态机和异常分支是否完整。

## 一、已经对齐／有意保留的差异

| 阶段 | V1 | 当前V2 | 评价与证据边界 |
|---|---|---|---|
| root创建 | 默认保活并后台boot | 同样；返回不代表Ready | 目标一致；两种模式API已核对 |
| 父子归属 | 沿parent找root共享 | 同样 | 归属一致，不等于所有收尾自动安全 |
| 子任务结束 | 没有统一parent排除；snapshot回合保留减少误伤 | execution和terminal checkpoint明确排除child | V2当前边界更明确；成功/失败/中断单测，公共shell双模式API |
| release | 只写keepAlive=false | 已恢复只改标志，不清有效代理 | 已对齐；不等于免于后续idle回收 |
| 失败源保护 | 最终snapshot非Ready不销毁 | 删除有损降级，非Ready不继续销毁 | 保护原则已对齐；恢复可执行性另见下文 |
| 缓存与touch | dbTouch限定root、ID、running | 主解析校验PG，活动及命令ID写入CAS限定代际 | 已补主路径，仍不能宣称所有辅助路径均完善 |
| 新建实例落库失败 | 直接kill/close后传播 | 保留创建lease，先对账再补偿；不确定时保留 | V2更适合提交回包未知场景；真实PG确定失败双模式验收，其余单测 |
| 恢复失败 | 可退回镜像冷启动，查询失败也可能冷启动 | 查询错误传播、恢复失败保留恢复点并报错 | 应保留V2，不能为“对齐”改回隐式空目录 |
| 历史恢复点 | 新Ready后可删除兄弟恢复点 | 保留旧点，GC跳过最新可恢复点 | V2更保守；需评估保留成本，不等于永久不GC |
| snapshot并发创建 | 独立PG advisory事务锁 | session行UPDATE事务锁加creating部分唯一索引，校验源ID | 并发去重目标相同；V2锁范围对前台影响需专项验收 |
| 队列与重启 | 持久队列、续租、跨实例接管 | 同类机制，并按代际与活动检查 | 两者都不能仅凭队列声称所有工具exactly-once |

已实测部分见[五项修改验收](./sandbox-lifecycle-v1-alignment-2026-10-04.md)：341项回归、core/server类型检查，snapshot 22点与PVC 15点。**这是此前测试结果，本轮没有新增一轮完整E2E。**

## 二、本轮新增确认：快照404处理迁移错误

### D-01：删除404不标deleted，creating对账404不标failed（P1）

V1在`tool/session-snapshot.ts`的`deleteSnapshot:313–330`与`gc:369–378`，404会进入正确的状态收敛分支：远端已不存在等同删除成功；creating不可能再Ready时标failed。

当前V2 `sandbox/snapshot.ts:199–205,473–480` 将404转换成`Effect.tryPromise`的 **catch返回值null**。但catch函数是映射失败值，不是把操作转换为成功；随后`Effect.result`得到Failure(null)。删除分支只在Success写deleted；GC遇Failure直接continue，因此期望的`current===null`分支走不到。

本轮调用当前真实`SandboxSnapshot.create`的两个函数，用模拟db和抛出SDK真实404异常的manager验证：

| 函数 | 起始行 | 实际返回 | 数据库状态写入 | 应有行为 |
|---|---|---|---|---|
| deleteAllForSession | deleting | Success | 0次 | 标deleted |
| gc | 已超时creating | Success | 0次 | 标failed |

证据：[function-probes.json](./evidence/lifecycle-deep-audit-2026-10-04/function-probes.json)。不是平台E2E。

影响：删除积压不收敛；消失的creating行持续占用creating唯一约束，后续startSnapshot可能反复合并到不存在的快照。**这是确认的V2迁移缺陷，不是一般策略选择。** 推荐保留404错误类型并显式恢复为成功值；先补真实函数单测，再修复、重测。

## 三、本轮新增确认：后台循环错误隔离弱于V1

### D-02：一次PG异常可能终止整条后台扫描fiber（P1）

V1 `tool/sandbox-provider.ts:3017–3037` 对idle查询catchCause返回空候选；`3127–3133` 每个候选独立隔离；OOM查询及候选在`2920–2923,2994–2998`也分别隔离，下一周期可继续。

V2 `sandbox/provider.ts:1801–1915`，idle候选查询及多个中间更新用orDie，外层直接`idleReap → sleep → forever → forkScoped`，没有包住整个迭代的错误恢复；只在部分最终destroy有catchCause。OOM循环`1927–1934,1996–2000`也有类似结构。

本轮最小Effect组合验证：一次失败经orDie后，forever立即Failure，扫描次数为1；forever不会自动复活fiber。**源码及Effect语义已确认，尚未对真实服务注入PG断连。**

影响：idle、GC、创建lease sweep及周期destroy/refresh nudge可能一起停止，或者OOM观测停止，直到服务层重新构建/重启。detached drain自身catchCause不等于扫描调度fiber不会退出。

建议：迭代级恢复、候选级隔离、失败可观测及调度存活检查；不能简单无限吞错，应保留错误日志和下一周期重试。先把“一次PG失败后第二周期继续”沉淀为用例。

## 四、保留源之后，V1/V2可用性并不等价

### D-03：失败、超时、创建异常后的状态与队列协同（P0可用性／状态风险）

V1 `tool/sandbox-provider.ts:1979–1982,2030–2053,2133–2136` 使用killed/snapshotting与cleanup协调，创建返回null或await非Ready保留源。**其执行体部分失败路径正常return，队列可能complete而非fail，后续依赖killed重扫**。因此不能声称V1所有快照失败都按同一操作精确重试5次。

V2 `sandbox/provider.ts:931–932,953–976` 的分支不同：

- 平台明确Failed：将源行回running，然后操作fail。
- create请求异常或等待timeout：保留snapshotting，操作fail。
- 队列worker要求当前行snapshotting；回running后，后续队列领取需要和idle重新关闭admission协调，不能保证每次attempt都实际调用远端snapshot。
- admission在`1557–1559`直接阻止snapshotting/killed的新工具请求。

已实测的create异常耗尽重试留下snapshotting、远端Running、v2文件完整；这证明物理数据源保留，**不证明Agent可以继续执行**。显式Ready超时、平台Failed及GC后来Ready的恢复路径仍需分别验收。

另：`snapshot-operation.ts:59–100`仅对pending/running去重。旧操作failed后，`provider.ts:1837–1843`可再次enqueue新操作，因此MAX_ATTEMPTS=5约束**单条操作**，不是同一源永久总共最多5次。V1也有killed重扫机制，不能把此点写成只有V2无限重试。

建议明确“保存pending、最终failed但源可执行、继续等待但有界阻塞”的契约，协调行状态、执行gate、操作状态和GC；不照搬V1一个状态名。

### D-04：kill返回与删除会话的后续行为（P0保护边界，部分已实测）

V2 `provider.ts:1242–1253`，destroy可在running或deadline到达时正常return；`sandboxId:1264–1266`仅暴露running实例。server kill handler再以其有无判断destroyed，因而snapshotting实际存活源可能返回destroyed=true。**此前API/PG/平台已复现，不是本轮猜测。**

`session.ts:472–485` 随后deleteSnapshots，错误仅记warn，未检查源是否真的安全销毁；child中断在`487–515`，晚于root物理处理。

V1 `session/session.ts:673–701`也先destroy/purge，之后才cancel root及递归删除child，并吞部分错误。删除顺序和失败继续不能全算V2新增缺陷；V2至少在物理处理前等待root idle，并明确child工具释放不销毁root。

**必须区分API逻辑删除、远端物理删除和快照保留策略。** V2 `sandbox/sql.ts`、`snapshot.sql.ts`及`database/pg-schema.sql`中这些session关联列没有声明session外键级联；不能凭“删session”推导sandbox/快照/队列记录同步删除，更不能仅凭行保留认定全部数据丢失。正常成功轮PG最终计数也不能替代“源保留时DELETE”故障用例。

建议先修kill真实状态返回，再明确DELETE遇retained/pending是否拒绝、延迟清理或显式强删；本轮没有运行危险DELETE失败源场景。

## 五、回合连续性与活动保护

### D-05：根snapshot回合结束仍比V1激进（P0条件连续性风险）

V1 `session/run-state.ts:69–87`只在`!keep && !snapshotMode`时destroy。当前V2 `session/execution.ts:91–104`虽排除child，但root仍只判断keepAlive，没有snapshotMode排除。

因此 **取消保活现在只改标志，但下一个根Agent回合结束仍可能保存并销毁**。release即时不销毁的API验收，不能证明后续根回合也不销毁。shell结束用例不是模型执行settled路径的替代。

默认root keepAlive=true通常掩盖此差异；snapshot是文件保存，不是运行内存/服务PID保存。若要非保活snapshot回合仍保持进程，V1策略更符合连续性目标。PVC是否回合结束销毁应单独保持既定契约，不混为一谈。

### D-06：code-mode活动保护尚未闭合（P0静态风险）

普通run和activity有心跳；默认code-mode daemon启动经过provider.run，随后`tool.ts:281`调用`codemode/runner.ts:106–192`的WebSocket execute，没有同范围的provider.activity。

纯JS/网络等待的code-mode如果不调用能touch的嵌套工具，不能从普通shell心跳推导完整保护。keepAlive不排除idle回收，父子共享也不等于共有活动租约。

该执行通道不能机械称为V1同名功能迁移遗漏；应按当前SaaS“所有Agent执行不受回收影响”的要求补验证。需要真实code-mode长等待、模型等待、父子并发与短idle阈值验收。

## 六、并发及辅助路径：主缓存修复并非全面证明

### D-07：preview重连／单飞等待者的并发窗口（P1静态风险）

`provider.ts:1652–1675` preview在connect前查PG，但connect成功后直接cache/return，没有后置代际核对；健康缓存也在isHealthy之后直接return。`1566`创建等待者直接await已有Deferred，未独立复核。主解析末尾`1610`的touch CAS能拦住一部分变化，不能泛化到所有只读端点。

V1主要复用与重连在`tool/sandbox-provider.ts:2199–2205,2251–2254`以带ID的dbTouch作为返回前判断；它同样不是横跨整个远端请求的线性化锁。

建议双副本在“查PG→connect/health→返回”窗口推进代际，证明旧句柄不缓存、不错误归属；本轮只确认窗口，没有宣称请求已经误操作。

### D-08：OOM采样仍可能把旧实例数据归到新代际（P1静态风险）

V1 `tool/sandbox-provider.ts:2910–2936`按查询行的row.id重连采样。V2 `provider.ts:1939–1955`仅按session取本地entry，用entry.sb采样，却以PG row.id构造baseline及事件身份；没有验证entry.sb.id等于row.id。

若另一副本切代际而本实例保留旧缓存，存在“采样S1，记录成S2”的分支。新的主缓存代际校验不自动覆盖后台OOM循环。V2避免为非本机连接的实例主动建箱是合理策略，但本机缓存也需身份核对；实际事件污染尚未E2E复现。

### D-09：扫描吞吐／公平性差异（P2容量风险）

V1 idle候选按time_updated排序、limit批量、concurrency=4（`3017–3031,3115–3135`）；V2 idle候选`.all()`后串行处理（`1817–1835`）。大规模PG及慢平台下，V2单周期处理量和后续扫描延迟需要容量测试，不把源码差异直接当性能失败。

V2快照gc expired取50条且无排序（`snapshot.ts:437–453`），再跳过各会话最新恢复点（`455–457`）。大量已过TTL但应保留的最新点有可能占满批次，旧点/deleting的扫描公平性需验证；不能因为有limit就声称GC长期必然覆盖。

## 七、共同问题及产品能力差异

| 项目 | 分类 | 处理原则 |
|---|---|---|
| CLEAN只检查workspace，而快照保护rootfs | V1/V2继承缺口 | 统一保护范围，补home/resources及目录拓扑用例；SHA正确不等于范围完整 |
| prune直接删源缓存 | V1/V2条件行为 | 记录开关，证明保存不破坏在用依赖；不能以删业务内容提速 |
| 快照时后台进程仍可能写多个文件 | 两者未完整证明事务一致性 | 活动时间CAS不是文件系统冻结；需要真实后台写测试 |
| 指定snapshotId恢复／派生 | V1有接口参数，V2资源schema未暴露 | 产品范围待确认，不擅自混用PVC与快照 |
| 恢复marker探针 | V1有观测，V2未同等保留 | 可补诊断；marker不证明全文件完整 |
| PTY绑定session sandbox | V1有对应runtime，V2尚未等价 | 本地Server PTY不能算远端沙箱PTY通过 |
| 无恢复点时冷启动 | 两者均有新建路径 | V2拒绝恢复错误不等于证明从未有未保存数据；平台硬杀仍需明确损失反馈 |

补充锁范围：V1用专门advisory事务锁，V2在`snapshot.ts:247–290`锁session行，并在同一事务中prepare/远端create。它加强同session创建去重，但可能阻塞其他更新session行的前台操作；等待Ready在事务外，不应夸大为整个Ready等待都持有行锁。需要控制面慢响应与并发消息落库的接口测试。

## 建议优先顺序（尚未执行）

1. 404状态收敛、后台调度存活：本轮新发现，先用例后修复。
2. kill真实状态＋失败源解锁：已有物理/PG/API反证，明确安全与可继续执行的契约。
3. 根snapshot回合保留＋code-mode统一活动保护：避免“已取消保活但不该终止任务/服务”的后续副作用。
4. 故障DELETE及父子停止顺序、跨副本并发窗口、OOM归属、CLEAN完整范围。
5. 再做扫描容量、锁等待与性能预算，不用减少保护范围换取速度。

**不建议整套回滚到V1；按V2服务结构补齐已验证的V1保护原则，并保留V2更严格的数据恢复保护。**
