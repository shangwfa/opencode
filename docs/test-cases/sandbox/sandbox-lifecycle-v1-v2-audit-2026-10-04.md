# 沙箱生命周期 V1 / V2 实现核对（2026-10-04）

> 本文保留修复前基线与风险分析。随后已授权的五项修改及实际验收见[生命周期对齐结果](./store/sandbox-lifecycle-v1-alignment-2026-10-04.md)；不要把本报告中的旧实现描述当作修复后的当前行为。

> 对当前未提交修复后的继续复核见[深度对比报告](./store/sandbox-lifecycle-v1-v2-deep-review-2026-10-04.md)，包含新确认的404状态收敛问题、后台循环错误隔离及剩余并发边界。

## 结论与证据边界

V2 已具备 PG 创建租约、快照操作队列、代际核对、命令心跳和恢复失败拒绝冷启动等保护，但**不能据此认为与 V1 生命周期等价，更不能认定对 code-agent 无负面影响已验收**。

优先问题是：dirty 源快照失败后仍可能被销毁、CLEAN 判定范围窄于保护范围、未保活 snapshot 回合结束即销毁，以及默认 code-mode 执行不具有统一活动租约。

- V1 基线：`feat/opencode-1.18.31`，提交 `152c8587db67195b707b581aa41bf50b4fe6a9e2`。按项目说明，V1 逻辑经过线上验证；本次不重复声称做过 V1 线上实测。
- V2 基线：`fa4c537e639bfdea4558292c2444fe75849f00ff`。检查当前源码，不改实现，不切换服务配置、不注入平台故障。
- 下文 V1 路径指该提交的文件，可用 `git show <V1提交>:<路径>` 查看；行号对应此次基线。
- 静态调用链结论、函数验证、历史 E2E 和本次回归分别标注；没有新增真实模型/平台故障 E2E。
- 工作区原有新增双模式用例及工具文档变更保留，未覆盖或提交。

## 生命周期对照

| 路径 | V1 | V2 | 判断 |
|---|---|---|---|
| 父子沙箱归属 | `session/sandbox-opts.ts:16` 沿 parent 链解析根会话配置 | `sandbox/provider.ts:453` 根会话解析，公共 boot/destroy/keepAlive 等在 `2114–2127` 归一化 | 目标一致：task 子会话共享根沙箱；不等于子任务结束可销毁根沙箱 |
| 创建与并发 | PG provider 有创建协调、缓存和 in-flight Deferred；`tool/sandbox-provider.ts:2401–2406` destroy 会失败掉本地创建等待者 | PG 创建租约见 `sandbox/create-lease.ts`；`provider.ts:764–775` creating 时暂不销毁，后续操作处理 | V2 不应照搬 V1 的本地 Deferred 策略；需验证创建完成后的回收和孤儿处理 |
| TTL/保活 | `tool/sandbox-provider.ts` 区分 PVC、keepAlive 的 TTL；idle reap 仍覆盖保活实例（`3008–3027`） | `provider.ts:730–748,1396–1403` PVC 用 maxTtl、保活扩 TTL；idle 扫描 `1877–1893` 不按 keep_alive 排除 | keepAlive 不是永不回收，也不是持续活动心跳 |
| 普通命令执行 | `tool/sandbox-provider.ts:2162` 命令期间定期心跳 | `provider.ts:2226,2322–2335` 开始 touch，消费流与心跳并行 | 普通 shell 的活动保护存在；不能外推到全部执行通道 |
| 回合结束 | `session/run-state.ts:69–87` 只有 `!keep && !snapshotMode` 才销毁；snapshot 等真正 idle 后统一回收 | `session/execution.ts:91–103,136–164` settled 的 ensuring 只检查 keepAlive，未按 snapshot 排除 | **行为回退**：未保活 snapshot 每轮可能保存并销毁，影响进程/开发服务连续性 |
| 回合检查点 | 以空闲周期刷新为主要路径，`tool/sandbox-provider.ts:3051–3067` | `provider.ts:1227–1268` 订阅成功/失败/中断，10秒去抖，请求 refresh | V2 增加保护机会，但回合成功不等于快照已经 Ready；短间隔去抖不保证每轮均有快照 |
| idle 回收 | 扫描 running/killed/snapshotting，CAS 后统一清理；`tool/sandbox-provider.ts:3008–3138` | `provider.ts:1861–1978` CAS，snapshot 入 destroy 队列，其他模式直接销毁 | 依赖 time_updated 可信；CAS 只能防已发生的更新时间竞争，不能识别无心跳的活跃任务 |
| 快照后销毁 | `tool/sandbox-provider.ts:1973–2077,2413–2418` Ready 后销毁，失败/超时保留源 | `provider.ts:970–1075` CLEAN 复用或最终保存，有租约/代际/活动变化检查；但含旧恢复点降级销毁 | V2 有结构性保护，同时存在违背数据保护门槛的例外分支 |
| release | V1 显式释放保活语义与 destroy 区分 | `provider.ts:1322–1326` 清 keepAlive 并进入销毁路径 | release 不是只修改一个标志；可能实际保存/销毁沙箱 |
| 显式 snapshot | V1 显式路径见 `tool/sandbox-provider.ts:3180–3244` | `provider.ts:2129–2177` 永不 CLEAN 复用，返回 creating 后后台 await | 不能拿 destroy 队列 attempts 描述显式接口，返回 ID 不等于 Ready |
| 恢复 | V1 有快照选择/恢复及兼容性检查 | `provider.ts:1334–1486` 选择恢复点、创建；恢复失败保留记录并拒绝 cold start | V2 恢复失败保护应保留；ready/stale 均可能是有效恢复点 |
| 会话删除 | V1 的 session 与 provider 清理路径分层，不与普通 onIdle 等同 | `session.ts:457–502` 先中断当前会话，root 销毁与快照清理在遍历子会话之前 | root 删除期间活动子任务停止顺序需专项验证；不能仅凭 child 删除不直接 destroy 判全面安全 |
| 服务重启 | V1 pgLayer 与非 PG layer 不同，不将非 PG destroyAll finalizer 当 SaaS 行为 | `session/execution.ts:80–89,145–152` shutdown 保留执行 claim；沙箱操作有持久租约 | V2 有恢复意图，不代表工具副作用 exactly-once、WebSocket 原地续跑或进程永不更换 |
| PTY | V1 有 `pty/sandbox-runtime.ts` 根沙箱保活/释放 | 当前 V2 PTY 未绑定 session sandbox，见 `sandbox-terminal.md` | 属于明确能力差异；Server 本地 PTY 测试不能替代远端沙箱连续性验收 |

