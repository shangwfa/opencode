# Session Sandbox Resource（会话级沙箱资源配置）

> 创建会话时通过 `sandbox: { cpu, memory }` 参数指定沙箱资源。创建沙箱时从会话信息中读取 resource 配置，传入 OpenSandbox SDK 创建对应规格的沙箱。
>
> 前置条件：SaaS 服务已启动（`docs/local-test-env.md`），本地 PG + 远端 Sandbox API 可用。

---

## 测试环境

```bash
# 本地 PG + 远端 Sandbox（参考 docs/local-test-env.md 组合变体）
# PG 转发 15432 → 127.0.0.1:5432（本地 PG）
# Sandbox 转发 30040 → 172.18.32.15:30040（远端 K8s Sandbox API）
BASE=http://localhost:14096
PG_URL=postgresql://local@127.0.0.1:5432/opencode
SB_DOMAIN=127.0.0.1:30040
SB_API_KEY=H68idVYzjadx
SB_IMAGE=crpi-hlpnu8kiweghie0r.cn-hangzhou.personal.cr.aliyuncs.com/shangwfa/opencode-sandbox:session-lsp-v3
```

---

## 一、会话创建 — sandbox resource 写入验证

### T29.1 创建带 sandbox resource 的会话 — API + PG 双重验证

```bash
bun -e '
const BASE = "http://localhost:14096"
const PG_URL = "postgresql://local@127.0.0.1:5432/opencode"

// 1. 创建会话，设置 sandbox resource
const sid = await (await fetch(BASE + "/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sandbox: { cpu: "2", memory: "4Gi" } }),
})).json()
console.log("API session.sandbox:", JSON.stringify(sid.sandbox))

// 2. 查 PG 确认持久化
const { Client } = require("pg")
const client = new Client({ connectionString: PG_URL })
await client.connect()
const { rows } = await client.query("SELECT sandbox FROM session WHERE id = $1", [sid.id])
await client.end()
console.log("PG  session.sandbox:", JSON.stringify(rows[0]?.sandbox))

const pass = JSON.stringify(sid.sandbox) === "{\"cpu\":\"2\",\"memory\":\"4Gi\"}"
  && JSON.stringify(rows[0]?.sandbox) === "{\"cpu\":\"2\",\"memory\":\"4Gi\"}"
console.log(pass ? "✅ T29.1 PASS" : "❌ T29.1 FAIL")
'
```
**期望**：API 返回和 PG 存储均为 `{"cpu":"2","memory":"4Gi"}`

---

### T29.2 不传 sandbox → null（创建沙箱时使用默认值）

```bash
bun -e '
const BASE = "http://localhost:14096"
const sid = await (await fetch(BASE + "/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
})).json()
console.log("session.sandbox:", sid.sandbox)
console.log(sid.sandbox === undefined ? "✅ T29.2 PASS — null, 创建沙箱时走默认 {cpu:1,memory:2Gi}" : "❌ T29.2 FAIL")
'
```
**期望**：`sandbox=undefined`

---

### T29.3 无效 cpu → 400

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:14096/session \
  -H 'Content-Type: application/json' \
  -d '{"sandbox":{"cpu":"abc","memory":"4Gi"}}'
echo ""
```
**期望**：HTTP `400`

---

### T29.4 无效 memory → 400

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:14096/session \
  -H 'Content-Type: application/json' \
  -d '{"sandbox":{"cpu":"2","memory":"8gb"}}'
echo ""
```
**期望**：HTTP `400`（`gb` 小写后缀不合法）

---

### T29.5 多资源格式组合

