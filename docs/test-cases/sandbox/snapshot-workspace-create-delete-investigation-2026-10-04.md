# snapshot 工作目录与 creating 残留排查

## 结论及范围

两个问题应分开处理。

1. creating 残留：受控 API 用例确定性复现了“删除后的 Session 再次获得建箱租约”。当前后台建箱重试缺少删除栅栏。
2. `/workspace` 写入失败：确认故障沙箱可列出目录，但无法创建文件。尚未定位底层文件系统为何返回 ENOENT。不能用一次重跑通过代替根因说明。

初始排查只增加诊断和证据。用户确认后，本次增加创建栅栏和工作目录可写就绪检查。底层文件系统 ENOENT 的原因仍未确定。

## 原始失败证据

证据目录：`store/evidence/skills-contract-snapshot-1791124509862-00699db7/`。

`prompt-5.json` 记录：

- skill 成功加载 V1 布局的资源目录。
- read 成功读取脚本第 2 行。
- node 执行真实脚本，写 `/workspace/skills-contract-00699db7.json` 返回 ENOENT。
- 独立 node 写入和 shell touch 同样失败，排除仅凭脚本输出推断失败。
- `ls -ld /workspace` 和列目录成功。
- node 向 `/root` 和 `/home/sandbox` 写入成功，向 `/workspace` 和 `/tmp/opencode` 写入失败。
- PG 清理后 Session、inbox、skills 为 0。sandbox 有 11 条 destroyed、1 条 creating。

残留记录为 `creating-2dd60fd7-3fe9-4c7e-99ce-3b3a5d18c09f`，所属 Session 为 `ses_ef8a7eb49ffeuAwq7p0eIDx6Zm`。该 Session 不存在。

## creating 残留的复现

执行器：`../scripts/sandbox-create-delete-diagnostic-v2.mjs`。

使用专用 Docker SaaS、独立 PG 和本地故障代理。代理只返回受控创建失败，不创建远端沙箱。

| 步骤                           | 观察                                    |
| ------------------------------ | --------------------------------------- |
| 第一次创建返回 503             | 租约释放到 destroyed                    |
| 在重试间隙调用 DELETE          | 返回 204                                |
| 后台发起第二次创建             | 同一 Session 再次获得 creating 租约     |
| 查询 PG                        | Session 数为 0，sandbox 状态为 creating |
| 释放诊断请求并等待全部重试结束 | 诊断库最终 Session 为 0，租约 destroyed |

证据：`store/evidence/opencode-create-delete-diagnostic-1791125436995-d608c8b7/result.json`。

源码链路：

- `packages/core/src/session.ts` 的 Session 创建使用 `Effect.runForkWith` 启动独立后台 keep-alive/boot。
- `packages/core/src/sandbox/provider.ts` 的 `createSandboxWithLease` 在创建失败后释放租约、延迟、重新 claim。
- `packages/core/src/sandbox/create-lease.ts` 的 claim 允许 destroyed 行重新进入 creating，不检查 Session 是否已关闭或删除。
- Session.remove 会检查当前 sandbox 状态，但 destroyed 间隙允许删除。之后的后台重试仍可重新获得租约。
- sandbox 表的 session_id 没有外键，不会阻止删除后留下租约行。

复现证明此竞态存在。历史失败轮次没有完整 DELETE/claim 时间戳，因此不能声称已还原该条历史记录的全部执行时间线。

建议修复：复用现有 SessionToolGate，阻止关闭或删除后的 Session 重新 claim/complete。检查与租约更新需要共享 PG 栅栏，不能只加非原子的“Session 存在”判断。删除仍须保留 dirty 源与失败恢复点保护。

## `/workspace` 的已知边界

- snapshot 的 `SandboxVolumes.buildVolumes` 返回空卷列表。不能简单归因于 PVC 挂载。
- 创建路径只尝试 `mkdir -p /workspace`，忽略初始化错误，并未验证实际写入能力。
- 故障源已经在测试清理时销毁，原始事件没有保存 mountinfo、文件系统类型和平台节点日志。
- 第 2 轮记录 23 次建箱 POST 504，第 3 轮成功运行也记录 24 次。因此 504 不是充分归因依据。