表内 V1 文件位于 `packages/opencode/src/`，V2 文件位于 `packages/core/src/`，除另有说明。

## 优先风险与需复现场景

### LIFECYCLE-01：最终快照失败后销毁 dirty 源（P0）

**源码已确认**：V2 `provider.ts:987–1039` 获取旧 ready/stale 恢复点，保存失败/timeout 后可走 `degradeDestroySnapshot`（`947–968`），将接受旧恢复点记入持久状态；随后 `1058–1069` 只要操作租约、代际和活动时间检查通过，仍销毁源。

V1 `tool/sandbox-provider.ts:1973–2077,2413–2418` 的路径是未成功保存保留源，不以“已有旧恢复点”替代最新修改保护。

**影响**：旧 v1 可恢复并不能证明 dirty v2 已持久化；末次失败后主动销毁会造成可避免的最新修改丢失。日志记录降级不等于数据已安全。

**验证状态**：本次为源码确认；历史上下文已有故障注入记录，本报告未新增平台故障复测。

**复现/验收**：双模式用例 CA-PERSIST-18。准备 v1 → 写 v2 → 最终保存失败 → 到达重试上限；要求保留 v2 源或阻止安全回收。建议恢复 V1 的保守原则，但按 V2 队列/租约实践实现，修复前先落专项回归。

### LIFECYCLE-02：队列 attempts 提前一轮降级（P1；加剧上述 P0）

**函数验证已确认**：`snapshot-operation.ts:136,145` claim 时将 attempts 加1并返回加后的值；`provider.ts:279–283` 又用 `attempts + 1 >= maxAttempts`。MAX_ATTEMPTS 为5（`snapshot-operation.ts:14`），第4次 claim 已可降级。

本次直接调用实际导出函数，输入 attempts=1/2/3/4/5，结果为 false/false/false/true/true。不是全队列平台 E2E，但足以确认计数口径与“最后一次重试”的注释不一致。修复数据保护策略优先于仅把次数改成5。

### LIFECYCLE-03：CLEAN 范围窄于快照保护范围（P0）

**源码已确认**：V2 `snapshot-reuse.ts:31–71,161–179` 默认扫描 `/workspace`；`provider.ts:991–998` CLEAN 时复用旧快照并最终销毁。V1 也有 workspace-only 复用（`tool/sandbox-provider.ts:1996–1999`），因此这是**继承的范围缺口，不全是迁移新增**。

