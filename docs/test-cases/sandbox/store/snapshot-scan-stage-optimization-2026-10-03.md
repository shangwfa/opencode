# 分阶段计时与单遍 manifest 扫描（2026-10-03）

## 提交与范围

- 前一轮轮询优化、确定性测试、Docker/API/PG 对照和历史结论更正已提交为 `8f10b59729`，未推送。
- 本轮新增阶段计时与单遍扫描，纳入2026-10-04补提交；不改平台镜像生成、Registry 上传或销毁降级策略，不改依赖包。

## 阶段计时

日志采用现有 Effect logger，消息为 `snapshot stage`，只记录关联 ID、阶段、毫秒和 effect outcome，不记录源码、命令或认证信息。

- provider：connect、content_check、lifetime、manifest、settle、destroy，携带 sessionID/sandboxID/operationID/kind。
- snapshot：session_lock、create_request，携带 sessionID/sandboxID。
- 临时命令：command_create、command_run、command_delete，携带 sandboxID/phase。
- settle 是等待 Ready 并执行原有后处理的整体耗时，不是纯平台 commit。
- session_lock 是获取会话行锁的语句耗时，不是完整锁持有时间；现有事务边界保持不变。
- command 阶段嵌套于 content_check/manifest，不能重复相加。
- outcome=success 仅表示 effect/Promise 正常返回，不代表工作区一定 CLEAN 或快照一定 Ready。超时返回值仍按原流程解释。
- 失败和中断也计时，保留原值、typed error、defect 和 interruption；临时命令仍使用原 Promise finally 删除，不为计时改动取消/清理时序。

当前服务写入 `/home/opencode/.local/share/opencode/log/opencode-local.log`；默认不打印到 Docker stderr，因此之前仅检查 docker logs 不能证明没有相关日志。

## 单遍 manifest

此前用两个 find 分别遍历文件/symlink 元数据和普通文件 SHA-256。现在一个 find 分支输出元数据，并用 `-exec sha256sum {} +` 批量计算普通文件哈希，最终排序格式不变。

- 不缓存或跳过 SHA-256，不以 mtime/size 判 CLEAN。
- 文件和 symlink 的 mode/size/path/target 字段保留，目录排除范围不变。
- GNU find 的 batched -exec 失败会影响最终退出码；外层保留 bash pipefail，未知/超时继续走 DIRTY。
- 新旧清单必须逐字节相等，支持复用既有 manifest；没有增加 schema 或改变 token 语义。
- 单遍不是原子写入屏障，仍不能声称任意后台写入下的应用级一致性。

## 测试与实测方法

- 20 个沙箱测试文件：258 pass，0 fail，含本地 PG；typecheck 通过。
- 2026-10-04提交前再次运行：20个文件258 pass、0 fail、635 expect；PG为127.0.0.1:5432/opencode-v2-up。typecheck再次通过；本轮代码与已验收运行镜像保持原改动范围，没有额外功能修改。
- 计时单测覆盖成功、typed error、中断及 effect 复用；扫描命令单测确认单个遍历、batched hash、timeout 和 pipefail。
- 在 Docker 重建 SaaS 后通过 API 执行三轮标准场景，保持有效 wait=900。
- 第一轮增加真实 GNU find 契约测试：普通文件、带空格路径、空目录、硬链接、正常与悬空 symlink，新旧清单 cmp；同大小覆盖并回填 mtime 后仍 DIRTY；不存在的工作区导致生成失败。
- 在同一个安装 Next.js 依赖的沙箱内，以 OLD1→NEW1、NEW2→OLD2、OLD3→NEW3 的交错顺序比较三对扫描并 cmp。
- 数据文件与比较清单在工作区外，不计入待扫描内容；比较后只清理本轮明确创建的契约 fixture。
- 此 shell/API 验证不是 AI/code-mode 验收；生产高并发和平台 Job 事件尚未取得。

## 验收结果

时间：2026-10-03 07:26:21–07:37:15 UTC。三轮 21 个检查点全部通过、全部操作 attempts=1；18 次新建 Ready、3 次 CLEAN 没有新增快照。23 条 shell 命令 exit=0（包含两条扫描专用校验），恢复哈希及真实 Next.js 构建验证通过。三个会话经 SaaS API 清理。

### manifest 同沙箱交错对照

工作区约 344MB、约 2 万普通文件；清单保存在 `/tmp`，没有扫描过程修改工作区内容。

| 配对 | 执行顺序 | 旧扫描 | 新扫描 | 旧减新 |
|---|---|---:|---:|---:|
| 1 | OLD→NEW | 626ms | 625ms | 1ms |
| 2 | NEW→OLD | 627ms | 614ms | 13ms |
| 3 | OLD→NEW | 847ms | 607ms | 240ms |
| 中位数 | | 627ms | 614ms | 13ms |

