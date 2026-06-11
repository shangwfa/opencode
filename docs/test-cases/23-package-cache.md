# 共享 Package Cache

> 公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。
> 技术方案详见 [`../shared-package-cache-design.md`](../shared-package-cache-design.md)。

## 二十三、共享 Package Cache

> 前置条件：`OPENCODE_SANDBOX_VOLUME_TYPE=pvc`，沙箱镜像基于 Node v24 LTS，预装 `npm`/`pnpm`/`yarn`/`bun`。
>
> ```bash
> BASE="http://127.0.0.1:14097"
> MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'
> ```
>
> 测试环境：宿主机 server + 本地 OpenSandbox Docker runtime + PVC 模式 + Node v24.16.0 LTS 镜像。
> 测试日期：2026-06-08（第三轮，镜像 pin corepack/pnpm/yarn/bun 版本，补充 mountPath 校验）。

### 标准 exec 使用流程

共享 package cache 通过 exec 手动指定 cache/store 参数使用，不自动改写包管理器默认行为。

```bash
# 1. 创建 session
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 2. npm 示例：显式指定共享 cache
curl -s --max-time 180 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && npm install --cache /xybot-front/cache/npm --prefer-offline"}'

# 3. pnpm 示例：显式指定共享 store
curl -s --max-time 180 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && pnpm install --store-dir /xybot-front/cache/pnpm-store"}'

# 4. Yarn Berry 4 示例：写入项目级 cacheFolder
curl -s --max-time 180 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && printf '\''cacheFolder: /xybot-front/cache/yarn\nenableGlobalCache: false\n'\'' > .yarnrc.yml && yarn install"}'

# 5. bun 示例：显式指定共享 cache
curl -s --max-time 180 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && bun install --cache-dir /xybot-front/cache/bun"}'
```

**期望**：后续不同 session 使用相同 cache/store 参数执行 install 时命中共享缓存，`node_modules` 仍保留在各自 session 的 `/workspace` 中。

---

### T23.1 共享 cache 目录可写

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"mkdir -p /xybot-front/cache/test && echo WRITABLE > /xybot-front/cache/test/flag.txt && cat /xybot-front/cache/test/flag.txt"}'
```

**期望**：stdout 输出 `WRITABLE`，exitCode=0

> **实测结果**（2026-06-08）：PASS — stdout=`WRITABLE`，exitCode=0

---

### T23.2 npm cache 挂载验证

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"npm config set cache /xybot-front/cache/npm --global && npm cache ls 2>/dev/null; echo EXIT=$?"}'
```

**期望**：exitCode=0，npm cache 路径指向 `/xybot-front/cache/npm`

> **实测结果**（2026-06-08）：PASS — npm cache path=`/xybot-front/cache/npm`

---

### T23.3 首次 npm install 填充共享 cache

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

# 初始化项目并安装（首次，cache 为空）
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && echo \"{\\\"name\\\":\\\"cache-test\\\",\\\"dependencies\\\":{\\\"lodash\\\":\\\"4.17.21\\\"}}\" > package.json && npm install --cache /xybot-front/cache/npm 2>&1 | tail -5"}'
```

**期望**：安装成功，`/xybot-front/cache/npm` 目录下出现缓存内容

> **实测结果**（2026-06-08 R2）：PASS — lodash install 成功，cache 目录含 `_cacache`/`_logs`，1.2M

验证 cache 内容：
```bash
curl -s --max-time 15 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"ls /xybot-front/cache/npm/ && du -sh /xybot-front/cache/npm/"}'
```

**期望**：cache 目录非空，有实际磁盘占用

---

### T23.4 跨 session 共享 cache（核心验证）

```bash
# Session A：首次 install
SID_A=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID_A: $SID_A"

curl -s --max-time 60 -X POST "$BASE/session/$SID_A/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && echo \"{\\\"name\\\":\\\"cross-test\\\",\\\"dependencies\\\":{\\\"is-even\\\":\\\"1.0.0\\\"}}\" > package.json && npm install --cache /xybot-front/cache/npm --prefer-offline 2>&1 | tail -3"}'

