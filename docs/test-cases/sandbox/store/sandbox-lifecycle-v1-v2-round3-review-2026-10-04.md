# 第三轮复核：V1与修复后V2的状态机、所有权和完整调用链

> 第三轮发现的五个问题随后进入[第四轮V2修复与验证](./sandbox-lifecycle-v2-round4-2026-10-04.md)。本文保留发现当时的源码哈希与失败证据，不代表后续工作区仍是这些分支。

## 结论与范围

**主要顺序路径已对齐，但当前V2仍不能认定与V1保护逻辑等价，更不能认定完整并发生命周期安全。** 这次复核发现5个未覆盖的边界问题，其中已归属实例的异常补偿存在绕过最终快照直接kill的严重分支。

- V1固定提交：`152c8587db67195b707b581aa41bf50b4fe6a9e2`；重新用git show核对导出的provider和session-snapshot源码，逐字一致。
- V2：HEAD `fa4c537e639bfdea4558292c2444fe75849f00ff`加当前两轮未提交修复。关键源码SHA-256在[证据JSON](./evidence/lifecycle-round3-2026-10-04/probes.json)，避免混淆后续工作区版本。
- 本轮仅对比、专用PG／函数验证和写报告；未继续改业务实现，未开远端沙箱、未调用真实远端kill、未提交或推送。
- 下述V1路径以`packages/opencode/src/`为前缀；V2以`packages/core/src/`为前缀。

## 一、第三轮新增问题

### R3-01：提交结果未知时，“已归属”错误地等同“仍running”（P0）

**当前代码：** `sandbox/create-lease.ts:188–206`。complete失败后虽然对账，但只有`row.id===sandbox.id && state===running`才保留；同ID的snapshotting/killed行仍进入`kill/close/release`。

合法的并发顺序可以是：创建者已提交S1→提交回包丢失→其他执行者开始最终保存，将S1推进snapshotting→创建者对账读到S1/snapshotting→误把S1当作“未归属新实例”直接kill。这会绕过snapshot-destroy的Ready门槛、队列及fencing。

**实际函数验证：** 调用当前`persistCreatedSandbox`，模拟complete响应失败、latest返回同ID：

| PG对账状态 | 实际结果 | 补偿调用 |
|---|---|---|
| running | Success | 无kill |
| snapshotting | Failure | kill、close、release |
| killed | Failure | kill、close、release |

这里kill是记录调用的模拟函数，不是平台误杀实测；但实际函数的危险分支已复现。

**V1比较：** `tool/sandbox-provider.ts:1726–1741`也在dbUpsert异常时直接kill，不能声称V1已解决提交结果未知。V2增加对账方向更好，但目前对账判据不足，应继续完善V2而不是退回V1：先判断是否已被PG归属；同ID非running应保留并报状态变化，不假装可用，也不能当孤儿kill。

### R3-02：snapshotting关闭了provider入口，却没有关闭全部工具admission（P0静态保护风险）

**当前代码：** `sandbox/provider.ts:940–948,1259–1267`将源推进snapshotting；`session/tool-gate.ts:45–57`的admit只检查逻辑/物理gate和sandbox ID，未检查SandboxTable.state。真正`toolGate.close(...,true)`在物理kill函数的`provider.ts:770`，不是整个快照期间的统一边界。

**真实PG验证：** 建立running源、调用gate.booted形成open gate→只将SandboxTable.state改snapshotting→调用实际gate.admit，返回Success，执行回调确实被调用。

普通shell的getOrCreate会拒绝snapshotting，不代表已捕获的Session Tool请求也被拒绝。`session/tool-sandbox.ts:309–336`执行时使用gate.admit，捕获请求的epoch不会因单独改SandboxTable.state自动改变。完整远端工具是否在特定窗口写文件，尚未做端到端故障验收。

**V1比较：** V1复用/重连以`dbTouchSandbox(sessionID,sandboxID)`的running CAS作为门槛（`tool/sandbox-provider.ts:1376–1388,2199–2205,2251–2254`）。V2新增gate是合理架构，但“行状态关闭”和“工具gate关闭”必须形成一致契约。V1的CAS也不等于能冻结所有后台进程，不能因此宣称V1已有全文件系统屏障。

