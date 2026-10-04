# 第四轮：完善V2生命周期边界

## 实现

基于第三轮确认的五个边界问题继续修复，不退回V1。HEAD仍为`fa4c537e639bfdea4558292c2444fe75849f00ff`；所有实现和报告均在未提交工作区，未推送。

| 第三轮问题 | 本轮变更 |
|---|---|
| R3-01 已归属源被异常补偿kill | complete失败或CAS miss均先对账。同ID running可复用；同ID其他状态保留并报生命周期变化；对账不可用保留并报错。仅确定不同ID的未归属源走原补偿。 |
| R3-02 snapshotting仍可工具admit | admission事务对SandboxTable做running+ID条件的无时间推进UPDATE，锁定源行直到工具dispatch acknowledgement。快照状态转换必须等待该事务；已snapshotting/killed/destroyed的源拒绝dispatch。 |
| R3-03 迟到physical close影响新代际 | physical close必须传预期ID，返回Closure令牌；无匹配不做销毁副作用。activeCommands、缓存、命令单飞及OOM基线只清理目标代际。destroyed/retained同时核对关闭epoch和源ID。 |
| R3-04 旧DELETE重开新close | close返回session/root/physical/sandbox/epoch令牌；reopen只能撤销自己的关闭。Session.remove用整段onExit恢复失败/缺陷/中断后的自有逻辑gate，不只覆盖cleanup里的409分支；显式停止的任务不自动续跑。 |
| R3-05 命令单飞漏结算/跨代际共享 | 独立command-session helper统一结算所有成功分支和失败cause，按session+代际编码key。cached/waiter/creator返回前核对当前PG running代际；失效和销毁也使用该key及Deferred身份。 |

销毁失败收尾仅恢复自身Closure且PG仍是同一running源时允许重开；snapshot worker仍须持有有效操作租约后按源CAS恢复running，再用自身关闭令牌恢复物理gate。Ready门槛、内容复核、操作队列、fencing、创建租约和恢复失败拒绝冷启动均保留。

`admit`保护的是**dispatch acknowledgement前的状态线性化**，不是工具执行全程锁，也不是后台进程/多文件/rootfs冻结。不能将本轮修复扩大解释为完整事务一致快照。

## 单测与接口验证

- 先新增创建补偿及gate失败用例：`12 pass / 12 fail`，见本机`lifecycle-round4-red.log`；命令漏结算的旧函数确定性复现保留在第三轮证据中。
- 最终专用PG 27文件回归：377 pass / 0 fail / 1071 expect，13.26秒。
- `Session.remove`本轮专项：4 pass，覆盖三层子孙保留、较旧DELETE与较新close交错、cleanup前defect及interrupt恢复。完整文件仍有既有Location缓存断言失败，未改断言：6 pass / 1 fail；此前HEAD文件级对照也复现该失败。
- 工具/会话5文件：116 pass / 0 fail；server4文件：20 pass / 0 fail。
- core源码和测试、server类型检查、涉及10个文件的oxlint及`git diff --check`通过。
- Docker首轮snapshot 28点、PVC 15点通过。首轮之后又补充销毁/失效收尾，因此另按最终源码重跑，不把中间版本结果当最终验收。
- 最终PVC：15点通过，证据`evidence/lifecycle-pvc-1791104857929-20f1e59d/result.json`。
- 最终snapshot：28点通过，证据`evidence/lifecycle-snapshot-1791104857929-e9807f2f/result.json`。5次快照创建失败后源仍Running、v2完整、kill明确未销毁；无需人工PG复位可写v3；DELETE409保留会话和恢复点并恢复自有逻辑gate；解除故障后Ready才安全销毁。

测试使用独立Docker容器、独立随机PG库及故障代理；只读挂载当前core/server/protocol源码，使用既有测试镜像，不表示已重建/部署新镜像。共享`opencode-saas-test`未重启。

## 复查补充（同日）

对最终源码又做了一轮静态调用链核对，未发现新问题，确认了以下依据：

- refresh worker 要求行状态为`running`且不转换状态（provider.ts:1128），三处`snapshotting`转换（986、1306、1933）均为销毁意图。admit新增的`running`核对因此只阻塞销毁，不破坏"refresh边执行边保存"。
- admit回调只包住`prepare`/`execute`的dispatch RPC（tool-sandbox.ts:181、309），流式`consume`在事务外，"dispatch acknowledgement"表述与实现一致。
- 锁序一致：admit事务按Root→Logical→Sandbox加锁，destroy close先取Root，reaper/touch单点更新Sandbox，无环形等待。`max:1`连接池下进程内本已串行，新增Sandbox行锁实际只影响跨副本，正是目标。
- destroySandbox的ensuring额外修复了一个此前未单独测试的泄漏：PVC直连路径kill失败时gate以前永远停在`closing`；现在行仍为running时由retained重开。destroyed→closed后ensuring的retained因`state='closing'`条件不会误开。该直连失败分支无独立单测，队列路径已有retained测试，如实标注。
- 全仓grep确认所有`gate.close/destroyed/retained/reopen`调用点均已迁移Closure令牌签名；`sessionCreates`引用（576、799、1744、1800行）全部使用代际key。
- session.ts:469的`Effect.uninterruptible`保证close事务提交与closure记录原子完成，请求中断不会丢失恢复令牌。
- 第三轮探针脚本使用了已移除的gate旧签名，无法在最终源码上重跑；其场景已被新单测取代（补偿×状态矩阵、跨连接写者串行化、新旧closure交错、命令单飞结算）。
- shell路径（getOrCreate入口状态检查）与活动时间戳核对仍是原有保护，未纳入admit串行化；该TOCTOU为既有行为，非本轮回归。

## 仍未验收/不扩大结论

本轮函数/PG所有权交错不等价于完整双SaaS副本E2E。真实PG断连后后台下一周期恢复、真实模型/default code-mode活动租约和根回合服务PID连续性、平台Failed/长Creating/timeout矩阵、CLEAN完整保护范围、后台多文件写一致性、远端PTY及registry层继承仍未闭合。API shell测试不替代真实模型/code-mode验收。

DELETE稳定子孙集合、snapshot提交结果未知的对账、后台fiber作用域等第三轮额外静态风险仍待专项复现讨论，不冒充已修。

成功session清理不等于快照/PVC/镜像全部物理回收。最终snapshot、PVC两个独立库均复核：session行0、非destroyed源行0、pending/running的destroy/refresh操作均0，结果分别保存在各轮证据目录的`pg-postcheck.json`。本轮不提交或推送，也不覆盖AGENTS.md、CLI版本及其他既有用户工作。

最终源码SHA-256及分层验证汇总：[verification.json](./evidence/lifecycle-round4-2026-10-04/verification.json)。

本机日志目录：`/private/var/folders/zk/8qd0lv657wn8kvpp__hwjj400000gn/T/opencode/`，前缀`lifecycle-round4-*`。