**待复现影响**：workspace 不变，但 home/resources/系统工具改变，仍可能复用旧 rootfs 恢复点并丢这些修改。文件 SHA-256 完整不代表扫描范围完整；空目录/硬链接拓扑也不能只由当前文件内容清单证明。

**复现/验收**：CA-PERSIST-05/07/18；已有快照后只改 home/resources 再安全回收。不得为加速擅自缩窄实际业务保护范围。

### LIFECYCLE-04：未保活 snapshot 回合结束销毁（P0 连续性风险）

**调用链已确认**：V1 onIdle 按 snapshot 排除销毁，V2 settled 的 ensuring 无此条件；V2 provider destroy 又会解析根会话（`2114–2127`）。根会话默认自动保活可掩盖该路径，不代表关闭保活/释放保活场景安全。

**待复现影响**：完整快照只保存文件，不保存运行中的开发服务/PTY/内存；每轮销毁导致这些进程停止、下一轮重建。若 task 子会话结束且根未保活，也需验证是否进入根沙箱销毁路径，与仍活动的父/兄弟任务竞争。

**复现/验收**：CA-PERSIST-02/08/12/15；同一 snapshot 会话关闭自动保活，启动开发服务器，结束回合，再发下一轮，核对沙箱代际、PID/启动时间、HTTP连续性。

### LIFECYCLE-05：活跃保护并未统一覆盖默认 code-mode（P0 静态风险）

**源码已确认的范围**：

- 普通 provider.run 有命令心跳（`provider.ts:2322–2335`）。
- `provider.activity` 会启动 scoped 5秒心跳（`2117–2120`）；实际调用点在 `session/tool-sandbox.ts:240,270`，保护会话自定义工具取得/加载期间。
- 默认沙箱 code-mode 经 `tool.ts:260–303` → `codemode/runner.ts:31–58,119–157`：启动 daemon 的 provider.run 结束后，execute 走 WebSocket；该通道没有同等 provider.activity 调用。
- code-mode 内部若调用 shell/custom session tool，会获得这些通道各自的保护；不能因此证明纯 JS/网络等待/模型等待期间始终有心跳。
- idle 扫描只按 sandbox time_updated（`provider.ts:1877–1893`），不直接按实际 Agent/执行 claim 判 busy；keepAlive 也不排除 idle reap。

**待复现影响**：执行时长越过 idle 阈值且没有其他刷新活动，可能被回收。普通长 shell 通过不能替代此项。

**复现/验收**：CA-PERSIST-03/10/13/22，专用环境短 idle，真实 execute 做不调用 shell 的受控长等待，核对持续活动记录、回收和结果终态。

### LIFECYCLE-06：安全销毁与活动子任务/后台写入缺少全面证明（P0 静态风险）

`provider.ts:764–790` destroy 会关闭物理 gate，并中断本实例记录的 activeCommands；它不是一个跨副本、覆盖全部进程的“等待所有业务任务安全结束”屏障。`session/tool-gate.ts:45–58,78–97` 有 admission/epoch，但不能据其存在推导全部内置工具、后台进程、WebSocket都受保护。

`session.ts:457–502` root 删除先处理 root，再中断子会话；快照期间后台写入也可能完全不更新 time_updated。销毁前更新时间相等只能证明该指标没变，不能证明文件系统没变或没有未完成任务。

**复现/验收**：CA-PERSIST-08/11/13/24/26；覆盖父子并发、背景事务写、跨实例 kill/boot；明确用户显式终止与后台安全回收的不同契约。不要将显式 kill 需要取消进程本身一概认定为实现错误。

### LIFECYCLE-07：启用 prune 会主动改变业务沙箱（条件风险）

V2 `snapshot-reuse.ts:27,173–179`，当 `config.snapshot.prune` 开启时执行缓存目录删除；调用包括正常保存 `provider.ts:916` 与显式保存 `2155`。V1 `tool/sandbox-provider.ts:1934,2028,3207` 也有 prune，属于继承行为。

这不是后台压缩副本，而是修改源沙箱。当前测试是否启用应记录有效配置，不能无条件声称本次环境存在删除。覆盖 CA-PERSIST-06/10/11/12：构建/服务使用缓存时保存，校验不破坏执行；保护要求不允许“为了更快保存直接删业务依赖的数据”。

### LIFECYCLE-08：destroy 返回不等于已销毁（接口状态风险）

