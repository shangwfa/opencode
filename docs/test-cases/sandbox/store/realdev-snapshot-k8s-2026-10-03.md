# 真实开发场景 × 远端 K8s 沙箱快照实测（2026-10-03）

## 结论

- 远端 K8s 后端快照耗时：固定开销 ~16s + 随内容增长（344MB 依赖 ~32s）；恢复 6-13s。
- **发现并修复复用失效 bug**：V2 manifest 含目录行，overlayfs 快照/恢复会翻转空目录存缺（pnpm store 前缀目录），恢复后销毁必判 DIRTY、每次新建快照；对齐 V1（manifest 排除目录）后无变化场景复用 4.1s。
- 走 SaaS 生产链路（API 触发销毁前快照与恢复），非 SDK 直连。

## 环境

- SaaS：`opencode-saas-test`（镜像 `manifest-nodir`），本地 PG `opencode-v2-up`
- 沙箱：远端 K8s `172.18.32.15:30040`（转发 30040），镜像 `session-terminal-20261003`（amd64）
- 会话：`persistMode=snapshot`，cpu 2 / memory 4Gi
- 项目：Next 16.3.8 + React 19.3.0，pnpm store 在 `/workspace/.pnpm-store`

## 场景耗时（修复后全链路）

| 场景 | workspace 规模 | 恢复+命令 | 销毁前快照 |
|---|---|---:|---:|
| S0 空工作区 | 6 文件 | — | 16.3s（新建） |
| S1 写项目文件 | 36KB/6 文件 | 5.6s | 16.4s（新建） |
| S2 pnpm install | 344MB/20056 文件 | 11.1s（含安装 4.2s） | 32.4s（新建） |
| S3 改 2 份源码 | 344MB | 12.8s | 19.2s（新建，内容变了应新建） |
| S4 next build | 373MB/20196 文件 | 15.5s（含构建） | 25.2s（新建，内容变了应新建） |
| **S5 无变化** | 373MB | 5.8s | **4.1s（复用，无新快照）** |
| S6 恢复验证 | 373MB | 8.0s | — |

S6 验证 `.next`（BUILD_ID 等）、node_modules、两处源码修改全部在位。

## 复用失效 bug 的定位链（修复前）

现象：S5「无变化」仍新建快照 21.9s；2 万文件场景恢复→销毁必新建。

逐项排除与实证：

1. 小文件（2 文件/61 文件）恢复→销毁**复用正常**（8.3s）→ 复用机制本身工作
2. 恢复后被动写入：`find -newermt T` 计数 **0**（恢复不产生写入，mtime 干净）
3. token identity：沙箱内 `/var/tmp/.opencode-snapshot-token` 与 PG `manifest_token` **一致**
4. 扫描超时嫌疑排除：恢复层上完整 manifest 扫描实测 **2.37s**（timeout 15s 富余）
5. 生产判定命令原样输出 **DIRTY** → manifest 内容 diff → **28 行差异全部是 `d`（目录）行，零文件差异**：pnpm store 内容寻址**空目录**（`files/12`、`files/5d` 等）在 overlayfs 快照→恢复后集合翻转

根因：V2 manifest 扫描含目录（`find -printf` 无 `-type` 过滤，"目录/symlink 拓扑增强"），空目录在远端 overlayfs 快照/恢复间不稳定。V1 的 manifest **只扫文件**（生产验证语义）。

### 修复

`packages/core/src/sandbox/snapshot-reuse.ts` `manifestScan`：文件 + symlink 保留（`%y %l` 拓扑），**目录排除**。目录行本就冗余：quick mtime 路径已覆盖（任何子文件增删都会更新父目录 mtime）。

存量快照（旧含目录 manifest）首次判定自然 diff → 多一次快照后自洽，无需 bump schema。

### 验收

- 单测 `sandbox-snapshot-reuse.test.ts` 7/7（新增目录排除断言）
- 大文件场景（20112 文件）恢复→销毁：**复用 10.5s**（修复前必新建 22-45s）
- 上表 S5 `reused=true` 4.1s

## 与本地 Docker 后端对照（docs/test-cases/sandbox/store/nextjs-snapshot-performance-2026-10-03.md）

| | 本地 Docker（docker commit） | 远端 K8s |
|---|---|---|
| 快照机制 | 同步 docker commit，**暂停沙箱全程** | 平台异步，**不暂停**（销毁前快照在沙箱存活期发起） |
| 空区快照 | 9.5-19.4s | 16.3-32.5s |
| 344MB 依赖快照 | 39.0-40.2s | 32.4-45.3s |
| 恢复 | 0.85-1.39s | 6-13s |
| 复用判定 CLEAN | 1.4-5.2s（4Gi/2CPU 本地） | 2.4s（恢复层上实测） |

## 脚本

- `docs/test-cases/scripts/realdev-snapshot-e2e.mjs`：上述全链路（SaaS API）
- `docs/test-cases/scripts/snapshot-reuse-diff-probe.mjs`：manifest 差异定位/复现工具

均只操作自己创建的会话/沙箱，结束清理（DELETE 会话）；PG 快照行由服务保留策略管理。
