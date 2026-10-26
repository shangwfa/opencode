# 沙箱实现审查（2026-10-26）

> 后续修复状态：本报告保留发现时的证据，不作为当前缺陷清单。生命周期四项已修复，真实阿里云 API 补测 4/4 通过；三个遗漏迁移随修复补入版本控制（提交前已验证 80 个迁移导入均可在索引解析），不重写旧提交。详细修复和测试边界见 `docs/test-cases/sandbox/sandbox-audit-fix-2026-10-26.md`。

## 结论与证据边界

当前实现不宜直接视为已完成生产验收。以下发现来自当前工作树的源码调用链审查；提交完整性另外通过 `git show` / `git cat-file -e` 验证。此次没有修改产品代码、启动付费云实例或重新执行 API/E2E。因此，生命周期问题是有明确路径的静态发现，不冒称真实云端复现。

假设部署为共享 PG 的无状态多 Pod，子会话共享根会话沙箱；沙箱可能因 TTL 到期、进程崩溃或云端删除而消失。

## 1. P0：提交缺少被导入的迁移模块

位置：`packages/core/src/database/migration.gen.ts`。

对提交 `2606bdbd23` 的 80 个迁移导入逐项执行 `git cat-file -e HEAD:<path>`，以下三个模块不存在于提交，实际仅存在于未跟踪工作树：

- `packages/core/src/database/migration/20261024062646_vercel_sandbox_binding.ts`
- `packages/core/src/database/migration/20261024093925_vercel_endpoint_token.ts`
- `packages/core/src/database/migration/20261025091743_aliyun_snapshot.ts`

后果：干净检出缺模块，无法按已测工作树正常构建/启动。此外，`database/pg.ts` 的多 Pod 引导锁仍未提交，多项沙箱测试也未提交；此前提交说明不准确。

最小修复：补齐必要模块和对应测试，核对暂存清单，在独立干净检出环境执行构建、空库迁移和双 Pod 首次启动，不再以混合工作树测试结果替代提交验收。

## 2. P1：Vercel 空闲回收丢失扫描候选，可停止重新活跃的沙箱

位置：`packages/core/src/sandbox/vercel/provider.ts:359-369`、`:166-190`。

路径：sweep 扫描到空闲候选 → 另一 Pod 执行工具、更新活动水位，或者停止后重建新 generation → sweep 仅传 `session_id` 调用 destroy → destroy 重读最新行，并对最新 generation 执行停机。running 分支 CAS 不比较扫描时的 `time_updated`，也不知道扫描时的 generation。

后果：旧扫描决定可以作用于重新活跃的实例，甚至替换后的实例；打断用户任务。destroy 内部的 generation 检查只保护它重读之后的变化，无法修补扫描到重读之间的窗口。

最小修复：与阿里云 capture 的 expected 参数保持相同原则，传入候选 id/state/time_updated，并在数据库 claim 时同时比较。手动停机与自动回收可共用执行流程，但不能丢掉自动回收的条件。

回归用例：冻结 sweep 在候选读取后，另一副本 touch 或替换 generation，恢复 sweep，断言无 stop 请求、PG 和 gate 均保持新状态。

## 3. P1：阿里云孤儿命令记录使快照、停机和会话删除长期受阻

位置：`packages/core/src/sandbox/aliyun/provider.ts:275-295`、`:194-199`、`:351-357`；`packages/core/src/session.ts:503-507`。

路径：命令已登记 PG → SaaS Pod 非正常退出，finalizer 未执行；或者 wait 失败且 killCommand 暂时失败，主动保留台账 → 原命令后来完成，但无持有者清理台账。

capture 将任何该 generation 的命令行都视为仍在运行，恢复 running 并拒绝快照/停机。interrupt 即使后来取消成功，也不清理台账；sweep 没有查询命令终态或回收孤儿记录的路径。会话删除先要求 destroy 成功，因此也被阻断。

