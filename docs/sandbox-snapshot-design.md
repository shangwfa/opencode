# Sandbox 快照持久化设计（本地盘 + 快照分层）

> 分支：`feat/session-snapshot`
> 状态：设计稿（待评审）
> 前置调研：`docs/overlay-pnpm-store-design.md`、`docs/sandbox-idle-reap.md`、`docs/session-pvc-mode.md`

---

## 一、背景与动机

### 1.1 现状问题

当前沙箱工作区持久化依赖 **NFS4 PVC**（`sessions/<sid>/workspace` 子路径挂载）：

| 问题 | 实测数据（2026-08-19，远端 K8s 沙箱） |
|---|---|
| NFS 元数据/小文件慢 | 写 1000 小文件 4.1s vs overlay 36ms（**113x**）；rm 500 文件 676ms vs 7ms（96x） |
| 依赖缓存随沙箱陪葬 | `/tmp/pnpm-vs`（overlay 临时层）在沙箱 idle 回收后丢失，NFS 上 symlink 悬空，必须重装 |
| 重装代价 | pnpm install p90 52s；近一周 159 会话累计安装 5 小时，长尾 >60s 的 71 次占一半时间 |
| store 覆盖窄 | 镜像预装 4 个前端模板（190MB），真实业务（如 1151 包项目）大量 miss |

NFS 本身无故障（近一周 exec_log 零 stale handle / EIO），是架构性瓶颈。

### 1.2 业界范式（E2B / Modal / Daytona 调研结论）

三家 AI 沙箱产品**均不使用共享网络文件系统做工作区**，共同范式：

```
热：pause（冻结，秒级恢复）
温：stop（FS 留 node 本地盘）
冷：快照/归档（增量存对象存储/镜像，分钟级恢复）
共享：Volume（对象存储 backing，仅放数据集/缓存）
```

快照本质是**增量镜像 diff**，恢复复用镜像分发基础设施，整箱恢复快于网络 FS 小文件随机 IO。

### 1.3 本地端到端验证（2026-08-20，Docker runtime + opensandbox-server 0.2.2）

| 环节 | 实测 | 说明 |
|---|---|---|
| 快照创建（REST `POST /sandboxes/{id}/snapshots`） | **70.2s**（15.7GB 镜像）/ **86s**（slim 9.8G，中位）/ **58s**（lean 8.57G 手动 commit） | 基础镜像容器 diff commit；异步不阻塞 |
| 快照恢复（`Sandbox.create({ snapshotId }）` | **491ms** | 对比重建+重装 30~120s，两个数量级提升 |
| `/tmp/pnpm-vs` 缓存 | **随快照保留** | 依赖缓存陪葬问题从根上解决 |
| 进程/内存 | 不保留 | FS-only 语义（同 Daytona cold snapshot），dev server 需重启 |

**关键坑**：快照 `Creating` 期间 kill 源容器 → commit 引用的 diff snapshot 失效 → 快照 Failed。必须保证 **快照 Ready 之后才允许销毁源沙箱**。

**性能瓶颈与优化（2026-08-21）**：docker commit 耗时与容器 rootfs 体积**近似线性**（实测 alpine 5MB→0.24s，slim 9.8G→73s），与可写层 diff 无关。`packages/opencode/docker/Dockerfile` 已做精简（`opencode-opensandbox:lean`）：只留 node@24（原 18/20/22/24 四版本 ~4G）、只留 pnpm@10（原 8/9/10/11 四版本）、清理 `/root/go`+go-build 缓存+pnpm/pip/mise 缓存，rootfs 9.8G→8.57G，手动 commit 73s→58s（**-21%**）。剩余大头为基础镜像自带（/usr/lib/jvm 937M、/opt/python 2G、/opt/go 770M）。进一步提速需换更小基础镜像或改 tar 增量快照（方案 B，架构级）。

---

## 二、目标架构

```
                    ┌─────────────────────────────────────────┐
                    │        opencode SaaS server (:4096)     │
                    │  sandbox-provider（本设计改造点）         │
                    │  ┌───────────────────────────────────┐  │
                    │  │ session_snapshot 表（PG）          │  │
                    │  └───────────────────────────────────┘  │
                    └───────────────┬─────────────────────────┘
                                    │ OpenSandbox API
                    ┌───────────────▼─────────────────────────┐
                    │      OpenSandbox server (K8s/Docker)    │
                    │  snapshot CRD / docker commit          │
                    └───────────────┬─────────────────────────┘
                                    │
              ┌─────────────────────┼──────────────────────┐
              ▼                     ▼                      ▼
     ┌────────────────┐   ┌────────────────┐    ┌──────────────────┐
     │ 运行态沙箱       │   │ 快照（镜像层）   │    │ PVC（降级为共享缓存）│
     │ rootfs=本地盘   │   │ 含 workspace +  │    │ shared/package-  │
     │ /workspace 本地 │   │ /tmp 依赖缓存   │    │ cache（可换JuiceFS）│
     └────────────────┘   └────────────────┘    └──────────────────┘
```

