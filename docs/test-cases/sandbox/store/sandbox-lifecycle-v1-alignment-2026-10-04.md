# V2 沙箱生命周期保护对齐 V1：修改与验收

## 本次实现范围

保留 V2 的 PG 创建租约、快照操作队列、父子共享沙箱和恢复失败拒绝冷启动机制，只修改已明确授权的五项：

1. **快照失败保留源**：移除“重试末次接受旧恢复点后销毁”的判断、实现和对应降级事件。create/marker错误、Failed、等待Ready超时均不能继续销毁；Ready或既有CLEAN复用成功仍走原代际/租约/活动核对。CLEAN扫描范围本次未改。
2. **缓存代际核对**：缓存与preview复用前核对PG的实际ID及running状态。活动更新和命令会话ID写入同时限定session、sandbox ID、running；失配不更新替代实例。失效缓存重新解析，preview仍不自动创建沙箱。
3. **创建落库异常补偿**：保留创建lease/CAS。确定未落库时kill/close新建实例，再按owner释放创建租约；提交返回错误但对账发现实例已running时保留并复用；PG对账也失败时保留实例并报不确定状态，不能盲kill。清理失败不释放源的创建租约。正常返回false的租约接管路径仍回收未归属重复实例。
4. **取消保活**：只写keepAlive=false，不调用销毁，也不清除仍有效的preview代理目标。显式kill仍是独立接口，正常idle回收仍按原策略运行。
5. **子任务结束边界**：成功/失败/中断的execution收尾明确排除parentID；子会话terminal不触发根的回合检查点。执行期间的活动保护不移除，主会话仍统一负责保存和物理生命周期。

主会话默认自动保活并立即后台boot的行为未修改。未修改依赖包、数据库schema或用户的AGENTS.md与已删除辅助脚本；未提交、未推送。

## 实现与回归入口

- `packages/core/src/sandbox/provider.ts`：删除降级销毁，使用Ready门槛和generation更新，release仅改标志，子terminal不驱动checkpoint。
- `packages/core/src/sandbox/snapshot-safety.ts`：`requireReadySnapshot`。
- `packages/core/src/sandbox/generation.ts`：缓存身份与PG CAS更新。
- `packages/core/src/sandbox/create-lease.ts`：`persistCreatedSandbox`，包括类型化失败和数据库defect的补偿/对账。
- `packages/core/src/session/execution.ts`：child终态不进入物理生命周期收尾。
- `packages/server/src/handlers/session.ts`：release不清仍有效代理目标。
- 单测：`sandbox-snapshot-safety.test.ts`、`sandbox-generation.test.ts`、`sandbox-create-compensation.test.ts`、`session-execution.test.ts`，并删除旧测试中接受有损降级的断言。
- API E2E：[`sandbox-lifecycle-safety-v2.mjs`](../../scripts/sandbox-lifecycle-safety-v2.mjs)。旧`snapshot-degrade-stop-e2e.mjs`保留历史步骤但禁止执行，防止按旧契约销毁失败源。

## 回归测试

在专用PG库 `opencode-v2-lifecycle-test-20261004`，重跑24个文件（全部顶层sandbox测试及session-execution/run-coordinator）：**341 pass，0 fail，986 expect**。core/server类型检查通过。

测试先复现：旧降级判断仍允许已有旧恢复点时销毁；子任务成功、失败、中断三种终态均额外进入一次生命周期Location scope。修复后的新断言通过。

覆盖Failed/timeout与多次重试、create异常短路、Ready允许后续销毁；代际失配、状态失配、迟到活动及命令ID写入；确定落库失败、已提交但回包错误、对账失败、defect、租约接管及清理失败。单测中的模拟源内容不是平台端到端恢复证据。

本地日志：`/private/var/folders/zk/8qd0lv657wn8kvpp__hwjj400000gn/T/opencode/lifecycle-fixes-tests.log`、`lifecycle-fixes-typecheck.log`、`lifecycle-fixes-server-typecheck.log`。

## Docker API / PG / 平台验收

