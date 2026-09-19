# Sandbox 镜像 — 多版本运行时 + 预装依赖缓存

OpenSandbox 沙箱容器镜像，基于 `opensandbox/code-interpreter:latest`。
通过 [mise](https://mise.jdx.dev/) 管理多版本 Node.js / pnpm，并预装 npm 依赖缓存以加速项目初始化。

## 目录结构

```
docker/
├── Dockerfile                  # 沙箱镜像构建文件
├── README.md                   # 本文档
├── package.json                # pnpm workspace root（构建时用）
├── pnpm-workspace.yaml         # workspace 配置
└── packages/                   # 模板项目（每个子目录 = 一个模板）
    ├── vite5/
    │   ├── package.json
    │   └── package-lock.json
    └── vite8/
        ├── package.json
        └── package-lock.json
```

## 版本管理（mise）

使用 [mise](https://mise.jdx.dev/) 的 **shims 模式**管理运行时版本。
shims 放在 `~/.local/share/mise/shims/`，PATH 最前面。
调用 `node`/`pnpm` 时，shim 自动检测当前目录的版本文件，路由到正确版本的二进制。

### 预装版本

| 工具 | 预装版本 | 默认版本 |
|------|---------|---------|
| Node.js | 18, 20, 22, 24 | 24 |
| pnpm | 8, 9, 10, 11 | 11 |

### 版本切换

通过 exec 接口执行命令切换版本：

```bash
# 方式一：mise use（修改当前目录的 mise.toml）
cd /workspace && mise use node@20 pnpm@9

# 方式二：mise install + mise.toml（项目已有版本声明）
cd /workspace && mise install

# 方式三：直接设置环境变量（临时生效）
MISE_NODE_VERSION=20 node -v
```

### 版本文件检测（自动）

mise 支持检测以下版本文件（已全部启用）：

| 文件 | 示例 |
|------|------|
| `mise.toml` | `[tools] node = "20"` |
| `.tool-versions` | `node 20.18.0` |
| `.nvmrc` | `20` |
| `.node-version` | `20.18.0` |
| `package.json` `devEngines` | `"devEngines": { "node": "20" }` |

shims 在每次调用时自动检测，无需 shell hook。

## 预装缓存

### npm cache — tarball 缓存（通用）

npm cache 目录设为 `/opt/package-cache-base/npm`，构建时已填充所有模板的 tarball。
**tarball 缓存不依赖 node/pnpm 版本，所有版本共享。**

### npm — 预装 node_modules

构建时对每个模板项目执行 `npm install`，将完整的 `node_modules` 保存到镜像内：

```
/opt/preload/<template>/node_modules   # 预装的 node_modules
/opt/preload/<template>/package.json
/opt/preload/<template>/package-lock.json
```

使用方式：

```bash
cp -a /opt/preload/vite5/node_modules .
npm install --prefer-offline   # 只补差异包，跳过已有包
```

### pnpm store — 不预装

pnpm store 格式跨版本不兼容（v3 / v10 / v11 各不相同），不预装。
pnpm install 时依赖 npm cache 中的 tarball 减少网络下载。

## 镜像内缓存清单

| 路径 | 用途 | 大小（参考） |
|------|------|-------------|
| `/opt/preload/<template>/node_modules` | npm 预装 node_modules | 每个 100-120MB |
| `/opt/package-cache-base/npm` | npm tarball cache（通用） | ~85MB |
| `/root/.local/share/mise/installs/node/*` | mise 管理的 Node.js 版本 | 每个 ~80MB |
| `/root/.local/share/mise/installs/pnpm/*` | mise 管理的 pnpm 版本 | 每个 ~5MB |

## 构建命令

```bash
cd packages/opencode

docker build \
  -t opencode-sandbox:mise \
  -f docker/Dockerfile \
  .
```

## 添加新模板项目

1. 在 `packages/` 下创建新目录，放入 `package.json` 和 `package-lock.json`

```
packages/
└── next15/
    ├── package.json
    └── package-lock.json
```

2. 重新构建镜像

### 生成 lockfile

```bash
cd packages/next15
npm install --ignore-scripts --cache /tmp/npm-cache-tmp
# package-lock.json 自动生成
```

## 与旧方案的区别

| | 旧方案 | 新方案 |
|---|---|---|
| 版本管理 | 固定 Node v24 + corepack + pnpm 11 | mise 管理多版本 Node + pnpm |
| 版本切换 | 不支持 | `mise use node@20 pnpm@9` |
| pnpm 来源 | corepack | mise（独立安装） |
| pnpm store 预装 | 是（~220MB） | 否（格式跨版本不兼容） |
| npm cache 预装 | 是 | 是（通用，不变） |
| node_modules 预装 | 是 | 是（不变） |
| 版本文件检测 | 无 | `.nvmrc` / `.node-version` / `mise.toml` / `.tool-versions` |

## 注意事项

- 镜像基于 `opensandbox/code-interpreter:latest`（~10GB），包含 Python/Java/Go/Node 等完整运行时
- 预装 4 个 Node 版本 + 4 个 pnpm 版本约增加 ~340MB
- npm registry 设为 `https://registry.npmmirror.com`
- 模板项目的 lockfile 应定期更新以保持缓存新鲜度
- pnpm 11 要求 Node.js 22+，如果项目用 node@18 + pnpm@11 会报错（mise 不干预这种组合）
