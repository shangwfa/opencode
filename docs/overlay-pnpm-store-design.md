# Overlay pnpm Store + NFS 预热技术方案

> 状态：待实现
> 前置：`feat/share-packages`（共享 Package Cache 已实现）
> 关联：[`overlayfs-package-cache-design.md`](./overlayfs-package-cache-design.md)（OverlayFS 方案，更重）、[`shared-package-cache-design.md`](./shared-package-cache-design.md)（共享缓存基线）

## 1. 问题

### 1.1 现象

PVC 模式下 pnpm install 重装耗时 ~3.7s，hardlinks=1（copy），未达到 hardlink 零拷贝。

### 1.2 根因

Dockerfile 与运行时挂载路径冲突：

| 来源 | 路径 | 性质 |
|------|------|------|
| `Dockerfile:91` `pnpm config set store-dir` | `/opt/pnpm-store` | 镜像层 overlay，构建时预装包 |
| `flag.ts:108` `OPENCODE_SANDBOX_PACKAGE_CACHE_MOUNT` 默认值 | `/opt/pnpm-store` | PVC 共享卷（NFS 后端）挂载点 |

两者指向**同一路径**。PVC 模式下 NFS 卷挂载到 `/opt/pnpm-store`，**覆盖**了镜像层预装的 store 内容。结果：

```
/opt/pnpm-store → NFS（网络存储）           ┐
                                            ├─ 跨文件系统 → hardlink 不可能 → copy
/tmp/pnpm-vs    → overlay（容器本地层）      ┘
```

### 1.3 实测数据（2026-08-07，远端 K8s sandbox，`/workspace` 为 NFS4）

| 方案 | store 位置 | hardlinks | 重装耗时 | 三次稳定 |
|------|-----------|-----------|---------|---------|
| 当前（NFS store） | NFS 共享 | **1**（copy） | **3.7s** | — |
| 最佳实践（overlay store+vs） | overlay 本地 | **2**（hardlink） | **1.4s** | 1.4/1.4/1.4s |

性能差距 **2.6x**（减少 62%）。node_modules 两者均只有 symlink（<120K）落在 NFS 上。

## 2. 方案设计

### 2.1 核心思路

**分离挂载点 + 启动时预热**：NFS 共享缓存挂到独立路径（不覆盖镜像层 store），容器启动时从 NFS 同步到 overlay store，install 时 store+vs 同在 overlay → hardlink 生效。

```
容器启动（一次性）：
  NFS 共享缓存 (/mnt/shared-package-cache)
    └── rsync/cp ──→ overlay /opt/pnpm-store     ← 批量同步，NFS 擅长大文件

pnpm install：
  overlay store (/opt/pnpm-store)
    └── hardlink ──→ overlay vs (/tmp/pnpm-vs)    ← 零拷贝（同文件系统）
                       └── symlink ──→ NFS node_modules  ← <120K 轻量
```

### 2.2 与 OverlayFS 方案的对比

| 维度 | 本方案（NFS 预热） | OverlayFS 方案 |
|------|-------------------|---------------|
| 复杂度 | 低（改 flag + 加预热脚本） | 高（内核 mount、root 权限） |
| 读路径 | overlay 本地（预热后全量命中） | overlayfs merged（lower=镜像层） |
| 写路径 | overlay（新包写本地） | NFS upperdir（新包写 PVC） |
| 跨 Pod 共享新包 | ❌（预热后各自独立） | ✅（upper 在 NFS） |
| 依赖 | rsync 或 cp | overlayfs 内核模块 + privileged |
| 适用场景 | 常用包固定、镜像定期更新 | 需要动态共享新安装包 |

本方案**不追求跨 Pod 实时共享新包**（新包从 registry 下载到本地 store，不回写 NFS），换取实现简单 + hardlink 性能。OverlayFS 方案保留作为后续升级路径。

## 3. 实现步骤

### 3.1 分离挂载点

**文件**：`packages/opencode/src/flag/flag.ts:108`

```diff
- process.env["OPENCODE_SANDBOX_PACKAGE_CACHE_MOUNT"] ?? "/opt/pnpm-store"
+ process.env["OPENCODE_SANDBOX_PACKAGE_CACHE_MOUNT"] ?? "/mnt/shared-package-cache"
```

NFS 共享卷挂载到 `/mnt/shared-package-cache`，不再覆盖镜像层的 `/opt/pnpm-store`。

### 3.2 预热脚本

