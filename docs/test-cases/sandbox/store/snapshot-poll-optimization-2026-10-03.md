# 快照 Ready 感知延迟优化（2026-10-03）

## 改动范围

只修改 SaaS `packages/core/src/sandbox/snapshot.ts` 的状态轮询，不修改远端 commit、压缩、Registry 上传、manifest、队列重试次数或销毁保护策略。

- 第一次查询仍立即执行。
- 前 60 秒成功查询到 Creating 后每 1 秒查询，之后每 5 秒。
- 状态查询接口连续失败按 2/4/5 秒退避，成功查询后重置错误计数。
- 每次 sleep 不超过剩余等待预算，避免小 wait 额外 sleep 到 5 秒。
- 使用 Effect Clock 控制等待时间，以 TestClock 做确定性测试；PG 持久化时间戳仍采用现有 Date.now。
- Ready 必须得到 PG 持久化确认；超时仍保持 Creating、Failed 保留远端错误详情，中断不伪造 Ready/Failed。

这是减少“平台 Ready → SaaS 发起下一次查询”的等待，不是改变平台创建算法。首次 60 秒的正常状态查询频率约为此前的 5 倍；长尾或连续接口错误恢复较稀疏查询，仍需在高并发部署观察平台负载。

## 验证

- 全部 19 个 `*sandbox*.test.ts` 文件：252 pass、0 fail，无跳过（注入本地 PG 连接）。
- 新增 `sandbox-snapshot-poll.test.ts`：16 个确定性用例，覆盖快速 Ready、长任务、错误退避与恢复、精确截止、查询越过截止、零等待、预算覆盖、PG 持久化失败/竞争与中断。
- `bun run typecheck` 通过。
- 最初两个用例对 mock row 做精确对象相等，遗漏数据库更新同时带入的 time_updated；改为校验目标字段后重新执行全套，通过。不是忽略测试失败。

## Docker/API 性能对照

基线是已排除 wait=1 污染的三轮测试，不再使用历史 109–121 秒样本。

- before image：`sha256:47856779939bf233a54a20fd7ea4d5366bdb68c1939eda501c0933aecf520c4d`。
- after image：`sha256:c69183bbe912ff9a46e7227ce734cd4def2101c99cb9667620447f0d5ad01ff4`。
- after 基于 before 镜像仅 COPY 修改的 snapshot.ts 构建，不重新安装依赖、不混入工作区其他改动。
- 已核对容器内 snapshot.ts SHA-256 与工作区完全一致：`698720a62ca4dc766b057b3e92bfe6ab4d91b0507dd36dc1589bbdd9606776c8`。
- 有效 wait 保持 900 秒，远端平台、沙箱镜像、CPU/内存和测试脚本不变。
- 测试脚本 SHA-256 均为 `c382bf61954478bee270827e3f155c14a5504a75f0411e2de886faf01b8ef797`。
- 三轮场景均通过 SaaS API 操作；平台 GET 与 PG 只读观测、校验恢复哈希及真实 Next.js build。shell/API 测试不代表 AI/code-mode 验收。
- before 原始记录：`evidence/snapshot-latency-retest.json`；after：`evidence/snapshot-latency-poll-optimized.json`。

不同时间段的前后测试不能消除平台调度/上传噪声；最终应同时比较端到端和每条样本中“端到端减平台记录耗时”的应用侧剩余时间，不将所有前后差值归为轮询收益。

## 性能对照结果

after 时间：2026-10-03 03:47:16–03:57:46 UTC。三轮共 21 个操作全部完成、全部 attempts=1；18 次真实快照均 Ready，3 次 CLEAN 没有新增快照。21 条命令全部 exit=0，恢复哈希和真实 Next.js 构建验证通过。3 个本轮会话经 API 清理。

### 直接相关的完成感知指标

对每个新建快照，用同一脚本时钟计算 `pgReadyObservedMs - remoteReadyObservedMs`：

| 指标 | before（5s 轮询） | after（首 60s 为 1s） |
|---|---:|---:|
| 样本数 | 18 | 18 |
| 观测间隔中位数 | 2.037s | 1.011s |
| 最大观测间隔 | 4.055s | 1.043s |