# 记录 Session A 的 cache 大小
CACHE_SIZE_A=$(curl -s --max-time 15 -X POST "$BASE/session/$SID_A/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"du -sb /xybot-front/cache/npm/ | cut -f1"}' | python3 -c "import json,sys;print(json.load(sys.stdin).get('stdout','0').strip())")
echo "Session A cache size: $CACHE_SIZE_A"

# Session B：使用同一 cache 安装同一依赖
SID_B=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID_B: $SID_B"

TIME_START=$(date +%s)
curl -s --max-time 60 -X POST "$BASE/session/$SID_B/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && echo \"{\\\"name\\\":\\\"cross-test\\\",\\\"dependencies\\\":{\\\"is-even\\\":\\\"1.0.0\\\"}}\" > package.json && npm install --cache /xybot-front/cache/npm --prefer-offline 2>&1 | tail -3"}'
TIME_END=$(date +%s)
ELAPSED=$((TIME_END - TIME_START))
echo "Session B install time: ${ELAPED}s"

# 验证 Session B 的 cache 目录与 Session A 共享
curl -s --max-time 15 -X POST "$BASE/session/$SID_B/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"ls /xybot-front/cache/npm/"}'
```

**期望**：
1. Session B 的 install 成功
2. Session B 能看到 Session A 写入的 cache 内容
3. Session B 的 install 时间明显短于 Session A（命中缓存）

> **实测结果**（2026-06-08 R2）：PASS — Session B 看到 Session A 的 cache（`_cacache`、`_logs`），is-even install 成功，2s

---

### T23.5 不同 session 的 node_modules 独立

```bash
# Session A 安装并写入标记
SID_A=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --max-time 60 -X POST "$BASE/session/$SID_A/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && echo \"{\\\"name\\\":\\\"a\\\",\\\"dependencies\\\":{\\\"lodash\\\":\\\"4.17.21\\\"}}\" > package.json && npm install --cache /xybot-front/cache/npm && echo MARK_A > /workspace/node_modules/.mark && cat /workspace/node_modules/.mark"}'

# Session B 安装不同依赖，检查无 A 的标记
SID_B=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --max-time 60 -X POST "$BASE/session/$SID_B/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cat /workspace/node_modules/.mark 2>&1; echo EXIT=$?"}'
```

**期望**：Session B 的 `/workspace/node_modules/.mark` 不存在（exitCode≠0），证明两个 session 的 node_modules 完全独立

> **实测结果**（2026-06-08 R2）：PASS — Session B 报 `No such file or directory`，exitCode=1

---

### T23.6 pnpm store 共享

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 使用 pnpm 安装，指定共享 store
curl -s --max-time 120 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && printf '"'"'{\"name\":\"pnpm-test\",\"dependencies\":{\"dayjs\":\"1.11.10\"}}'"'"' > package.json && pnpm install --store-dir /xybot-front/cache/pnpm-store 2>&1 | tail -5"}'

# 验证 store 有内容
curl -s --max-time 15 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"ls /xybot-front/cache/pnpm-store/ && du -sh /xybot-front/cache/pnpm-store/"}'
```

**期望**：pnpm store 目录非空，安装成功

> **实测结果**（2026-06-08 R2）：PASS — dayjs install 成功（11s），store 含 `v11/` 目录，3.0M

---

### T23.7 yarn cache 共享

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# Yarn Berry 4 使用 cacheFolder 配置（非 --cache-folder flag）
curl -s --max-time 120 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && printf '"'"'{\"name\":\"yarn-test\",\"dependencies\":{\"uuid\":\"9.0.0\"}}'"'"' > package.json && printf '"'"'cacheFolder: /xybot-front/cache/yarn\nenableGlobalCache: false\n'"'"' > .yarnrc.yml && yarn install 2>&1 | tail -10"}'

curl -s --max-time 15 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"find /xybot-front/cache/yarn -maxdepth 1 -type f | sort && du -sh /xybot-front/cache/yarn/"}'
```

**期望**：yarn cache 目录非空，安装成功

> **实测结果**（2026-06-08 R3）：PASS — Yarn 4.16.0 Berry，uuid install 成功，cache 含 `uuid-npm-9.0.0-...zip`，144K

---

### T23.8 bun cache 共享

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && printf '"'"'{\"name\":\"bun-test\",\"dependencies\":{\"ms\":\"2.1.3\"}}'"'"' > package.json && bun install --cache-dir /xybot-front/cache/bun 2>&1 | tail -5"}'

curl -s --max-time 15 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"ls /xybot-front/cache/bun/ 2>/dev/null; du -sh /xybot-front/cache/bun/ 2>/dev/null; echo EXIT=$?"}'
```

**期望**：bun cache 目录存在，安装成功

> **实测结果**（2026-06-08 R2）：PASS — ms install 成功（3s），cache 44K

---

### T23.9 自定义 mountPath