核心变化：

1. **工作区 `/workspace` 移到沙箱 rootfs（本地盘）**——摆脱 NFS 100x 元数据开销
2. **持久化单位从「共享卷」变为「整箱快照」**——idle 回收前快照，恢复时 `snapshotId` 拉起
3. **PVC 角色降级**——只保留 `shared/package-cache`（跨会话共享包缓存），后续可平滑替换为 JuiceFS
4. **dev server 不再随快照恢复**——进程态丢失，由预览流程按需重启（vite 冷启动 ~30s，另行优化）

---

## 三、快照生命周期与状态机

### 3.1 会话视角

```
                 发消息/exec                 idle 超时
  ┌─────────┐ ─────────────► ┌─────────┐ ───────────────► ┌──────────┐
  │ 无沙箱   │                │ 运行中   │  snapshot→Ready  │ 已快照     │
  │         │                │ (本地盘) │  然后销毁沙箱     │ (数据在镜像)│
  └────┬────┘                └────┬────┘                  └────┬─────┘
       │ 有snapshotId 直接恢复     │                            │
       │ (≈0.5s)                 │ 无 snapshotId 走镜像冷启动    │ 再次发消息
       └─────────────────────────┴────────────────────────────┘
```

### 3.2 快照记录状态机

```
creating ──► ready ──► restoring ──► ready（可复用）
   │                     │
   ▼                     ▼
failed               stale（源沙箱已被替代，等待 GC）
                            │
                            ▼
                        deleted（TTL / 会话删除 / 手动）
```

### 3.3 时序约束（实测坑）

- **destroy 必须等待 snapshot Ready**：Creating 中 kill 源容器会使快照 Failed
- 快照创建失败时**保留源沙箱**，记录失败原因并由 killed 重试分支继续尝试
- 同一会话不允许并发两个 snapshot 请求：PG advisory transaction 原子 claim creating 快照，跨 Pod 调用复用同一 id

---

## 四、快照所有权与管理模型（appId + 会话两级）

### 4.1 两级模型

与 `pvc_mode=session|app` 对称，快照分两级（业界对应：E2B 模板 ≈ baseline、pause ≈ session 快照；Daytona fork 同款派生语义）：

```
app（appId）
 └─ 基线快照（baseline，每 app 至多 1 个 current）   ← 长生命周期（跟随 app）
     │  新会话 create：从 baseline 派生（fork 语义，秒级）
     ├─ session A ── idle ──► session 快照 A ──► 恢复 A    ← 短 TTL（默认 7d）
     ├─ session B ── idle ──► session 快照 B ──► 恢复 B
     └─ session C ── 结束时"保存环境" ──► promote 为新 baseline
                                  （旧 baseline 退役，引用计数归零后 GC）
```

| 模型取舍 | 说明 |
|---|---|
| 恢复语义 | session 快照管「原样恢复」；baseline 管「新会话派生」——两种语义都不丢 |
| 回写/竞争 | baseline 只能显式 promote（会话结束时指定，或"最后存活会话"策略），**不做自动合并**（diff 合并语义过于复杂，业界无先例） |
| 基线更新 vs 运行中会话 | 旧 baseline 引用计数：仍有活跃会话从旧基线派生时不删，会话结束后 GC |
| 层累积 | 镜像层 content-addressable 自动去重；promote 链过厚时"重建基线"压实（低频运维操作） |
| TTL 分层 | session 快照 7d；baseline 跟随 app 生命周期，app 删除联动清理 |
| **同会话多快照** | **只保留最新 Ready**：创建窗口允许“旧 ready/stale + 一个 creating”；新快照 Ready 后旧终态快照进入 deleting，远端删除成功或 404 后标 deleted。被恢复消费的快照标记 stale，但在新快照 Ready 前保留作回退。 |
| 与 pvc_mode 的关系 | 两个不同维度：persistMode 决定 workspace 落点（PVC 卷 / 沙箱 rootfs）；pvc_mode=session\|app 只在 PVC 模式下有意义（session 独立卷 / app 共享卷）。快照会话不挂 workspace 卷，pvcMode 参数自然失效，无需校验 |

