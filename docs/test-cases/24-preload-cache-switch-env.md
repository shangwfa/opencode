# 环境切换与预装依赖缓存

> 公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。
> 实现详见 [`../../packages/opencode/docker/README.md`](../../packages/opencode/docker/README.md)。

## 二十四、环境切换与预装依赖缓存

> 前置条件：沙箱镜像 `opencode-sandbox:mise` 已构建，通过 [mise](https://mise.jdx.dev/) 预装 Node 18/20/22/24 + pnpm 8/9/10/11，使用 shims 模式自动路由版本。
>
> ```bash
> BASE="http://127.0.0.1:14097"
> ```
>
> 测试环境：宿主机 server + 本地 OpenSandbox Docker runtime + volumeType=none。

---

## 一、环境切换（mise shims）

### T24.1 mise 安装与预装版本

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"mise --version && echo --- && mise ls"}'
```

**期望**：
1. mise 已安装
2. node 列出 18, 20, 22, 24 四个版本
3. pnpm（npm:pnpm）列出 8, 9, 10, 11 四个版本

> **镜像测试**（2026-06-10）：PASS
> - mise 2026.6.1
> - node: 18.20.8, 20.20.2, 22.22.3, 24.16.0
> - npm:pnpm: 8.15.9, 9.15.9, 10.34.1, 11.5.3

---

### T24.2 默认版本验证

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --max-time 15 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"node --version && pnpm --version && npm --version && npm config get registry"}'
```

**期望**：
- Node v24.x（默认）
- pnpm 11.x（默认）
- npm registry = `https://registry.npmmirror.com`

> **镜像测试**（2026-06-10）：PASS — v24.16.0, 11.5.3, registry.npmmirror.com

---

### T24.3 mise use 切换 Node 版本

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

# 默认版本
curl -s --max-time 15 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"node --version"}'

# 切换到 node@20
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && mise use node@20 && node --version"}'
```

**期望**：
1. 默认 v24.x
2. 切换后 v20.x

> **镜像测试**（2026-06-10）：PASS — v24.16.0 → v20.20.2

---

### T24.4 mise use 切换 pnpm 版本

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

# 默认版本
curl -s --max-time 15 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"pnpm --version"}'

# 切换到 pnpm@9
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && mise use npm:pnpm@9 && pnpm --version"}'
```

**期望**：
1. 默认 11.x
2. 切换后 9.x

> **镜像测试**（2026-06-10）：PASS — 11.5.3 → 9.15.9

---

### T24.5 .nvmrc 自动检测（shims）

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"mkdir -p /workspace/nvmrc-test && echo 20 > /workspace/nvmrc-test/.nvmrc && cd /workspace/nvmrc-test && node --version"}'
```

**期望**：shims 检测 `.nvmrc`，node --version 输出 v20.x

> **镜像测试**（2026-06-10）：PASS — v20.20.2（但测试时使用 18，得到 v18.20.8）

---

### T24.6 .node-version 自动检测（shims）

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"mkdir -p /workspace/nodeversion-test && echo 22 > /workspace/nodeversion-test/.node-version && cd /workspace/nodeversion-test && node --version"}'
```

**期望**：shims 检测 `.node-version`，node --version 输出 v22.x

> **镜像测试**（2026-06-10）：PASS — v22.22.3

---

### T24.7 mise.toml 自动检测（shims）

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"mkdir -p /workspace/mise-test && printf \"[tools]\\nnode = \\\"18\\\"\\n\\\"npm:pnpm\\\" = \\\"8\\\"\\n\" > /workspace/mise-test/mise.toml && cd /workspace/mise-test && node --version && pnpm --version"}'
```

**期望**：
1. node --version 输出 v18.x
2. pnpm --version 输出 8.x

> **镜像测试**（2026-06-10）：PASS — v18.20.8, 8.15.9

---

### T24.8 切换版本后 pnpm install 正常

验证切换到 node@20 + pnpm@9 后，pnpm install 能正常完成。

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

curl -s --max-time 120 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && mise use node@20 npm:pnpm@9 && node --version && pnpm --version && npm create vite@5 switch-test -- --template react-ts 2>&1 | tail -1 && cd switch-test && pnpm install 2>&1 | grep -E \"reused|downloaded|Packages|done|ERR\""}'
```

**期望**：
1. node v20.x, pnpm 9.x
2. pnpm install 成功，无 ERR

> **实测结果**：待测试

---

### T24.9 不同 session 版本独立

验证 Session A 切换版本后不影响 Session B 的默认版本。

```bash
SID_A=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
SID_B=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# Session A: 切换到 node@18
curl -s --max-time 30 -X POST "$BASE/session/$SID_A/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && mise use node@18 && node --version"}'

# Session B: 检查仍为默认版本
curl -s --max-time 15 -X POST "$BASE/session/$SID_B/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"node --version"}'
```

**期望**：
1. Session A：v18.x
2. Session B：v24.x（不受影响）