所有新旧 cmp 均通过；契约测试输出 `MANIFEST_CONTRACT_PASS`。不存在工作区的生成命令确实失败，这个预期错误会出现在测试输出中，不是漏掉了失败断言。

**没有足够证据证明单遍扫描显著加速。** 中位数只差 13ms，第三对旧扫描较慢但不能归因于遍历次数；仅一沙箱三对暖缓存样本，不能推广到冷缓存或高并发。可以确认减少了一次目录遍历并保持输出兼容，不能将端到端变化归为扫描收益。

### 阶段实测

读取真实 SaaS 文件日志并按本轮 session/sandbox ID 过滤，获得 258 条 `snapshot stage` 记录。嵌套阶段不重复相加，下面主要列顶层阶段。

| 阶段 | 样本数 | 中位数 | 范围 |
|---|---:|---:|---:|
| connect | 21 | 124ms | 108–147ms |
| content_check（包括快速 DIRTY 和 CLEAN 扫描） | 18 | 133.5ms | 115–2916ms |
| lifetime | 18 | 38.5ms | 32–47ms |
| session_lock | 18 | 3ms | 2–10ms |
| manifest（含命令会话、扫描、du 等） | 18 | 947.5ms | 126–2663ms |
| create_request | 18 | 45.5ms | 40–58ms |
| settle（平台等待与原有后处理） | 18 | 14856.5ms | 10699–40286ms |
| destroy | 21 | 237ms | 172–458ms |

与场景关联后：

| 场景 | content_check 中位数 | manifest 中位数 | settle 中位数 |
|---|---:|---:|---:|
| 两文件基线 | 不需要 | 159ms | 12711ms |
| 依赖安装后 | 142ms | 793ms | 28573ms |
| 恢复后小改 | 128ms | 1100ms | 14810ms |
| 构建后 | 155ms | 2630ms | 18075ms |
| 无变化 CLEAN | 976ms | 不需要 | 不需要 |

manifest 内部 command_create、command_delete 的中位数分别 43/44.5ms；content_check 对应约 40/42.5ms。命令往返确有成本，但当前样本不是秒级主要瓶颈。CLEAN 三条 content_check 范围 947–2916ms，扫描仍有冷热或运行条件相关波动，原因未被进一步证明。

### 端到端数据（非扫描因果收益）

| 场景 | 样本数 | 范围 | 中位数 |
|---|---:|---:|---:|
| 基线 | 3 | 12.68–14.71s | 14.69s |
| 依赖安装后 | 3 | 30.55–46.30s | 30.73s |
| 小改 | 9 | 14.66–19.95s | 18.88s |
| 构建后 | 3 | 18.77–24.26s | 24.07s |
| CLEAN | 3 | 3.03–5.09s | 3.04s |

本轮仍不能声称已解决平台 150 秒长尾。settle 是混合阶段，只有平台的 Job 事件、diff/压缩/上传阶段时间才足以定位真正的创建成本。

## 后续决策

1. 保留输出兼容的单遍扫描和可观测性，但不宣称显著性能收益。
2. 不继续盲目合并命令会话或跳过 hash：本轮往返中位数只有几十毫秒，哈希仍是保守数据校验的一部分。
3. 下一主要方向是取得远端 committer Job 的启动、镜像拉取、diff、压缩、上传时间，判断预拉 committer 镜像、资源配额或 Registry 网络是否能降低 settle 和长尾。未取得这些日志前不猜测原因，也不直接改平台配置。
4. mtime 噪声引发不必要快照、活跃沙箱重复累计依赖层等尚未按行为用例复现，不在本轮中直接修改。

## 原始证据

- API/PG/恢复完整记录：`evidence/snapshot-latency-scan-stage.json`。
- 测试日志：`evidence/snapshot-latency-scan-stage.log`。
- 容器镜像与源文件哈希：`evidence/snapshot-latency-scan-stage-environment.json`。
- 本轮过滤后的阶段日志：`evidence/snapshot-latency-scan-stage-timings.log`。
- 阶段日志结构化记录：`evidence/snapshot-latency-scan-stage-timings.json`。
- 单测与 typecheck：`evidence/snapshot-scan-stage-tests.log`、`evidence/snapshot-scan-stage-typecheck.log`。
- 提交前重跑：`evidence/snapshot-scan-stage-final-tests-2026-10-04.log`、`evidence/snapshot-scan-stage-final-typecheck-2026-10-04.log`。

当前运行镜像 `opencode-saas-sandbox-test:snapshot-scan-stage`，image ID `sha256:6148ff5c41a20a4a1c005494ff30dee4a8f48fa65c0dc6603e06060bc87051dd`。只在上一轮镜像上复制四个本轮业务模块，未重新安装依赖。之前镜像容器保留为 `opencode-saas-test-poll-optimized-backup-20261003`。

最初 typecheck 检出 nullable sandbox ID 与 Logger.message 为 unknown 的类型问题，分别做可空规范化和准确的 unknown 收集类型后，全套测试与 typecheck 重跑通过。
