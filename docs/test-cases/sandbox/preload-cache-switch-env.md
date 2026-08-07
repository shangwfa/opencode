# 环境切换与预装依赖缓存

> 公共测试环境和配置请参考 [`00-preamble.md`](./00-preamble.md)。
> 实现详见 [`../../packages/opencode/docker/README.md`](../../packages/opencode/docker/README.md)。
>
> **分工**（2026-07-17 去重）：本文档只保留**远端环境特有**用例——mise 版本切换（一）、NFS 环境影响（三）、远端隔离稳定性（四）。pnpm store 的**功能验证**（配置/首次/重装命中/并发/node_modules 隔离）统一由 [`23-package-cache.md`](./23-package-cache.md)（T23.x）覆盖；原 T24.11-T24.13、T24.21、T24.22 已归并删除，编号保留断档。

## 二十四、环境切换与预装依赖缓存（pnpm）

> 前置条件：沙箱镜像已构建，通过 [mise](https://mise.jdx.dev/) 预装 Node 18/20/22/24 + pnpm 8/9/10/11（默认 node@24 + pnpm@10），使用 shims 模式自动路由版本。
> pnpm store 预装在 `/opt/pnpm-store`（镜像层），virtual-store 配置为 `/tmp/pnpm-vs`（overlay 本地盘），NFS 环境下所有 IO 在本地盘完成。
>
> ```bash
> BASE="https://test-opencode.shadow-rpa.net"
> API_KEY="H68idVYzjadx"
> ```
>
> 测试环境：test-opencode.shadow-rpa.net 远端测试环境（`/workspace` 为 NFS4 PVC 挂载）。
>
> 每个测试用例使用独立 session，不复用 session ID。

---

## 一、环境切换（mise shims）

### T24.1 mise 安装与预装版本

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" \
  -d '{"command":"mise --version && echo --- && mise ls"}'
```

**期望**：
1. mise 已安装
2. node 列出 18, 20, 22, 24 四个版本
3. pnpm（npm:pnpm）列出 8, 9, 10, 11 四个版本

> **远端测试**（2026-06-11）：PASS
> - mise 2026.6.2
> - node: 18.20.8, 20.20.2, 22.22.3, 24.16.0
> - npm:pnpm: 8.15.9, 9.15.9, 10.34.1, 11.5.2

---

### T24.2 默认版本验证

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --max-time 15 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" \
  -d '{"command":"node --version && pnpm --version && npm config get registry"}'
```

**期望**：
- Node v24.x（默认）
- pnpm 10.x（默认）
- npm registry = `https://registry.npmmirror.com`

> **远端测试**（2026-06-11）：PASS — v24.16.0, pnpm@10.34.1, registry.npmmirror.com

---

### T24.3 mise use 切换 Node 版本

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" \
  -d '{"command":"node --version && cd /workspace && mise use node@20 && node --version"}'
```

**期望**：默认 v24.x → 切换后 v20.x

> **远端测试**（2026-06-11）：PASS — v24.16.0 → v20.20.2

---

### T24.4 mise use 切换 pnpm 版本

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" \
  -d '{"command":"pnpm --version && cd /workspace && mise use npm:pnpm@9 && pnpm --version"}'
```

**期望**：默认 10.x → 切换后 9.x

> **远端测试**（2026-06-11）：PASS — 10.34.1 → 9.15.9

---

### T24.5 .nvmrc 自动检测（shims）

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" \
  -d '{"command":"mkdir -p /workspace/nvmrc-test && echo 20 > /workspace/nvmrc-test/.nvmrc && cd /workspace/nvmrc-test && node --version"}'
```

**期望**：shims 检测 `.nvmrc`，node --version 输出 v20.x

> **远端测试**（2026-06-11）：PASS — v20.20.2

---

### T24.6 .node-version 自动检测（shims）

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" \
  -d '{"command":"mkdir -p /workspace/nodeversion-test && echo 22 > /workspace/nodeversion-test/.node-version && cd /workspace/nodeversion-test && node --version"}'
```

**期望**：shims 检测 `.node-version`，node --version 输出 v22.x

> **远端测试**（2026-06-11）：⚠️ NOTE — `.node-version` 不生效（`mise.toml` 优先级更高，与 99-acceptance-status 一致）

---

### T24.7 mise.toml 自动检测（shims）

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" \
  -d '{"command":"mkdir -p /workspace/mise-test && printf \"[tools]\\nnode = \\\"18\\\"\\n\\\"npm:pnpm\\\" = \\\"8\\\"\\n\" > /workspace/mise-test/mise.toml && cd /workspace/mise-test && node --version && pnpm --version"}'
