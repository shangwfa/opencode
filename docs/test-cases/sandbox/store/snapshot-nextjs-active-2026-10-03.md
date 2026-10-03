# Next.js 活跃沙箱连续检查点验收（2026-10-03）

## 场景与判定

本轮模拟真实文件开发活动，经 Docker SaaS HTTP API 执行，沙箱 CPU=2、memory=4Gi、persistMode=snapshot，wait=900。不是 AI/code-mode 验收，也不包含并发写入一致性证明。

每轮独立创建专用会话：

1. 安装 Next.js 16.3.8、React/react-dom 19.3.0，创建可构建的 App Router 项目，显式拍快照。
2. 不销毁沙箱，连续修改页面三次，每次显式拍快照。
3. 执行真实 `pnpm build`，验证 `.next/BUILD_ID`，显式拍快照。
4. 销毁后恢复，校验全工作区文件 SHA-256、依赖、构建产物和页面内容，核对平台 snapshotId 是构建快照。
5. 在恢复的新沙箱内再连续修改三次，每次拍快照。
6. 再销毁恢复，校验最新工作区与页面，重新构建；核对平台 snapshotId 是最后一次小改快照。
7. 经 API 删除本轮会话，查询 PG 确认会话已清理。

计划三轮，每轮8次快照，总24次。每次修改前验证上一份工作区 hash 清单，每次拍照后验证 PG `session_snapshot.state=ready` 与 `source_sandbox_id`；活跃阶段代际必须保持一致，恢复阶段必须切换代际。记录端到端及提交请求时间、平台实际启动镜像和恢复来源。

## 测试脚本修正

最初脚本错误地要求显式快照产生 snapshot_refresh 队列操作，并假设无变化显式快照会复用。核对 `packages/core/src/sandbox/provider.ts:2129–2177` 后确认，POST `/api/session/:id/snapshot` 直接启动快照并后台等待完成：不走 snapshot_operation 队列，且显式调用从不复用。

因此主动停止错误脚本，只通过 API 清理它创建的会话 `ses_efeeeddc2ffecEJ38LOmomS921`，修正断言后从新会话完整重跑；不将错误轮计入有效样本。本轮无变化只作恢复前 hash 校验，不额外调用显式快照并伪称 CLEAN 优化。

## 结论边界

- 这是“同一活跃沙箱连续快照”和“恢复后的连续快照”对照，与此前每次拍完销毁的实验不同。
- 前后工作区规模不完全相同：恢复阶段已有构建产物，不能直接将耗时差异都归因于层增量。
- 三轮只能给出该环境样本，不能排除平台缓存、内部重试或长尾。
- 显式快照不经队列，不能用 snapshot_operation.attempts 来声称 attempts=1；必须分别说明没有 SaaS 队列重试和平台内部重试未知。
- 没有 Registry 只读权限，本轮无法读取 OCI 层 digest/size 或末层文件，不把时间差当作层内容证据。
- 源码仍表明：当前 committer 以启动镜像为基础追加当前可写层 diff，而非自动以活跃沙箱上一检查点为基础。

## 结果

首轮修正后在安装阶段触发原120秒命令超时，没有产生有效快照样本。随后读取安装日志，pnpm 10.34.6最终报告安装完成，耗时132.1秒，node_modules约336772KiB。这同时暴露命令超时后远端安装仍继续执行的行为，不将它伪称安装失败或快照慢。命令预算改为600秒，快照wait仍900秒，清理原测试会话后重新执行。

用户强调snapshot与PVC互斥并要求重测，因此停止前一正在执行的测试，清理它创建的专用会话 `ses_efee98c69ffeu8qAXRNr649BMK`，不将其样本混入新轮。最新测试输出为容器 `/tmp/snapshot-nextjs-exclusive.json`，执行日志在宿主批准的临时目录 `snapshot-nextjs-exclusive.log`。

最新三轮增加严格前置校验，首次创建及两次恢复都检查：
- PG会话JSON中 `persistMode=snapshot`。
- `pnpm config get registry` 必须精确为 `https://registry.npmmirror.com/`，同时记录pnpm版本。
- 从远端沙箱实际 `/proc/self/mountinfo` 解析挂载，`/workspace`、`/resources` 和各会话 home/cache/config/local/tmp路径必须属于与 `/` 相同的overlay挂载；检测到独立挂载立即停止。
- SaaS源码 `buildVolumes` 对snapshot返回空列表（`packages/core/src/sandbox/volumes.ts:44–46`），不挂PVC或PVC共享包缓存。本次不改变服务全局PVC配置，只用会话显式覆盖。