这是当前样本中约 1 秒的完成感知中位数改善。脚本约每秒采样，因此不是精确内部轮询延迟；同一周期先读 PG 再 GET 平台时会出现少量负值（before 最小 -0.045s、after -0.214s），原始数据保留，不裁零或隐藏。不能根据小样本声明生产 p95/SLA。

### 端到端中位数及平台记录中位数

单位秒，小改聚合 9 个样本，其他场景各 3 个样本。

| 场景 | before 端到端 | after 端到端 | before 平台记录创建→Ready | after 平台记录创建→Ready |
|---|---:|---:|---:|---:|
| 基线两文件 | 16.58 | 14.56 | 12.05 | 12.05 |
| 依赖安装后 | 33.29 | **43.62** | 28.09 | **38.09** |
| 恢复后小改 | 18.69 | 14.65 | 14.04 | 12.12 |
| 构建产物后 | 25.88 | 18.76 | 18.05 | 14.05 |
| 无变化 CLEAN | 3.05 | **5.05** | 不创建 | 不创建 |

每条样本分别计算“端到端减平台记录耗时”，再求中位数（不是两个中位数直接相减）：

| 场景 | before 剩余时间 | after 剩余时间 |
|---|---:|---:|
| 基线 | 4.46 | 2.51 |
| 依赖 | 5.23 | 5.36 |
| 小改 | 5.65 | 4.59 |
| 构建 | 7.80 | 4.71 |

剩余时间仍包括控制面、扫描、PG、销毁与观测误差，不能全部解释成轮询延迟。

### after 全部端到端样本

| 场景 | 第一轮 | 第二轮 | 第三轮 |
|---|---:|---:|---:|
| 基线 | 14.61 | 14.56 | 12.48 |
| 依赖 | 31.21 | 45.55 | 43.62 |
| 小改 1 | 19.65 | 14.52 | 12.46 |
| 小改 2 | 14.65 | 19.84 | 14.56 |
| 小改 3 | 18.69 | 12.41 | 19.66 |
| 构建 | 23.81 | 18.76 | 16.58 |
| CLEAN | 3.05 | 5.07 | 5.05 |

## 结论与边界

1. 轮询策略已经减少本次样本中的 Ready 感知间隔；没有放松 PG 确认、Creating 保留或失败状态语义。
2. 基线、小改和构建的端到端中位数下降，但小改/构建的平台阶段也更快，不能把下降全部归因于 SaaS 修改。
3. 依赖端到端变慢伴随平台记录耗时增加约 10 秒，应用侧剩余时间基本相同；不能声称“所有场景都更快”。
4. CLEAN 不走新建快照状态轮询，本次中位数反而多约 2 秒；目前没有额外阶段日志证明其原因，不能把它当作已经优化或已定位的噪声。该策略没有直接优化 CLEAN。
5. 本次没有重现 before 的 150 秒构建样本，**不代表该平台长尾已修复**；该修改不改变 Job/压缩/上传。
6. 正常窗口状态查询量增加；虽然错误和长任务有降频，仍没有高并发平台压测，不能宣称资源成本无影响。多实例同时观测同快照的请求合并不在本次范围。
7. 下一步应在应用侧补 prepare/控制面/销毁阶段计时，并向平台收集 committer Job 事件和 diff/压缩/上传时间，再决定下一项优化；不因几轮中位数提前改持久化架构或承诺消除长尾。

## 留存证据

- after 全样本：`evidence/snapshot-latency-poll-optimized.json`。
- after 原始日志：`evidence/snapshot-latency-poll-optimized.log`。
- 容器与源文件哈希：`evidence/snapshot-latency-poll-optimized-environment.json`。
- 单测输出：`evidence/snapshot-poll-unit-tests.log`。
- typecheck 输出：`evidence/snapshot-poll-typecheck.log`。
- 当前服务使用 `opencode-saas-sandbox-test:snapshot-poll-1s`；baseline 容器保留为 `opencode-saas-test-poll-baseline-backup-20261003`，没有删除用户资源。

本次未提交或推送。
