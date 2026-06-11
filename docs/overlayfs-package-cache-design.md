# OverlayFS 加速 Package Cache 技术方案

> 分支：`feat/overlayfs-package-cache`
> 前置：`feat/share-packages`（共享 Package Cache 已实现）
> 状态：设计中

## 1. 背景

### 1.1 现状

`feat/share-packages` 已实现 PVC 共享 Package Cache（`/xybot-front/cache`），多个 session 共享同一个 pnpm store / npm cache。但实测发现：

| 场景 | 耗时 | 瓶颈 |
|------|------|------|
| pnpm install（reused 174, downloaded 0） | **24.7s** | PVC 磁盘 I/O |
| pnpm install（reused 190, downloaded 14） | **34.8s** | PVC 磁盘 I/O + 网络下载 |

`user+sys` 仅 ~3s，剩余 ~22s 全部是 PVC I/O 等待。即使 100% 缓存命中，PVC 的 IOPS 限制导致 hardlink/create 操作仍然很慢。

### 1.2 行业参考

| 产品 | 方案 |
|------|------|
| **Replit** | OverlayFS 只读快照 + Copy-on-Write upper 层 |
| **GitHub Codespaces** | Prebuild 快照（提前构建完整环境） |
| **Gitpod** | Prebuilt Workspace（类似 Codespaces） |

Replit 的 OverlayFS 方案最适合我们的场景：不依赖 CI 触发，无侵入，按热度自动覆盖常用包。

### 1.3 目标

- 常用包（react/vite/typescript 等）install 耗时从 ~25s 降到 **<3s**
- 对 agent/bash 调用方式透明，不改 install 命令格式
- 只考虑 npm 和 pnpm 两个包管理器
- PVC 模式自动启用，非 PVC 模式降级为现有行为

## 2. 方案设计

### 2.1 核心思路

在 sandbox 镜像中预装常用 npm/pnpm 缓存（只读层），容器启动时通过 OverlayFS 与 PVC 可写层合并，pnpm/npm 读取常用包时命中镜像层（本地磁盘），只有新包才写 PVC。

```
┌───────────────────────────────────────────────────────┐
│  Sandbox Container                                     │
│                                                        │
│  /opt/package-cache-base/     ← 镜像层（只读）          │
│    ├── pnpm-store/                                      │
│    │     ├── react@18.3.1/                              │
│    │     ├── vite@5.4.21/                               │
│    │     └── typescript@5.6.3/                          │
│    └── npm/                                             │
│          ├── _cacache/content-v2/...                    │
│          └── _cacache/index-v5/...                      │
│                                                        │
│  ─── OverlayFS ──────────────────────────────────────  │
│                                                        │
│  /xybot-front/cache/           ← merged 视图            │
│    ├── lower = /opt/package-cache-base  (只读，镜像)     │
│    ├── upper = PVC upper 目录            (可写，PVC)      │
│    └── work  = tmpfs 工作目录                            │
│                                                        │
│  pnpm/npm 看到的 /xybot-front/cache/ = 只读层 + 可写层   │
│    读常用包 → 命中镜像层 → 本地磁盘 → 快                 │
│    安装新包 → 写 upper 层 → PVC → 隔离                   │
└───────────────────────────────────────────────────────┘
```

### 2.2 OverlayFS 工作原理

OverlayFS 是 Linux 内核内置的联合文件系统（Docker 镜像的底层技术）：

```
merged (用户看到的目录)
  ├── lowerdir (只读，可以有多个)
  ├── upperdir (可写，只有一个)
  └── workdir  (内核内部使用)

读：从 upper → lower 依次查找，优先 upper
写：写到 upper（Copy-on-Write）
删：在 upper 创建 whiteout 标记
```

- 同一文件系统内 hardlink 正常工作（merged view 内）
- 跨 lower/upper 的读操作零开销（内核直接引用）
- 需要 `CAP_SYS_ADMIN` 或 `fuse-overlayfs`（用户态实现）

### 2.3 对比现有方案

| | 现有（PVC 共享 cache） | OverlayFS 方案 |
|---|---|---|
| 常用包首次安装 | ~35s（网络下载 + PVC 写入） | **<3s**（命中镜像层，零网络零 PVC 读取） |
| 删除 node_modules 重装 | ~25s（PVC 硬链接） | **<3s**（镜像层直接可见） |
| 非常用包安装 | 取决于网络 | 不变（走 upper + 网络下载） |
| 镜像体积 | 基线 | +300~500MB |
| K8s 权限要求 | 无 | `SYS_ADMIN` 或 fuse-overlayfs |