```

**期望**：node v18.x, pnpm 8.x

> **远端测试**（2026-06-11）：PASS — v18.20.8, 8.15.9

---

### T24.8 切换版本后 pnpm install 正常

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --max-time 120 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" \
  -d '{"command":"cd /workspace && mise use node@20 npm:pnpm@9 && node --version && pnpm --version && npm create vite@5 switch-test -- --template react-ts 2>&1 | tail -1 && cd switch-test && pnpm install 2>&1 | grep -E \"reused|downloaded|Packages|done|ERR\""}'
```

**期望**：node v20.x + pnpm 9.x，pnpm install 成功，无 ERR

> **远端测试**（2026-06-11）：PASS — node@20 + pnpm@9, 174 packages

---

### T24.9 不同 session 版本独立

```bash
SID_A=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
SID_B=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# Session A: 切换到 node@18
curl -s --max-time 30 -X POST "$BASE/session/$SID_A/exec" \
  -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" \
  -d '{"command":"cd /workspace && mise use node@18 && node --version"}'

# Session B: 检查仍为默认版本
curl -s --max-time 15 -X POST "$BASE/session/$SID_B/exec" \
  -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" \
  -d '{"command":"node --version"}'
```

**期望**：Session A v18.x，Session B v24.x（不受影响）

> **远端测试**（2026-06-11）：PASS — A→v18.20.8, B→v24.16.0

---

### T24.10 全局工具可用性（supergateway + ripgrep）

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" \
  -d '{"command":"which supergateway && supergateway --help 2>&1 | head -1 && which rg && rg --version | head -1"}'
```

**期望**：supergateway 和 ripgrep 均可执行

> **远端测试**（2026-06-11）：PASS — supergateway in mise shims, rg 14.1.0

---

## 二、pnpm store 预装缓存

> pnpm store 配置：
> - `store-dir` = `/opt/pnpm-store`（镜像层 overlay，读快）
> - `virtual-store-dir` = `/tmp/pnpm-vs`（overlay 本地盘，写快）
> - 两者同文件系统 → hardlink 生效，NFS 上只有轻量 symlink

### T24.14 不匹配项目 pnpm install（express）

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --max-time 120 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" \
  -d '{"command":"mkdir -p /workspace/express-test && cd /workspace/express-test && echo \"{\\\"name\\\":\\\"express-test\\\",\\\"dependencies\\\":{\\\"express\\\":\\\"^4.21.0\\\"}}\" > package.json && time pnpm install 2>&1 | grep -E \"reused|downloaded|Packages|Done|real|ERR\""}'
```

**期望**：pnpm install 成功，无 ERR

> **远端测试**（2026-06-11）：PASS — reused 4, downloaded 64, 68 packages, **2.7s**

---

### T24.15 store → virtual-store hardlink 验证

验证 `/opt/pnpm-store` 和 `/tmp/pnpm-vs` 在同一文件系统（overlay），hardlink 生效。

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --max-time 120 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" \
  -d '{"command":"cd /workspace && npm create vite@5 hl-test -- --template react-ts 2>&1 | tail -1 && cd hl-test && pnpm install 2>&1 | tail -1 && echo \"=== store/vs 同文件系统 ===\" && df -T /opt/pnpm-store /tmp/pnpm-vs 2>/dev/null | awk \"NR>1{print \\$2,\\$NF}\" && echo \"=== hardlink 数 ===\" && VS_FILE=$(find /tmp/pnpm-vs -name \"index.js\" -path \"*/react/*\" 2>/dev/null | head -1) && stat -c \"inode=%i hardlinks=%h\" \"$VS_FILE\" 2>/dev/null"}'
```

**期望**：
1. store 和 virtual-store 都在 overlay 文件系统
2. virtual-store 中的文件 hardlinks=2（一个 store，一个 virtual-store）

> **远端测试**（2026-06-11）：PASS — 两者均 overlay，hardlinks=2

---

### T24.16 pnpm install 后 build 能跑通

验证 pnpm install 完成后，项目可以正常 build。

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --max-time 120 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" \
  -d '{"command":"cd /workspace && npm create vite@5 build-test -- --template react-ts 2>&1 | tail -1 && cd build-test && pnpm install 2>&1 | tail -1 && time pnpm build 2>&1 | tail -5 && du -sh dist/"}'
```