严格互斥首轮在挂载校验脚本因嵌入JavaScript换行转义错误而失败，没有快照样本。修复为String.raw并对生成脚本作独立语法检查，清理该测试会话 `ses_efee43bd6ffeNd6T5wCWwQGQHh` 后完整重跑。失败会非零退出并保留本轮资源以排查，不自动销毁失败源沙箱。挂载校验是会话持久化路径级证据，不声称诊断接口提供了完整Pod spec。

### 有效重测结果

2026-10-03 09:34:39–09:54:36 UTC，三轮全部通过：24次显式快照PG Ready、42条命令exit=0、9次前置校验通过。每轮原沙箱连续5次快照保持同一代际，恢复后连续3次快照保持新代际。两次恢复均核对平台snapshotId和完整工作区文件SHA-256；最后一次恢复后重新构建成功。

| 场景 | 三轮耗时（秒） | 中位数（秒） |
|---|---|---:|
| 活跃安装依赖后 | 42.98 / 10.25 / 33.53 | 33.53 |
| 活跃小改1 | 42.96 / 33.57 / 33.54 | 33.57 |
| 活跃小改2 | 41.08 / 33.64 / 33.58 | 33.64 |
| 活跃小改3 | 40.93 / 35.52 / 35.62 | 35.62 |
| 活跃构建后 | 43.03 / 37.62 / 35.77 | 37.62 |
| 恢复后小改1 | 13.98 / 17.82 / 17.93 | 17.82 |
| 恢复后小改2 | 11.99 / 18.01 / 17.98 | 17.98 |
| 恢复后小改3 | 11.96 / 17.86 / 17.90 | 17.86 |

聚合9个活跃小改样本：33.54–42.96秒，中位数35.52秒；9个恢复后小改样本：11.96–18.01秒，中位数17.86秒。耗时定义为显式POST请求开始到PG Ready的约1秒采样观测，包含manifest准备、远端提交和应用等待，不是纯压缩/上传。

结果与源码“差异相对启动镜像”一致：安装依赖后活跃沙箱的小改仍较慢，恢复新沙箱后连续小改更快。但没有OCI层大小、内容、远端Job计时，不把约17.66秒的中位数差全部归因于依赖重打包，也不排除平台缓存或波动。第二轮依赖快照10.25秒的较快样本同样保留，不剔除。

九次模式检查均为snapshot，pnpm版本10.34.6、有效registry为淘宝镜像；所有指定会话持久化路径属于根目录同一overlay挂载。没有混挂PVC或共享PVC包缓存。检查命令会重写同内容`.npmrc`，不改变后续SHA清单内容，但会变更其mtime；恢复阶段的快照不是严格“仅一个源码文件的磁盘变化”。

三会话都经API清理，最终PG复核会话剩余0条，9条snapshot_destroy操作done、attempts=1（包括销毁和删除时产生的操作）。24个显式快照没有队列attempts指标，不把这9条操作的attempts推广到显式快照或平台内部重试。

原始证据：
- `evidence/snapshot-nextjs-exclusive-v2.json`：全部API/PG样本、命令、前置校验和恢复来源。
- `evidence/snapshot-nextjs-exclusive-v2.log`：执行过程。
- `evidence/snapshot-nextjs-exclusive-pg.json`：清理后PG复核。
- `evidence/snapshot-nextjs-exclusive-environment.json`：运行镜像、wait和两个脚本SHA-256。

结论：snapshot模式能在真实Next.js依赖/构建场景保存并恢复文件；同一活跃沙箱连续快照的成本明显高于恢复后的本轮样本。若减少连续检查点成本，应评估平台增量机制；本轮没有自动重启/rebase业务沙箱，也没有改变数据保护策略。

脚本：`docs/test-cases/scripts/snapshot-nextjs-active-e2e.mjs`，共享 shell/SSE 与只读诊断工具在同目录 `snapshot-layer-confirmation-e2e.mjs`。不修改业务服务或依赖包，不提交、不推送。