## 3. 代码改动

### 3.1 `packages/opencode/Dockerfile`（sandbox 镜像）

#### 3.1.1 预装 pnpm store

```dockerfile
# 预装常用前端依赖到 pnpm store
RUN pnpm store add \
    react@18 react-dom@18 \
    @vitejs/plugin-react \
    vite@5 \
    typescript@5 \
    @types/react@18 @types/react-dom@18 \
    eslint@9 \
    next@14 \
    express@4
```

#### 3.1.2 预装 npm cache

```dockerfile
RUN mkdir -p /tmp/preload && cd /tmp/preload \
    && echo '{"dependencies":{"react":"^18","react-dom":"^18","vite":"^5","typescript":"^5","@vitejs/plugin-react":"^4","eslint":"^9","next":"^14","express":"^4"}}' > package.json \
    && npm install --cache /opt/package-cache-base/npm --prefer-offline \
    && rm -rf /tmp/preload
```

#### 3.1.3 安装 fuse-overlayfs（备选方案）

```dockerfile
# 优先使用内核 overlayfs（需要 CAP_SYS_ADMIN）
# 降级方案：fuse-overlayfs（无需特权）
RUN ARCH=$(uname -m) \
    && curl -fsSL "https://github.com/containers/fuse-overlayfs/releases/latest/download/fuse-overlayfs-$(uname -m)-unknown-linux-gnu" \
       -o /usr/local/bin/fuse-overlayfs \
    && chmod +x /usr/local/bin/fuse-overlayfs
```

#### 3.1.4 预装包列表

预装包列表根据以下维度确定：

1. **频率**：SaaS 平台用户 install 频率 Top 50
2. **体积**：优先预装体积大的包（如 esbuild，含 native binary）
3. **模板**：内置项目模板（vite-react、next.js）的核心依赖

初始列表：

```
# 框架 & 核心库
react, react-dom, next, express, vue, @angular/core

# 构建工具
vite, @vitejs/plugin-react, webpack, esbuild

# TypeScript
typescript, @types/react, @types/react-dom, @types/node

# 代码质量
eslint, typescript-eslint, prettier

# 样式
tailwindcss, postcss, autoprefixer

# 工具
lodash, axios, dayjs, zod

# 测试
vitest, jest, @testing-library/react
```

#### 3.1.5 目录结构

镜像构建后的目录结构：

```
/opt/package-cache-base/
  ├── pnpm-store/
  │     ├── v3/files/...         (content-addressable files)
  │     └── v3/metadata/...
  └── npm/
        └── _cacache/
              ├── content-v2/sha512/...
              └── index-v5/...
```

### 3.2 Sandbox 镜像 entrypoint 修改

在 `code-interpreter.sh`（或自定义 entrypoint）中添加 OverlayFS 挂载逻辑：

```bash
#!/bin/bash

# ========== OverlayFS Package Cache Setup ==========
CACHE_BASE="/opt/package-cache-base"
CACHE_MERGED="${OPENCODE_PACKAGE_CACHE_MOUNT:-/xybot-front/cache}"
CACHE_UPPER="/xybot-front/cache-upper"
CACHE_WORK="/tmp/package-cache-work"

if [ -d "$CACHE_BASE" ]; then
    mkdir -p "$CACHE_UPPER" "$CACHE_WORK" "$CACHE_MERGED"

    # 尝试内核 overlayfs（需要 CAP_SYS_ADMIN）
    if mount -t overlay overlay \
        -o "lowerdir=$CACHE_BASE,upperdir=$CACHE_UPPER,workdir=$CACHE_WORK" \
        "$CACHE_MERGED" 2>/dev/null; then
        echo "[overlayfs] kernel overlay mounted at $CACHE_MERGED"
    # 降级到 fuse-overlayfs（无需特权）
    elif fuse-overlayfs -o "lowerdir=$CACHE_BASE,upperdir=$CACHE_UPPER,workdir=$CACHE_WORK" \
        "$CACHE_MERGED" 2>/dev/null; then
        echo "[overlayfs] fuse-overlayfs mounted at $CACHE_MERGED"
    else
        # 降级：不做 overlay，直接使用 PVC 路径
        echo "[overlayfs] mount failed, falling back to direct PVC cache"
        # 将镜像预装内容复制到 PVC（一次性）
        if [ ! -f "$CACHE_MERGED/.overlay-base-copied" ]; then
            cp -a "$CACHE_BASE"/* "$CACHE_MERGED"/ 2>/dev/null
            touch "$CACHE_MERGED/.overlay-base-copied"
            echo "[overlayfs] pre-populated cache from image layer"
        fi
    fi
fi

# ========== 原有 entrypoint 继续执行 ==========
exec /opt/opensandbox/code-interpreter.sh "$@"
```