### 4.2 查找规则（getOrCreate 时）

```
1. session 有有效快照（最新 ready|stale）→ 恢复它（原样回来）
2. 否则 app 有 current baseline → 从 baseline 派生（新会话继承环境）
3. 否则 → 镜像冷启动（现状路径）
每层失败自动降级到下一层，快照恢复失败不阻塞会话创建
```

## 五、数据模型（PG）

新增 `session_snapshot` 表（`*.pg.ts` + `migration-pg`）：

```ts
const table = pgTable("session_snapshot", {
  id: text().primaryKey(),                    // 快照 ID（OpenSandbox snapshot id）
  session_id: text(),                         // 归属会话（baseline 为空）
  app_id: text(),                             // baseline 必填；session 快照冗余记录归属 app
  scope: text().notNull(),                    // session | baseline
  state: text().notNull(),                    // creating|ready|failed|stale|deleted|retired
  reason: text(),                             // 失败/状态原因
  size_bytes: bigint(),                       // 快照大小（可选，server 返回时填）
  time_created: bigint().notNull(),
  time_updated: bigint().notNull(),
})
// index: (session_id, state) —— 会话恢复时取最新 ready 快照
// index: (app_id, scope) —— baseline 查找与"每 app 至多一个 current"约束
```

> 不在 session 表加列：快照是多对一（一个会话历次快照），且要支持 GC 扫描。

## 六、sandbox-provider 改造

### 6.1 创建流程（getOrCreate）

三级查找（见 §4.2），逐级降级：

```
getOrCreate(sessionID)
  ├─ 内存 map 命中 → 返回
  ├─ ① 查 session 快照: 最新有效快照（state in ready|stale）？
  │    ├─ 有 → Sandbox.create({ snapshotId, volumes: [package-cache] })
  │    │        └─ 成功后将该快照标记 stale（已消费；stale 仍可再次恢复——运行中沙箱
  │    │           异常退出时兜底，直到被新快照替代时删除）
  ├─ ② 查 app baseline: app_id 有 current baseline？
  │    └─ 有 → Sandbox.create({ snapshotId: baseline, volumes: [package-cache] })
  │             └─ baseline 不标记 stale（可重复派生）；旧基线被 promote 替换后标 retired
  ├─ ③ 镜像冷启动：Sandbox.create({ image, volumes: [...] })   // 现状路径
  └─ ①②恢复失败（快照过期/被 GC/层损坏）→ 自动降级到下一级 + 记日志，不阻塞会话创建
```

### 6.2 销毁流程（idle 回收 / 会话删除）

**实现要点（2026-08-20 修订）**：
- `run-state onIdle`（每轮交互结束）在快照模式下**不立即销毁**——每轮一次 docker commit（~70s）不可接受；统一交给 idle reap（超时真空闲）处理
- 快照等待**异步化**：锁内仅发起（fork 后台 fiber），Ready 后 fiber 完成 kill + 落库；锁立即释放，不阻塞 idle reap 扫描与会话恢复
- **代码安全承诺（核心语义）**：快照未成功不销毁沙箱——发起失败/Failed/超时均**保留沙箱**（行保持 killed，idle reap 的 killed 重试分支每轮重试快照）；沙箱 server 侧 TTL 兜底最终回收。三条销毁路径（idle reap / zombie / getOrCreate killed 重试）**统一走 `cleanupSandbox({snapshot:true})` 同一语义**（zombie 曾独立实现"失败仍销毁"，已修正）；快照未完成期间用户消息走 "cleanup pending" 失败，下次重试从快照恢复
- **发起去重**：`startSnapshot` 发现已有 creating 快照时直接返回其 id——并发 fiber（reap + killed 重试）等同一个快照，避免重复 commit；卡死的 creating 由 gc 对账修正后下轮正常发起新快照
- **显式快照 fencing**：POST snapshot 原子将 sandbox 从 running 置为 snapshotting，期间新请求返回 snapshot pending；Ready/Failed/超时后恢复 running，源沙箱不销毁。进程中断遗留的 snapshotting 由 reap 超时接管
- **进程退出不销毁**：pgLayer 退出（发版/重启）不调 destroyAll——PG 行保持 running，沙箱活在独立沙箱 server 上，新实例 reconnect 继续用（dockerLayer 的 scope-exit 清理仅限本地非快照模式）
- 显式 destroy（DELETE /session、write 超时）不快照（业务主动删除/异常路径）