sandbox 创建后、首次使用前，通过 `runInSession` 执行一次性预热（与 LSP daemon / PTY agent 的注入方式一致）。

**注入点**：`packages/opencode/src/tool/sandbox-provider.ts` 的 `getOrCreate` 方法，sandbox 创建成功后追加：

```ts
// 预热：NFS 共享缓存 → overlay 本地 store（仅 PVC 模式 + 共享缓存存在时）
if (config.volumeType === "pvc") {
  yield* sandbox
    .runInSession(
      sessionID,
      [
        `if [ -d /mnt/shared-package-cache/pnpm-store ]; then`,
        `  mkdir -p /opt/pnpm-store`,
        `  cp -an /mnt/shared-package-cache/pnpm-store/. /opt/pnpm-store/ 2>/dev/null || true`,  // -a 保留属性, -n 不覆盖已有
        `fi`,
      ].join(" "),
      { timeoutSeconds: 30 },
    )
    .pipe(Effect.catch(() => Effect.void))  // 预热失败不影响 sandbox 创建
}
```

> `cp -an`（archive + no-clobber）：已存在的文件跳过，只补充缺失的包。比 rsync 轻量（sandbox 镜像无 rsync）。

### 3.3 镜像层预装保持不变

`Dockerfile:91-105` 的 pnpm store 预装**不改动**——它仍然是 overlay 层的"基线 store"。PVC 挂载不再覆盖它，预热只是在此基础上补充 NFS 上的新包。

### 3.4 预热填充 NFS 共享缓存

NFS 共享缓存需要有内容才能预热。两种填充方式：

1. **镜像构建时导出**（推荐）：Dockerfile 预装 store 后，追加一步把 store 内容复制到 NFS 挂载点（首次启动自动填充）。或 CI 定期跑一个"种子 job"。
2. **懒填充**：install 时如果 overlay store 没有，从 registry 下载到 overlay store，同时异步写一份到 NFS 共享缓存（供后续 session 预热）。

初期可只依赖镜像层预装（步骤 3.3），NFS 预热作为增量优化。

## 4. 验证方法

```bash
# 前置：source test-env.sh 1
SID=$(new_sid -kb)  # keepAlive + boot

# 1. 确认 store 和 vs 同在 overlay
exec "df -T /opt/pnpm-store /tmp/pnpm-vs | awk 'NR>1{print \$1,\$2,\$NF}'"
# 期望：两者均为 overlay

# 2. 确认 hardlink 生效
exec "cd /workspace && mkdir bench && cd bench && npm create vite@5 . -- --template react-ts && pnpm install && VS=\$(find /tmp/pnpm-vs -name index.js -path '*/react/*' | head -1) && stat -c 'hardlinks=%h' \"\$VS\""
# 期望：hardlinks=2

# 3. 重装耗时
exec "cd /workspace/bench && for i in 1 2 3; do rm -rf node_modules; time pnpm install 2>&1 | grep Done; done"
# 期望：~1.4s 稳定

# 4. NFS 上 node_modules 只有 symlink
exec "du -sh /workspace/bench/node_modules && find /workspace/bench/node_modules -maxdepth 2 -type l | wc -l"
# 期望：<200K + symlink 数 >0
```

## 5. 改动清单

| 文件 | 改动 | 说明 |
|------|------|------|
| `packages/opencode/src/flag/flag.ts` | 改默认挂载点 | `/opt/pnpm-store` → `/mnt/shared-package-cache` |
| `packages/opencode/src/tool/sandbox-provider.ts` | 加预热逻辑 | `getOrCreate` 后 `runInSession` 执行 `cp -an` |
| `packages/opencode/docker/Dockerfile` | 无改动 | 镜像层预装保持不变 |
| `packages/opencode/docker/README.md` | 更新说明 | 修正"store 不预装"过时描述 |

预计改动量：<50 行。

## 6. 风险与降级

| 风险 | 影响 | 降级 |
|------|------|------|
| NFS 共享缓存为空（首次部署） | 预热无内容，退化为从 registry 下载 | 镜像层预装兜底 + registry mirror |
| overlay 空间不足 | 大量包复制撑满本地盘 | 限制 store 大小或改用 OverlayFS 方案 |
| `cp -an` 耗时过长 | sandbox 首次请求延迟 | 设 timeoutSeconds=30，超时跳过预热 |
| 非 PVC 模式 | 预热不触发（volumeType !== "pvc"） | 无影响，保持现有行为 |