V2 `provider.ts:1304–1317` 等待有上限；恢复 running（保存失败保留源）或达到 deadline 都可正常返回。`session.ts:472–485` 在 root 删除时随后清快照、继续删会话，错误又可仅记录警告。

**待复现影响**：调用方把 void 返回视为已安全销毁/资源已清理，继续删除元数据，可能产生仍存活源或操作/恢复点失去关联。需追踪实际 PG 外键级联和平台结果，不能仅据这段代码断言已经数据丢失。

**复现/验收**：CA-PERSIST-18/21/26，保存失败或超过预算后 DELETE，会话、快照、队列和远端实例一起对账。需明确 blocked/retained/pending 与 destroyed 的API语义。

## 本次验证结果

- 重跑 `packages/core/test/sandbox*.test.ts` 加 `session-execution.test.ts`、`session-run-coordinator.test.ts`：**22个测试文件，319 pass，0 fail，868 expect**，18.29秒。按测试环境连接本地 PG `opencode-v2-up`。
- 测试日志：`/private/var/folders/zk/8qd0lv657wn8kvpp__hwjj400000gn/T/opencode/lifecycle-v1-v2-audit-tests-2026-10-04.log`，为本机证据，未纳入仓库。
- 实际函数调用确认 LIFECYCLE-02 提前降级；其余本次未新增真实 AI/code-mode 或平台故障 E2E。
- **319项通过是现有契约回归，不是上述风险的否定证据**。尤其存在降级行为测试时，通过可能意味着风险行为被当前测试接受。

## 建议顺序（尚未实施）

1. 先为 LIFECYCLE-01/03/04 编写能失败的专项回归，再讨论修复：保留 dirty 源、统一 CLEAN 保护范围、恢复 snapshot 回合结束保留原则。
2. 为全部执行通道明确根会话活动租约与销毁屏障；覆盖默认 code-mode、task 子会话和跨副本，不以单进程 Map 代替 PG协调。
3. 明确 release/kill/DELETE 的安全保护与用户显式取消语义，返回/记录真实 pending/retained/destroyed 状态。
4. 按 [双模式共同验收](./persistence-code-agent-execution.md) 执行真实接口、模型、过程、PG与平台对账；先确认 PTY能力范围和性能预算。

用户当前请求是核对实现，本次仅新增核对报告；未修复、未提交、未推送。不得将建议表述为已经完成的保护。

## 二次核对：核心遗漏、策略变化与默认路径

### 用户明确的生命周期契约

- 主会话默认 `keepAlive=true`，创建成功后立即发起后台 boot；API返回不表示远端已 Ready。
- 子任务完成只收尾自身执行状态，**不参与沙箱保活、释放、检查点决策或销毁**；物理沙箱由主会话统一管理。执行期间的活动保护仍需要覆盖子任务，不等于子任务负责生命周期。
- 最终快照创建失败、Failed 或等待 Ready 超时，不能因为已有旧恢复点而销毁 dirty 源。重试耗尽也应保留源并暴露失败。

V1 主会话默认自动保活见 `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:173–193`；V2 对应 `packages/core/src/session.ts:340–356`。两者都先保活再后台创建。此前未保活 snapshot 的差异是条件路径，不应写成默认每轮销毁。

### 核心对照结论（本次新增源码核对）

| 项目 | 分类 | 默认保活能否规避 | 结论 |
|---|---|---|---|
| 最终保存失败仍接受旧恢复点并销毁 | V2 对 V1 安全原则的回退 | 不能；idle/显式销毁仍可进入 | 必须恢复“失败保留源”的原则 |
| 缓存复用前验证 PG 代际及 running 状态 | V1 有、V2 未完整保留 | 不能 | 不能只凭旧SDK连接健康就继续操作 |
| 远端创建成功、PG落库失败时回滚远端资源 | V1 有、V2异常分支未完整保留 | 不能 | 成功创建后持久化失败需补偿/可对账，不允许失去所有权 |
| release只取消保活 | V2 改变 V1 行为 | 显式 release 时不能 | 当前会立即进入销毁，应明确恢复旧语义还是变更API契约 |
| 子任务完成完全不操作物理生命周期 | V2 缺少明确父子边界 | 默认通常避免销毁，但仍调用生命周期查询 | 应在子任务收尾处排除沙箱生命周期处理，不能依赖根的 keepAlive 值 |
| snapshot 回合结束保留沙箱 | V1 有、V2条件丢失 | 正常自动保活时可以 | 保留为关闭/释放保活后的连续性回归，不当作默认故障 |
| 默认沙箱 code-mode 全执行期间活动租约 | V2新增执行通道的保护缺口 | 不能；保活仍参加 idle 扫描 | 不是 V1 同名 code-mode 功能遗漏，但必须补统一活动保护 |
| CLEAN完整保护范围 | V1/V2共同缺口 | 不能 | 修复范围判断，不能称为 V2 单独迁移回退 |
| 选定 snapshotId 创建派生/恢复沙箱 | V1能力在V2未暴露 | 不相关 | 最新自动恢复存在；指定恢复源功能需单独确认产品范围 |
| marker恢复探针 | V1观测项在V2未保留 | 不相关 | 可观测性减少，不等于证明 V2 恢复数据错误 |
| 独立非保活 zombie 回收循环 | V2没有一一对应循环 | 正常 idle 扫描可覆盖部分 | 属于机制合并/配置边界，不直接判默认回收缺失 |