```bash
bun -e '
const BASE = "http://localhost:14096"
const cases = [
  { cpu: "1",    memory: "2Gi"    },
  { cpu: "0.5",  memory: "1Gi"    },
  { cpu: "500m", memory: "512Mi"  },
  { cpu: "0.25", memory: "256Mi"  },
  { cpu: "100m", memory: "128Mi"  },
  { cpu: "4",    memory: "16Gi"   },
]
for (const r of cases) {
  const sid = await (await fetch(BASE + "/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sandbox: r }),
  })).json()
  const ok = sid.sandbox?.cpu === r.cpu && sid.sandbox?.memory === r.memory
  console.log(`${ok ? "✅" : "❌"} cpu=${r.cpu.padEnd(5)} memory=${r.memory.padEnd(8)} → ${JSON.stringify(sid.sandbox)}`)
}
'
```
**期望**：全部 ✅

---

## 二、从会话读取 resource 创建沙箱 — SDK cgroup 验证

> **核心链路**：创建会话（写入 sandbox 配置）→ `resolveSandboxOpts` 从会话读取 resource → `Sandbox.create({ resource })` → SDK 验证 cgroup 实际限制

### T29.6 从会话读取 resource → 创建沙箱 → SDK 验证

```bash
bun -e '
import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox"
import { resolveSandboxOpts } from "../../src/session/sandbox-opts"
import { Database } from "@opencode-ai/core/database/database"

const BASE = "http://localhost:14096"
const PG_URL = "postgresql://local@127.0.0.1:5432/opencode"
const SB_DOMAIN = "127.0.0.1:30040"
const SB_API_KEY = "H68idVYzjadx"
const SB_IMAGE = "crpi-hlpnu8kiweghie0r.cn-hangzhou.personal.cr.aliyuncs.com/shangwfa/opencode-sandbox:session-lsp-v3"

// 1. 用户创建会话，设置沙箱资源
console.log("=== 1. 创建会话 sandbox:{cpu:2,memory:4Gi} ===")
const sid = await (await fetch(BASE + "/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sandbox: { cpu: "2", memory: "4Gi" } }),
})).json()
console.log("sessionID:", sid.id)

// 2. 从会话中读取 sandbox resource（resolveSandboxOpts 代码路径）
console.log("\n=== 2. resolveSandboxOpts 从会话读取 resource ===")
Database.setClient(PG_URL) // 初始化 PG 连接
const opts = await resolveSandboxOpts(sid.id)
const resource = opts.sandbox ?? { cpu: "1", memory: "2Gi" }
console.log("resolved resource:", JSON.stringify(resource))
console.log("from session:", opts.sandbox ? "✅ 使用会话配置" : "⚠️ 会话无配置, 走默认值")

// 3. 用从会话读取的 resource 创建沙箱
console.log("\n=== 3. 创建沙箱（resource 来自会话）===")
const cfg = new ConnectionConfig({ domain: SB_DOMAIN, protocol: "http", apiKey: SB_API_KEY, useServerProxy: true })
const sb = await Sandbox.create({ connectionConfig: cfg, image: SB_IMAGE, timeoutSeconds: 120, resource, readyTimeoutSeconds: 90 })
console.log("sandboxID:", sb.id)

// 4. SDK 验证沙箱 cgroup 实际限制
console.log("\n=== 4. SDK 验证 cgroup ===")
const result = await sb.commands.run(
  "cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us; cat /sys/fs/cgroup/memory/memory.limit_in_bytes"
)
const [cpuQuota, memLimit] = result.logs.stdout.map(m => m.text.trim()).filter(Boolean).map(Number)
console.log("cpu.cfs_quota_us:", cpuQuota, `(期望 ${Number(resource.cpu) * 100000})`)
console.log("memory.limit_in_bytes:", memLimit, `(期望 ${Number(resource.memory.replace(/[^0-9]/g, "")) * 1024 ** 3})`)

const cpuOK = cpuQuota === Number(resource.cpu) * 100000
const memOK = memLimit === Number(resource.memory.replace(/[^0-9]/g, "")) * 1024 ** 3
console.log("cpu 生效:", cpuOK ? "✅" : "❌")
console.log("memory 生效:", memOK ? "✅" : "❌")

// 5. 关闭沙箱
console.log("\n=== 5. 关闭沙箱 ===")
await sb.kill().catch(() => {})
await sb.close().catch(() => {})
console.log(cpuOK && memOK ? "\n✅ T29.6 PASS — 从会话读取 resource, 沙箱 cgroup 精确匹配" : "\n❌ T29.6 FAIL")
'
```
**期望**：
- `resolveSandboxOpts` 返回会话中存储的 `sandbox`
- 沙箱 `cpu.cfs_quota_us=200000`、`memory.limit_in_bytes=4294967296`
- cpu ✅ memory ✅

