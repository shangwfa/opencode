# 《Vercel Sandbox Provider 设计方案》审核报告

> 历史报告，仅适用于初稿。本文“方案整体成立”等结论已由二次审核更正；实施依据为 `sandbox-provider-vercel-design.md` Revision 2。尤其不得沿用 onCreate 防冷启动、自动重放恢复、命令超时放大、host 复用及单凭 pid 文件取消等旧建议。二次审核见 `sandbox-provider-vercel-industry-review.md`。

Date: 2026-10-24
审核对象: `docs/sandbox-provider-vercel-design.md`（Draft）
审核方式: 逐条对照仓库代码证据 + Vercel 官方文档（2026-08/09 版）
结论: **方案整体成立，发现 3 个 Blocker、5 个 Major，已将可确认项直接修订回设计文档，其余列为 P1 评审输入。**

---

## 1. Blocker（已修订进设计文档）

### B1. interrupt 的 pkill 兜底方案技术不可行 ✅已修
- **问题**：初稿写「detached 命令注入 `OC_OP_<operationID>` env marker，kill 失败时 `pkill -f marker`」。`pkill -f` 匹配的是进程 cmdline（`/proc/<pid>/cmdline`），环境变量不在其中，此兜底永远匹配不到。
- **修正**：改用仓库既有 pid 文件惯例——detached 启动命令落 `/tmp/oc-op-<operationID>.pid`（与 runner `PID_FILE`（runner.ts:4）、MCP bridge、tool-host 同构），interrupt 读 pid 后 `kill`。主路径（PG 存 cmdId → `getCommand(cmdId).kill()`）不变。

### B2. boot 的 sandbox name 用错了键 ✅已修
- **问题**：初稿 §6 写 `getOrCreate({name:"oc-<sessionID>"})`。但 `resolveSandboxKey`（provider.ts:684-698）及其注释（677-682）明确：**所有沙箱状态（内存表、PG 行、命令会话）按解析出的 root sessionID 键控**，子会话必须共享根会话沙箱。直接用传入 sessionID 会让每个子会话各建一个空沙箱，破坏核心语义。
- **修正**：name = `oc-<resolveSandboxKey(sessionID)>`。

### B3. provider 切换后旧行为未定义 ✅已修（§13 补充）
- **问题**：方案声称「PG 旧行按 host 字段区分互不干扰」，但没定义切换后旧会话的行为——旧 sandbox id 打 Vercel API 必然 404，用户会看到莫名失败。
- **修正**：二选一并写入 §13/Q9：① 工厂按行级 `host` 路由双活（推荐，分派时读行即可）；② 明确报错引导新建会话。禁止静默拿旧 id 打新 provider。

## 2. Major（已修订或列为 P1 前置）

### M1. 冷启/resume 延迟预算不足 ✅已修（§7.2）
- 证据：runner launcher 预算 10s（`runner.ts:52`）基于 OpenSandbox「创建与命令分离」假设；Vercel 的首个 SDK 调用触发 auto-resume，官方 changelog 明确创建**包含快照恢复等待**，uncached snapshot「larger increase possible」。10s 会假失败。
- 修正：命令预算 provider 可配置/放大；boot 90s 超时按 P0 实测校准。

### M2. 连接失败不会触发 resume，恢复链缺失 ✅已修（§7.6）
- 证据：endpoint 重试仅重复 resolve（`runner.ts:57-63`，20×250ms）；OpenSandbox 网关地址常驻所以够用，Vercel VM 停机后 domain 不可达且没人触发恢复。
- 修正：约定「连接失败 → 显式 `getOrCreate(resume:true)` → 重跑幂等 launcher → 重连」。同时确认一个**利好**：三段式的幂等 launcher 天然解决「resume 后新 VM 上 daemon 全灭」问题，这正是三段式在 Vercel 下依然成立的核心依据（已写入 §7.6 作为设计论证）。

### M3. extendTimeout 频率与默认 5min timeout ✅已修（§6/§7.6）
- 初稿「touchSandbox 心跳顺带续期」会每次活动打一次 API（rate limit/成本风险）。改为「`expiresAt` 剩余 < 阈值才 extend」；`Sandbox.create` 显式传 `timeout` 覆盖默认 5min（否则比现有 600s TTL 更激进，活跃会话会频繁停机）。
- 后台任务存活语义（nohup 任务随 VM 消亡、不复活）与 OpenSandbox idle reap 对齐但阈值不同，新增 Q8 供产品确认。

### M4. 文件密集工作流的延迟/成本回归（P1 e2e 必测）
- `fileRead` 等从 execd 内网 HTTP（provider.ts:365-380）变为公网 API 调用；内置工具一次 turn 可能产生几十次文件操作。已在审核中标注，需在 P1 e2e 加基线对比用例（设计文档 §12 待补一条用例）。

### M5. refuseCreate 拦截点需区分两种 onCreate（P1 实现要求）
- Vercel「快照过期静默删重建」触发的 onCreate 与「全新首次创建」必须区分：前者 PG 存在恢复意图记录（latestSnapshot 已消费过），应 fail loud 拒绝冷启（延续 provider.ts:1623-1625 的数据保护契约）；后者放行。已写入 §7.7。

## 3. Minor / 待验证（并入 P0 spike 清单 ✅已修 §11）

| 项 | 说明 |
|---|---|
| sandbox name 格式约束 | 长度/字符集官方文档未明确，`oc-<id>` 规范化规则需实测 |
| 文件大小上限 | compaction `tool_history_*.md` 可能超限（compaction.ts:446-475） |
| API 配额/rate limit | pricing 页有 API quotas 段未取证；文件/命令调用频率受限影响大 |
| auto-resume 冷启实测 | 校准 M1 的预算数值 |
| `fileFind`/scan/OOM 的成本属性 | 每次 `runCommand` 均耗 Active CPU + 配额，高频路径需标注 |

## 4. 审核确认成立的关键设计（抽查通过）

- Interface 语义覆盖完整（run 三形态/EndpointResolution 三态/文件 API）——对照 provider.ts:52-101 逐条核对 ✓
- 三段式保留的可行性：launcher 是纯 shell 命令，`runCommand` 可执行；readiness probe 内嵌 ✓
- `persistent:true` ≙ snapshot 模式、`persistent:false` ≙ none 模式映射正确 ✓
- PG 表不动、`host` 承载 provider 标识、`id`=sandbox name 可行 ✓
- PVC 无对等物 → 强制 snapshot 门控 + 告警，处理正确 ✓
- SaaS 不迁 Vercel 的论据成立（800s maxDuration vs 长会话、内网 PG）✓
- 计费估算数学正确（4GB×$0.0212=$0.085/h + Active CPU 按占比折算）✓

## 5. 遗留动作

1. M4 的文件密集 e2e 用例补进 §12（P1 开工时）
2. Q1（MCP 鉴权）、Q2（refresh 策略）、Q8（后台任务 SLA）、Q9（旧行路由）需评审定案
3. P0 spike 按 §11 扩充后清单执行，产出 `docs/research/vercel-sandbox-spike.md`
