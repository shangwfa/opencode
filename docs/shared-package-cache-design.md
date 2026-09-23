# 共享 Package Cache 技术方案

> 分支：`feat/share-packages`
> 状态：设计中

## 1. 背景

SaaS 模式下，每个 sandbox session 首次执行 `npm install` / `pnpm install` / `yarn install` / `bun install` 时，需要从远端 registry 下载全部依赖。即使多个 session 安装相同依赖（如 `react`、`vite`），也无法复用已下载的包，导致：

1. **安装速度慢**：每次完整下载，无缓存命中
2. **带宽浪费**：相同包重复下载
3. **用户体验差**：用户等待时间长

### 现状

- 每个 sandbox session 挂载 6 个 PVC subPath（workspace、home、cache、config、local、tmp），按 sessionID 隔离
- `/home/sandbox/.cache` 是 session 私有的，sandbox 销毁后缓存丢失
- 无跨 session 共享缓存机制

### 目标

- PVC 模式下，所有 session 共享一个 package manager cache/store 目录
- 挂载路径默认 `/xybot-front/cache`
- 每个 session 仍保留独立 `/workspace` 和独立 `node_modules`
- 不需要 enabled flag，PVC 模式自动开启

## 2. 方案设计

### 2.1 核心思路

在现有 `buildVolumes()` 中，PVC 模式下额外追加一个 **共享 volume**，其 `subPath` 不含 sessionID，所有 session 读写同一目录。

```
┌─────────────────────────────────────────────────────┐
│  PVC (sandbox-test)                                  │
│                                                      │
│  sessions/ses_abc/workspace/     ← session 私有      │
│  sessions/ses_abc/home/          ← session 私有      │
│  sessions/ses_abc/.cache/        ← session 私有      │
│  ...                                                 │
│  sessions/ses_xyz/workspace/     ← session 私有      │
│  sessions/ses_xyz/home/          ← session 私有      │
│  ...                                                 │
│                                                      │
│  shared/package-cache/           ← 全局共享（新增）   │
│    ├── npm/                                          │
│    ├── pnpm-store/                                   │
│    ├── yarn/                                         │
│    └── bun/                                          │
└─────────────────────────────────────────────────────┘
```

### 2.2 共享 Volume 定义

```typescript
{
  name: "package-cache",
  mountPath: config.packageCacheMount,   // 默认 "/xybot-front/cache"
  subPath: "shared/package-cache",        // PVC 内固定路径，所有 session 共享
  pvc: { claimName: config.pvcClaimName } // 复用同一个 PVC
}
```

- `subPath` 为 `shared/package-cache`（固定值），不包含 sessionID
- 所有 session 挂载同一个 PVC 的同一个 subPath → 自动共享
- 复用现有 PVC claim，不需要单独创建 PVC

### 2.3 与现有 Volume 的关系

| Volume | subPath | 作用 | 隔离 |
|--------|---------|------|------|
| workspace | `sessions/{sessionID}/workspace` | 项目代码 | session 私有 |
| home | `sessions/{sessionID}/home` | 用户主目录 | session 私有 |
| cache | `sessions/{sessionID}/cache` | 用户缓存 | session 私有 |
| config | `sessions/{sessionID}/config` | 用户配置 | session 私有 |
| local | `sessions/{sessionID}/local` | 用户本地数据 | session 私有 |
| tmp | `sessions/{sessionID}/tmp` | 临时文件 | session 私有 |
| **package-cache（新增）** | `shared/package-cache` | 包管理器缓存 | **全局共享** |

### 2.4 Sandbox 内部目录结构

共享 volume 挂载到 `/xybot-front/cache`，首次 install 时自动创建子目录：

```
/xybot-front/cache/
  ├── npm/                # npm --cache /xybot-front/cache/npm
  ├── pnpm-store/         # pnpm --store-dir /xybot-front/cache/pnpm-store
  ├── yarn/               # yarn --cache-folder /xybot-front/cache/yarn
  └── bun/                # bun --cache-dir /xybot-front/cache/bun
```

子目录由 install 命令参数指定（agent/bash 拼参数时使用），不需要在镜像中预创建。

## 3. 代码改动

### 3.1 `packages/opencode/src/flag/flag.ts`

新增 1 个环境变量：

```typescript
// Sandbox 共享 Package Cache
export const OPENCODE_SANDBOX_PACKAGE_CACHE_MOUNT =
  process.env["OPENCODE_SANDBOX_PACKAGE_CACHE_MOUNT"] ?? "/xybot-front/cache"
```

- 不新增 `ENABLED` flag
- PVC 模式下自动挂载，`volumeType=none` 时不挂载（无 volume 可用）

### 3.2 `packages/opencode/src/tool/sandbox-provider.ts`

#### 3.2.1 `SandboxConfig.Interface` 新增字段

```typescript
export interface Interface {
  // ... 现有字段 ...
  readonly packageCacheMount: string
}
```

