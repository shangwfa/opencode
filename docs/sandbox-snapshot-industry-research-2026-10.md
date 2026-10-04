# 沙箱快照行业深度研究（2026-10）

对照产品：E2B、Daytona、Modal、Runloop、CodeSandbox、AWS Lambda MicroVMs、Tensorlake、Firecracker 自建方案。数据来源为各产品官方文档、官方博客与第三方实测基准，标注于各处。

## 一、机制谱系：三个流派

| 流派 | 代表 | 捕获内容 | 恢复语义 |
|---|---|---|---|
| **VM 内存+文件系统快照**（Firecracker） | E2B pause/snapshot、Daytona hot snapshot、Modal memory snapshot、Runloop、AWS Lambda MicroVMs、Tensorlake checkpoint | 文件系统 + 内存 + 运行进程 | resume 原沙箱；进程照跑 |
| **文件系统级快照** | E2B `keepMemory:false`、Daytona cold snapshot、Modal `snapshotFilesystem`、Runloop snapshot、**OpenSandbox（我们）** | 仅文件系统 | 恢复即重启，进程/内存丢失 |
| **卷/备份型持久化** | GitHub Codespaces（stop/start 保卷）、Gitpod Classic（stop 时备份） | 挂载卷 | stop/start 原地保留 |

业界明确区分两对语义（Tensorlake 博客《Suspend vs. Snapshot》）：
- **Suspend/Resume**：一对一，恢复同一实例，计费停止（E2B paused 状态免费保留、无限期）
- **Snapshot/Fork**：一对多，源继续运行，快照派生任意新沙箱（E2B/Daytona/Modal/Runloop 全支持）

我们目前只有"销毁前快照 → 恢复"，两者都不是：沙箱必须销毁（非 suspend），快照仅限同会话恢复（非 fork）。

## 二、关键数字基准

| 产品 | 快照/暂停耗时 | 恢复耗时 | 来源 |
|---|---|---|---|
| E2B pause（mem+fs） | **~4s / 1GiB RAM** | ~1s（实测 662ms） | 官方 docs + LogRocket 实测 |
| E2B create（冷） | — | 717ms | LogRocket 实测 |
| Daytona | — | 1254ms | LogRocket 实测 |
| Modal | — | 1.60s → P99 2.33s | towardsai 基准 |
| CodeSandbox（microVM） | — | **<2s**（含 VM restore） | Northflank |
| Firecracker restore（自建） | 快照写入较贵（同步写内存页） | **5-30ms**；CoW fork 亚毫秒 | Firecracker docs + dev.to/Spheron |
| AWS Lambda MicroVMs | idle 自动 suspend（mem+disk） | "近即时，多 GB 会话也无感" | AWS 官方博客 |
| **我们（OpenSandbox K8s fs 快照）** | **16-45s**（按内容 344MB≈32s） | **6-13s** | 本仓实测 realdev-snapshot-k8s-2026-10-03.md |

结论：VM 快照流派的恢复延迟（≤2s）比我们低一个量级；我们的快照耗时与内容量线性、无有效增量。

## 三、最佳实践逐维度

### 1. 生命周期触发（业界共识：空闲自动挂起 + 请求自动唤醒）

- **E2B**：`lifecycle.onTimeout: pause`——超时自动暂停（可配 fs-only）；paused 无限期、无 TTL、不自动删除
- **Daytona**：`auto_stop_interval` 默认 15min；`auto_archive_interval`——停止 1h 后文件系统转对象存储（不占磁盘配额）
- **Runloop**：suspend 自动空闲检测 + **wake-on-HTTP**（请求到达自动恢复，"客户端感觉从未暂停"）
- **AWS Lambda MicroVMs**：idle 窗口自动 suspend、下一请求自动 resume

我们有 idleReap + 周期 refresh(1800s) + 销毁前快照——骨架在，但缺**任务完成触发**与**无感唤醒**的产品语义。

### 2. 快照失败的降级链（E2B 黄金实践）

E2B auto-pause 的完整降级路径（官方 docs "Persistence"）：

```
节点拒绝内存快照（ServiceBusy：上一个快照未完成）
  → 保持运行，重试至超时后约 2 分钟
  → 仍拒绝 → 降级 fs-only 快照（丢内存、保磁盘，恢复时重启）
```

