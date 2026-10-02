# V2 沙箱快照安全优化验收

## 范围

先落地防丢、创建前仲裁、活跃期检查点和恢复点保留。不包含 baseline/app 快照，不修改依赖包。

## 实现

- `snapshot-safety.ts`：丢租停止执行、保守重连、基于绝对到期时间续租。
- `snapshot.ts`：会话行事务锁先于远端调用；重叠请求复用已完成的同源快照；恢复失败保留检查点；不返回已回滚 ID；不删除已有 ID 的远端对象；保留旧版本和最后恢复点。
- `snapshot-reuse.ts`：manifest 身份绑定、防止失败尝试污染 CLEAN；拓扑元数据、hash、pipefail 和准备完成确认。
- `provider.ts`：不因网络/健康错误销毁代码；不静默恢复成空 workspace；独立周期扫描覆盖活跃会话；扫描合并与游标；销毁前租约、代次及活动检查。
- `tool-gate.ts`：旧沙箱销毁完成不能关闭新沙箱 admission。
- 新增迁移 `20261002145754_snapshot_manifest_token`；所有实例需使用新 schema。混版旧实例不能提供上述保证。

## 平台 TTL 实测

脚本：`docs/test-cases/scripts/sandbox-ttl-contract.mjs`。

首次配置 30s 被平台以 422 拒绝，最小 TTL 为 60s；修正后 4 项断言通过：

1. 返回绝对 `expiresAt`。
2. 执行命令不更新到期时间。
3. `renew(120)` 更新到期时间。
4. 越过原到期时间仍能执行命令。

本用例通过真实 API 创建和清理专用沙箱，不使用其他会话。

## Docker/API E2E

脚本：`docs/test-cases/scripts/sandbox-snapshot-safety-e2e.mjs`。

两个 Docker 实例，端口 14124/14125；基于现有测试镜像，只读挂载当前 `packages/core/src`。PG 使用新建隔离库 `opencode-v2-snapshot-safety-e2e`，经已有 15432 转发连接；OpenSandbox 为本地 8080。未暂停、重建或清理原主实例。

验收同时检查 HTTP 行为、PG 状态与远端容器运行状态：

- 两个已初始化服务实例的并发快照 ID 相同，PG 仅一条快照且有 manifest token。
- 无变化销毁复用；PG destroyed 与远端真实销毁一致；跨实例恢复 v1。
- 模拟失败尝试覆盖 marker/manifest 后，销毁必须新拍快照，恢复 v2，旧恢复点仍保留。
- 不兼容恢复不冷启动、不落库 running 空沙箱；修正后恢复 v2。
- 快进本轮会话检查点年龄，持续执行命令保持活跃：idle-reap=0 时仍创建周期检查点，源沙箱保持 running。
- 临时将本轮快照 ID 指向不存在远端，验证真实 restore-create 失败不冷启动；修正 ID 后恢复 v3。

17 项断言的完整脚本已跑通。年龄快进是调度测试，不是固定 RPO 的长期实测。

曾有两次冷实例并发断言失败：PG 显示第二份创建发生在第一份 Ready 之后。增加服务层重叠请求时间窗口测试，并在 E2E 预初始化两实例后验证真正服务层并发；**不宣称冷实例 HTTP 到达时间的全链路幂等**。

DELETE_ENABLED=false，测试会话成功后删除；备份按删除门控保留。失败会话定位后仅清理明确属于本轮的 ID。

## 单测和校验

- 防丢 helper：无租约不执行、丢租/续租错误中断、正常返回、暂态失败重试、明确缺失、寿命续租。
- PG 创建：六实例只调用一次远端、prepare 只执行一次、源代次不符拒绝、终态重叠请求合并、恢复失败可重试、已登记 ID 不删除、最后恢复点不 GC。
- PG 队列：测试领取限定会话，避免共享库其他残留污染；过期 owner 不得复活租约。
- admission：旧代次完成不能关闭替代沙箱。

最终 Core typecheck、migration check 已通过。相关十一文件回归为 **107 pass / 0 fail，421 expect**，包含 PG 创建/队列/租约、manifest、provider、shell、admission。双实例完整 17 项 E2E 在最终代码上复跑通过；TTL 契约 4 项通过。

## 未完成与保证边界

- 没有跨所有写入路径的原子静默屏障，后台写入仍可能与 manifest/commit 竞争；需要平台冻结/一致性能力验证。
- 尚无用户确认后清空 workspace 的专用恢复 API；当前策略是保留数据并报错。
- 周期检查点及活动续租已实现，任务完成/危险操作检查点触发尚未单独接入。
- 平台不支持远端 fencing 时，已发出的 HTTP 副作用不能靠中断撤销；不能声称完整外部副作用 fencing。
- 当前创建仲裁在 PG 事务内持有会话行锁直到 marker/远端创建返回，可能等待或阻塞该会话的行更新；后续若实测影响吞吐，应改为独立 durable 创建租约，不凭本轮测试宣称无性能成本。
- 未验证平台目录/增量快照能力，不擅自实现；未做前后性能基准，不声明加速倍数。
- E2E 为 shell/文件/生命周期路径，不使用 AI Agent，不作为 code-mode 执行链路的新增验收。

最终隔离库检查：会话 0、running/snapshotting/creating 沙箱 0、pending/running 双队列操作 0。两台本轮 Docker 实例已删除，原主实例未改动；删除门控关闭时保留的快照仍在隔离库/平台，属于保留策略而非零存储残留。