#### 3.2.2 `defaultConfig` 新增

```typescript
export const defaultConfig: Interface = {
  // ... 现有配置 ...
  packageCacheMount: Flag.OPENCODE_SANDBOX_PACKAGE_CACHE_MOUNT,
}
```

#### 3.2.3 `buildVolumes()` 修改

```typescript
export function buildVolumes(sessionID: string, config: SandboxConfig.Interface): Volume[] {
  if (config.volumeType === "none") return []

  // 现有 session-scoped volumes（不变）
  const prefix = `sessions/${sessionID}`
  const mounts = [
    { name: "workspace", mountPath: "/workspace", sub: `${prefix}/workspace` },
    { name: "home", mountPath: "/home/sandbox", sub: `${prefix}/home` },
    { name: "cache", mountPath: "/home/sandbox/.cache", sub: `${prefix}/cache` },
    { name: "config", mountPath: "/home/sandbox/.config", sub: `${prefix}/config` },
    { name: "local", mountPath: "/home/sandbox/.local", sub: `${prefix}/local` },
    { name: "tmp", mountPath: "/home/sandbox/tmp", sub: `${prefix}/tmp` },
  ]

  const result = mounts.map((m) => {
    const base: Volume = { name: m.name, mountPath: m.mountPath, subPath: m.sub }
    if (config.volumeType === "pvc") {
      base.pvc = { claimName: config.pvcClaimName }
    } else {
      base.host = { path: `/var/opencode/sessions/${sessionID}/${m.name}` }
    }
    return base
  })

  // 新增：PVC 模式下追加共享 package cache volume
  if (config.volumeType === "pvc") {
    result.push({
      name: "package-cache",
      mountPath: config.packageCacheMount,
      subPath: "shared/package-cache",
      pvc: { claimName: config.pvcClaimName },
    })
  }

  return result
}
```

### 3.3 测试文件更新

以下测试文件中的 `baseConfig` 需要新增 `packageCacheMount` 字段：

| 文件 | 改动 |
|------|------|
| `test/tool/sandbox-pvc.test.ts` | baseConfig 新增 `packageCacheMount: "/xybot-front/cache"`，新增共享 cache 测试 case |
| `test/tool/sandbox-cleanup-volume.test.ts` | 3 个 config 对象各新增 1 行 |
| `test/tool/sandbox-command-queue.test.ts` | 1 个 config 对象新增 1 行 |
| `test/tool/sandbox-provider-pg-e2e.test.ts` | 1 个 config 对象新增 1 行 |

### 3.4 新增测试 case（sandbox-pvc.test.ts）

```typescript
describe("shared package cache", () => {
  const cfg = { ...baseConfig, volumeType: "pvc" as const, pvcClaimName: "my-pvc" }

  test("PVC 模式自动包含共享 package-cache volume", () => {
    const vols = buildVolumes("ses_1", cfg)
    const cache = vols.find((v) => v.name === "package-cache")
    expect(cache).toBeDefined()
    expect(cache!.mountPath).toBe("/xybot-front/cache")
    expect(cache!.subPath).toBe("shared/package-cache")
    expect(cache!.pvc).toEqual({ claimName: "my-pvc" })
  })

  test("所有 session 共享同一个 subPath", () => {
    const a = buildVolumes("ses_aaa", cfg)
    const b = buildVolumes("ses_bbb", cfg)
    const cacheA = a.find((v) => v.name === "package-cache")!
    const cacheB = b.find((v) => v.name === "package-cache")!
    expect(cacheA.subPath).toBe(cacheB.subPath)
  })

  test("volumeType=none 不挂载 package-cache", () => {
    const vols = buildVolumes("ses_1", baseConfig)
    expect(vols.find((v) => v.name === "package-cache")).toBeUndefined()
  })

  test("自定义 mountPath", () => {
    const customCfg = { ...cfg, packageCacheMount: "/custom/cache" }
    const vols = buildVolumes("ses_1", customCfg)
    const cache = vols.find((v) => v.name === "package-cache")!
    expect(cache.mountPath).toBe("/custom/cache")
  })
})
```

## 4. 包管理器使用方式

共享 cache 挂载后，agent/bash 执行 install 命令时应指定 cache/store 路径：

### 4.1 包管理器识别

| Lockfile | 包管理器 |
|----------|---------|
| `pnpm-lock.yaml` | pnpm |
| `yarn.lock` | yarn |
| `bun.lockb` / `bun.lock` | bun |
| `package-lock.json` / `npm-shrinkwrap.json` | npm |
| 无 lockfile | npm |

### 4.2 标准 exec 使用流程

共享 package cache 不自动改写包管理器行为。依赖安装由调用方通过 exec API 执行，并在命令中显式指定 cache/store 路径。