```
idle reap / zombie 回收 / killed 重试（带快照）:
  lock → claim + 置 killed → reconnect
    → 沙箱存活: fork(startSnapshot → awaitSnapshot)
        → ready   → kill + 落库
        → failed/超时 → 保留沙箱（下轮重试；TTL 兜底）
    → 沙箱已死: 直接 killByID + 标记 destroyed
```

### 6.3 volume 布局变化

| 挂载点 | 现状（PVC 模式） | 快照模式 |
|---|---|---|
| `/workspace`、`/resources`、`/home/sandbox/*`、tmp | PVC subPath（NFS） | **无 volume，落在 rootfs（随快照持久化）** |
| `shared/package-cache` | PVC subPath | **保留 PVC**（跨会话共享，与快照互补） |

`buildVolumes` 增加 `volumeType: "snapshot"`：只挂 package-cache，其余路径不挂卷。恢复时传 `snapshotId` + 同样的 package-cache volume。

> 注意：`pvc_mode` 与快照模式是两个维度——`pvc_mode=session|app` 仅在 PVC 持久化下决定 workspace 卷的粒度；快照会话 workspace 在 rootfs，不挂 workspace 卷，`pvcMode`/`appId` 参数自然失效（不报错）。

### 6.4 配置项

持久化方式是**会话级配置**：创建会话时 `sandbox.persistMode: "pvc" | "snapshot"`（创建时固化到 sandbox JSON，fork/子会话继承）；缺省回退全局默认。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `OPENCODE_SANDBOX_SNAPSHOT_ENABLED` | `false` | 快照能力总开关：未开时会话选 `persistMode=snapshot` 返回 400 |
| `OPENCODE_SANDBOX_SNAPSHOT_TTL_SEC` | `7d` | 快照保留期（对应 Modal 30d/7d，我们更短：快照含用户数据，跟会话保留策略对齐） |
| `OPENCODE_SANDBOX_SNAPSHOT_WAIT_SEC` | `900` | 等待 Ready 上限；超时保持 creating，等待下轮/GC 对账 |
| `OPENCODE_SANDBOX_VOLUME_TYPE` | `pvc` | 全局默认 persistMode；取值 `pvc` / `snapshot`（`host`/`none` 为本地开发形态，不支持会话级覆盖到 snapshot 之外的组合） |

全局默认为 `snapshot` 时必须开 `SNAPSHOT_ENABLED`（否则所有缺省会话创建即失败，服务拒绝启动）；`pvc` 默认 + 能力开关开启 = 会话按需选快照，合法组合。

### 6.5 SDK 兼容

- `@alibaba-group/opensandbox@0.1.11` **已支持** `Sandbox.create({ snapshotId })` 恢复
- 快照创建/查询/删除通过 OpenSandbox SDK 的 `SandboxManager` 调用
- 远端 server 0.1.13+ 已有 snapshot API（K8s CRD 实现）；**前置条件：集群管理员补 `sandboxsnapshots` RBAC**（已实测 403）

---

## 七、快照 GC

1. **TTL 过期**：后台任务（复用 watchdog 扫描周期）扫 `state in (ready, stale, failed)` 且 `time_created < now - TTL` → 调远端 DELETE + 标记 deleted
2. **会话删除联动**：先把快照置为 deleting；远端删除成功或 404 后标 deleted，其他错误由 GC 持久重试。快照记录不再 FK cascade，避免丢失重试凭据
3. **对账**：`state=creating` 超过等待窗口的记录 → 查询远端实际状态；Ready 补 ready、Failed 标 failed，查询错误或仍 Creating 时保持 creating
4. 存储压力：快照是镜像 diff，由 OpenSandbox server / K8s 节点镜像存储管理；TTL + 会话删除是唯一回收路径，监控 `session_snapshot` 表行数与远端快照列表差值

---

## 八、镜像瘦身（衍生红利）

状态从「镜像预装」迁移到「快照 diff」后，沙箱镜像回归纯运行时职责：

| 镜像内组件 | 现状 | 快照方案下 |
|---|---|---|
| `/opt/pnpm-store` 预装（190MB，4 模板填充） | 弥补缓存随沙箱陪葬的手段 | **可砍**——快照保留 `/tmp/pnpm-vs`；新会话冷装走共享 package-cache |
| `/opt/preload/*/node_modules`（npm 方案，100~120MB × 4 模板） | NFS 时代规避重装的补丁 | **可砍**（连同 `docker/packages/` 模板库与 Dockerfile 第 11 步） |
| mise 多版本 node/pnpm（839MB） | 运行时需求 | 保留 |
| LSP daemon + typescript + pyright | 功能需求 | 保留 |