---

### T29.7 不传 sandbox → 默认 resource → SDK 验证

```bash
bun -e '
import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox"
import { resolveSandboxOpts } from "../../src/session/sandbox-opts"
import { Database } from "@opencode-ai/core/database/database"

const BASE = "http://localhost:14096"
const PG_URL = "postgresql://local@127.0.0.1:5432/opencode"
const SB_DOMAIN = "127.0.0.1:30040"
const SB_API_KEY = "H68idVYzjadx"
const SB_IMAGE = "crpi-hlpnu8kiweghie0r.cn-hangzhou.personal.cr.aliyuncs.com/shangwfa/opencode-sandbox:session-lsp-v3"

// 创建不带 sandbox 的会话
const sid = await (await fetch(BASE + "/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
})).json()

// resolveSandboxOpts 读不到 sandbox → 走默认值
Database.setClient(PG_URL)
const opts = await resolveSandboxOpts(sid.id)
const resource = opts.sandbox ?? { cpu: "1", memory: "2Gi" }
console.log("会话无 sandbox 配置 → 默认 resource:", JSON.stringify(resource))

const cfg = new ConnectionConfig({ domain: SB_DOMAIN, protocol: "http", apiKey: SB_API_KEY, useServerProxy: true })
const sb = await Sandbox.create({ connectionConfig: cfg, image: SB_IMAGE, timeoutSeconds: 120, resource, readyTimeoutSeconds: 90 })
const result = await sb.commands.run(
  "cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us; cat /sys/fs/cgroup/memory/memory.limit_in_bytes"
)
const [cpuQuota, memLimit] = result.logs.stdout.map(m => m.text.trim()).filter(Boolean).map(Number)
console.log("cgroup cpu:", cpuQuota, "memory:", memLimit)
await sb.kill().catch(() => {})
await sb.close().catch(() => {})

const pass = cpuQuota === 100000 && memLimit === 2147483648
console.log(pass ? "✅ T29.7 PASS — 默认 {cpu:1,memory:2Gi} 生效" : "❌ T29.7 FAIL")
'
```
**期望**：`cpu.cfs_quota_us=100000`、`memory.limit_in_bytes=2147483648`（默认 1 cpu / 2Gi）

---

### T29.8 多资源组合 → SDK cgroup 精确验证

