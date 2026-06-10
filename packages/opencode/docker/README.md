# Sandbox 镜像 — 预装依赖缓存

OpenSandbox 沙箱容器镜像，基于 `opensandbox/code-interpreter:latest`，预装 npm/pnpm 依赖缓存以加速项目初始化。

## 目录结构

```
docker/
├── Dockerfile                  # 沙箱镜像构建文件
├── README.md                   # 本文档
├── sandbox-entrypoint.sh       # OverlayFS 挂载 + 原始 entrypoint 透传
├── package.json                # pnpm workspace root
├── pnpm-workspace.yaml         # workspace 配置
└── packages/                   # 模板项目（每个子目录 = 一个模板）
    └── vite5/
        ├── package.json        # 模板依赖声明
        └── package-lock.json   # npm 锁文件（锁定精确版本）
```

## 预装策略

### npm — 预装 node_modules

构建时对每个模板项目执行 `npm install`，将完整的 `node_modules` 保存到镜像内：

```
/opt/preload/<template>/node_modules   # 预装的 node_modules（只读）
/opt/preload/<template>/package.json   # 模板 package.json
/opt/preload/<template>/package-lock.json
```

用户在 sandbox 中创建匹配的项目后，复制 `node_modules` 再增量安装：

```bash
cp -a /opt/preload/vite5/node_modules .
npm install --prefer-offline   # 只补差异包，跳过已有包
```

### pnpm — 预装 store

构建时通过 `pnpm install`（workspace 模式）将所有模板依赖填充到 pnpm 默认 store：

```
/root/.local/share/pnpm/store/v11/    # pnpm store（hardlink 源）
```

用户在 sandbox 中 `pnpm install` 时，store 命中的包直接 hardlink，无需下载。

### npm cache — tarball 缓存

npm 默认 cache 目录设为 `/opt/package-cache-base/npm`，构建时已填充所有模板的 tarball。未命中 store 的包从本地 cache 读取，避免网络下载。

## 镜像内缓存清单

| 路径 | 用途 | 大小（参考） |
|------|------|-------------|
| `/opt/preload/<template>/node_modules` | npm 预装 node_modules | 每个 100-120MB |
| `/root/.local/share/pnpm/store/v11` | pnpm store（hardlink） | ~220MB |
| `/opt/package-cache-base/npm` | npm tarball cache | ~85MB |

## 构建命令

```bash
cd packages/opencode

docker build \
  -t opencode-sandbox:overlayfs-test \
  -f docker/Dockerfile \
  .
```

构建时间约 40-60s（BuildKit cache mount 加速），首次约 5-10 分钟。

## 添加新模板项目

1. 在 `packages/` 下创建新目录，放入 `package.json` 和 `package-lock.json`

```
packages/
└── next15/
    ├── package.json
    └── package-lock.json
```

2. 重新构建镜像

```bash
docker build -t opencode-sandbox:overlayfs-test -f docker/Dockerfile .
```

新模板的 `node_modules` 和 pnpm store 会自动包含在镜像中。

### 生成 lockfile

npm lockfile 需要在本机生成后放入目录：

```bash
cd packages/next15
npm install --ignore-scripts --cache /tmp/npm-cache-tmp
# package-lock.json 自动生成
```

pnpm lockfile 由 Dockerfile 内 `pnpm install` 自动生成（workspace 级别），无需手动管理。

> **注意**：本地 pnpm 版本可能与镜像内版本不同，lockfile 可能不兼容。镜像构建时会自动重新解析。提供真实 lockfile 后可改用 `--frozen-lockfile` 锁定版本。

## OverlayFS（PVC 模式）

`sandbox-entrypoint.sh` 提供 OverlayFS 三级降级，用于 PVC 持久化场景：

1. **kernel overlay**（需要 `CAP_SYS_ADMIN`）
2. **fuse-overlayfs**（用户态，无需特权）
3. **cp -a**（直接复制，兜底方案）

降级到 cp -a 时，首次启动会将 `/opt/package-cache-base` 复制到 PVC 挂载点，后续启动跳过。

> 在本地 Docker 测试中，OpenSandbox 会覆盖 entrypoint 为 `/opt/opensandbox/bootstrap.sh`，因此 OverlayFS 挂载不会触发。OverlayFS 主要为远端 K8s 环境设计。

## 性能对比

基于 Vite 5 + React 18 + TypeScript 模板测试：

| 场景 | 包管理器 | 优化前 | 优化后 | 提升 |
|------|---------|--------|--------|------|
| 新项目首次 install | pnpm | 24s（downloaded 204） | ~10s（reused 190, downloaded 14） | 58% |
| 清空 node_modules 重装 | pnpm | 24s | 1.7s（reused 204） | 93% |
| cp node_modules + npm install | npm | 25s | 4.5s | 82% |
| npm 重装（同 lockfile） | npm | 25s | 3.9s | 84% |

## 注意事项

- 镜像基于 `opensandbox/code-interpreter:latest`（~10GB），包含 Python/Java/Go/Node 等完整运行时
- 预装缓存会增加镜像约 300-500MB
- npm registry 已设为 `https://registry.npmmirror.com`
- Node.js 版本 v24，pnpm 11.5.2
- 模板项目的 lockfile 应定期更新以保持缓存新鲜度
