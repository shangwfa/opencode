# 本地 OpenSandbox 快照平台耗时定位

## 结论

本轮主要耗时发生在 Docker commit 内，且期间暂停沙箱进程。不是 SaaS manifest、平台上传或数十秒的线程排队。只改源码时，同一容器仍有约 769MiB 可写层，连续 commit 没有把该容器重新基于上一份快照创建。

这是本地 Docker 后端结论，不代表 Kubernetes 后端或生产性能。每个场景仅一个样本，不能作为分位数/稳定 SLO。

## 实测

2026-10-03，本地 OrbStack；测试开始宿主可用空间超过 15GiB；专用沙箱 2 CPU/4Gi。固定 Next 16.3.8、React/ReactDOM 19.3.0，pnpm store 在 workspace 中。不运行 next dev/build，不包含 SaaS manifest、PG 仲裁或队列。

| 场景 | 请求开始到观察 Ready / CLI 返回 | Docker pause→unpause | 请求开始到 pause | commit 事件收到→观察 Ready |
|---|---:|---:|---:|---:|
| 项目未安装依赖 | 12.73s | 12.25s | 0.065s | 0.433s |
| 安装 Next/React 后 | 32.76s | 32.44s | 0.070s | 0.266s |
| 同沙箱仅修改页面源码 | 24.04s | 23.78s | 0.048s | 0.217s |
| 再修改源码，直接 docker commit | 30.20s | 30.14s | 0.030s | 不适用 |

Ready 以 250ms 轮询观察，最后一列包含轮询/网络开销，不能视为纯数据库更新时间。原始记录中的 `commitToReadyMs` 使用平台状态时间与 Docker 事件时间，出现约 -0.26 至 -0.55 秒负差，不用于阶段结论，也未定位其具体原因。上述最后一列改用同一诊断进程的接收/观察时间。

平台三次请求的 pause→commit 分别为 12.23、32.42、23.75s，与 pause→unpause 基本一致。直接 commit 的对照排除了平台包装层是主要耗时来源，但尚不能进一步区分 Docker 内部文件扫描、压缩、镜像存储或磁盘 I/O。

## 实现与结构证据

本机安装 OpenSandbox Server 0.2.2，Docker Python SDK 7.2.0。只读检查，未修改依赖包。

- `opensandbox_server/services/snapshot_service.py:118–153`：检查源沙箱、记录 Creating、提交线程池，返回受理结果。
- `snapshot_service.py:300–329,337–355`：后台 runtime 完成后更新终态。
- `services/docker/snapshot_runtime.py:130–175`：查找容器、调用 `container.commit(repository, tag)`，返回 Ready；此创建路径没有 push/upload。
- `docker/api/container.py` 的 `commit` 默认 `pause=True`；实测确实产生 pause/unpause 事件。暂停是容器运行进程的停顿，不等同于应用级事务一致性保证。
- 未安装时 `SizeRw` 31.48MiB；依赖安装后 769.37MiB；只改源码和后续直接提交仍为 769.37MiB。三份平台镜像均为 19 层；依赖安装后和源码修改后的镜像累计逻辑 Size 均约 1118.39MiB。累计 Size 不等于实际新增存储或网络字节。

## 优化方向与边界

1. 先在 Docker 内部继续拆分扫描/归档/压缩/落盘，不能仅凭本轮数据归因磁盘慢。
2. 文件无变化应复用，避免 commit 带来的长暂停。
3. 需要平台支持增量/目录快照，或评估检查点后重建到新基线；重建会影响进程、连接和工具会话，不能当成无损透明优化。
4. pnpm 下载缓存可作为性能对照，但移除会失去离线重装能力，不能默认删除。
5. 不能为提速直接关闭 pause：后台写入与 manifest 的一致性问题尚未解决。

## 产物与清理

- 脚本：`docs/test-cases/scripts/snapshot-platform-timing.mjs`。
- 原始数据：`snapshot-platform-timing-2026-10-03.json`，包含 Docker 事件时间和接收时间。
- 本轮一个沙箱、三份平台快照、一份直接 commit 镜像均已成功清理；只操作本轮明确 ID。未操作历史卡住的 Creating 快照及其他会话。