后果：安全保留台账变成不能自动收敛的永久阻塞，持续占用昂贵资源；不能通过简单删除超时记录修复，否则可能在命令仍写盘时拍快照。

最小修复：补充远端命令终态/取消确认对账；只在确认终态后按 generation 删除台账，再允许 capture。保留无法确认时的拒绝策略和可观测错误。

回归用例：命令登记后模拟 Pod 消失、远端命令随后完成；新副本应能对账并完成快照、停止、删除。另测取消首次失败后再次成功。

## 4. P1：阿里云远端已消失时 PG running 不收敛，已有快照也无法恢复

位置：`packages/core/src/sandbox/aliyun/provider.ts:96-105`、`:202-207`、`:330-343`、`:411-419`。

路径：snapshot 模式已有 ready 恢复点，但当前实例 TTL 到期/被云端删除，PG 仍为 running。boot 的 info NotFound 直接失败，不更新绑定；destroy 走 capture，仍要求源实例 running 才能创建新快照，失败后无法完成 destroyed；purge 又要求先 destroyed。

后果：正常 boot、后台回收和会话删除均无法完成；旧恢复点存在也无法进入恢复分支。此处应区分“源已确认不存在”和“探测暂时失败”，不能把所有异常视为消失，也不能默默回退到空工作区。

最小修复：仅对类型明确的 NotFound 做 generation CAS 收敛，保留快照台账；有可靠恢复点时允许明确的恢复流程，无恢复点则报告数据丢失且提供可控删除路径。不得自动恢复暂停实例来掩盖该问题。

回归用例：info 精确返回 SandboxNotFoundError 与网络超时分别测试；前者能收敛并按恢复策略处理，后者必须保留现场、不杀实例、不创建空工作区。

## 5. P1：阿里云手动快照的失败恢复会变成停机

位置：`packages/core/src/sandbox/aliyun/provider.ts:170-185`、`:203-236`、`:330-335`、`:390-395`。

路径：snapshot API 调用 capture(id, false)，它仅持久化 owner/intent，没有持久化 stop=false → 云端已经产生快照但返回失败，或 Pod 在确认后崩溃，PG 留在 snapshotting → 过期后 sweep 统一调用 destroy → capture(id, true) 找回原快照后执行 api.kill。

后果：用户请求“拍快照并继续使用”，后台恢复却执行停机；运行中服务/后台任务被中断。这与应当保守保留源实例的恢复意图不一致。

最小修复：将操作类型（capture-only / snapshot-and-stop）与 intent 一起持久化，恢复严格沿用原类型，不从 sweep 调用方式推断意图。

回归用例：capture-only 在云端成功后模拟响应丢失/Pod 崩溃，新副本恢复后应写入 ready 并重新开放 gate，断言 kill 调用次数为零；stop 类型仍须保存后 kill。

## 其他观察与未完成范围

- OpenSandbox snapshot operation 已有 PG claim、heartbeat 和 fencing token，safety 模块也明确将临时连接失败与 confirmed-gone 分离。这些是值得其他后端复用的状态协调原则，不代表该后端所有路径无缺陷。
- Vercel 端口 token gate 检查路径前缀后才转发 HTTP/WS，端口注册有预算检查；本次未发现可据以确认的鉴权绕过，不作安全无漏洞承诺。
- 本轮重点覆盖统一路由、三个后端生命周期/命令主链、共享创建租约、部分 OpenSandbox 快照队列与安全辅助、Vercel gate，以及会话删除调用方；尚未逐分支完成约 2780 行 OpenSandbox provider 的全部恢复/GC 路径、preview 重写与文件工具攻击面审计。
- 快照长期保留策略按此前约定不在本轮要求中；未将它作为缺陷重复提出。
- 以上五项应优先补确定性失败用例，再修复并进行 API + SSE + PG 三层验收。历史 119 项通过不能覆盖未包含的崩溃/扫描并发场景。