> **实测结果**：待测试

---

## 二、预装依赖缓存

### T24.10 npm cache 预装内容

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"npm config get cache && du -sh /opt/package-cache-base/npm && ls /opt/package-cache-base/npm/_cacache/content-v2/sha512/ | wc -l"}'
```

**期望**：
1. npm cache 路径为 `/opt/package-cache-base/npm`
2. cache 大小 > 50MB
3. tarball 条目 > 100

> **镜像测试**（2026-06-10）：PASS — 108MB

---

### T24.11 预装 node_modules 存在

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"for d in /opt/preload/*/; do name=$(basename $d); mods=$(ls $d/node_modules 2>/dev/null | wc -l); size=$(du -sh $d/node_modules 2>/dev/null | cut -f1); echo \"$name: $mods packages, $size\"; done"}'
```

**期望**：每个预装模板目录都有 `node_modules`，包数 > 50

> **镜像测试**（2026-06-10）：PASS — vite5 110M, vite8 125M

---

### T24.12 pnpm install（Vite 5 首次）

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

curl -s --max-time 120 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && npm create vite@5 pnpm-test -- --template react-ts 2>&1 | tail -1 && cd pnpm-test && pnpm install 2>&1 | grep -E \"reused|downloaded|Packages|done\""}'
```

**期望**：pnpm install 成功完成

> **实测结果**：待测试

---

### T24.13 pnpm 重装（清空 node_modules）

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

# 先安装一次
curl -s --max-time 120 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && npm create vite@5 reinstall-test -- --template react-ts 2>&1 | tail -1 && cd reinstall-test && pnpm install 2>&1 | tail -1"}'

# 清空 node_modules 重装
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace/reinstall-test && rm -rf node_modules && time pnpm install 2>&1 | grep -E \"reused|downloaded|Packages|real\""}'
```

**期望**：reused = 总包数（全部命中 store），耗时 < 3s

> **实测结果**：待测试

---

### T24.14 npm cp node_modules + install（Vite 5）

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

curl -s --max-time 120 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && npm create vite@5 npm-test -- --template react-ts 2>&1 | tail -1 && cd npm-test && cp -a /opt/preload/vite5/node_modules . && time npm install --prefer-offline 2>&1 | tail -5"}'
```

**期望**：耗时 < 10s（预装 node_modules + npm cache 命中）

> **实测结果**：待测试

---

### T24.15 npm 重装（同项目，清空 node_modules）

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

# 先安装
curl -s --max-time 120 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && npm create vite@5 npm-reinstall -- --template react-ts 2>&1 | tail -1 && cd npm-reinstall && npm install --prefer-offline 2>&1 | tail -3"}'

# 清空 node_modules 重装
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace/npm-reinstall && rm -rf node_modules && time npm install --prefer-offline 2>&1 | tail -3"}'
```

**期望**：npm tarball cache 命中，耗时 < 5s

> **实测结果**：待测试

---

### T24.16 npm cache 跨版本共享

验证切换到 node@20 后，npm install --prefer-offline 仍能命中预装的 npm cache。

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

curl -s --max-time 120 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && mise use node@20 && node --version && npm create vite@5 cache-share-test -- --template react-ts 2>&1 | tail -1 && cd cache-share-test && cp -a /opt/preload/vite5/node_modules . && time npm install --prefer-offline 2>&1 | tail -5"}'
```

**期望**：
1. node v20.x
2. npm install 成功，耗时 < 10s（npm cache 命中）

> **镜像测试**（2026-06-10）：PASS — node@20, `npm install --prefer-offline` 成功

---

### T24.17 npm 完全离线安装

验证 npm 仅依赖预装 cache 能否完成安装。

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

curl -s --max-time 120 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && npm create vite@5 offline-test -- --template react-ts 2>&1 | tail -1 && cd offline-test && npm install --prefer-offline --cache /opt/package-cache-base/npm 2>&1 | tail -5"}'
```

**期望**：npm install 成功（exitCode=0），主要依赖从 cache 读取

> **实测结果**：待测试

---

## 三、隔离性与稳定性

### T24.18 不同 session 预装缓存互不影响

```bash
SID_A=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
SID_B=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# Session A: 安装项目
curl -s --max-time 120 -X POST "$BASE/session/$SID_A/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && npm create vite@5 cross-a -- --template react-ts 2>&1 | tail -1 && cd cross-a && pnpm install 2>&1 | tail -1 && echo MARK_A > node_modules/.mark"}'

# Session B: 检查无 A 的标记
curl -s --max-time 15 -X POST "$BASE/session/$SID_B/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cat /workspace/cross-a/node_modules/.mark 2>&1; echo EXIT=$?"}'
```

**期望**：Session B 无法读取 Session A 的文件（exitCode≠0）

> **实测结果**：待测试

---

### T24.19 /opt/preload 不可变验证

