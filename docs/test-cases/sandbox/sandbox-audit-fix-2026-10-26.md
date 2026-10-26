# 沙箱审查问题修复（2026-10-26）

## 改动

- Vercel：自动回收携带扫描候选的 generation/state/time_updated，PG claim 同时校验候选和当前读取值。过期扫描不能停止新 generation 或已重新活跃的实例；手动停止也比较读取后的活动水位。
- 阿里云命令：SDK `commands.list()` 确认命令已不在运行列表后，才清除该 generation 的孤儿台账。仍在运行或列表请求失败时保留记录并拒绝快照。显式 interrupt 成功（含 SDK 确认 PID 不存在）后清除对应记录。
- 阿里云实例消失：仅明确的 `SandboxNotFoundError` 才按 generation/state/time_updated CAS 收敛 PG 并关闭旧 gate、清理旧命令。存在 ready 快照时，下一次 boot 从快照恢复；无可靠快照时持久化 `lost:` 标记，拒绝空工作区，但允许显式删除。网络超时不会触发该路径，也不恢复暂停实例。
- 阿里云快照恢复：`command_session_id` 持久化 `capture:<owner>:<intent>` 或 `stop:<owner>:<intent>`，后台恢复严格沿用原操作，capture-only 不调用 kill。旧格式兼容原 stop 恢复行为。
- 提交完整性：三个遗漏迁移随修复补入版本控制；提交前核对迁移注册表的 80 个导入在索引均存在。同时补齐上次遗漏的沙箱测试及路径更新、PG 引导锁、Vercel 测试依赖的探针脚本和 Dockerfile 引用的 runner 构建脚本；已核对本次暂存 TypeScript 文件的内部导入及 Docker 构建脚本无缺失。不重写旧提交，没有改 schema，不产生新迁移。

## 先复现后修复

新增阿里云定向用例在旧实现上运行，结果 2 pass / 4 fail：capture-only 恢复、可恢复的实例消失、无恢复点删除、孤儿记录回收失败；两个保守拒绝分支原本就通过。证据：`artifacts/sandbox-audit-fix-20261026/sandbox-audit-before.log`。

Vercel 新增三项 PG 确定性用例：扫描后活动水位变化、扫描后 generation 替换、未变化候选可 claim。前两项断言状态保留 running 且无远端 stop。

## 真实 Docker / 阿里云 API / SSE / PG

执行器：`docs/test-cases/scripts/sandbox-audit-recovery.mjs`。

- SaaS 容器 `opencode-sandbox-audit-fix`，端口 15140；基于 `opencode-saas:sandbox-audit-fix-20261026` 并覆盖最终 provider 源码重启验证。
- 独立数据库 `opencode-v2-sandbox-audit-lifecycle-test`，阿里云二代模板 `base-5wa5`。
- 全程订阅公共会话 SSE，原始事件保存于 result.json；shell 命令和消息输出通过真实 API 验证。
- capture-only 崩溃通过 PG 注入“已确认快照、尚未完成操作”模拟；不是声称注入了云端响应丢包。源实例 generation 不变且仍能读文件。
- 原生 SDK 删除实例模拟 TTL/云端丢失，再经 shell API 自动从快照恢复；核对旧文件标记与新 generation。
- PG 注入不存在的 PID 模拟孤儿台账，远端命令列表对账后拍快照成功且台账清零。
- 无快照实例消失后，shell 消息明确报告拒绝空工作区、PG generation 不变且持久化 lost 标记，DELETE 会话成功。

最终 **4/4 通过**：`artifacts/sandbox-audit-fix-20261026/retest/result.json`。首跑前三项通过，第四项执行器误要求 shell 失败返回非 2xx；实际接口返回 204，并在 shell 消息和 SSE 中记录错误。修正契约断言后重跑，首跑证据保留。

## 清理与边界

- 两轮 API 测试会话、命令、快照 PG 记录均清零；按四个测试会话 metadata 查询原生 Sandbox.list，活动实例均为空，见 `cloud-cleanup.json`。测试容器已停止。
- 单测最终回归 **75 pass / 0 fail（5 文件）**：aliyun-provider、vercel-provider、aliyun-client、session-tool-gate、sandbox-create-lease，见 `artifacts/sandbox-audit-fix-20261026/sandbox-audit-final-tests.log`。typecheck、oxlint 和 migration check 通过。
- 本轮没有模型轮次，sandbox Code Mode executor 保持开启配置，但不将 shell API 用例称为 Code Mode 执行验证。
- 后续已按要求补齐 Vercel 真实云端双 Pod 并发 E2E 与模型 Code Mode：F 阶段 4 项、回收/端口竞争 4 项全部通过，见 `vercel-audit-e2e-2026-10-26.md`。本段前述“本轮没有模型轮次”仅指最初阿里云生命周期执行器，不包含该后续补验。没有扩展至 OpenSandbox 的其余未审完路径或快照长期保留策略。