### LIFECYCLE-09：缓存身份与活动写入缺少完整代际约束（P0 静态风险）

V1 `tool/sandbox-provider.ts:2199–2205`，缓存复用必须先经 `dbTouchSandbox(sessionID, cached.id)` 成功；该更新在 `1376–1388` 同时限定 session、sandbox ID 和 state=running。缓存失配就丢弃，重连路径在 `2251–2254` 同样核对。

V2 `provider.ts:1624–1626` 虽读取 PG admission，但只拒绝 snapshotting/killed；`1654–1657` 缓存健康就返回，没有比较缓存ID与PG当前ID。`touchSandbox:730–735` 仅按session更新，不限制ID或state；`commandSession:1790–1795` 写command_session_id也仅按session。`resolveExisting:1713–1720` 缓存分支甚至不先查PG当前代际。

**风险场景**：A实例缓存旧沙箱S1，B实例已推进其状态或持久化S2，而S1仍可健康连接。A可能操作S1、刷新S2的活动时间，或把S1的命令会话写到S2行。新执行 admission gate 在会话自定义工具中存在，不能外推为全部 provider.run/文件/preview 已有相同防护。

**验证边界**：已确认条件/更新语句差异，未跨实例实际复现；正常单实例创建成功不能否定这条风险。

**专项用例**：专用双实例共享PG，各缓存同一会话；推进代际后让旧实例执行shell、文件读取及preview。断言旧缓存失效，命令ID/活动更新限定实际代际，旧请求不写新代际。对应 CA-PERSIST-04/24。

### LIFECYCLE-10：创建成功后落库异常的补偿分支不完整（P1 资源与恢复可靠性）

V1 `tool/sandbox-provider.ts:1725–1742`，dbUpsert失败会kill/close已创建实例，然后传播失败。

V2 `provider.ts:1594–1617`，远端create成功后调用 `createLease.complete`；返回false时已有kill/close重复实例分支，但complete本身抛出数据库错误时没有同等补偿。创建单飞最终清理Deferred（`1684–1699`）并不等于清理远端实例。

**风险场景**：远端创建已成功，PG写入报错，业务尚未取得实例，后续sweep/重试可能再建一个，旧资源未被确认接管或回收。数据库提交结果未知时应先按owner/实例ID对账，不能盲kill已被有效接管的实例。

**专项用例**：专用环境在远端成功后注入complete的确定失败及提交结果未知；核对平台资源、PG owner与实际使用代际，不泄漏、不误杀有效实例。对应 CA-PERSIST-20/21/24。

### LIFECYCLE-11：release从标志更新变成实际销毁（行为回退）

V1 `tool/sandbox-provider.ts:2498–2502` 只写keep_alive=false；HTTP调用见 `server/sandbox-proxy.ts:861–887`。V2 `provider.ts:1322–1326` 写false后调用destroyViaQueue；HTTP入口 `packages/server/src/handlers/session.ts:681–684`。

因此 `keep-alive enabled=false` 在V2可能立即停止命令/后台服务，snapshot还会等待保存，而V1只是允许后续正常生命周期回收。这个行为变化已在源码确认，不需把它误解为默认创建时没有保活。

**专项用例**：主会话运行开发服务器时关闭保活，检查接口耗时、实例代际、PID与是否立即终止；依据确定后的契约判定，不能无声扩大“取消保活”的含义。对应 CA-PERSIST-12/13。

### LIFECYCLE-12：子任务收尾必须与根物理生命周期分离

V2 `session/execution.ts:91–103,136–164` 对所有settled执行destroyUnkeptSandbox，读取session后没有parentID排除。provider.isKeepAlive/destroy在 `2116–2127` 都映射根，因此子任务完成仍会查询主沙箱保活，根未保活时可进入主沙箱销毁。

