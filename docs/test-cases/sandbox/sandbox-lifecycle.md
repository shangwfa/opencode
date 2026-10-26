# V2 Session Sandbox 生命周期验收

> 本文覆盖当前 SaaS V2 的 session sandbox、保活、销毁和 idle reap。验收前按 [`local-test-env.md`](../../local-test-env.md) 启动服务，并确认 SaaS 与测试客户端连接同一个 PG。当前 V2 sandbox 是每 session 一个 `/workspace`；本文不包含旧版 exec、PVC/snapshot、按 sandbox ID 管理或 `exec_log` 契约。

## 当前生命周期契约

实现位于 `packages/core/src/sandbox/provider.ts`、`packages/core/src/session.ts` 和 `packages/server/src/handlers/session.ts`。

| 操作                | API / 触发点                                                                | 当前行为与 PG 证据                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 创建 root session   | `POST /api/session`                                                         | 默认 `OPENCODE_SESSION_AUTO_KEEPALIVE` 未设为 `0`/`false` 时，后台启用 keep-alive 并 boot；等候异步创建完成再查 PG                        |
| 创建 fork session   | `POST /api/session/:id/fork`                                                | 不自动 boot；首次 shell/文件工具访问才懒创建                                                                                              |
| 显式保活并立即 boot | `POST /api/experimental/session/:id/keep-alive`，`{enabled:true,boot:true}` | 返回 sandbox ID；PG `running/keep_alive=true`                                                                                             |
| 显式保活但延迟 boot | 同上，`{enabled:true,boot:false}`                                           | 写 `pending-<sessionID>` 行（`destroyed/true`），不创建远端 sandbox；首次工具调用懒创建                                                   |
| 销毁实例            | `POST /api/session/:id/kill-sandbox`                                        | 远端实例销毁、PG `destroyed`；不清 keep-alive 偏好                                                                                        |
| release             | keep-alive endpoint，`{enabled:false}`                                      | 先清 keep-alive，再销毁；PG `destroyed/false`                                                                                             |
| 删除 session        | `DELETE /api/session/:id`                                                   | 应销毁关联 sandbox；PG sandbox 行保留为 `destroyed`，由 session 清理逻辑处理会话数据                                                      |
| 空闲回收            | Provider 后台 idle reap                                                     | 默认 idle 3600 秒，扫描间隔 300 秒；回收 `running/killed` 过期行，CAS 防止并发刷新后误杀。包含 `keep_alive=true` 行；仅销毁实例，不清偏好 |

`keep_alive` 是 session 级持久偏好；`destroy` 与 idle reap 不清除它，只有 `release` 清除。它不会阻止 idle reap 回收过期 sandbox；重建时会继承该偏好，并影响创建 TTL（当前配置）。Provider 的创建合并是进程内协调，不构成多副本分布式锁。

## 运行接口 + PG 验收

脚本会创建测试 session、检查 HTTP/PG 状态，并在成功跑完时删除测试 session。`BASE` 传服务根地址（**不要**带 `/api`），脚本内部会拼接 API 路径。脚本断言失败时需按输出的 session ID 手动清理。

```bash
BASE=http://127.0.0.1:14106 \
PG_URL='postgresql://local@127.0.0.1:5432/opencode-v2-up' \
OPENCODE_PASSWORD="$OPENCODE_PASSWORD" \
node docs/test-cases/scripts/sandbox-keepalive-v2.mjs
```

覆盖 root 自动保活/boot、PG 状态、跨服务实例重连（设置 `BASE_SECONDARY` 时）、release、显式 boot、kill 后保活偏好、重建、fork session 延迟创建和 session 删除销毁。

验证 `boot:false` 的懒创建时，需单独启动关闭 root 自动 boot 的服务，避免 root session 自动创建干扰断言：

```bash
# 服务启动环境：OPENCODE_SESSION_AUTO_KEEPALIVE=0
BASE=http://127.0.0.1:14107 \
PG_URL='postgresql://local@127.0.0.1:5432/opencode-v2-up' \
OPENCODE_PASSWORD="$OPENCODE_PASSWORD" \
node docs/test-cases/scripts/sandbox-keepalive-lazy-v2.mjs
```

**通过条件**：两个脚本退出码为 0；脚本内 API assertions 全通过；PG 断言分别观察到自动 boot 的 `running/true`、延迟 boot 的 `pending/destroyed/true`、release 的 `destroyed/false`、kill 保留偏好及 fork 隔离。运行失败时检查脚本打印的 session ID，并手动 release、删除 session，避免遗留实例。

## Idle reap 验收

Provider 当前只有周期 idle reap，没有旧版文档中的 onIdle 即时销毁或 zombie 单独清理器。扫描周期固定 300 秒，默认 idle 阈值 3600 秒，可通过 `OPENCODE_SANDBOX_IDLE_REAP_SEC` 配置；设置为 `0` 关闭扫描。扫描先 CAS 将过期行标记 `killed`，再销毁；成功后为 `destroyed`，失败会保留状态供后续扫描重试。`keep_alive` 的真值不会排除过期行。

