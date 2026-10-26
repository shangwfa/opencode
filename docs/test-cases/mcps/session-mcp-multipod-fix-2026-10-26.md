# Session MCP 恢复与多 Pod 正确性：修复与验收（2026-10-26）

范围（经确认）：MCP 安全恢复（T22.31）、已发现的多 Pod 正确性、修复后的模型/Code Mode 回归。快照长期保留按用户指示延后，不在本轮。

## 修复内容

### 1. MCP 调用安全恢复（T22.31，`session/mcps.ts` + `session/mcp-http-bridge.ts`）

- bridge 新增 `GET /health`：stdio 存活返回 200 `{ready:true}`，子进程死亡返回 503。
- `call` 派发前先做 preflight（`healthCommand` 返回 0/1/2 三态）：**确认已死**才驱逐并重连后再派发一次；**健康未知**（pid 文件损坏、探测超时/500）直接失败，绝不派发。
- 自动重试收紧为 `canReplayCall`：仅显式 `McpClient.SessionExpiredError`（服务端协议级会话拒绝，客户端不会已收到工具结果）可透明重试一次；连接重置、fetch failed、5xx 等模糊失败**只驱逐、不重放**——请求可能已产生副作用。`mcp/index.ts` 全局 MCP 的恢复重放同样只认显式拒绝。
- bridge `initialize` 结果缓存 + `notifications/initialized` 去重：多个 Pod/客户端接入同一 stdio 子进程时只初始化一次。
- launcher 携带配置指纹（generation + command + env + bridge 脚本哈希）：沙箱侧按 `.meta` 标记 + flock 注册表幂等复用健康 bridge；配置漂移或桥死亡才重启。`evict` 只关闭本 Pod 的 MCP 客户端，不再误杀其他 Pod 正在使用的共享 daemon。

### 2. bridge 端口跨 Pod 一致（`session/sql.ts` + 迁移 `20261025152054_session_mcp_runtime_port`）

- 端口分配从 Pod 内存移到 PG：`session_mcps.runtime_port` 在事务内按 owner 行锁分配，两个 Pod 对同一会话得到一致端口；disabled/非 local 定义在 reconcile 与删除路径清理残留 daemon。

### 3. sweep 语义改为沙箱侧仲裁（`bridgeSweepCommand(generation)`）

- 旧逻辑按"Pod 内存没有 runtime 就全局清扫"，重启后一个 Pod 会杀掉另一 Pod 正在使用的健康 bridge（F 首轮在旧代码下即此失败形态）。新逻辑在沙箱内按物理 generation 标记（flock + `.generation` 文件）幂等：同一 generation 只清一次，generation 变化（真实回收/重建）才清扫。

### 4. Vercel 跨 Pod 端口合并（`sandbox/vercel/provider.ts`）

- `Sandbox.update` 的 ports 是全量替换：原进程内 mutex 下，两个 Pod 并发注册端口会互相覆盖丢失（已复现：期望 [9911,11234,13000,19911] 实得 3 个）。改为在 PG generation 行锁内重读远端 routes 再合并。

### 5. OpenSandbox readiness 与跨 Pod 中断（`sandbox/opensandbox/provider.ts`）

- `isReady` 不再只看本进程 entries 缓存（原实现下未连接过的新 Pod 对运行中沙箱误报 false）：从 PG 行重连并执行 execd `/ping` 健康检查，3 秒超时，绝不创建。
- isolated/detached 命令登记 PG `sandbox_command` 台账；`interrupt` 先查 PG 并经控制面定向取消（新 Pod 可取消其他 Pod 派发的操作），再回退本地表；destroy 时清理台账。

### 6. PG 引导/迁移串行化（`database/pg.ts`）

- 空 database 上两个 Pod 同时启动会竞争 CREATE TABLE/VIEW（`pg_type_typname_nsp_index` 唯一冲突），失败一方进程退出（复现两次）。引导、COMPAT_DDL 与增量迁移现持会话级 advisory lock（`opencode:database:migrate`）串行执行，锁在连接池 max:1 的同一连接上获取/释放，`ensuring` 保证解锁。

## 先复现，后修复

| 检查 | 修复前 | 修复后 |
| --- | --- | --- |
| Vercel 双副本并发端口注册 | 丢端口（`multipod-ports-before.log`） | 四端口齐全 |
| OpenSandbox 新副本 interrupt PG 台账命令 | 取消未到达远端（`multipod-cancel-before.log`） | 定向取消成功 |
| 空库双 Pod 并发启动 | 一存一亡（`docker-a/b.log` 首轮） | 双双 healthy |
| F 跨 Pod 发现不杀 in-flight | 旧 sweep 杀健康桥（F 首跑失败） | 复用且 in-flight 完成 |
| T22.31 杀桥后首调用 | 首次 error、模型重试才成功（2026-10-25） | 首次调用透明完成 |

## 测试

- **单测最终回归**：8 文件 **119 pass / 0 fail**（session-mcps、mcp-http-bridge、sandbox-opensandbox-readiness、sandbox-vercel-provider、sandbox-aliyun-provider、sandbox-command-session、session-tool-gate、sandbox-provider），含新增用例：replay 边界、bridge preflight 三态、共享 stdio 只初始化一次、Vercel 双副本端口合并、OpenSandbox 跨副本 readiness + 中断。专用 PG `opencode-v2-aliyun-reap-unit-test`。
- `bun run typecheck`、oxlint、`bun run migration -- --check`、`bun dump-pg-schema.ts` 全部通过；`database-pg-real/compat` 7 测试在新库上通过（覆盖 bootstrap 加锁路径）。
- **真实 E2E**（双 Docker 15130/15131 + 专用 PG `opencode-v2-mcp-multipod3-test` + 阿里云 `base-5wa5` + 公共 SSE）：B 14 项、D 8 项、F 4 项全部通过（详见 `docs/test-cases/mcps/session-mcp.md` 2026-10-26 节）。B 阶段在上一镜像 `mcp-multipod-fixed-20261025` 上先行通过。D3 业务断言全过但 wrapper 误要求子会话有独立 sandbox 行标 failed，D4 以 `EXPECT_SANDBOX=0`（既有契约）重跑通过；两份证据均保留。
- **模型/Code Mode 回归**：B/D/F 全部用例经 `prompt_stream` 真实模型轮次驱动，嵌套 MCP 调用均为 sandbox Code Mode `execute` 内的严格 completed 断言，无 shell 伪造。

## 已知边界与待办

- `mcp.test.ts` 现代协议 `exposes every connection operation`（resources list_changed）超时：撤销本轮 `client.ts` 改动后仍复现，判定疑似预先存在（客户端 SDK `subscriptions/listen` 与 fixture handler 的兼容问题），未计入本轮结果，待单独排查。
- F/D/B 的真实跨 Pod E2E 在阿里云后端完成；OpenSandbox/Vercel 后端仅有单测级多副本验证，未跑同套 E2E。
- 快照长期保留（七天过期/24h 上限）按用户指示延后。

## 清理复核

- PG `multipod3` 与 `multipod1` 两个测试库：`session_v2=0`、`session_mcps=0`、`sandbox_command=0`，全部 sandbox 绑定 `destroyed/remote_name=null`。
- 5 个本轮云实例原生 `Sandbox.getInfo` 逐个 `SandboxNotFoundError`（`cloud-cleanup.json`）。
- 两个测试容器已停止；容器日志与单测/复现日志保存在 `artifacts/mcp-multipod-fix-20261025/`。测试库与镜像保留备查。