要点：**永不丢数据、永不卡死，降级是显式语义**（`keepMemory` 是每次 pause 的选择而非锁定模式）。对照我们：快照失败 → 保留重试（数据保护到位），但没有"降级"档位——`waitMs` 900s 内反复重试同一档。

### 3. 保留与 GC

- **E2B**：paused 无限期，显式 kill 才删
- **Modal**：snapshot 7 天；**re-snapshot 不重置 TTL**——从 4 天前快照恢复后再快照，新快照只剩 3 天寿命（防链式续命刷存储，官方 docs "Re-snapshotting"）
- **Runloop**：显式删除

我们的 TTL 14 天 + 恢复点保留更精细，但无链式 TTL 防刷设计。

### 4. 增量与去重

- **Firecracker CoW fork**：93% 内存页跨 fork 共享（实测 100 个 numpy VM 共享 2.4GB 只读页，每 VM 私有仅 1.75MB）
- **Modal filesystem snapshot**：内容寻址增量层（此前调研已确认）
- **我们**：本地 Docker 后端为全量 commit（实测小改 2 行仍 43-57s）；远端 K8s 后端**疑似有层增量**（+344MB≈32s vs +30MB≈25s，非严格线性）——值得专门验证
- **内容无变化复用（CLEAN 判定）是我们特有**——业界因增量便宜而不需要；它是对"全量昂贵"的补偿，也是本轮修复过两个 bug（token、目录行）的关键路径

### 5. 一致性

- Firecracker 快照 = 全 VM 暂停点，天然 crash-consistent + 内存态一致
- E2B snapshot "briefly pauses then continues"（短暂停）
- 我们：本地 commit 暂停 12-32s（长）；远端 K8s 快照不暂停但也**无一致性保障**（后台写入与快照竞态，此前已识别为遗留项）

### 6. 冷启动与分发

- Firecracker warm pool 公式（Spheron）：`pool = ceil(peak_rps × p99_restore_s × 1.2)`
- 我们实测冷节点（无镜像缓存）创建 60s 超时必失败（~15%），已用"创建失败重试"缓解；业界根治法即节点预拉/预热池

## 四、差距与可落地建议（优先级）

| 级 | 项 | 参照 | 预期收益 |
|---|---|---|---|
| P0 | 任务完成/回合结束触发快照（有变化才拍，合并去抖） | E2B onTimeout、Runloop idle suspend | 消灭"任务完成→销毁"间的丢失窗口；快照点对齐产品语义 |
| P0 | 最终快照失败/超时保留源，明确报告待重试或失败；不得以旧恢复点、仅记录 manifest 或缩小保护范围允许销毁 dirty 源 | 参考失败回退机制，但必须保护最新磁盘修改 | 有界等待与资源状态透明，不以丢修改换取销毁成功 |
| P1 | 验证远端 K8s 快照是否层增量（小改 vs 大改耗时/存储对比实验） | Modal 内容寻址增量 | 若有增量，复用判定可降级为兜底；若无，评估快照成本模型 |
| P1 | 预热池/节点预拉镜像 | Firecracker warm pool | 根治冷节点 15% 失败 |
| P1 | fork 语义：从任意快照派生新沙箱（子会话并行探索） | E2B/Daytona/Modal/Runloop 一对多 fork | 支撑"一个任务多方案并行"的 Agent 模式 |
| P2 | 恢复延迟 6-13s → 目标 <2s | CodeSandbox（容器系 <2s 证明可行） | 会话续接体验 |
| P2 | 链式 TTL：恢复后再快照继承原快照剩余寿命 | Modal 7 天不重置 | 防快照链无限续命 |
| P2 | 后台写入一致性（fsync 屏障/快照期写冻结） | Firecracker 全 VM 暂停点 | 应用级一致性（当前为已知缺口） |

## 五、与既有调研的关系

本文档更新并取代早前口头调研结论（E2B fs+mem、Daytona 停止保盘/归档、Modal 增量与 best-effort 退出快照），补充了：机制三分法、E2B 降级链全文、Modal 链式 TTL、Firecracker warm pool 公式、第三方延迟基准（LogRocket/towardsai）、以及与本仓实测数据的直接对照。