测试使用原测试镜像 `opencode-saas-sandbox-test:snapshot-scan-stage`，**独立Docker容器以只读bind挂载当前core/server源码**，不替换共享运行容器；因此这是源码覆盖后的测试运行，不表示已构建或部署新镜像。每轮独立PG库，镜像/容器/模式/操作证据在result.json。

| 模式 | 有效结果 | 完整证据 |
|---|---|---|
| snapshot | 22个检查点通过 | [result.json](./evidence/lifecycle-snapshot-1791075531478-89776bc7/result.json) |
| PVC | 15个检查点通过 | [result.json](./evidence/lifecycle-pvc-1791075919729-3a9abbd4/result.json) |

两组分别核对workspace挂载（snapshot无单独PVC挂载，PVC有workspace挂载），不能把其中一组结果复制给另一模式。

公共路径：创建root自动keepAlive/boot → 取消保活后源仍Running、同ID且文件可读 → 非保活root下child执行不销毁、不生成根操作、无独立物理行 → 仅推进测试PG行让仍健康缓存失去running身份 → preview不复用旧缓存 → boot取得新代际并保留文件 → 显式安全销毁。

快照专项：S1 Ready → 新代际恢复S1 → 写v2 → **专用代理对这一个源的createSnapshot注入HTTP500，不停源容器** → 真实队列领取和失败累计5次 → 操作failed、同一源仍Running、无源DELETE、直接平台命令核对v2 → 旧S1仍stale可恢复。退避时间仅对该测试操作调为到期，不改attempts、不伪造终态；真实worker按既有扫描周期重试。

创建补偿专项（两种模式）：仅在该轮专用库为唯一title安装PG trigger，在真实远端创建成功后的creating→running落库时抛错；确认代理捕获202创建、204补偿DELETE，PG原owner租约释放为destroyed，平台GET返回404。trigger随后移除。该测试不能替代提交结果未知/跨实例接管的真实故障E2E；这些目前只有单测。

成功轮清理测试session及远端实例；两组只读PG最终复核均为session行0、非destroyed沙箱行0、pending/running销毁操作0，证据在各目录`pg-final.json`。PVC底层目录和远端快照/Registry镜像按既有保留策略处理，不宣称删除session即物理回收全部持久化数据。失败轮资源保留诊断，不自动删除唯一数据来源。

## 发现的剩余问题（不算本次通过项）

1. **kill-sandbox误报destroyed=true**：快照create异常耗尽5次后PG仍snapshotting、平台源Running，但HTTP返回destroyed=true。已有明确实测证据，原因是handler用只暴露running的sandboxId判断物理销毁。本次只改源保护，没有擅自扩展接口状态契约；应单独修复真实retained/pending/destroyed反馈。
2. **保留源的解锁/重试策略**：create异常或timeout可能让源保留在snapshotting，后续工具请求会被admission阻止。Failed分支仍按原策略回running。测试故障解除后手动将**该测试行**复位running，再通过正常kill创建Ready快照后清理；这不是生产自动恢复已验收。恢复可执行性需继续讨论，不能以保留物理源推导Agent已能自动继续。
3. **未覆盖**：真实模型/task/code-mode、沙箱PTY、完整保护范围CLEAN、跨副本真实竞争、未知PG提交的网络故障、并发写事务与性能预算。公共shell/API验证不是“code-agent全场景无负面影响”的最终验收。

## 失败轮处理

早期专用代理未改写平台返回的server-proxy端点，SDK无法在Docker内完成ready；后续补端点改写及/v1匹配。Bun.SQL直接读PG的boolean底层值也需规范化。曾出现并发轮同毫秒生成相同库名/证据目录，已加模式和随机nonce；PVC补偿测试曾在平台创建504后的中间destroyed状态过早判定，已要求真实202创建及对应204补偿DELETE再判。

上述失败不纳入有效结果；保留失败JSON与本地运行日志。最终有效snapshot/PVC证据仅以上表两轮为准。详细失败目录位于`store/evidence/lifecycle-*`，并发命名碰撞轮的PVC失败输出另在本地`lifecycle-fixes-pvc-api.log`中，不拿其共享目录充当独立PVC证据。