```bash
bun -e '
import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox"
import { resolveSandboxOpts } from "../../src/session/sandbox-opts"
import { Database } from "@opencode-ai/core/database/database"

const BASE = "http://localhost:14096"
const PG_URL = "postgresql://local@127.0.0.1:5432/opencode"
const SB_DOMAIN = "127.0.0.1:30040"
const SB_API_KEY = "H68idVYzjadx"
const SB_IMAGE = "crpi-hlpnu8kiweghie0r.cn-hangzhou.personal.cr.aliyuncs.com/shangwfa/opencode-sandbox:session-lsp-v3"
Database.setClient(PG_URL)
const cfg = new ConnectionConfig({ domain: SB_DOMAIN, protocol: "http", apiKey: SB_API_KEY, useServerProxy: true })

const cases = [
  { cpu: "0.5",  memory: "1Gi"    },
  { cpu: "500m", memory: "512Mi"  },
  { cpu: "0.25", memory: "256Mi"  },
  { cpu: "2",    memory: "4Gi"    },
]

for (const want of cases) {
  // 1. 创建会话
  const sid = await (await fetch(BASE + "/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sandbox: want }),
  })).json()

  // 2. 从会话读取 resource
  const opts = await resolveSandboxOpts(sid.id)
  const resource = opts.sandbox

  // 3. 创建沙箱
  const sb = await Sandbox.create({ connectionConfig: cfg, image: SB_IMAGE, timeoutSeconds: 120, resource, readyTimeoutSeconds: 90 })

  // 4. SDK 验证 cgroup
  const result = await sb.commands.run(
    "cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us; cat /sys/fs/cgroup/memory/memory.limit_in_bytes"
  )
  const [cpuQuota, memLimit] = result.logs.stdout.map(m => m.text.trim()).filter(Boolean).map(Number)

  const cpuExpected = want.cpu.endsWith("m") ? Number(want.cpu.replace("m", "")) * 100 : Number(want.cpu) * 100000
  const memUnit = want.memory.replace(/[0-9]/g, "")
  const memNum = Number(want.memory.replace(/[^0-9]/g, ""))
  const memMul = { Ki: 1024, Mi: 1024**2, Gi: 1024**3, Ti: 1024**4, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[memUnit]
  const memExpected = memNum * memMul

  const ok = cpuQuota === cpuExpected && memLimit === memExpected
  console.log(`${ok ? "✅" : "❌"} cpu=${want.cpu.padEnd(5)} mem=${want.memory.padEnd(8)} → quota=${cpuQuota}/${cpuExpected} mem=${memLimit}/${memExpected}`)

  await sb.kill().catch(() => {})
  await sb.close().catch(() => {})
}
'
```
**期望**：全部 ✅，cgroup 限制精确匹配会话配置

---

## 三、子会话 / fork 继承

### T29.9 子会话自动继承父会话 sandbox resource

```bash
bun -e '
const BASE = "http://localhost:14096"
const parent = await (await fetch(BASE + "/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sandbox: { cpu: "2", memory: "4Gi" } }),
})).json()
const child = await (await fetch(BASE + "/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ parentID: parent.id }),
})).json()
console.log("parent:", JSON.stringify(parent.sandbox))
console.log("child: ", JSON.stringify(child.sandbox))
console.log(JSON.stringify(child.sandbox) === "{\"cpu\":\"2\",\"memory\":\"4Gi\"}" ? "✅ T29.9 PASS" : "❌ T29.9 FAIL")
'
```
**期望**：子会话 sandbox 继承父会话配置

---

### T29.10 fork 继承

```bash
bun -e '
const BASE = "http://localhost:14096"
const orig = await (await fetch(BASE + "/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sandbox: { cpu: "2", memory: "4Gi" } }),
})).json()
const fork = await (await fetch(`${BASE}/session/${orig.id}/fork`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
})).json()
console.log("fork:", JSON.stringify(fork.sandbox))
console.log(JSON.stringify(fork.sandbox) === "{\"cpu\":\"2\",\"memory\":\"4Gi\"}" ? "✅ T29.10 PASS" : "❌ T29.10 FAIL")
'
```
**期望**：fork 继承原会话 sandbox

---

## 四、单元测试

### T29.11 SandboxResource Schema 编解码

```bash
bun test test/session/sandbox-resource.test.ts --test-name-pattern "SandboxResource schema" 2>&1 | tail -5
```

### T29.12 cpu/memory 格式校验

```bash
bun test test/session/sandbox-resource.test.ts --test-name-pattern "format validation" 2>&1 | tail -5
```

### T29.13 Info / CreateInput / toRow / resource selection

```bash
bun test test/session/sandbox-resource.test.ts --test-name-pattern "Session.Info|CreateInput|toRow|resource selection" 2>&1 | tail -5
```

---

## 结果汇总