**期望**：build 成功，dist/ 目录存在且有输出

> **远端测试**（2026-06-11）：PASS — vite build 成功，dist/ 160K，耗时 3.9s

---

## 三、NFS 环境不影响 pnpm install

> 背景：`/workspace` 挂载 NFS4 PVC（`172.18.32.8:/middleware/...`），直接写入大量小文件会很慢（60s+）。
> pnpm 的 virtual-store-dir 方案将所有重 IO 放在 overlay 本地盘（`/tmp/pnpm-vs`），NFS 上只写 symlink（< 100K）。

### T24.17 确认 /workspace 是 NFS 挂载

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" \
  -d '{"command":"df -T /workspace /tmp /opt | head -5 && echo --- && mount | grep workspace | head -1"}'
```

**期望**：/workspace 类型为 nfs4，/tmp 和 /opt 为 overlay

> **远端测试**（2026-06-11）：PASS
> - /workspace: nfs4 (`172.18.32.8:/middleware/...`)
> - /tmp, /opt: overlay

---

### T24.18 NFS 上 node_modules 只有 symlink（无重 IO）

验证 pnpm install 后，NFS 上的 node_modules 只有轻量 symlink，真正的包内容在 overlay。

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --max-time 120 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" \
  -d '{"command":"cd /workspace && npm create vite@5 nfs-struct-test -- --template react-ts 2>&1 | tail -1 && cd nfs-struct-test && pnpm install 2>&1 | tail -1 && echo \"=== NFS node_modules 大小 ===\" && du -sh node_modules && echo \"=== symlink 数量 ===\" && find node_modules -maxdepth 2 -type l | wc -l && echo \"=== symlink 指向 ===\" && readlink node_modules/react && echo \"=== virtual-store 大小（overlay）===\" && du -sh /tmp/pnpm-vs && echo \"=== df 确认 virtual-store 在 overlay ===\" && df -T /tmp/pnpm-vs | tail -1"}'
```

**期望**：
1. NFS 上 node_modules < 200K（只有 symlink + metadata）
2. symlink 指向 `/tmp/pnpm-vs/...`（overlay）
3. /tmp/pnpm-vs > 50MB（真正的包内容在 overlay）

> **远端测试**（2026-06-11）：PASS
> - NFS node_modules: **86K**（symlink + .modules.yaml + lock.yaml）
> - symlink 指向: `../../../tmp/pnpm-vs/react@18.3.1/node_modules/react`
> - /tmp/pnpm-vs: **90M**（overlay 本地盘）

---

### T24.19 NFS vs overlay pnpm install 耗时对比

在同一 session 中对比：NFS 目录（/workspace）和 overlay 目录（/tmp）上 pnpm install 的耗时。
由于 virtual-store-dir 和 store-dir 均在 overlay，两者的 pnpm install 耗时应接近。

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --max-time 180 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" \
  -d '{"command":"cd /workspace && npm create vite@5 nfs-perf -- --template react-ts 2>&1 | tail -1 && cd nfs-perf && time pnpm install 2>&1 | grep -E \"Done|real\" && rm -rf node_modules && echo \"=== NFS 重装 ===\" && time pnpm install 2>&1 | grep -E \"Done|real\" && mkdir -p /tmp/overlay-perf && cp package.json pnpm-lock.yaml /tmp/overlay-perf/ && cd /tmp/overlay-perf && rm -rf node_modules /tmp/pnpm-vs && echo \"=== overlay 重装 ===\" && time pnpm install 2>&1 | grep -E \"Done|real\""}'
```

**期望**：NFS 重装与 overlay 重装耗时差距 < 2x（NFS 只写 symlink，无重 IO）

> **远端测试**（2026-06-11）：PASS
> - NFS 首次: **6.8s**, NFS 重装: **2.7s**
> - overlay 首次: **8.7s**, overlay 重装: **1.5s**
> - NFS 重装仅比 overlay 慢 ~1s（symlink 写入开销），无 NFS 小文件风暴

---

### T24.20 pnpm install 三次重装稳定性

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --max-time 120 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" \
  -d '{"command":"cd /workspace && npm create vite@5 stable-test -- --template react-ts 2>&1 | tail -1 && cd stable-test && pnpm install 2>&1 | tail -1 && for i in 1 2 3; do rm -rf node_modules; time pnpm install 2>&1 | grep -E \"Done|real\"; done"}'
```