```bash
# 使用自定义路径启动 opencode server
# OPENCODE_SANDBOX_PACKAGE_CACHE_MOUNT=/custom/cache
# 此测试需要重启 server，跳过自动化，仅验证配置读取

# 单元测试中已覆盖（sandbox-pvc.test.ts "custom packageCacheMount"）
```

**期望**：单元测试通过，`buildVolumes` 返回的 `mountPath` 为 `/custom/cache`

> **实测结果**（2026-06-08 R3）：PASS — 自定义路径 `/custom/cache` 生效，尾部斜杠归一化为 `/custom/cache`

---

### T23.9b 非法 mountPath 校验

```bash
# 单元测试中已覆盖（sandbox-pvc.test.ts "invalid packageCacheMount is rejected"）
```

**期望**：以下配置会被拒绝并 fail-fast：`""`、`cache`、`/`、`/workspace`、`/workspace/cache`、`/home`、`/home/sandbox/.cache/npm`

> **实测结果**（2026-06-08 R3）：PASS — 非绝对路径、根路径、与 session volume 冲突或互为父子路径的配置均抛错

---

### T23.10 volumeType=none 时不挂载 package-cache

```bash
# 此场景在非 PVC 环境（volumeType=none）下测试
# 单元测试中已覆盖（sandbox-pvc.test.ts "volumeType=none does not mount package-cache"）

# 验证方式：在 volumeType=none 的 server 上执行
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --max-time 15 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"ls -d /xybot-front/cache 2>&1; echo EXIT=$?"}'
```

**期望**：目录不存在（exitCode≠0），因为 `volumeType=none` 时不挂载共享 cache volume

---

### T23.11 共享 cache 不被 session 销毁清理

```bash
SID_A=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# Session A 写入 cache 标记
curl -s --max-time 15 -X POST "$BASE/session/$SID_A/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"mkdir -p /xybot-front/cache/test && echo PERSIST > /xybot-front/cache/test/persist.txt"}'

# 销毁 Session A 的 sandbox
curl -s -X POST "$BASE/session/$SID_A/kill-sandbox" || curl -s -X POST "$BASE/instance/dispose"

sleep 5

# Session B 验证 cache 内容仍在
SID_B=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --max-time 15 -X POST "$BASE/session/$SID_B/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cat /xybot-front/cache/test/persist.txt"}'
```

**期望**：Session B 读到 `PERSIST`，证明共享 cache 不随 session 销毁而清理

> **实测结果**（2026-06-08 R2）：PASS — Session A `kill-sandbox` 后，Session B 读到 `PERSIST` 和 `WRITABLE`

---

### T23.12 缓存命中加速对比

```bash
# Session A: 冷启动（清空 cache 后首次 install）
SID_COLD=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --max-time 30 -X POST "$BASE/session/$SID_COLD/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"rm -rf /xybot-front/cache/npm/_cacache /xybot-front/cache/npm/_logs"}'

# 首次 install（纯网络下载）
START=$(date +%s%N)
curl -s --max-time 180 -X POST "$BASE/session/$SID_COLD/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && printf '"'"'{\"name\":\"cold\",\"dependencies\":{\"axios\":\"1.9.0\",\"lodash\":\"4.17.21\",\"dayjs\":\"1.11.13\"}}'"'"' > package.json && time npm install --cache /xybot-front/cache/npm 2>&1 | tail -5"}'
END=$(date +%s%N)
echo "Cold: $(( (END - START) / 1000000 ))ms"

# Session B: 命中缓存（同包不同 session）
SID_WARM=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
START=$(date +%s%N)
curl -s --max-time 120 -X POST "$BASE/session/$SID_WARM/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && printf '"'"'{\"name\":\"warm\",\"dependencies\":{\"axios\":\"1.9.0\",\"lodash\":\"4.17.21\",\"dayjs\":\"1.11.13\"}}'"'"' > package.json && time npm install --cache /xybot-front/cache/npm --prefer-offline 2>&1 | tail -5"}'
END=$(date +%s%N)
echo "Warm: $(( (END - START) / 1000000 ))ms"
```

**期望**：缓存命中后 install 耗时明显低于冷启动（加速比 >= 1.2x）

> **实测结果**（2026-06-08 R2）：PASS
> - 冷启动：16.8s（3 个包，纯网络下载）
> - 缓存命中：3.8s（同包不同 session，`--prefer-offline`）
> - **加速比：4.4x**

---

### T23.13 并发 install 安全性