```bash
# 先确认运行中的 session sandbox，且 PG_URL 指向该 SaaS 实例使用的同一 PG。
SID='已创建且有 running sandbox 的 session ID'
psql "$PG_URL" -X -c "SELECT session_id,id,state,keep_alive,time_updated FROM sandbox WHERE session_id='$SID'"

# 仅在隔离测试库操作：将该行改为超过阈值，等待最多一个扫描周期 + 处理时间。
psql "$PG_URL" -v ON_ERROR_STOP=1 -c \
  "UPDATE sandbox SET time_updated=(extract(epoch FROM now()-interval '3700 seconds')*1000)::bigint WHERE session_id='$SID' AND state='running'"

for i in $(seq 1 72); do
  STATE=$(psql "$PG_URL" -X -A -t -c "SELECT state FROM sandbox WHERE session_id='$SID'" | tr -d '[:space:]')
  [ "$STATE" = destroyed ] && { echo 'PASS: idle sandbox reaped'; break; }
  sleep 5
done
test "$STATE" = destroyed
psql "$PG_URL" -X -c "SELECT session_id,id,state,keep_alive,time_updated FROM sandbox WHERE session_id='$SID'"
```

**通过条件**：状态在 idle 阈值加最多 300 秒扫描延迟后变为 `destroyed`；原 `keep_alive` 值不变。要验证 CAS 防误杀，应在扫描窗口竞争刷新 `time_updated`，并确认仍为 `running`；单靠手动更新字段无法稳定命中“扫描候选后、CAS 前”的窄窗口，优先使用可控 fake client 的自动化测试。

## 自动化检查与覆盖边界

```bash
cd packages/core
bun run test -- sandbox-provider.test.ts sandbox-config.test.ts sandbox-path.test.ts
bun run typecheck
```

当前列出的 `sandbox-provider.test.ts` 主要检查 Provider disabled 行为，不能证明真实创建/销毁、idle reap、超时、并发与 PG 状态机已全面覆盖。`sandbox-lifecycle` 接口脚本补充真实 SaaS + PG E2E；若要稳定覆盖创建失败/迟到实例清理、CAS 竞态及多 Provider 并发，需使用可控 fake OpenSandbox client 的 Provider 集成测试。跨 SaaS 实例共享同一 PG 的重连路径可通过设置 `BASE_SECONDARY` 在运行脚本中验收，但它不代表并发创建已有分布式互斥。

## 复测记录

| 日期       | 镜像 / 环境                                                                                                                              | 用例                                            | 结果                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 2026-09-24 | `opencode-saas-v2:lifecycle-verify`（当前工作区构建）+ 本地 PG `opencode-v2-up` + 本地 OpenSandbox（8080，`opencode-opensandbox:local`） | `sandbox-keepalive-v2.mjs`                      | ✅ 8 项断言全过：root 自动 boot、release、boot 幂等、kill 保留偏好、重建、fork 不自动 boot、fork/父 session 删除销毁沙箱 |
| 2026-09-24 | 同上，`OPENCODE_SESSION_AUTO_KEEPALIVE=0` 独立实例（14107）                                                                              | `sandbox-keepalive-lazy-v2.mjs`                 | ✅ boot=false 写 pending/true 且不建远端沙箱；首次 shell 懒创建并继承偏好                                                |
| 2026-09-24 | 同上，`OPENCODE_SANDBOX_IDLE_REAP_SEC=60`                                                                                                | idle reap 手工用例                              | ✅ `keep_alive=false/true` 两个过期 running 行 275s 内回收为 destroyed，`keep_alive=true` 偏好保留                       |
| 2026-09-24 | 本地                                                                                                                                     | `sandbox-provider/config/path` 单测 + typecheck | ✅ 19 pass / 0 fail                                                                                                      |
| 2026-10-24 | Vercel provider：独立容器 `opencode-saas:vercel-t20-rg-20261024` + 专用 PG `opencode-v2-vercel-lifecycle-test`                          | `sandbox-keepalive-v2.mjs` / `sandbox-keepalive-lazy-v2.mjs` / `sandbox-idle-reap-v2.mjs` | ✅ 三个脚本退出码 0；详见下方「Vercel 后端复测」                                                                         |
| 2026-10-25 | Aliyun provider：`opencode-saas:aliyun-lifecycle-20261025` + `base-5wa5` + 独立生命周期 PG | 全部适用接口用例、边界补测、CAS 竞态、单测/typecheck | ⚠️ 主流程和懒创建通过；idle 保活回收、killed 重试、刷新 CAS 三项不符合契约；单测 114/114，通过详情见 [阿里云复测](aliyun-lifecycle-2026-10-25.md) |

复测备注：

- 脚本 `session.fork` 前置条件：父 session 需至少一条持久化消息；`synthetic resume:false` 只进 pending inbox 不满足。脚本已改为 fork 前用 `session.shell` 播种。
- 旧镜像 `opencode-saas-v2:local-session-log` 不含 root 自动 boot 逻辑（无 `OPENCODE_SESSION_AUTO_KEEPALIVE`），主脚本首断言会失败；需用包含该功能的镜像。
- 远端 OpenSandbox（30040）当前创建沙箱 `Failed`，不能用于本验收。