建议增加工作目录可写就绪检查，并在失败时保存 stat、mountinfo、文件系统类型和平台日志。不能通过重置 workspace 或冷启动丢弃持久数据来恢复。

## 重跑结果

目录对齐后的 PVC：13/13 通过。证据：`store/evidence/skills-contract-pvc-1791124157038-ebd0a77c/`。

snapshot 第 3 轮：13/13 通过，包含实际写入预检、原生 read、真实 shell 输出、随机产物和重建后再次执行。证据：`store/evidence/skills-contract-snapshot-1791124917774-f7beb2d6/`。

两次成功运行的清理检查均无 Session、inbox、skills 残留，sandbox 均为 destroyed。第 2 轮的孤立 creating 记录另行通过现有 GC 清理，见下文。

## 用户确认后的修复与验证

### 创建栅栏

`SessionToolGate.creating` 在现有 PG 栅栏事务内检查 Session 存在、逻辑栅栏 open、物理栅栏不在 closing。claim 和 complete 使用同一事务执行，防止检查与租约变更之间发生删除。已完成物理销毁的会话仍允许按需重建，但已关闭或删除的 Session 不允许。

`booted` 也检查 Session 和逻辑栅栏，不允许晚到的建箱结果重新打开已删除会话。删除失败后的 reopen、dirty 源保护和恢复点保留逻辑不变。

API 回归使用 `PROBE_EXPECT_BLOCKED=true`：

- 修复前失败：DELETE 204 后出现第 2 次建箱请求。证据：`store/evidence/opencode-create-delete-diagnostic-1791126273753-25cef112/`。
- 修复后通过：DELETE 204 后只保留原有 1 次请求，Session 为 0，租约 destroyed。证据：`store/evidence/opencode-create-delete-diagnostic-1791126523220-81661222/`。

### 工作目录就绪

`SandboxWorkspace.ensureWritable` 在租约 complete 和 running 发布之前检查实际写入、读取和删除临时文件。等待预算为 15 秒。仅没有恢复点、没有挂载卷的新沙箱可以初始化 `/workspace`。恢复与挂载的目录不得通过重新创建来掩盖故障。

失败使用现有未提交沙箱的所有权核验和补偿清理。已经归属的物理代际不会被补偿路径删除，快照恢复点不会被重置。就绪失败不自动重建。

真实沙箱 API 故障注入通过：代理拒绝就绪命令，请求失败后未发布 running、未再次建箱、未提交沙箱 DELETE 204；PG Session、inbox、skills 均为 0，唯一租约 destroyed。证据：`store/evidence/skills-contract-snapshot-1791126810610-c96c77ab/`。该注入验证就绪失败处理，不声称复现了原来的底层 ENOENT。

### 旧租约清理

执行器通过 API 创建不自动 boot 的诊断会话，初始化 provider 并等待现有 stale-lease GC。未直接更新 PG，未新建远端沙箱。

第 2 轮的 creating 租约收敛到 destroyed，诊断会话经 DELETE 清理，PG 无 Session 残留。证据：`store/evidence/session-skills-snapshot-1791126974714-9d7a25c7/`。原始失败记录保持不变。

### 验证进度

相关单测 405 项通过、27 项跳过、0 项失败。创建、就绪及补偿相关 PG 专项 47 项通过，包含独立 PG 写入者与创建事务的锁顺序检查。类型检查、lint 和 diff 检查通过。

修复后 PVC 全量 API 13/13 通过，覆盖真实脚本执行、产物检查和沙箱重建后再次执行。Session、inbox、skills 均为 0，15 条 sandbox 均为 destroyed，清理错误为 0。证据：`store/evidence/skills-contract-pvc-1791126974713-d86e7a8a/`。

修复后 snapshot 全量 API 13/13 通过，同样覆盖真实脚本执行、产物检查和沙箱重建后再次执行。Session、inbox、skills 均为 0，15 条 sandbox 均为 destroyed，清理错误为 0；生产源码摘要与当前文件一致。证据：`store/evidence/skills-contract-snapshot-1791127499021-da0e68b0/`。这是修复后的独立复测，不复用此前通过记录；原始失败证据保留。