```bash
# 3 个 session 并发 npm install（不同包，同一 cache 目录）
SID1=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
SID2=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
SID3=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 并发发起（& 后台并行）
(curl -s --max-time 180 -X POST "$BASE/session/$SID1/exec" \
  -d '{"command":"cd /workspace && printf '"'"'{\"name\":\"c1\",\"dependencies\":{\"axios\":\"1.9.0\"}}'"'"' > package.json && npm install --cache /xybot-front/cache/npm 2>&1 | tail -3"}' > /tmp/conc1.json &)
(curl -s --max-time 180 -X POST "$BASE/session/$SID2/exec" \
  -d '{"command":"cd /workspace && printf '"'"'{\"name\":\"c2\",\"dependencies\":{\"lodash\":\"4.17.21\"}}'"'"' > package.json && npm install --cache /xybot-front/cache/npm 2>&1 | tail -3"}' > /tmp/conc2.json &)
(curl -s --max-time 180 -X POST "$BASE/session/$SID3/exec" \
  -d '{"command":"cd /workspace && printf '"'"'{\"name\":\"c3\",\"dependencies\":{\"dayjs\":\"1.11.13\"}}'"'"' > package.json && npm install --cache /xybot-front/cache/npm 2>&1 | tail -3"}' > /tmp/conc3.json &)
wait

# 验证 cache 完整性
curl -s --max-time 30 -X POST "$BASE/session/$SID1/exec" \
  -d '{"command":"npm cache verify --cache /xybot-front/cache/npm 2>&1"}'
```

**期望**：
1. 三个并发 install 全部 exitCode=0
2. `npm cache verify` 报告无损坏
3. 后续 install 可正常命中缓存

> **实测结果**（2026-06-08 R2）：PASS
> - npm 并发 3 session（axios/lodash/dayjs）：全部 exitCode=0
> - `npm cache verify`：78 entries verified, 0 corrupted
> - pnpm 并发 2 session（uuid/ms）：全部 exitCode=0，无冲突

---

## 单元测试覆盖

以下 case 在 `test/tool/sandbox-pvc.test.ts` 中实现，无需 sandbox 环境：

| Case | 验证点 | 结果 |
|------|--------|------|
| PVC mode includes shared package-cache volume | PVC 模式返回 7 个 volume（6 session + 1 shared cache） | PASS |
| all sessions share the same package-cache subPath | 不同 sessionID 的 package-cache subPath 相同（`shared/package-cache`） | PASS |
| volumeType=none does not mount package-cache | none 模式不挂载 | PASS |
| volumeType=host does not mount package-cache | host 模式不挂载 | PASS |
| custom packageCacheMount | 自定义 mountPath 生效，尾部斜杠归一化 | PASS |
| invalid packageCacheMount is rejected | 非法路径和挂载冲突 fail-fast | PASS |
| package-cache uses the same PVC claim | 共享 cache 与 session volume 使用同一个 PVC claim | PASS |

> 单元测试 69 pass, 0 fail（2026-06-08 R3，sandbox 相关 3 文件）。

## 测试结果汇总

| 用例 | 结果 | 备注 |
|------|------|------|
| T23.1 共享 cache 目录可写 | PASS | |
| T23.2 npm cache 挂载验证 | PASS | |
| T23.3 首次 npm install 填充共享 cache | PASS | lodash, cache 1.2M |
| T23.4 跨 session 共享 cache | PASS | Session B 看到 Session A 的 cache, 2s |
| T23.5 node_modules 独立 | PASS | `.mark` 文件跨 session 不可见 |
| T23.6 pnpm store | PASS | dayjs, store 3.0M (pnpm 11.5.2 预装) |
| T23.7 yarn cache 共享 | PASS | uuid, cache 144K zip (Yarn 4.16.0 Berry) |
| T23.8 bun cache | PASS | ms, cache 44K (bun 1.3.14 预装) |
| T23.9 自定义 mountPath | PASS | 单元测试覆盖，尾部斜杠归一化 |
| T23.9b 非法 mountPath 校验 | PASS | 单元测试覆盖，非法/冲突路径抛错 |
| T23.10 volumeType=none | PASS | 单元测试覆盖 |
| T23.11 销毁不清理共享 cache | PASS | kill-sandbox 后新 session 可读 |
| T23.12 缓存命中加速对比 | PASS | 冷 16.8s → 热 3.8s，加速 4.4x |
| T23.13 并发 install 安全性 | PASS | npm 3并发 + pnpm 2并发，cache verify OK |