建议先明确refresh可边执行边保存、destroy必须阻止新执行这两种契约，再统一admit与代际/状态检查；不能只依赖下一次5秒活动心跳失败。

### R3-03：迟到的物理close可能先影响新代际，后置ID检查太晚（P1并发执行风险）

**当前调用顺序：** `provider.ts:755–787`先查旧行/expected ID，随后`toolGate.close(sessionID,true)`，中断session级activeCommands并drop缓存，之后才再读PG并检查expected ID／entry ID。

`session/tool-gate.ts:78–86`物理close只按root ID更新，不限定预期sandbox ID或epoch。若另一个执行者在两次PG读取之间已完成S1→S2：旧请求可能先把S2的物理gate设closing，甚至影响本进程S2的命令，再因为后置ID不符退出。

**真实PG函数验证：** S1 booted→PG及gate推进S2/open→调用现有无代际参数的physical close→S2 gate变closing。这个验证证明close本身没有fencing；并未运行整个跨副本kill/boot交错，也未实测新命令被中断。

**V1比较：** V1销毁路径首先使用带ID的`dbTransitionState` CAS（`tool/sandbox-provider.ts:1977–1983,2414`）。V2已有前后ID判断，但应将V1的“副作用前按身份领取”原则同时落实到gate、activeCommands和缓存清理，而不只落实到最终PG行写入。不能断言V1所有缓存失效动作都线性化安全。

### R3-04：失败DELETE恢复gate没有关闭操作所有权（P1）

**当前代码：** `session.ts:505–509`失败后调用reopen；`session/tool-gate.ts:106–113`只要求session存在和逻辑gate处于closed，没有预期epoch或关闭owner。

**真实PG验证：** A close得到closed/epoch2→B再close得到closed/epoch3→A失败后reopen→gate变open/epoch4。较早请求可以撤销后来请求的关闭。

`retained`物理恢复已限定sandbox ID和running状态，但也没有绑定某一次关闭epoch。它防了错误代际，不代表防了同代际的多次不同生命周期意图。

**V1比较：** V1没有同等持久gate重开协议，这不是机械迁移遗漏，而是新增V2恢复机制的所有权缺口。应继续用PG CAS：close返回关闭令牌/epoch，reopen仅撤销自己仍持有的关闭；不能以一个closed布尔状态替代并发所有权。

### R3-05：命令会话已创建的二次检查分支漏结算Deferred（P1可用性）

**当前代码：** `provider.ts:1733–1759,1777–1798`。

顺序可以是：A首次读到commandSessionID为空→B完成创建并移除其单飞令牌→A领取自己的令牌→A二次读已存在的有效ID，执行`if(current)return current`→跳过`Deferred.succeed`→ensuring把A的令牌判作未结算并fail→A收到“Command session creation interrupted”，尽管有效命令会话就在缓存中。

**函数体验证：** 程序从当前provider精确提取完整commandSession函数体，用Bun移除类型后执行，注入两次读取之间ID出现的确定性调度。实际两次读取后得到Failure，错误为`Command session creation interrupted: probe-session`。没有改写该分支或调用平台SDK。

另有静态窗口：`sessionCreates`仍按session ID单飞，等待者在`1748`直接返回命令ID；新代际可能加入旧代际命令上下文的令牌。主沙箱创建等待者已补后置代际核对，不代表命令会话等待者也已补齐。

**V1比较：** 本问题属于V2持久命令会话／单飞实现的内部结算缺口，不假设V1有同名结构或可直接移植。应保持V2设计，每条成功分支统一结算token，并将命令上下文的单飞与返回绑定实际sandbox ID。

## 二、对前两轮结果的再确认