## Vercel 后端复测（2026-10-24）

独立 Docker 测试实例使用 `OPENCODE_SANDBOX_PROVIDER=vercel`（镜像 `opencode-saas:vercel-t20-rg-20261024`），通过真实 Vercel Sandbox 执行同一组生命周期脚本；三个脚本均经 `sandbox-vercel-t19.mjs` 包装器运行（创建会话后订阅公共 SSE，结束时删除会话、核对 PG 并做远端只读清理复核）。PG 使用专用库 `opencode-v2-vercel-lifecycle-test`。

**结果：三个脚本退出码均为 0。**

| 用例 | Vercel 实测结论 |
| --- | --- |
| root 自动保活/boot | PASS（`running` + `keep_alive=true`） |
| release | PASS（API 返回 false；PG `destroyed` 且 `keep_alive` 清除） |
| 显式 boot 与幂等 | PASS（新建 sandbox ID 与 PG 一致；重复 boot 返回同一 ID） |
| kill-sandbox | PASS（`destroyed`、sandbox ID 为 null、`keep_alive` 保留） |
| 销毁后重建 | PASS（新 ID、`running`、偏好保留） |
| fork 延迟创建 | PASS（无自动 sandbox 行；首次 shell 懒创建） |
| 子/父会话删除 | PASS（各自 sandbox 销毁） |
| session 删除 | PASS（沙箱销毁；`keep_alive` 偏好保留） |
| `boot:false` 懒创建 | PASS（`pending-<sessionID>`、`destroyed`、`keep_alive=true`，不创建远端沙箱） |
| 首次 shell 懒创建 | PASS（替换 pending 行，`running`，继承偏好） |
| 服务重启重连 | PASS（重启后复用 PG 中的 remote sandbox，shell 完成） |
| idle reap | PASS（`time_updated=0` 并重启后行变为 `destroyed`，`keep_alive` 保留） |
| 远端清理 | PASS（4 个测试沙箱均不存在，无残留快照） |

### 本轮环境编排注意

这两点会误判为产品失败，复跑时先排除：

1. 直接复用旧测试容器的全部 env 会带入 `OPENCODE_SESSION_AUTO_KEEPALIVE=0` 与 `OPENCODE_SANDBOX_IDLE_REAP_SEC=0`，导致「root 自动保活」首断言失败、idle reap 完全不扫描。本文验收必须去掉这两个变量；`boot:false` 实例才显式设置 `OPENCODE_SESSION_AUTO_KEEPALIVE=0`。
2. 两个实例同时对**空库**启动会竞争迁移 DDL（`duplicate key ... pg_type_typname_nsp_index`），后启动实例退出。先启动一个实例完成迁移，再启动第二个；这是测试库初始化顺序问题，不是生命周期回归。

### 证据与复跑

证据目录：`artifacts/vercel-lifecycle-20261024/`（`keepalive2/`、`lazy2/`、`idlereap/`、`summary.json`、`cleanup-verification.json`、`checks/`）。`keepalive/` 保留环境变量误配导致的首次失败，用于对照。

```bash
# 自动保活实例
BASE=http://127.0.0.1:15110 OPENCODE_PASSWORD=... \
PG_URL=postgresql://local@127.0.0.1:5432/<dedicated>-test \
STRESS_OUT="$PWD/artifacts/vercel-lifecycle-20261024/keepalive2" \
bun docs/test-cases/scripts/sandbox-vercel-t19.mjs sandbox-keepalive-v2 \
  "$PWD/artifacts/vercel-lifecycle-20261024/keepalive2"

# 懒创建实例（服务端 OPENCODE_SESSION_AUTO_KEEPALIVE=0）
BASE=http://127.0.0.1:15111 ... \
bun docs/test-cases/scripts/sandbox-vercel-t19.mjs sandbox-keepalive-lazy-v2 ...

# idle reap（同一自动保活实例；包装器要求容器名以 opencode-vercel-t19- 开头）
BASE=http://127.0.0.1:15110 RESTART_CONTAINER=opencode-vercel-t19-lifecycle-a ... \
bun docs/test-cases/scripts/sandbox-vercel-t19.mjs sandbox-idle-reap-v2 ...
```

## 不再适用的旧版断言

- `POST /session/:id/exec`、`/exec/async`、旧 `bash` 工具、`exec_log`：不是当前 V2 sandbox API 契约。
- `onIdle` 立即销毁、idleKill/zombie 清理、PVC/snapshot、`/sandbox/:sandboxID/kill`：当前 Provider 未实现这些旧生命周期路径，不应列为 V2 通过项。
- session 创建后一律没有 sandbox 行：仅在关闭 root 自动保活/boot 或创建 fork session 时成立；默认 root session 会异步自动 boot。
- `keep_alive=true` 永不回收：不成立；idle reap 仍会回收超时行，且保留 `keep_alive` 标记供后续重建继承。