| 用例 | 状态 | 说明 |
|------|------|------|
| T29.1 | ✅ | 创建带 sandbox 的会话 — API + PG 双重验证 |
| T29.2 | ✅ | 不传 sandbox → null（走默认值） |
| T29.3 | ✅ | 无效 cpu → 400 |
| T29.4 | ✅ | 无效 memory → 400 |
| T29.5 | ✅ | 多资源格式组合均通过 |
| T29.6 | ✅ | 从会话读取 resource 创建沙箱 — SDK cgroup 精确匹配 |
| T29.7 | ✅ | 无配置走默认 {cpu:1,memory:2Gi} — SDK 验证 |
| T29.8 | ✅ | 多资源组合 SDK cgroup 精确验证（0.5cpu/500m/0.25cpu/2cpu） |
| T29.9 | ✅ | 子会话自动继承父会话 sandbox |
| T29.10 | ✅ | fork 继承 |
| T29.11 | ✅ | Schema 编解码单元测试 |
| T29.12 | ✅ | 格式校验单元测试（38 用例） |
| T29.13 | ✅ | Info/CreateInput/toRow 单元测试 |

---

## 格式校验规则

| 字段 | 正则 | 合法示例 | 非法示例 |
|------|------|---------|---------|
| cpu | `/^\d+(\.\d+)?m?$/` | `1`, `0.5`, `500m`, `0.25` | `abc`, `-1`, `1.5.5`, `.5`, `5.` |
| memory | `/^\d+(Ki\|Mi\|Gi\|Ti\|K\|M\|G\|T)$/` | `2Gi`, `512Mi`, `1G`, `128Mi` | `8gb`, `1024`, `-1Gi`, `1.5Gi`, `2 G` |

---

## 数据流

```
用户 POST /session { sandbox: { cpu: "2", memory: "4Gi" } }
  ↓ Schema 校验 + Session.create → projector 写 PG sandbox 列
  ↓
创建沙箱时:
  resolveSandboxOpts(sessionID)
    → 沿 parent_id 链找到 root session
    → 从会话中读取 sandbox = {"cpu":"2","memory":"4Gi"}
  ↓
  createSandbox(sessionID)
    → resource = resolved.sandbox ?? {cpu:"1", memory:"2Gi"}
    → Sandbox.create({ resource })   ← resource 来自会话
  ↓
SDK 验证: cpu.cfs_quota_us=200000 (2 cores), memory.limit_in_bytes=4294967296 (4Gi)
```

### 继承逻辑

- **子会话**：不传 sandbox 时自动继承父会话配置（沿 parent_id 链 resolve）
- **fork**：继承原会话 sandbox 配置
- **默认值**：会话无 sandbox 配置时，使用 `{cpu:"1", memory:"2Gi"}`

---

## 改动文件清单

```
packages/schema/src/v1/session.ts                        # SessionInfo schema 加 sandbox（事件序列化）
packages/core/src/session/sql.ts                         # SQLite schema 加 sandbox JSON 列
packages/core/src/session/projector.ts                   # sessionRow 写入 sandbox
packages/core/src/database/migration/20260710...ts       # 新 migration: ALTER TABLE session ADD sandbox
packages/core/src/database/migration.gen.ts              # 注册新 migration
packages/opencode/src/session/session.pg.ts              # PG schema 加 sandbox JSON 列
packages/opencode/src/session/session.ts                 # SandboxResource Schema + Info/CreateInput + create/fork
packages/opencode/src/session/sandbox-opts.ts            # resolveSandboxOpts 返回 sandbox
packages/opencode/src/session/projectors.ts              # toPartialRow 写入 sandbox
packages/opencode/src/tool/sandbox-provider.ts           # createSandbox 使用 resolved.sandbox + 默认值
packages/opencode/src/server/sandbox-proxy.ts            # exec/exec-async 透传 root.sandbox
packages/opencode/test/session/sandbox-resource.test.ts  # 单元测试（52 个）
```