| 路径 | 当前结论 | 与V1的关系 |
|---|---|---|
| snapshot 404 | 显式恢复为成功值后状态收敛，原Failure(null)错误已修 | 已补齐V1原则 |
| 后台异常隔离 | 每轮、每候选恢复typed/defect，shutdown interruption不吞 | 已补齐V1主要异常隔离；不等于服务监控/PG断连已验收 |
| root snapshot回合 | 显式persistMode和部署默认模式均有保留判断 | 已补齐V1的回合连续性原则 |
| child收尾 | execution及terminal checkpoint显式排除child | 比V1依赖模式/默认值更明确 |
| release | 只改保活标志，不销毁/清有效代理 | 已补齐V1语义 |
| 最终snapshot非Ready | 常规destroy不继续kill，失败源可恢复running | 主路径已修；R3-01说明仍有别的kill入口绕开保护 |
| kill／DELETE顺序路径 | kill=false、DELETE409及元数据保留有前轮E2E | 已改善；R3-03/04说明并发意图仍有漏洞 |
| 恢复失败 | 继续保留恢复点并拒绝cold start | V2更保守，不能改回V1隐式冷启动 |
| 缓存、preview、OOM | 增加PG代际/前后核对 | 方向正确；不能外推到命令token、物理gate和全部副作用 |
| 快照队列 | 两版本都有持久队列、租约和接管 | 不能把机制存在当作所有异常分支完整的证明 |

上一轮HTTP500测试是在平台创建确定失败时补偿／恢复，没有模拟“创建已落库并被别的生命周期接管、回包才报错”。其PASS不能否定R3-01。

## 三、继续需要关注但本轮未端到端复现的边界

1. **DELETE的整段失败恢复**：逻辑gate从`session.ts:460`开始关闭；root/child中断、子孙枚举等步骤在cleanup.exit之前。这里PG失败或请求中断时，没有覆盖整段的带owner恢复finalizer，可能留下未删除的会话和closed逻辑gate。不能用cleanup内部的409路径证明所有早期失败均能继续执行。
2. **子孙集合并不稳定**：先枚举再逐个关闭，Session.create没有以root删除中状态原子拒绝新child。并发新增子孙可能不在该次枚举中。V1也有枚举与删除竞态；V2提前枚举加停止顺序只解决固定树，不能称跨实例完整屏障。
3. **后台fiber作用域**：V1使用`forkIn(creationScope)`，V2 create/drain/命令创建使用`forkDetach`。安装的Effect v4明确将其挂全局scope；这不是“不因HTTP断开而取消”与“provider关闭也可存活”都自动合理的证明。需要服务/Location重建和PG层关闭验收，不建议让请求scope取消持久任务，也不建议默认无界全局detach。
4. **snapshot落库与远端补偿**：sandbox实例的persistCreatedSandbox不是snapshot行的补偿。`snapshot.ts:250–352`补偿集中在插入失败/冲突分支，整个事务提交异常与回包未知还应单独验证；没有对账就不能盲删已归属快照。
5. **CLEAN完整范围、默认code-mode活动租约、后台多文件写一致性**：仍是已有未闭合范围，不重复宣称已修。新增“Ready后再核对workspace”不能证明home/resources或整个rootfs最新修改已被完整保护。

## 四、验证结果与建议

- 7条确定性场景输出见[probes.json](./evidence/lifecycle-round3-2026-10-04/probes.json)。其中创建补偿是模拟回包错误；gate是实际专用PG；commandSession是当前函数体确定性调度。均未执行真实远端危险操作。
- 专用PG重跑25个既有相关测试文件：**353 pass、0 fail、1011 expect，12.20秒**。本机日志`lifecycle-round3-regression.log`。
- **现有回归全绿与本轮危险分支同时存在，说明覆盖缺口，不说明这些问题已经修复。** 本轮没有增加平台故障E2E或扩大前轮PASS范围。
- 当前请求是再次对比，未继续改实现；AGENTS.md、CLI版本相关用户工作及此前改动均保留。

优先建议：先落R3-01“同ID已归属非running不得补偿kill”的失败用例；随后统一destroy/admit/close/reopen的PG状态和关闭所有权，覆盖迟到操作与并发DELETE；再补命令单飞结算与代际token。保留V2架构，不整体退回V1，也不把V1已有的未知提交风险当成熟方案照搬。