连锁收益：镜像变小 → 冷启动拉取快、docker commit diff 层小 → 快照创建/恢复传输量同步下降；`docker/README.md` 与实现的偏差问题顺带消失。

**执行顺序（重要）**：瘦镜像的前提是共享 package-cache 层可靠——全新会话（无快照）首次安装将从「镜像 store 命中」变为「共享缓存命中或网络下载」，若 package-cache 仍是 NFS 后端会变慢。顺序：

```
快照上线 → 观察冷启动占比 → package-cache 换 JuiceFS（或实测 NFS 命中够快）→ 再砍镜像预装
```

## 九、风险与开放问题

| 风险 | 缓解 |
|---|---|
| K8s 快照实现是 CRD（SandboxSnapshot v1alpha1），**行为与 Docker runtime 的 docker commit 语义一致性未验证**（数据落点、是否含 overlay 可写层、恢复耗时均是假设）；本地 70s/684ms 全部基于 Docker | **K8s 行为属"待验证假设"**：registry 配置就绪后先跑 T25.8 基准（创建/恢复耗时、数据完整性）再谈生产灰度 |
| 自动/显式快照期间的新请求与文件写入竞争 | sandbox 先切换为 killed/snapshotting，新请求明确返回 cleanup/snapshot pending；不再从镜像或旧快照并发创建 |
| dev server 进程不随快照恢复，预览重启 ~30s（vite 冷启动） | 独立问题（预览探测窗口优化），不阻塞本设计；快照保留了 node_modules，重启免重装 |
| 沙箱内已存在的后台进程不受 API fencing 控制 | 快照为文件系统 crash-consistent，不保证进程内存状态；业务写入入口在 snapshotting 期间被拒绝 |
| 镜像膨胀：每会话一个 diff 层，节点镜像存储压力 | TTL 默认 7d + 会话删除联动；监控远端快照数量 |
| 快照会话误传 pvcMode=app | 不报错：快照会话不挂 workspace 卷，app 参数自然失效（维度不同，见 §6.3） |
| upstream 合并 | sandbox-provider 为 SaaS 深度定制文件，已知冲突点（见 upstream-merge-guide），新增逻辑集中放减少冲突面 |

---

## 十、测试计划（docs/test-cases/sandbox/）

新增 `snapshot-persistence.md`（沿用 Txx.x 编号风格）：

- T25.1 快照创建成功：exec 写文件 → 触发 idle 快照 → session_snapshot 记录 ready
- T25.2 快照恢复：kill 后再发消息 → 沙箱 <5s 就绪 → workspace 文件、/tmp/pnpm-vs 缓存存在
- T25.3 Creating 期间销毁保护：快照未 Ready 时 destroy 不提前 kill
- T25.4 快照失败降级：远端快照失败 → 保留沙箱、记录 failed/creating、下轮重试
- T25.5 恢复失败降级：snapshotId 恢复失败（快照被删）→ 自动回退镜像启动
- T25.6 GC：TTL 过期 / 会话删除后快照清理
- T25.6b 同会话多次快照：idle 快照两次 → 旧快照被删除（远端与记录），仅最新可恢复
- T25.7 NFS 场景回归：pvc 模式行为不变（开关关闭）
- T25.8 （K8s 环境，RBAC 通后）远端快照创建/恢复耗时基准

---

## 十一、实施阶段

| 阶段 | 内容 | 验证 |
|---|---|---|
| P1 | PG 表 + migration；REST 快照客户端封装；配置项 | 单测 |
| P2 | create/destroy 流程改造 + 降级路径；volumeType=snapshot | 本地组合 3 全链路（本文档 §1.3 已验证可行性） |
| P3 | GC + 对账 + watchdog 异步化 | 单测 + T25.x 集成用例 |
| P4 | 远端 K8s 验证（依赖 RBAC 授权）+ 生产灰度 | T25.8 + 生产观察 |

---

## 十二、与现有文档的关系

- 取代/演进：`session-pvc-mode.md`（session 模式）、`overlay-pnpm-store-design.md`（缓存部分诉求被快照吸收）
- 保留：`shared-package-cache-design.md`（PVC 仅剩此职责，后续可换 JuiceFS 后端）
- 依赖：`sandbox-idle-reap.md`（回收触发点）、`docs/guides/sandbox-frontend-debug-guide.md`（dev server 重启行为变化需更新）