1. 创建 session。
2. 通过 `/session/{sessionID}/exec` 在 `/workspace` 写入或复用项目文件。
3. 根据 lockfile 选择包管理器。
4. 执行下面对应的 install 命令，并显式传入 `/xybot-front/cache/...`。
5. 后续 session 使用同一路径执行 install，即可命中共享缓存。

exec 请求示例：

```bash
curl -s --max-time 180 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && npm install --cache /xybot-front/cache/npm --prefer-offline"}'
```

### 4.3 Install 命令参考

```bash
# npm
npm ci --cache /xybot-front/cache/npm --prefer-offline
npm install --cache /xybot-front/cache/npm --prefer-offline

# pnpm（sandbox 镜像已预装 pnpm）
pnpm install --frozen-lockfile --store-dir /xybot-front/cache/pnpm-store

# yarn Berry 4（sandbox 镜像已预装 yarn）
printf 'cacheFolder: /xybot-front/cache/yarn\nenableGlobalCache: false\n' > .yarnrc.yml && yarn install --immutable

# yarn v1
yarn install --frozen-lockfile --cache-folder /xybot-front/cache/yarn

# bun（sandbox 镜像已预装 bun）
bun install --frozen-lockfile --cache-dir /xybot-front/cache/bun
```

> **注意**：install 命令由 agent/bash 执行，不在本次代码改动范围内。本 PR 只负责提供共享 volume 基础设施。

### 4.4 Mount Path 校验

`OPENCODE_SANDBOX_PACKAGE_CACHE_MOUNT` 必须满足：

- 绝对路径。
- 不能是 `/`。
- 不能与 session volume 挂载路径冲突或互为父子路径。

被拒绝的示例：`""`、`cache`、`/`、`/workspace`、`/workspace/cache`、`/home`、`/home/sandbox/.cache/npm`。

## 5. 不涉及

| 不做 | 原因 |
|------|------|
| `OPENCODE_SANDBOX_PACKAGE_CACHE_ENABLED` flag | 用户明确不需要，PVC 模式默认开启 |
| Dockerfile 修改 | sandbox 镜像已升级 Node v24 LTS，并 pin corepack/pnpm/yarn/bun 版本 |
| install 脚本 | 命令由 agent/bash 拼接，后续可独立优化 |
| host 模式支持 | 只考虑 PVC 模式 |
| 租户隔离 | 所有 session 共享同一个 cache |
| lockfile hash 跳过 install | 后续优化，独立 PR |
| `node_modules` 共享 | 避免路径、postinstall、native binding、并发污染问题 |

## 6. 改动量估算

| 文件 | 改动 |
|------|------|
| `src/flag/flag.ts` | +2 行 |
| `src/tool/sandbox-provider.ts`（Interface + defaultConfig + buildVolumes + mountPath 校验） | +35 行 |
| 4 个测试文件 baseConfig | 各 +1 行 |
| `test/tool/sandbox-pvc.test.ts` 新增 case | +45 行 |
| **合计** | ~75 行 |

## 7. 验证步骤

### 7.1 单元测试

```bash
cd packages/opencode
bun test test/tool/sandbox-pvc.test.ts
bun test test/tool/sandbox-cleanup-volume.test.ts
bun test test/tool/sandbox-command-queue.test.ts
```

### 7.2 本地集成验证

```bash
# 1. 启动 OpenSandbox server
nohup env OPENSANDBOX_INSECURE_SERVER=YES uvx opensandbox-server > /tmp/opensandbox-server.log 2>&1 &

# 2. 启动 opencode server
env OPENCODE_DATABASE_URL='postgresql://app:8zuhlMLd4gaeUG5k@127.0.0.1:15432/opencode' \
  OPENCODE_AUTH_PROVIDER=pg \
  OPENCODE_SANDBOX_ENABLED=1 \
  OPENCODE_SANDBOX_DOMAIN=127.0.0.1:8080 \
  OPENCODE_SANDBOX_IMAGE=opencode-opensandbox:local \
  OPENCODE_SANDBOX_USE_SERVER_PROXY=false \
  OPENCODE_SANDBOX_VOLUME_TYPE=pvc \
  OPENCODE_SANDBOX_PVC_CLAIM=sandbox-test \
  bun run --conditions=browser ./src/index.ts serve --hostname 127.0.0.1 --port 14097 --print-logs --pure

# 3. 创建 session A，执行 npm install
# 4. 创建 session B，执行 npm install（应命中共享缓存，速度更快）
# 5. 检查 PVC 内 /shared/package-cache/ 目录存在且两个 session 可见相同内容
```

## 8. 后续扩展（本次不做）

- **host 模式支持**：`volumeType=host` 时挂载 `/var/opencode/cache`
- **lockfile hash 跳过 install**：检测 lockfile 未变时直接跳过
- **install 封装脚本**：自动识别包管理器并拼 cache 参数
- **租户隔离**：按租户 ID 隔离 cache subPath
- **cache 清理策略**：定期清理过期/无用缓存
