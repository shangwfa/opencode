# 生命周期第二轮：保留V2机制，补齐V1保护

> 本文是第二轮实现及顺序路径验收记录。随后[第三轮状态机复核](./sandbox-lifecycle-v1-v2-round3-review-2026-10-04.md)又确认了未覆盖的提交未知、gate所有权和命令单飞边界，不能据本表PASS推导全生命周期并发安全。

## 范围与结果

按深度复核中的七项要求修改，没有整体移植V1，没有改依赖包、提交或推送。V2的创建租约、快照操作fencing、PG代际CAS、父子共享、恢复失败拒绝冷启动保持不变。

| 对齐项 | 本轮实现 | 验证边界 |
|---|---|---|
| 快照404 | 删除404显式恢复为成功后标deleted；creating对账404恢复为null后标failed | 先红灯2 fail；真实PG＋模拟SDK404/500单测通过 |
| 后台异常隔离 | recoverIteration应用于idle/OOM整轮和每个候选；typed failure与defect隔离，shutdown interruption仍传播 | 单测＋正常Docker执行；没有对真实PG做断连E2E |
| 非保活snapshot根回合 | 显式snapshot配置提前退出回合销毁；未显式配置时通过provider.lifecycle解析部署默认模式 | 成功/失败/中断三种根终态单测；没有真实模型开发服务器PID验收 |
| 失败后继续执行 | 有效操作租约下仅将原snapshotting实例CAS回running，不伪造lastActivity；恢复该实例closing物理gate | createSnapshot连续HTTP500的真实队列与API验证通过；Failed/timeout的完整平台矩阵尚未跑 |
| kill与DELETE | kill依据PG生命周期而不是running-only ID判断；未确认destroyed不清有效代理。DELETE先关闭并停止子孙执行，源未销毁返回409，保留元数据／恢复点，并重新开放逻辑gate | API/PG/平台验证kill=false、DELETE409、源仍可执行；三层父子结构单测 |
| 恢复失败 | 继续保留恢复点、传播错误、拒绝隐式冷启动 | 既有及本轮回归，不改回V1降级行为 |
| 并发代际 | 单飞等待者返回前核对PG；preview健康/重连后核对代际；OOM采样前后核对ID，避免旧采样归属新实例 | 代际判断/CAS单测与原API代际用例；没有跨副本窗口故障E2E |

## 失败恢复的安全约束

- destroy worker接受保留失败后的running源时，必须按ID、状态、最后活动值CAS重新关闭admission。检测到操作创建后有新活动，旧销毁意图结束，不因迟到重试销毁新工作的源。
- create错误、Failed、timeout或远端删除未确认时，保留物理源；只有当前操作续租成功才允许复位该原实例。失去租约、替代实例或destroyed实例不能被旧worker重新开放。
- timeout期间可能已有后续写入；合并到旧creating快照并等到Ready不再直接允许kill，必须核对对应恢复点及当前workspace内容。不能拿旧capture冒充最新修改。
- worker结果改用Effect.exit，捕获typed failure及defect；操作失败记录Cause，保留队列接管机制。
- DELETE拒绝清理后保留PG会话及快照；不主动删除唯一源。DELETE本身是显式取消操作，失败后恢复admission不代表被用户取消的任务自动续跑。

仍沿用当前workspace-only CLEAN判断；本次没有把它包装成完整rootfs/多文件事务保护。home/resources、后台写一致性和默认code-mode统一活动租约仍需专项工作。

## 代码入口

- `packages/core/src/sandbox/snapshot.ts`：404状态收敛。
- `packages/core/src/sandbox/background.ts`：每轮/每候选异常隔离。
- `packages/core/src/sandbox/generation.ts`：保留源恢复CAS。
- `packages/core/src/sandbox/provider.ts`：lifecycle查询、重试admission、失效capture核对、preview/单飞/OOM身份校验。
- `packages/core/src/session/execution.ts`：snapshot根回合保留。
- `packages/core/src/session/tool-gate.ts`：当前保留源物理gate恢复及失败DELETE逻辑gate恢复。
- `packages/core/src/session.ts`、`session/error.ts`：先停止子孙、源未销毁拒绝删元数据。
- `packages/server/src/handlers/session.ts`、`packages/protocol/src/groups/session.ts`：kill正确返回，DELETE409映射及协议声明。