### 3.3 `packages/opencode/src/tool/sandbox-provider.ts`（Volume 调整）

现有 `buildVolumes()` 需要为 OverlayFS upper 层添加 PVC volume：

```typescript
if (config.volumeType === "pvc") {
  // 现有：共享 package cache（OverlayFS merged 挂载点）
  result.push({
    name: "package-cache",
    mountPath: config.packageCacheMount, // /xybot-front/cache
    subPath: "shared/package-cache",
    pvc: { claimName: config.pvcClaimName },
  })

  // 新增：OverlayFS upper 层（每个 session 独立）
  // 用途：存储 session 安装的新包（不在镜像预装列表中的）
  result.push({
    name: "package-cache-upper",
    mountPath: "/xybot-front/cache-upper",
    subPath: `${prefix}/cache-upper`,
    pvc: { claimName: config.pvcClaimName },
  })
}
```

> **为什么 upper 层按 session 隔离？**
> 
> OverlayFS upper 层是可写的，如果多个 session 共享同一个 upper 目录：
> - 并发写冲突（两个 session 同时安装不同的包）
> - 一个 session 删除包会影响其他 session（whiteout 文件）
> 
> 按 session 隔离 upper 层，每个 session 有独立的可写视图，互不干扰。

### 3.4 K8s SecurityContext

内核 overlayfs 需要 `CAP_SYS_ADMIN`：

```yaml
securityContext:
  capabilities:
    add:
      - SYS_ADMIN
```

如果 K8s 策略不允许 `SYS_ADMIN`，使用 `fuse-overlayfs` 降级方案（无需特权），但需要：

```yaml
securityContext:
  # fuse-overlayfs 不需要额外 capability
  # 但需要 /dev/fuse 设备
devices:
  - /dev/fuse
```

### 3.5 降级策略

| 条件 | 行为 |
|------|------|
| 内核 overlay + `SYS_ADMIN` | 最佳性能，overlay 挂载 |
| fuse-overlayfs 可用 | 次佳性能，用户态 overlay |
| 都不可用 | 降级：首次启动时 `cp -a` 预装内容到 PVC，后续等同现有共享 cache |

## 4. 数据流

### 4.1 pnpm install 数据流（OverlayFS 模式）

```
pnpm install --store-dir /xybot-front/cache/pnpm-store
                          │
                          ▼
                  /xybot-front/cache/ (OverlayFS merged)
                          │
            ┌─────────────┼─────────────┐
            ▼                            ▼
    lower (镜像，只读)              upper (PVC，可写)
    react@18.3.1 ✓                 some-rare-pkg@1.0.0
    vite@5.4.21  ✓                 (新安装的包)
    typescript@5.6.3 ✓
            │                            │
            ▼                            ▼
    本地磁盘读取（快）              PVC 写入
            │                            │
            └─────────────┼─────────────┘
                          ▼
                  硬链接/复制到 node_modules
                  (PVC，但包已在 merged 视图内，
                   同一 overlayfs 文件系统可 hardlink)
```

### 4.2 node_modules 创建速度分析

关键问题：OverlayFS merged view 到 PVC `node_modules` 的 hardlink 是否有效？

- **同一 overlayfs 实例内**：hardlink 有效（内核处理）
- **overlayfs → 外部 PVC 挂载点**：**跨文件系统，hardlink 失败**，pnpm 降级为 copy

这意味着：
- 常用包（在 lower 层）：读快（本地磁盘），但 copy 到 node_modules 仍需 PVC 写
- 不过 **copy 的瓶颈在 PVC 写**，读的 0 开销可减少 ~30% 耗时

**进一步优化（可选）**：把 `node_modules` 也纳入 OverlayFS：

```
/workspace/app/node_modules/
  ├── lower = /opt/prebuilt-modules/vite-react-ts  (镜像预装)
  ├── upper = PVC session 私有
  └── merged
```

这样常用模板的 `node_modules` 完全从镜像层读取，**零 I/O**。但这增加了复杂度，建议作为二期优化。

## 5. 常用包维护

### 5.1 包列表来源

```bash
# 统计平台用户 install 频率（从 exec API 日志分析）
grep -oP '(?<=install )\S+' /var/log/opencode/exec.log \
  | sort | uniq -c | sort -rn | head -50
```

### 5.2 自动更新流程