**默认状态**：根自动保活通常令实际destroy不发生；这只能说明默认值遮住分支，不能满足“子任务不关心沙箱生命周期”的契约。

回合检查点订阅 `provider.ts:1237–1256` 用事件sessionID直接找sandbox行，当前子会话通常没有自己的物理行而跳过。应把生命周期触发边界显式定在root，不能依靠“查不到子会话sandbox行”偶然避免副作用。子任务的文件修改由主会话统一保存，活动保护覆盖整个共享沙箱。

V1 `session/run-state.ts:69–87` 也没有显式parentID排除；其snapshot排除条件和Provider归属策略与V2不同。因此**独立的子任务生命周期边界属于用户此次明确的验收要求，不应声称 V1 在所有模式已经保证**。

**专项用例**：主/两个子任务共享实例，覆盖根保活true/false及snapshot/PVC；子任务完成、失败、中断都不调用物理keepAlive/release/destroy，不生成子任务驱动的保存请求，也不终止父/兄弟进程。主会话按自己的保护流程完成保存。对应 CA-PERSIST-08/15/24。

### 其他能力差异与不能直接判错的地方

1. **指定恢复源**：V1 `tool/sandbox-provider.ts:1554–1570,1744–1747` 支持显式snapshotId并保留源所有权；V2 `packages/schema/src/session-sandbox-resource.ts:6–22` 没有snapshotId，`snapshot.ts:146–151` 只自动选session最新恢复点。若需要选历史检查点或派生新会话，当前这项能力缺失；不建议恢复旧的PVC/快照混挂语义。
2. **恢复marker抽查**：V1 `tool/sandbox-provider.ts:1684–1711` 探针并持久记录markerPresent，原来也是观测不阻断；V2 `provider.ts:1458–1512` 没有同等探针。补回来可增加可信诊断，但marker存在不等于全文件完整性校验。
3. **恢复失败拒绝cold start**：V1 `tool/sandbox-provider.ts:1633–1657` 失败会降级镜像冷启动；V2 `provider.ts:1472–1486` 拒绝这样做，这是符合当前数据保护要求的改进，**不能为追求V1等价改回去**。同理schema不兼容时V2阻止恢复比V1冷启动更保守。
4. **后台refresh策略**：V1 `tool/sandbox-provider.ts:1866–1892` 空闲CAS并短暂snapshotting fence；V2 `provider.ts:1114–1196` running期间也可按年龄检查内容。V2减少前台被fence阻塞的机会，但并发写一致性需要专项验证，不能机械恢复长时间阻塞策略，也不能声称任意多文件事务已经一致。
5. **创建lease心跳**：`create-lease.ts:135–141` 有heartbeat，但provider没有调用。单次create的预算小于创建租约（`provider.ts:1521,1447–1454`），所以不能仅凭未调用就判正常create会租约过期；仍需验证初始化超时、PG慢响应及恢复接管。
6. **idle/zombie**：V1有独立非保活zombie循环（`tool/sandbox-provider.ts:2810–2890`）；V2主要通过idle扫描与创建lease sweep接管（`provider.ts:1861–1978`）。关闭idle且关闭snapshot时该扫描不启动，需明确是否希望仍运行资源对账；不能把关闭配置后的行为泛化成默认缺失。
7. **kill结果可信度**：V2 handler `packages/server/src/handlers/session.ts:714–718` 用sandboxId有无判断destroyed，provider.sandboxId只暴露running（`provider.ts:1329–1332`）。snapshotting行未物理销毁也可能返回null，因此等待超时后可能误报destroyed=true。这是额外状态语义风险，需接口/PG/平台对账复现，不能只看HTTP200。

### 本轮范围和建议

本轮新增的是源码深对比，没有修改实现、运行平台故障或新增PASS结论。前述319项是上一轮同基线的现有回归结果；其中 `packages/core/test/sandbox-create-retry-drift.test.ts:32–45` 仍把已有恢复点的降级作为成功行为测试，不满足用户现已明确的“失败不销毁”契约。

按优先级应先沉淀失败用例：失败保留源 → 子任务结束不参与生命周期 → cache/更新代际约束 → release行为 → 创建落库补偿 → code-mode活动租约。确定性回归与真实API/PG/平台故障验收都需要，修复后分别重跑。保留现有用户改动，不对AGENTS.md或已删除的辅助脚本做恢复/覆盖。