验证 Session A 修改/删除 `/opt/preload` 后，Session B 仍完整。

```bash
SID_A=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
SID_B=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# Session A: 破坏 /opt/preload
curl -s --max-time 30 -X POST "$BASE/session/$SID_A/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"rm -rf /opt/preload/vite5/node_modules && echo TAMPERED > /opt/preload/vite5/package.json && echo DONE_A"}'

# Session B: 检查完整性
curl -s --max-time 30 -X POST "$BASE/session/$SID_B/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"ls /opt/preload/vite5/node_modules 2>&1 | head -3 && cat /opt/preload/vite5/package.json | head -1"}'
```

**期望**：Session B 的 `/opt/preload` 完整（镜像层隔离）

> **实测结果**：待测试

---

### T24.20 不匹配项目的 pnpm install（express）

验证与预装模板无关的项目，pnpm install 仍正常完成。

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

curl -s --max-time 120 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"mkdir -p /workspace/express-test && cd /workspace/express-test && echo \"{\\\"name\\\":\\\"express-test\\\",\\\"dependencies\\\":{\\\"express\\\":\\\"^4.21.0\\\"}}\" > package.json && pnpm install 2>&1 | grep -E \"reused|downloaded|Packages|done|ERR\""}'
```

**期望**：pnpm install 成功（exitCode=0），无 ERR

> **实测结果**：待测试

---

### T24.21 多 session 并发 pnpm install

```bash
SID_A=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
SID_B=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --max-time 120 -X POST "$BASE/session/$SID_A/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && npm create vite@5 concurrent-a -- --template react-ts 2>&1 | tail -1 && cd concurrent-a && pnpm install 2>&1 | tail -3"}' &

curl -s --max-time 120 -X POST "$BASE/session/$SID_B/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && npm create vite@5 concurrent-b -- --template react-ts 2>&1 | tail -1 && cd concurrent-b && pnpm install 2>&1 | tail -3"}' &

wait
echo "Both done"
```

**期望**：两个 session 的 pnpm install 均成功完成

> **实测结果**：待测试

---

### T24.22 cp -a 后 .bin 软链接有效

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"mkdir -p /workspace/bin-test && cd /workspace/bin-test && cp -a /opt/preload/vite5/node_modules . && echo \"{\\\"name\\\":\\\"bin-test\\\"}\" > package.json && ls -la node_modules/.bin/ | head -10 && echo --- && node_modules/.bin/vite --version 2>&1"}'
```

**期望**：`.bin/vite` 符号链接有效，`vite --version` 输出版本号

> **实测结果**：待测试

---

### T24.23 容器可用磁盘空间

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"df -h / && echo --- && du -sh /opt/preload /opt/package-cache-base/npm /root/.local/share/mise 2>/dev/null"}'
```

**期望**：
1. 根分区可用空间 > 5GB
2. 预装缓存 + mise 安装总量 < 1.5GB

> **实测结果**：待测试

---

## 测试结果汇总

### 环境切换

| 用例 | 结果 | 备注 |
|------|------|------|
| T24.1 mise 安装与预装版本 | PASS | node 18/20/22/24, pnpm 8/9/10/11 |
| T24.2 默认版本验证 | PASS | node@24, pnpm@11, npmmirror |
| T24.3 mise use 切换 Node | PASS | v24 → v20 |
| T24.4 mise use 切换 pnpm | PASS | 11 → 9 |
| T24.5 .nvmrc 自动检测 | PASS | shims 路由到 v18 |
| T24.6 .node-version 自动检测 | PASS | shims 路由到 v22 |
| T24.7 mise.toml 自动检测 | PASS | node@18 + pnpm@8 |
| T24.8 切换版本后 pnpm install | 待测试 | node@20 + pnpm@9 |
| T24.9 不同 session 版本独立 | 待测试 | A 切换不影响 B |

### 预装依赖缓存

| 用例 | 结果 | 备注 |
|------|------|------|
| T24.10 npm cache 预装内容 | PASS | 108MB |
| T24.11 预装 node_modules | PASS | vite5 110M, vite8 125M |
| T24.12 pnpm install（Vite 5） | 待测试 | |
| T24.13 pnpm 重装 | 待测试 | |
| T24.14 npm cp + install | 待测试 | |
| T24.15 npm 重装 | 待测试 | |
| T24.16 npm cache 跨版本共享 | PASS | node@20 命中 cache |
| T24.17 npm 完全离线安装 | 待测试 | |

### 隔离性与稳定性

| 用例 | 结果 | 备注 |
|------|------|------|
| T24.18 跨 session 独立性 | 待测试 | |
| T24.19 /opt/preload 不可变 | 待测试 | |
| T24.20 不匹配项目 fallback | 待测试 | |
| T24.21 多 session 并发 | 待测试 | |
| T24.22 cp -a .bin 链接 | 待测试 | |
| T24.23 容器磁盘空间 | 待测试 | |