新增lifecycle是core内部状态查询，没有改变现有kill成功响应字段；DELETE增加已存在ConflictError的409契约。Docker测试需同时挂载core/server/**protocol**，不能用旧协议验证新错误响应。

## 测试结果

| 测试 | 结果 |
|---|---|
| 专用PG：全部sandbox顶层测试＋session execution/run-coordinator，25文件 | **353 pass，0 fail，1011 expect** |
| 专用PG：新增retained DELETE单测 | **1 pass，0 fail**；其余3项用名称过滤，未计为通过 |
| SQLite：session-remove完整文件最终重跑 | **3 pass，1 fail**；唯一失败及HEAD文件对照见下文 |
| SQLite：工具edit/patch、session shell/compaction/owned，5文件 | **116 pass，0 fail** |
| server完整路由/middleware：session sandbox-resource/create/events/pvc-mode，4文件 | **24 pass，0 fail** |
| core与server类型检查 | 通过 |

404红灯证据：本机`lifecycle-404-red.log`为0 pass、2 fail；修复后包含在353项。后台typed/defect、shutdown中断、根snapshot三终态、保留源CAS、物理/逻辑gate重开、404与非404分支均有新增用例。

### 已复核的既有失败

`session-remove.test.ts`原有“removes unloaded sessions and children without initializing an instance”要求删除后Location RcMap立即为空，在关闭自动keepalive时仍有1 fail。使用Bun preload仅将`packages/core/src/session.ts`换成HEAD源码、不覆盖工作区，也复现同一位置的1 fail（2 pass、1 fail）。这是**该文件的对照证据，不是整个仓库的干净基线**。未通过stash/reset丢弃用户工作，也没有删除该测试或修改其断言掩盖失败。

首次将全局list断言测试与其他测试共用已有PG时还有会话残留导致list非空，不把这一轮427 pass/2 fail算最终全绿结果；改为分组隔离验证。新增源保留用例独立在PG通过。

本机日志位于`/private/var/folders/zk/8qd0lv657wn8kvpp__hwjj400000gn/T/opencode/`：`lifecycle-round2-tests-final.log`、`lifecycle-round2-retained-remove.log`、`lifecycle-round2-integration-tests.log`、`lifecycle-round2-server-tests.log`、`lifecycle-round2-{core,server}-typecheck.log`、`lifecycle-round2-remove-baseline.log`及对应preload脚本。

## 最终Docker API E2E

独立容器、独立PG、专用控制面故障代理；不重启共享SaaS、不停止健康源、不修改共享PG。仍是原镜像只读挂载当前源码的测试实例，不宣称已构建或部署新镜像。

| 模式 | 最终通过 | 证据 |
|---|---|---|
| snapshot | **28个检查点** | [result.json](./evidence/lifecycle-snapshot-1791081213515-9626e2f9/result.json) |
| PVC | **15个检查点** | [result.json](./evidence/lifecycle-pvc-1791081633762-a6b8e83a/result.json) |

snapshot：S1→恢复新代际→写v2→对该源snapshot创建注入HTTP500→真实worker5次失败→源仍Running、无DELETE、v2完整→kill返回`destroyed:false`→**不人工复位PG，直接经SaaS写v3**→故障仍在时DELETE返回409、会话和S1仍在→再经SaaS读v3→解除故障→正常Ready保存后安全清理。

另覆盖两种模式的root自动boot、release只改标志、child执行不销毁、preview旧缓存失效、真实PG创建落库异常补偿等既有路径。代际切换用例人为推进本用例PG状态，仅验证缓存失效，不等于完整安全迁移／跨副本竞争验收。三层child停止顺序单测不替代真实并发AI子任务E2E。

最终两轮PG只读复核：session行0、非destroyed沙箱行0、pending/running销毁操作0，见各目录`pg-final.json`。快照/镜像、PVC目录按既有持久化策略保留，不把session删除说成所有底层存储已回收。

### 失败与重跑记录

- 初次DELETE检查失败时，专用Docker未挂载新protocol错误声明；补齐挂载后按当前源码重跑，通过409及元数据保留断言。失败证据`lifecycle-snapshot-1791079505186-11e35375`保留，不自动清唯一源。
- 一轮PVC在`/api/info`就绪等待阶段超时，无创建session、无平台请求；日志显示服务已listen，但未确定超时根因。保留`lifecycle-pvc-1791081213515-aa5dab65`证据，独立重跑最终15点通过，不猜测根因、不计失败轮为通过。
- 先前28/15点通过轮也保留；以上表最终证据为本轮结果，不引用上一轮人工snapshotting复位当自动恢复证据。

## 尚未验收的边界

真实PG断连后的调度恢复；跨副本create/preview/OOM窗口；真实平台Failed/长Creating/超时的恢复矩阵；模型回合结束后开发服务器PID持续性；默认code-mode统一活动保护；CLEAN完整保护范围与并发多文件写一致性。

本轮实现与通过项不等于“code-agent所有执行通道无负面影响”最终验收。剩余项目不擅自扩大到其他策略修改。