```
每周定时任务
  → 分析用户 install 日志
  → 生成 Top 50 包列表
  → 重新构建 sandbox 镜像
  → 推送到 registry
  → 新 session 自动使用新镜像
```

### 5.3 包版本策略

- 使用 major range（如 `react@18`）而非精确版本
- 预装 latest minor/patch
- pnpm store 支持 content-addressable，同一包不同版本共存

## 6. 改动量估算

| 文件 | 改动 |
|------|------|
| `packages/opencode/Dockerfile` | +30 行（预装 pnpm store + npm cache + fuse-overlayfs） |
| sandbox entrypoint 脚本 | +40 行（OverlayFS 挂载逻辑 + 降级） |
| `packages/opencode/src/tool/sandbox-provider.ts` | +8 行（upper 层 volume） |
| `packages/opencode/test/tool/sandbox-pvc.test.ts` | +20 行（overlay volume 测试） |
| K8s deployment manifest | +3 行（securityContext） |
| **合计** | ~100 行 |

## 7. 验证步骤

### 7.1 镜像验证

```bash
# 构建镜像
docker build -t opencode-sandbox:overlayfs -f packages/opencode/Dockerfile packages/opencode

# 验证预装内容
docker run --rm opencode-sandbox:overlayfs ls -la /opt/package-cache-base/pnpm-store/
docker run --rm opencode-sandbox:overlayfs ls -la /opt/package-cache-base/npm/

# 验证 OverlayFS 挂载（需要 --privileged 或 --cap-add SYS_ADMIN）
docker run --rm --privileged opencode-sandbox:overlayfs \
  bash -c 'mount -t overlay overlay -o lowerdir=/opt/package-cache-base,upperdir=/tmp/upper,workdir=/tmp/work /xybot-front/cache && ls /xybot-front/cache/pnpm-store/'
```

### 7.2 功能验证

```bash
# 创建 session，执行 pnpm install（常用包）
curl -s -X POST "$BASE/session/$SID/exec" \
  -d '{"command":"cd /workspace && npx create-vite@5 app --template react-ts && cd app && pnpm approve-builds esbuild && time pnpm install --store-dir /xybot-front/cache/pnpm-store 2>&1"}'

# 期望：<3s（全部命中镜像层）

# 删除 node_modules 重装
curl -s -X POST "$BASE/session/$SID/exec" \
  -d '{"command":"cd /workspace/app && rm -rf node_modules && time pnpm install --store-dir /xybot-front/cache/pnpm-store 2>&1"}'

# 期望：<3s

# 安装非常用包
curl -s -X POST "$BASE/session/$SID/exec" \
  -d '{"command":"cd /workspace/app && time npm install d3 --cache /xybot-front/cache/npm 2>&1"}'

# 期望：d3 走网络下载 + PVC upper 写入，但后续 session 再安装 d3 可从 PVC upper 命中
```

### 7.3 降级验证

```bash
# 不加 SYS_ADMIN capability 启动
# 验证降级到 fuse-overlayfs 或 cp -a 模式
```

## 8. 风险与应对

| 风险 | 影响 | 应对 |
|------|------|------|
| K8s 不允许 `SYS_ADMIN` | 内核 overlay 不可用 | fuse-overlayfs 降级 |
| fuse-overlayfs 也不可用 | OverlayFS 完全不可用 | cp -a 降级（等同现有方案） |
| 镜像体积增大 300-500MB | 拉取时间增加 | 增量构建 + 镜像层缓存 |
| upper 层 PVC 空间增长 | 长期存储消耗 | 定期清理 upper 层（保留 lower 层已有包的 whiteout 清理） |
| overlayfs 内核兼容性 | 某些 K8s 节点内核版本低 | 降级链保证基本可用 |
| pnpm hardlink 跨 overlay 失败 | 退化为 copy，略慢 | copy 仍比 PVC 读 + hardlink 快（读来自本地磁盘） |

## 9. 不涉及

| 不做 | 原因 |
|------|------|
| yarn / bun 支持 | 用户明确只需 npm + pnpm |
| node_modules OverlayFS | 二期优化，增加复杂度 |
| 自动分析用户 install 日志 | 后续独立实现 |
| host 模式支持 | 只考虑 PVC 模式 |
| CI 自动重建镜像 | 后续接入 |

## 10. 后续扩展（本次不做）

- **node_modules OverlayFS**：常用模板预装 node_modules，零 I/O
- **自动热度分析**：每周统计用户 install 频率，自动更新预装列表
- **CI 自动重建镜像**：热度列表变化时触发镜像重建
- **upper 层合并清理**：定期将 upper 层内容合并到新的基础镜像层，清理 PVC 空间