**期望**：三次重装耗时稳定，均 < 3s

> **远端测试**（2026-06-11）：PASS — **1.6s / 1.6s / 1.6s**（三次稳定）

---

## 四、隔离性与稳定性

### T24.23 /opt/pnpm-store 不可变验证

```bash
SID_A=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
SID_B=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# Session A: 破坏 store
curl -s --max-time 30 -X POST "$BASE/session/$SID_A/exec" \
  -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" \
  -d '{"command":"rm -rf /opt/pnpm-store/v10 && echo DONE_A"}'

# Session B: 检查完整性
curl -s --max-time 30 -X POST "$BASE/session/$SID_B/exec" \
  -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" \
  -d '{"command":"ls /opt/pnpm-store/v10 2>&1 | head -3 && du -sh /opt/pnpm-store"}'
```

**期望**：Session B 的 `/opt/pnpm-store` 完整（镜像层隔离）

> **实测结果**：⚠️ NOTE — `/opt/pnpm-store` root 可写（overlay 层运行时行为，镜像构建时不可变；与 99-acceptance-status 一致）

---

### T24.24 容器可用磁盘空间

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" \
  -d '{"command":"df -h / && echo --- && du -sh /opt/pnpm-store /root/.local/share/mise 2>/dev/null"}'
```

**期望**：根分区可用空间 > 5GB，pnpm store + mise < 1.5GB

> **远端测试**（2026-06-11）：PASS — pnpm-store 190M, mise 839M, 可用 57G

---

## 测试结果汇总

### 环境切换

| 用例 | 结果 | 备注 |
|------|------|------|
| T24.1 mise 安装与预装版本 | PASS | node 18/20/22/24, pnpm 8/9/10/11 |
| T24.2 默认版本验证 | PASS | node@24, pnpm@10, npmmirror |
| T24.3 mise use 切换 Node | PASS | v24 → v20 |
| T24.4 mise use 切换 pnpm | PASS | 10 → 9 |
| T24.5 .nvmrc 自动检测 | PASS | v20.20.2 |
| T24.6 .node-version 自动检测 | ⚠️ NOTE | `.node-version` 不生效（`mise.toml` 优先级更高） |
| T24.7 mise.toml 自动检测 | PASS | node@18 + pnpm@8 |
| T24.8 切换版本后 pnpm install | PASS | node@20 + pnpm@9, 174 packages |
| T24.9 不同 session 版本独立 | PASS | A→v18, B→v24 不受影响 |
| T24.10 全局工具可用性 | PASS | supergateway + rg 14.1.0 |

### pnpm store 预装缓存

| 用例 | 结果 | 备注 |
|------|------|------|
| T24.11 store 配置验证 | ➡️ 归并 T23.1 | 远端实测（2026-06-11）：store-dir + virtual-store-dir 正确, 190MB |
| T24.12 pnpm install 首次 | ➡️ 归并 T23.2 | 远端实测：reused 173/174, **6.8s** |
| T24.13 pnpm 重装 | ➡️ 归并 T23.3 | 远端实测：reused 174/174, **1.5s** |
| T24.14 不匹配项目 fallback | PASS | express 68 packages, **2.7s** |
| T24.15 hardlink 验证 | PASS | overlay 同 fs, hardlinks=2 |
| T24.16 pnpm build 跑通 | PASS | vite build 成功, dist/ 160K, 3.9s |

### NFS 环境不影响

| 用例 | 结果 | 备注 |
|------|------|------|
| T24.17 确认 NFS 挂载 | PASS | /workspace=nfs4, /tmp=/opt=overlay |
| T24.18 NFS node_modules 只有 symlink | PASS | NFS 86K, overlay 90M |
| T24.19 NFS vs overlay 耗时对比 | PASS | NFS 重装 2.7s vs overlay 1.5s, 差距 ~1s |
| T24.20 三次重装稳定性 | PASS | 1.6s / 1.6s / 1.6s |

### 隔离性与稳定性

| 用例 | 结果 | 备注 |
|------|------|------|
| T24.21 多 session 并发 | ➡️ 归并 T23.8 | 远端实测：3 session 并发 install 成功 |
| T24.22 跨 session 独立性 | ➡️ 归并 T23.5 | 远端实测：跨 session 互不可见 |
| T24.23 /opt/pnpm-store 不可变 | 待测试 | |
| T24.24 容器磁盘空间 | PASS | pnpm-store 190M, mise 839M, 可用 57G |
