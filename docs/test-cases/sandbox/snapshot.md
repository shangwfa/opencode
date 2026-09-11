# 快照持久化（本地盘 + 快照分层）

> 设计文档：[`../../sandbox-snapshot-design.md`](../../sandbox-snapshot-design.md)。
> **仅适用于快照模式**：`OPENCODE_SANDBOX_VOLUME_TYPE=snapshot` + `OPENCODE_SANDBOX_SNAPSHOT_ENABLED=true`。
> workspace 位于沙箱 rootfs（本地盘），持久化依赖快照（docker commit / K8s SandboxSnapshot CRD）。
> 公共测试环境参考 `docs/local-test-env.md`；宿主机直跑参考 `local-test-env.md` 备选方案。

```bash
# 宿主机直跑（组合 3：本地 PG + 本地 OpenSandbox server:8080，镜像 opencode-opensandbox:slim）
# 关键开关：
#   OPENCODE_SANDBOX_VOLUME_TYPE=snapshot        workspace 走 rootfs，仅挂 shared package-cache
#   OPENCODE_SANDBOX_SNAPSHOT_ENABLED=true       启用快照（idle 回收前快照、创建时恢复）
#   OPENCODE_SANDBOX_SNAPSHOT_WAIT_SEC=300       快照 Ready 等待上限
#   OPENCODE_SANDBOX_IDLE_REAP_SEC=60            （测试用）缩短 idle 回收阈值
#   OPENCODE_SANDBOX_SNAPSHOT_IMAGE=<ref>        快照模式冷启动/降级镜像（默认 mini v1.0.0；
#                                                默认 pvc 模式仍用 OPENCODE_SANDBOX_IMAGE 原镜像）
# 注意：确保同一本地 PG 只有单实例 opencode server（双实例会互相回收对方沙箱）
export BASE=http://127.0.0.1:14097
export PG_URL='postgresql://local@127.0.0.1:5432/opencode'
```

---

## 二十五、快照生命周期

### T25.1 冷启动（无快照）：snapshot 模式建沙箱 + workspace 落 rootfs

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --max-time 120 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"df -T /workspace | tail -1 && mkdir -p /workspace/app && echo MARKER > /workspace/app/marker.txt && cat /workspace/app/marker.txt"}'
```

**期望**：`/workspace` 为 overlay（非 NFS/PVC 卷）；marker 写入成功；`session_snapshot` 表无该 session 记录。

> **本地实测**（2026-08-20，宿主机直跑 + slim 镜像）：PASS — 冷启动 5s 内完成（含 pnpm install 1.4s）

### T25.2 idle 回收触发快照

```bash
# 等待 idle（IDLE_REAP_SEC + 扫描周期），轮询快照表
psql $PG_URL -t -A -c "SELECT state FROM session_snapshot WHERE session_id='$SID' ORDER BY time_created DESC LIMIT 1"
# creating → ready（docker commit 大镜像 ~75s；轮询日志）
grep session-snapshot <server-log> | tail -3
```

**期望**：`creating` → `ready`；`sandbox` 表对应行 `destroyed`；日志出现 `snapshot ready on reap`。
**关键约束**：快照 Ready 之前源沙箱不被 kill（Creating 中 kill 会使 commit 失效）。

> **本地实测**（2026-08-20）：PASS — creating 75.4s 后 ready， waitedMs=75394

### T25.3 快照恢复：数据 + 依赖缓存 + 秒级

```bash
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"cat /workspace/app/marker.txt && ls /tmp/pnpm-vs >/dev/null && echo VS_KEPT && cd /workspace/app && rm -rf node_modules && pnpm install 2>&1 | tail -1"}'
```

**期望**：marker 存在、`/tmp/pnpm-vs`（依赖缓存）随快照保留、`pnpm install` 亚秒级（store 命中）；恢复总耗时 < 5s；日志 `restoreFrom=<snapshotId>`；快照状态转 `stale|restored`（已消费，保留作回退）。

> **本地实测**（2026-08-20）：PASS — restoreFrom=dee6406c…，恢复+exec（含 rm node_modules + 重装）3.2s，重装 702ms，快照标 stale|restored

### T25.3b 恢复来源真伪：真·快照恢复 vs 镜像冷启动

场景：`Sandbox.create(snapshotId)` 与 `Sandbox.create(image)` 都会返回一个 Running 沙箱——**状态无法区分来源**。本用例验证「声称从快照恢复」的沙箱确实携带快照数据，而非悄悄降级成了镜像冷启动；同时反向对照冷启动路径的数据为空。

```bash
# ── 方式 A：opencode HTTP 全链路 ──
# 1) snapshot 会话写入特征文件 → 快照 ready → 杀远端沙箱（或 idle 回收）
curl -s -X POST "$BASE/session/$SID/exec" -d '{"command":"echo SNAPSHOT-EVIDENCE-$RANDOM > /workspace/origin.txt"}'
curl -s -X POST "$BASE/session/$SID/snapshot"; sleep 40   # 等 ready
psql "$PG_URL" -tAc "DELETE FROM sandbox WHERE session_id='$SID'"  # 或直接杀远端
# 2) 触发重建，取三重证据
curl -s -X POST "$BASE/session/$SID/exec" -d '{"command":"cat /workspace/origin.txt"}'   # 数据面
psql "$PG_URL" -tAc "SELECT command FROM exec_log WHERE session_id='$SID' AND source='sandbox-create' ORDER BY time_created DESC LIMIT 1"
```

**期望**（快照恢复路径）：① exec 输出含 `SNAPSHOT-EVIDENCE-*`（数据随快照回来）；② exec_log `"restoredFromSnapshot":true`；③ 创建耗时显著低于该镜像冷启动基线（mini ≈5s，快照恢复应秒级）。
**反向对照**（降级冷启动路径）：marker 不存在（`No such file`）且 `"restoredFromSnapshot":false` —— 两标志必须**一致**；若出现 `true 但无 marker` 即「假恢复」，属严重缺陷。

```bash
# ── 方式 B：纯 curl 直连 OpenSandbox（绕开 opencode，定位服务侧行为）──
K=http://<opensandbox>; AUTH="OPEN-SANDBOX-API-KEY: <key>"
IMG=crpi-hlpnu8kiweghie0r.cn-hangzhou.personal.cr.aliyuncs.com/shangwfa/opencode-sandbox:v1.0.0
S=$(curl -s -X POST $K/sandboxes -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"image\":{\"uri\":\"$IMG\"},\"entrypoint\":[\"tail\",\"-f\",\"/dev/null\"],\"timeoutSeconds\":3600,\"resourceLimits\":{\"cpu\":\"1\",\"memory\":\"2Gi\"}}" | jq -r .id)
# 写特征文件（经 execd proxy，端口 44772）
curl -s -X POST $K/sandboxes/$S/proxy/44772/command -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"command":"mkdir -p /workspace && echo REAL-SNAP-MARKER > /workspace/mark.txt && sync"}'
SNAP=$(curl -s -X POST $K/sandboxes/$S/snapshots -H "$AUTH" -H 'Content-Type: application/json' -d '{"name":"restore-origin-check"}' | jq -r .id)
sleep 40   # 等 Ready（GET /snapshots/$SNAP 轮询 status.state）
curl -s -X DELETE $K/sandboxes/$S -H "$AUTH"   # 删源沙箱
# 反复恢复（多副本部署下有 NOT_FOUND 交替问题，见下方复测记录）→ 对成功的沙箱验证内容
R=$(curl -s -X POST $K/sandboxes -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"snapshotId\":\"$SNAP\",\"timeoutSeconds\":3600,\"resourceLimits\":{\"cpu\":\"1\",\"memory\":\"2Gi\"}}" | jq -r '.id // empty')
curl -s -X POST $K/sandboxes/$R/proxy/44772/command -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"command":"cat /workspace/mark.txt"}'   # stdout 必须输出 REAL-SNAP-MARKER
```

**期望**：stdout 含 `REAL-SNAP-MARKER` = 真·快照恢复；空/No such file = 实际是镜像冷启动。

> **远端 K8s 实测**（2026-08-22，方式 B）：PASS — 恢复成功 5/5 个沙箱均 cat 出完整 marker，快照 rootfs 物化真实有效。注意多副本部署下恢复请求约 50% 报 `SNAPSHOT::NOT_FOUND`（控制面元数据副本本地化，见上方根因分析），需重试至命中持有副本。
> **复测**（2026-09-07）：恢复循环 x10 仍 5 OK / 5 NOT_FOUND 完美交替——运维侧未修复，仍待根治（见文末复测记录）。
> **复测**（2026-09-10）：未修复——GET x12 独立连接严格 `404 200` 交替、新快照恢复 x10 仍 5 OK / 5 NOT_FOUND（marker 5/5 完整）。已沉淀自动化脚本 [`scripts/snapshot_notfound_check.py`](scripts/snapshot_notfound_check.py)（每请求独立 TCP 连接防 LB 粘滞误判，附粘滞对照组），见文末复测记录。
> **本地实测**（2026-08-20，方式 A 思路）：T25.3 的 marker+pnpm store 断言即隐式覆盖此真伪检查。

### T25.4 快照失败降级（源容器已死）

场景：快照 Creating 期间源容器被外部回收（如实例重启窗口的孤儿清理）→ server 端 commit 失效。

**期望**（当前语义）：快照记录 `failed`（reason=server reported Failed）；沙箱**保留**（行保持 killed）→ 下轮 reap 重试时发现沙箱已死 → 直接 killByID + destroyed；下次创建走镜像冷启动；GC 对账将遗留 `creating` 修正为 `failed`。

> **本地实测**（2026-08-20，旧语义下执行）：PASS — server 重启窗口内容器被回收，快照 bf0e222e 标记 failed，会话删除时正常清理
> **待复测**：新语义下"failed → 保留 → 下轮发现已死直接回收"链路

### T25.4b 快照失败保留沙箱（代码安全承诺）

场景：idle 回收时快照发起失败或 Failed/超时（如沙箱 server 故障）。

**期望**：沙箱**不被销毁**（保留代码），sandbox 行保持 killed；idle reap 的 killed 重试分支（每轮，≥300s）重试快照；期间用户消息返回 "cleanup pending" 错误（不无快照杀沙箱）；沙箱 server 侧 TTL 兜底最终回收。三条销毁路径（idle reap / zombie / killed 重试）语义一致。

> **扩展（2026-08-28）**：显式关闭接口同样遵守该承诺——`POST /session/:id/kill-sandbox`（T12.20）与 `POST /sandbox/:sandboxID/kill`（T12.19）对 snapshot 会话均**先快照 Ready 再销毁**，失败保留沙箱重试；单测 `sandbox-provider-destroy-by-id.test.ts` 覆盖（快照 Failed → 无 DELETE、行保持 killed）。

> **状态**：代码级验证 + 自动化测试（2026-08-20）：`test/tool/sandbox-idle-reap.test.ts` 18 pass（含 reconnect 500 保持 killed 不 DELETE）、`test/tool/session-snapshot-pg.test.ts` 3 pass（跨实例 creating 去重、getSnapshot 瞬时 500 重试后 Ready 落库、DELETE 500 保持 deleting 由 GC 收敛）；HTTP 层故障注入待补

### T25.5 同会话多快照只保留最新

```bash
# 恢复后再 exec → 再次 idle 快照 → 检查旧快照
psql $PG_URL -t -A -c "SELECT state FROM session_snapshot WHERE session_id='$SID' ORDER BY time_created"
```

**期望**：新快照 Ready 后，旧快照（含 stale）远端删除 + 记录 `deleted|superseded`；任意时刻每 session 至多一个有效快照。

> **本地实测**（2026-08-20）：PASS（sibling 清理随 ready 执行）

### T25.6 会话删除联动清理

```bash
curl -s -X DELETE "$BASE/session/$SID" -o /dev/null -w "DELETE: %{http_code}\n"
psql $PG_URL -t -A -c "SELECT state||'|'||coalesce(reason,'') FROM session_snapshot WHERE session_id='$SID'"
curl -s http://127.0.0.1:8080/snapshots   # OpenSandbox server 远端快照列表
```

**期望**：远端删除成功或 404 时记录为 `deleted|session deleted`；遇到 5xx/网络错误时记录保持 `deleting`，GC 下轮重试，远端最终无该会话条目。session 删除不会级联清除快照记录。

> **本地实测**（2026-08-20）：PASS — 记录 deleted:session deleted，远端无残留

### T25.7 关闭开关回归（pvc 模式不受影响）

```bash
# 用默认 VOLUME_TYPE=pvc + SNAPSHOT_ENABLED=false 跑既有用例
source docs/test-cases/test-env.sh 2   # 或对应组合
```

**期望**：sandbox-lifecycle.md（T12）/ preload-cache-switch-env.md（T24）全部用例行为不变；`session_snapshot` 表无新增记录。

> **本地实测**（2026-08-20）：PASS — 单测 sandbox-pvc.test.ts 40 pass（4 fail 为既有基线）；typecheck 无新增错误

### T25.9 显式快照 API（不依赖回收时机）

```bash
# 发起（异步，立即返回）——业务在关键节点手动触发，沙箱暂时进入 snapshotting
curl -s -X POST "$BASE/session/$SID/snapshot" -d '{}' -H 'Content-Type: application/json'
# → {"snapshotId":"96298045-…","state":"creating"}

# 轮询状态
curl -s "$BASE/session/$SID/snapshot"
# → {"snapshotId":"96298045-…","state":"ready"}   （docker commit ~75s）

# 用返回的 snapshotId 派生新会话（sandbox.snapshotId 参数）
curl -s -X POST "$BASE/session" -d '{"sandbox":{"cpu":"1","memory":"2Gi","snapshotId":"<id>"}}'
```

**期望**：POST 立即返回 creating；快照期间源沙箱为 snapshotting，新 exec/message 返回 snapshot pending；GET 轮询到 ready 后源沙箱恢复 running（不销毁）；派生会话数据完整。

> **本地实测**（2026-08-20）：PASS — idle 设 1h（排除回收干扰），显式快照 74s ready，派生会话 marker 完整

### T25.10 会话级镜像指定（sandbox.image）

```bash
# 会话 A 用指定镜像（需在沙箱 registry 存在；远端 K8s 用完整 registry URL，本地 OpenSandbox 可用短名）
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' \
  -d '{"sandbox":{"cpu":"1","memory":"2Gi","image":"crpi-hlpnu8kiweghie0r.cn-hangzhou.personal.cr.aliyuncs.com/shangwfa/opencode-sandbox:session-terminal"}}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s -X POST "$BASE/session/$SID/exec" -d '{"command":"node --version"}' -H 'Content-Type: application/json'
```

**期望**：沙箱用指定镜像创建；日志 `creating sandbox` 带 image（非全局默认）；`sandbox.image` 缺省时行为与之前一致（用全局镜像）。

> **本地实测**（2026-08-20）：PASS — 指定 `opencode-opensandbox:local` 后沙箱容器确认用该镜像创建
> **远端 K8s 实测**（2026-08-26）：PASS — 需用完整 registry URL，短名 `session-terminal` 会导致远端无法解析

### T25.11 快照会话传 pvcMode=app：参数失效不报错

```bash
# 快照模式部署下创建 app 模式会话
curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{"pvcMode":"app","appId":"my-app"}'
# 或会话级选择：-d '{"sandbox":{"cpu":"1","memory":"2Gi","persistMode":"snapshot"}}'
```

**期望**：创建成功（200）；快照会话 workspace 在 rootfs、不挂 app/session PVC 卷（仅 package-cache）；`pvcMode`/`appId` 参数不生效。`pvcMode` 是 PVC 模式内部维度（session/app 卷粒度），与持久化模式（pvc/snapshot）正交。

> **本地实测**（2026-08-20，代码级）：buildVolumes 单测覆盖（app 参数被忽略，仅挂 package-cache）

### T25.12 子会话继承 sandbox 参数（含 image/snapshotId）

```bash
# 父会话带 sandbox 配置创建，fork/子会话不传 sandbox
curl -s -X POST $BASE/session/:parentID/fork
# 子会话 exec 后查沙箱是否用父会话的 image/snapshotId
```

**期望**：子会话继承父会话 sandbox 整块配置（cpu/memory/image/snapshotId）。

> **本地实测**（2026-08-20）：PASS — parentID 创建子会话，`GET /session` 返回 `{'cpu':'1','memory':'2Gi','image':'opencode-opensandbox:local'}`，沙箱确认用继承镜像创建

### T25.13 metadata.sandboxSnapshot 回填

```bash
# 快照 ready 后（T25.2 或 T25.9），查询会话
curl -s $BASE/session/$SID | python3 -c "import json,sys;print(json.load(sys.stdin).get('metadata',{}).get('sandboxSnapshot'))"
```

**期望**：`{"id":"<snapshotId>","time":<ms>}`，与最新 ready 快照一致；业务自定义 metadata 字段不被覆盖。

> **本地实测**（2026-08-20）：PASS — `{"bizField":"keep-me","sandboxSnapshot":{"id":"00395281…","time":1787195896066}}`

### T25.14 keepAlive 与快照共存

```bash
curl -s -X POST "$BASE/session/$SID/keep-alive" -d '{"enabled":true}' -H 'Content-Type: application/json'
# 沙箱长期保留，不触发 idle 回收；显式快照 API 仍可用
curl -s -X POST "$BASE/session/$SID/snapshot"
```

**期望**：keepAlive 沙箱不被 idle 回收（无自动快照）；显式快照 API 正常工作。

> **本地实测**（2026-08-20）：PASS — keepAlive 开启后显式快照 ready，快照后沙箱保持 running

### T25.8 K8s 环境远端快照（待 RBAC）

**前置**：集群管理员给 `opensandbox-server` SA 授权 `sandboxsnapshots.sandbox.opensandbox.io` CRUD。

**期望**：远端 K8s 环境重复 T25.1-T25.6；关注 K8s CRD 实现的创建/恢复耗时基准（Docker 实测：创建 75s / 恢复 0.7s）。

> **状态**：~~BLOCKED — 远端 RBAC 403（2026-08-19 实测）~~ **已解除**（2026-09-07 复测）：RBAC 已授权，K8s 快照创建全链路正常（见文末复测记录）；完整 T25.1-T25.6 K8s 全量用例待跑

---

## 已知边界

| 场景 | 行为 |
|---|---|
| 快照不保留进程/内存 | dev server 需重启（FS-only 语义，同 Daytona cold snapshot） |
| 会话删除恰逢快照 Creating | 记录先转 deleting；删除失败由 GC 持久重试，awaitSnapshot 的 CAS 不会将其复活为 ready |
| baseline（app 级派生） | P4 未实现，表结构已预留 scope/app_id |
| 双实例共享同一 PG | creating claim 与 sandbox claim 均由 PG 原子协调；同一 session 的新请求在 killed/snapshotting 期间被拒绝 |

---

## 复测记录（2026-08-20，会话级 persistMode + P0/P1 修复后）

环境：宿主机直跑（本地 PG opencode_test + 本地 OpenSandbox 8080，镜像 opencode-opensandbox:slim，IDLE_REAP_SEC=60）。

| 用例 | 结果 | 备注 |
|---|---|---|
| T25.1 冷启动 rootfs | PASS | /workspace overlay，marker 写入，快照表 0 记录 |
| T25.2 idle 自动快照 | PASS | 60s 空闲 + 扫描周期后 creating→ready，Ready 后沙箱 destroyed |
| T25.3 快照恢复 | PASS | restoreFrom=<id>，marker 完整，快照 stale\|restored（slim 镜像无 /tmp/pnpm-vs，VS 断言仅 local 镜像适用） |
| T25.5 同会话多快照 | PASS | 新快照 ready 后旧快照 deleting\|superseded → GC 重试 → deleted\|superseded（实测 deleting→deleted 重试链路） |
| T25.6 会话删除清理 | PASS | 全部 deleted（session deleted / superseded），远端 /v1/snapshots 无残留 |
| T25.9 显式快照 | PASS* | 显式 POST 时沙箱已被 idle reap 接管（fenced），轮询 ready；语义正确 |
| T25.11 app 参数失效 | PASS | 快照会话不挂 app/session 卷（buildVolumes 单测 + 代码级） |
| T25.13 metadata 回填 | PASS | metadata.sandboxSnapshot 与最新快照一致 |
| 会话级 persistMode 固化 | PASS | 创建传 sandbox.persistMode=snapshot → GET /session 返回固化值，fork 继承（代码级） |
| T25.4/T25.4b 故障注入 | 单测覆盖 | session-snapshot-pg.test.ts（get 500 重试 / DELETE 500→deleting→GC 收敛 / 跨实例去重）；HTTP 层注入待补 |
| T25.7 pvc 回归 | 单测覆盖 | sandbox-pvc 46/46（含 persistMode 覆盖全局、app 参数失效） |
| T25.8 K8s | BLOCKED | RBAC 403（运维） |

单测汇总：sandbox-idle-reap 18/18、session-snapshot-pg 3/3、sandbox-pvc 46/46、sandbox-provider-pg 13/13、session-pvc-pg 8/8、files/exec/mcp/read-timeout 52/52、session-schema+write/read/edit 57/57、cleanup-volume 27/27、command-queue+concurrency 38/38、migrate-pg-sql 7/7。跳过：sandbox-glob-grep（拉取公共镜像 404）、pty/sandbox-runtime（缺 @/pty/sandbox-credential，基线）、session-tool-pg（sql 初始化基线缺陷）。

### T25.15 真实开发场景端到端：建会话 → 拉代码 → 开发 → 空闲快照 → 恢复续写

模拟业务真实使用：AI 在沙箱内拉取代码、开发需求、提交部分工作；沙箱空闲关闭（自动快照）；用户回来发消息，从快照恢复沙箱，验证代码与开发进度完整，并继续开发。

```bash
# ── 阶段 1：创建会话 + 拉取代码 + 开发 ─────────────────────────
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' \
  -d '{"sandbox":{"cpu":"1","memory":"2Gi","persistMode":"snapshot"}}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 拉取代码（公共小仓库；无外网时退化为 git init 自造项目）
curl -s --max-time 120 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && (git clone --depth 1 https://github.com/octocat/Hello-World.git app 2>&1 | tail -1) || (mkdir -p app && cd app && git init -q && echo hello > README.md && git add . && git -c user.email=t@t -c user.name=t commit -qm init)"}'

# 开发需求：改代码 + 装依赖（制造 node_modules 等重资源状态）
curl -s --max-time 120 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace/app && echo FEATURE_WIP > feature.txt && mkdir -p node_modules && echo cached > node_modules/.marker && git add feature.txt && git -c user.email=t@t -c user.name=t commit -qm wip && echo DEV_DONE"}'

# ── 阶段 2：等待空闲关闭（IDLE_REAP_SEC + 扫描周期，快照 Ready 后沙箱销毁）──
watch psql $PG_URL -tAc "SELECT state FROM session_snapshot WHERE session_id='$SID' ORDER BY time_created DESC LIMIT 1"   # → ready
psql $PG_URL -tAc "SELECT state FROM sandbox WHERE session_id='$SID'"   # → destroyed

# ── 阶段 3：恢复会话，从快照续写 ───────────────────────────────
T0=$(date +%s)
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace/app && cat feature.txt && cat node_modules/.marker && git log --oneline | head -2 && echo RESUME_FROM_$(git rev-parse --short HEAD)"}'
T1=$(date +%s)   # 恢复+exec 耗时 T1-T0，应 < 15s（快照恢复秒级 + 命令）

# 继续开发：在恢复的代码上再写一笔
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace/app && echo STEP2 > feature.txt && git add . && git -c user.email=t@t -c user.name=t commit -qm step2 && git log --oneline | head -3"}'
```

**期望**：
- 阶段 1：clone/开发命令 exitCode 0，`DEV_DONE` 输出
- 阶段 2：快照 `creating → ready`，**Ready 之后** sandbox 行才 `destroyed`；`metadata.sandboxSnapshot` 回填
- 阶段 3：恢复后 `feature.txt`=FEATURE_WIP、`node_modules/.marker` 存在（依赖缓存随快照保留）、git 历史含 `wip`；恢复+exec < 15s；日志 `restoreFrom=<snapshotId>`
- 续写：step2 提交成功，git 历史 wip → step2 连续；最终会话删除后快照与远端全部清理

> **本地实测**（2026-08-20，宿主机直跑 + slim 镜像，IDLE_REAP_SEC=60）：PASS — clone octocat/Hello-World → wip 提交（feature.txt + node_modules）→ 空闲 ~280s 进 creating（期间 sandbox killed 保留）→ ready 后 destroyed → 恢复 +exec **1.2s**（restoreFrom=3ca36579…，feature.txt/node_modules/git 历史完整）→ step2 续写提交成功（wip→step2 连续）→ 会话删除快照 `deleted:session deleted`、远端零残留。

### T25.16 快照恢复失败降级（快照丢失 → 镜像冷启动）

场景：快照 ready 后远端被删（GC 误删/层损坏/跨环境迁移），会话再 exec 时 `Sandbox.create(snapshotId)` 失败。

```bash
# 1. 建快照会话 + 写 marker + 显式快照到 ready
# 2. 远端手动删除快照
curl -s -X DELETE "http://127.0.0.1:8080/v1/snapshots/<snapshotId>"   # 204
# 3. kill-sandbox（显式销毁不触发快照，快照表记录保持）→ 再 exec 触发恢复
curl -s -X POST "$BASE/session/$SID/kill-sandbox"
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"cat /workspace/m.txt 2>&1 || echo FILE_GONE; echo EXEC_OK"}'
```

**期望**：exec exitCode 0（降级镜像冷启动成功、会话不阻塞）；marker 消失（FILE_GONE）；快照记录转 `failed|restore failed: Sandbox.create failed: Snapshot <id> not found`；日志 `snapshot restore failed; marked`。

> **本地实测**（2026-08-21）：PASS — 降级冷启动成功，`failed|restore failed` 落库，日志 `snapshot restore failed; marked`

### T25.17 stale 快照回退恢复（显式 kill 后回到最近快照时点）

场景：恢复消费后快照转 `stale|restored`（保留作回退）。显式 `kill-sandbox` **不触发快照**（sandbox-provider.ts destroy 无 snapshot 分支），此后数据回退到最近一次快照时点——恢复后的新写入丢失。

```bash
# 快照 ready（含 m2.txt）→ kill → exec 恢复（stale|restored）→ 写 post.txt → 再 kill → 再 exec
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" \
  -d '{"command":"cat /workspace/m2.txt && (cat /workspace/post.txt 2>&1 || echo POST_GONE) && echo FALLBACK_OK"}'
```

**期望**：m2.txt 存在（快照时点数据）、post.txt 不存在（POST_GONE，恢复后写入丢失）、exitCode 0；日志 `restoreFrom=<stale 快照 id>`。

> **本地实测**（2026-08-21）：PASS — stale 可重复恢复，语义为「FS-only 回退到最后快照」。**业务须知**：显式 kill-sandbox 会丢上次快照之后的写入，关键节点应先 POST /snapshot。

### T25.18 快照 TTL 过期 GC

前置：server 以 `OPENCODE_SANDBOX_SNAPSHOT_TTL_SEC=60` 启动（GC 挂 idle reap 扫描周期，固定 300s）。

```bash
psql $PG_URL -tAc "SELECT state||'|'||coalesce(reason,'') FROM session_snapshot WHERE id='<snapshotId>'"
```

**期望**：ready 后下个 GC 周期转 `deleted|ttl expired`，日志 `snapshot gc`；远端同步删除。

> **本地实测**（2026-08-21）：PASS — ready 后 ~150s 内 GC 收敛 `deleted|ttl expired`

### T25.19 派生会话传坏 snapshotId → 降级冷启动

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' \
  -d '{"sandbox":{"cpu":"1","memory":"2Gi","snapshotId":"00000000-0000-0000-0000-000000000000"}}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --max-time 90 -X POST "$BASE/session/$SID/exec" -d '{"command":"pwd && ls -A /workspace | wc -l"}' -H 'Content-Type: application/json'
```

**期望**：会话创建成功；exec 降级冷启动成功（workspace 空）；快照表无脏记录（markRestoreFailed 对非本会话快照 no-op）。

> **本地实测**（2026-08-21）：PASS — 附小瑕疵：`sandbox created` 日志仍打 `restoreFrom=<坏 id>`（实际冷启动），有误导性，待修

### T25.20 creating 卡死对账（GC reconcile 两分支）

```bash
# Ready 修正分支：把远端仍存在的 ready 快照 PG 状态改回 creating + 时间挪老（waitMs+60s 之外）
NOW=$(python3 -c "import time;print(int(time.time()*1000))")
psql $PG_URL -c "UPDATE session_snapshot SET state='creating', reason=NULL, time_created=$((NOW-1500000)) WHERE id='<远端存在的快照>'"
# 等 GC 周期（≤300s）
```

**期望**：
- 远端实际 Ready → `ready|reconciled` + sibling 清理 + metadata.sandboxSnapshot 回填 ✓
- 远端 404（已被删）→ **keeping creating 不收敛**（reconcile 对 404 仅 warn + continue）⚠️ 已知坑：卡死 creating 记录永不收敛，需人工清理或后续将 404 判定为 failed

> **本地实测**（2026-08-21）：Ready 分支 PASS（`ready|reconciled` + metadata 回填）；404 分支实测确认卡 creating 不收敛（坑已立档）

### T25.21 快照 creating 期间的消息路径（message vs exec）

```bash
# 发起显式快照（creating 窗口 ~75s）后立即发消息
curl -s -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用 bash 工具执行 echo win-check"}],"model":{...}}'
```

**期望与实测**（2026-08-21）：
- 纯文本消息（不碰沙箱）：HTTP 200 正常完成 ✓
- 带 bash 工具的消息：HTTP 200 完成（LLM loop 吞掉工具错误继续），但工具执行失败，AI 收到 `Sandbox creation failed` 并重试多次后放弃告知用户；快照 ready 后自动恢复 ✓
- ⚠️ 文案问题：getOrCreateUnlocked 的 "Sandbox snapshot pending" 失败被 Deferred.fail 包装成通用 `Sandbox creation failed`（HTTP 层 UnknownError），用户/AI 无法区分「快照中」与「创建故障」——文案待改进
- ⚠️ 测试坑：本机代理（http_proxy=127.0.0.1:7897）会拦截 curl 导致 HTTP 000，所有请求必须 `--noproxy '*'`

### T25.22 server 重启后沙箱接管（PG running + 内存 map 清空）

```bash
# keepAlive 会话沙箱 running → kill 直跑 server → 同配置重启 → exec
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" -d '{"command":"cat /workspace/restart.txt"}' -H 'Content-Type: application/json'
```

**期望**：getOrCreate 走 PG row(running) → reconnectIfPresent → healthy → 复用原沙箱（sandboxID 不变、数据完整）；日志 `reconnected to existing sandbox`。unhealthy 时 killed + cleanupSandbox(snapshot:true) → "cleanup pending" 下轮重试（代码路径，未注入）。

> **本地实测**（2026-08-21）：PASS — sandboxID 重启前后一致，RESTART_BASELINE 数据完整，日志 `reconnected to existing sandbox`（131ms）

### T25.23 混合部署：全局 pvc + 会话级 persistMode=snapshot

```bash
# 全局 VOLUME_TYPE=pvc + SNAPSHOT_ENABLED=true，会话显式 persistMode=snapshot
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' \
  -d '{"sandbox":{"cpu":"1","memory":"2Gi","persistMode":"snapshot"}}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" -d '{"command":"df -T /workspace | tail -1"}' -H 'Content-Type: application/json'
curl -s -X POST "$BASE/session/$SID/snapshot" -d '{}' -H 'Content-Type: application/json'
```

**期望**：workspace 在 rootfs（仅挂 package-cache）、显式快照正常。

> **本地实测**（2026-08-21）：**FAIL — 发现两个 bug**：
> ① workspace 误挂 PVC 卷（df 显示 btrfs 非 overlay）：`resolveSandboxOpts` 的 `safeParse`（session-opts.ts:52-64）只保留 cpu/memory/image/snapshotId、**丢弃 persistMode** → createSandbox 回退全局 pvc → buildVolumes 挂 workspace PVC 卷。全局 snapshot 部署下 fallback 碰巧一致故不暴露。
> ② 显式快照返回 `unavailable`（createSnapshot 静默 null，1870 catchCause 吞掉具体原因，无日志）。
> 附带验证：kill-sandbox 后数据经 PVC 卷保留（MIX_MARKER 在）——数据不丢但持久化方式与会话声明不符。
> **危险组合防护确认**：全局 pvc + SNAPSHOT_ENABLED=false + 会话 persistMode=snapshot → 创建直接 400（session.ts:796 "persistMode=snapshot 需要 OPENCODE_SANDBOX_SNAPSHOT_ENABLED=true"），静默数据丢失不存在 ✓
>
> **修复后复测（2026-08-21 同日）**：**PASS**。
> **真实根因**（比初判更深）：db.pg.ts 的 jsonb 类型 override `parse: (x) => x` 使 drizzle 读 jsonb 列得到**原始 JSON 字符串**——`resolveSandboxOpts` 走 safeParse 分支丢 persistMode；`dbResolvePersistMode` 直接按对象访问字符串得 undefined → 两处同根因回退全局 pvc。
> **修复内容**：
> - `sandbox-opts.ts`：新增导出 `parseSandboxColumn(raw)` 统一解析 string|object 双形态并透传 persistMode；`resolveSandboxOpts` 改用
> - `sandbox-provider.ts` `dbResolvePersistMode`：改用 `parseSandboxColumn`
> - `sandbox-provider.ts` `createSnapshot`：各 null 分支补 reason 日志，catchCause 改为 log.error 不再静默
> - 顺带：降级冷启动后 `restoreFrom` 日志不再打无效 id（T25.19 瑕疵）；GC reconcile 对远端 404 的 creating 记录标 failed 终止重试（T25.20 坑）
> **复测结果**：场景 1 全链路 PASS（/workspace overlay ✓、显式快照 creating→ready ✓、kill 后恢复 FIX_MARKER + restoreFrom 日志 + stale|restored ✓）；全局 snapshot 部署回归冒烟 PASS（exec/快照/恢复正常）；typecheck 无新增错误（39 < 基线 43）。

### T25.24 无变更复用快照（kill/idle 回收跳过重复快照）

场景：沙箱自上次快照 Ready 后 workspace 无任何写入（如恢复后仅读操作、或纯闲置）时，销毁路径（kill-sandbox / idle 回收 / destroyById）不再重复发起快照，直接复用已有 ready/stale 快照并立即销毁——省 20~80s 快照创建与远端存储。

机制：快照 Ready 前在源沙箱 rootfs 写入 marker（`/var/tmp/.opencode-snapshot-marker`）和内容清单（`/var/tmp/.opencode-snapshot-manifest`，均随快照持久化）；销毁前用临时 command session 执行 mtime 快速筛查和 mode、size、SHA-256 清单比对。两者均无变化才复用；marker/清单缺失、有新写入、RPC/命令失败或超时均保守走原快照路径。显式 `POST /snapshot` 不复用（业务要求「现在」时点）。

```bash
# 场景 1：复用主路径（无写入 → 不新建快照）
curl -s -X POST "$BASE/session/$SID/exec" -d '{"command":"echo data > /workspace/a.txt"}'   # 写入
curl -s -X POST "$BASE/session/$SID/snapshot"; <等 ready>                                   # 快照 S1
curl -s -X POST "$BASE/session/$SID/kill-sandbox"                                           # S1 后无写入
# 期望：日志 snapshot reused (workspace unchanged)；快照表无新 creating/ready 记录（仍只有 S1）；
#       远端 POST /sandboxes/<id>/snapshots 未发生；销毁秒级完成（无 20~80s 快照等待）
#       GET /session/$SID/sandbox → sandboxId 立即 null
#       ★ 再 exec 恢复：cat /workspace/a.txt == "data"（复用快照数据完整，非空/非镜像冷启动）

# 场景 2：dirty 路径（有写入 → 正常新快照）
curl -s -X POST "$BASE/session/$SID/exec" -d '{"command":"echo more > /workspace/b.txt"}'   # S1 后写入
curl -s -X POST "$BASE/session/$SID/kill-sandbox"
# 期望：新快照 S2 creating→ready；S1 superseded；行为与改动前完全一致

# 场景 3：回退安全（命令通道异常 → 保守快照）
# execd 不可达/命令失败时（注入方式：mock 或环境故障），kill 仍走「先快照 Ready 再销毁」原路径

# 场景 4：idle 回收复用（自动快照主战场，前置 OPENCODE_SANDBOX_IDLE_REAP_SEC=60）
# 建快照会话 → 写 marker → 等 idle 自动快照 S1 ready（沙箱 destroyed）→ exec 恢复（S1 转 stale）
# → 无写入 → 等下一轮 idle 回收
# 期望：日志 snapshot reused；快照表无新快照（仍只有 stale S1）；sandbox 行 destroyed
#       （此前每次 idle 都会重新快照，现在无变更直接复用）

# 场景 5：显式 POST /snapshot 不复用（反向语义）
# S1 ready 后无任何写入 → 显式 POST /session/$SID/snapshot
# 期望：仍产生新快照 S2 creating→ready（不复用 S1）；S1 superseded
#       （业务显式要「现在」时点，必须新快照，防止实现误伤）

# 场景 6：连续复用（stale 快照）
# S1 ready → kill（复用，S1 转 stale）→ exec 恢复 → 无写入 → 再次 kill
# 期望：再次复用 stale S1；快照表无新记录；数据仍完整

# 场景 7：升级兼容（旧快照无 manifest）
# 用升级前镜像创建的快照 S0（无 /var/tmp/.opencode-snapshot-manifest）→ 恢复 → 无写入 → kill
# 期望：首次 kill 判 dirty（多一次快照补 manifest，S0 superseded）；第二次无写入 kill 才复用
```

**期望**：单测 `test/tool/sandbox-snapshot-reuse.test.ts`（判定脚本六态 / Effect 映射 / findRestorable / destroy 三路径）全过；集成场景 1~7 行为如上（1/2/4 为核心，5 反向，7 升级兼容）；T25.4b 安全承诺不变（复用失败不影响「快照未成功不销毁」）。

> **实现记录**（2026-09-10）：
> - 代码：`sandbox-provider.ts` 模块级新增 `SNAPSHOT_MARKER_PATH` / `snapshotDirtyCheckCommand` / `workspaceUnchangedSinceSnapshot` / `touchSnapshotMarker`；`cleanupSandbox` 快照分支 startSnapshot 前插「无变更 → 复用 `findRestorable` 最新快照直接销毁」；快照 Ready 后 touch marker（cleanupSandbox 与显式 `createSnapshot` 两路径）。`session-snapshot.ts` 暴露 `findRestorable`。
> - 判定语义：**两级判定**——① `find /workspace -newermm <marker> -print -quit` mtime 快速路径；② mode、size、SHA-256 内容清单全量比对，覆盖 mtime 回填、粗粒度时间分辨率与同尺寸内容改写。快照恢复会重建文件 ctime，不能将 ctime 用作快照间判定。清单缺失/扫描超时/不一致/命令失败一律保守 dirty 走原快照路径。**T25.4b 安全承诺不变**。
> - 执行路径：判定使用一次性 `commands.createSession` / `runInSession` / `deleteSession`，避免恢复沙箱的无会话 `/command` SSE 流可能不结束；SDK 和沙箱内命令均有超时，超时直接保守快照。
> - 已知边界：① 仅对比 /workspace（npm cache 等更新不触发新快照，属预期收益）；② marker 写在快照开始前，随 rootfs 保存；③ find 与清单扫描瞬间的并发写入存在理论竞态窗口，丢失量级为 dev server 临时文件；④ 删除/重命名由父目录 mtime 覆盖。
> - 单测：`test/tool/sandbox-snapshot-reuse.test.ts` 16/16 pass；回归 `sandbox-provider-destroy-by-id.test.ts` 9/9 pass；typecheck 59 个既有错误，无新增。
> - **集成复测待办**：场景 3/4/7 及其余全量快照用例仍需按专项环境执行。

### T25.25 快照操作队列持久化 + 跨实例租约接管

场景：kill/idle 回收触发的快照销毁不再只依赖进程内 fiber，而是先写 `snapshot_operation`（durable job），再由 worker 凭租约领取执行；实例崩溃后另一实例凭租约过期接管。

```bash
PSQL="psql $PG_URL -Atc"
# 造一条 pending 操作（模拟崩溃遗留），任意 kill 触发 drain
$PSQL "INSERT INTO snapshot_operation (id,session_id,sandbox_id,kind,state,attempts,fencing_token,time_created,time_updated)
  VALUES ('op_t2525','$SID','ghost-2525','snapshot_destroy','pending',0,0,extract(epoch from now())*1000,extract(epoch from now())*1000)
  ON CONFLICT DO NOTHING"
curl -s -X POST "$BASE/session/$SID/kill-sandbox"
# 期望：op → done|attempts=1|fencing=1（幂等执行体，reconnect 404 后 killByID 忽略 404 → dbMarkDestroyed）
$PSQL "SELECT state||'|attempts='||attempts||'|fencing='||fencing_token FROM snapshot_operation WHERE id='op_t2525'"
```

**期望**：操作 `done|attempts=1|fencing=1`；正常 kill 的 op 同样落库并 `done`。多实例同时 drain 时靠 `FOR UPDATE SKIP LOCKED` 不重复领取。

### T25.26 fencing：租约过期接管后旧执行者不覆盖状态

场景：执行体运行期间续租；租约过期被接管后，旧执行者的 `complete`/`fail`/`heartbeat` 全部失效。

```bash
PSQL="psql $PG_URL -Atc"
NOW=$(date +%s000)
# 造 running 且租约未过期（owner=dead-instance）
$PSQL "INSERT INTO snapshot_operation (id,session_id,sandbox_id,kind,state,attempts,fencing_token,lease_owner,lease_until,time_created,time_updated)
  VALUES ('op_t2526','$SID','ghost-2526','snapshot_destroy','running',1,7,'dead-instance',$((NOW+300000)),$NOW,$NOW) ON CONFLICT DO NOTHING"
curl -s -X POST "$BASE/session/$SID/kill-sandbox"; sleep 6
# 期望①：租约未过期，另一实例不领取 → 仍 running|fencing=7
$PSQL "SELECT state||'|fencing='||fencing_token FROM snapshot_operation WHERE id='op_t2526'"
$PSQL "UPDATE snapshot_operation SET lease_until=$((NOW-1000)) WHERE id='op_t2526'"
curl -s -X POST "$BASE/session/$SID/kill-sandbox"
# 期望②：租约过期后被接管 → done|fencing=8|attempts=2（fencing 单调递增）
$PSQL "SELECT state||'|fencing='||fencing_token||'|attempts='||attempts FROM snapshot_operation WHERE id='op_t2526'"
```

**期望**：未过期不领取；过期后 `done|fencing=8|attempts=2`。单测 `snapshot-operation.test.ts` 覆盖「旧 token complete 被拒」「心跳失租返回 false」。

### T25.27 幂等唯一索引：并发 enqueue 收敛为一条

场景：同 `session_id + sandbox_id + kind` 的活跃操作至多一条；并发 enqueue 由部分唯一索引 + `ON CONFLICT DO NOTHING` 收敛。

```bash
PSQL="psql $PG_URL -Atc"
# 并发插入（应用层 enqueue 等价）
for i in $(seq 1 6); do
  $PSQL "INSERT INTO snapshot_operation (id,session_id,sandbox_id,kind,state,attempts,fencing_token,time_created,time_updated)
    VALUES ('op_t2527_$i','$SID','sb-2527','snapshot_destroy','pending',0,0,extract(epoch from now())*1000,extract(epoch from now())*1000)
    ON CONFLICT DO NOTHING" &
done; wait
# 期望：活跃操作仅 1 条
$PSQL "SELECT count(*) FROM snapshot_operation WHERE session_id='$SID' AND sandbox_id='sb-2527' AND state IN ('pending','running')"
```

**期望**：结果为 `1`；索引定义 `snapshot_operation_active_uniq ON (session_id, sandbox_id, kind) WHERE state IN ('pending','running')`。

### T25.28 快照兼容性元数据 + schema 不兼容阻断

场景：快照记录 `image` / `arch` / `schema_version` / `runtime_version`；恢复前校验 `schema_version`，不兼容则标记 failed 并冷启动。

```bash
PSQL="psql $PG_URL -Atc"
# 建快照后查元数据
$PSQL "SELECT 'schema='||coalesce(schema_version::text,'-')||' runtime='||coalesce(runtime_version,'-')||' arch='||coalesce(arch,'-') FROM session_snapshot WHERE session_id='$SID' ORDER BY time_created DESC LIMIT 1"
# 人为置不兼容版本 → kill → 恢复
$PSQL "UPDATE session_snapshot SET schema_version=999 WHERE session_id='$SID'"
curl -s -X POST "$BASE/session/$SID/kill-sandbox"; <等 destroyed>
curl -s -X POST "$BASE/session/$SID/exec" -d '{"command":"cat /workspace/a.txt 2>&1"}'
# 期望：冷启动（a.txt 不存在），快照 failed|incompatible
$PSQL "SELECT state||'|'||coalesce(reason,'-') FROM session_snapshot WHERE session_id='$SID' ORDER BY time_created DESC LIMIT 1"
```

**期望**：元数据落库（`schema=1`、`runtime_version`、`image`）；置 `999` 后恢复冷启动、快照 `failed|incompatible: schema 999 != 1`；`schema_version=1` 的正常快照不受影响（T25.17/T25.24 回归）。`arch` 取自远端 `SandboxInfo.platform.arch`，该远端实现可能不返回（为空时跳过 arch 检查）。

### T25.29 快照聚合统计接口

场景：`GET /snapshot/stats` 从 `session_snapshot` + `exec_log` 聚合，供观测。

```bash
curl -s "$BASE/snapshot/stats" | python3 -m json.tool
# 期望字段：snapshots（状态分布）、operations（各 source 的 count/p50Ms/p95Ms）、
#          gc（creating/deleting backlog）、derived（reuseHitRate/fallbackRate）
```

**期望**：返回 `snapshot-create` / `snapshot-restore` / `snapshot-reuse` / `snapshot-fallback` 的计数与 P50/P95；`reuseHitRate = reuse/(reuse+create)`、`fallbackRate = fallback/(restore+fallback)`。历史 `snapshot-reuse` 记录兼容旧 `checkMs` 字段。

### T25.30 快照 prune 与体积观测

场景：`OPENCODE_SANDBOX_SNAPSHOT_PRUNE=1` 时快照前清理可重建产物；`snapshot-create` 记录 `workspaceKb` / `pruned`。

```bash
# 容器需带 OPENCODE_SANDBOX_SNAPSHOT_PRUNE=1
# 写入后 kill → 查 exec_log
psql "$PG_URL" -Atc "SELECT command FROM exec_log WHERE session_id='$SID' AND source='snapshot-create' ORDER BY time_started DESC LIMIT 1"
# 期望：command 含 "workspaceKb":<n>,"pruned":true
```

**期望**：`pruned=true` 且 `workspaceKb` 有值；默认（未设 flag）`pruned=false` 且不执行清理。清理白名单：`/root/.cache`、`/home/sandbox/.cache`、`/workspace/.cache`（不含 `/tmp` 与 pnpm store）。

### T25.31 快照失败原因落库

场景：远端 `SnapshotStatus.reason`/`message` 落库到 `session_snapshot.reason`，排障可见根因。

```bash
PSQL="psql $PG_URL -Atc"
# 快照 Failed（远端因 RegistryNotConfigured / POD_READY_TIMEOUT 等失败）后
$PSQL "SELECT state||'|'||coalesce(reason,'-') FROM session_snapshot WHERE session_id='$SID' ORDER BY time_created DESC LIMIT 1"
# 期望：failed|server Failed: <reason>: <message>
# 超时：creating|wait timeout: <最后观察到的 reason>
# GC 对账失败：failed|reconcile: Failed: <reason>
```

**期望**：`reason` 含远端根因字符串；单测 `session-snapshot-pg.test.ts` 用 mock 覆盖「Failed + reason → 落库」。

### T25.32 远端 API 能力边界（调研，非用例）

场景：评估快照分层/差量/内存快照的可行性。

- **支持**：整机 rootfs 快照（`POST /sandboxes/{id}/snapshots`，body 仅 `{name?}`）；从快照创建沙箱（`CreateSandboxRequest.snapshotId`，与 `image` 互斥，可同时带 `platform`/`volumes`/`networkPolicy`/`resourceLimits`/`entrypoint`）；快照 `Creating/Ready/Failed/Deleting` + `reason/message/lastTransitionAt`。
- **不支持**：directory snapshot（无 path 参数）、差量/增量快照、memory snapshot 控制、mount/unmount 快照到运行中沙箱、快照大小/digest 等元数据。
- **结论**：workspace/依赖/系统层分层（原建议第 6 项）在当前远端 API 下**无法实现**，需远端新增 directory snapshot + mount 能力。当下可用替代：`snapshotId + volumes` 组合（快照 + 独立卷）、`status.reason` 排障（已用于 T25.31）。

---

## 复测记录（2026-08-21，commit 13b750953b，镜像重建后全量回归 + 缺口用例补充）

环境：宿主机直跑（本地 PG `opencode_test` + 本地 OpenSandbox 8080，镜像 `opencode-opensandbox:slim`；缺口用例阶段 IDLE_REAP_SEC=3600 排除回收干扰、TTL 用例单独以 SNAPSHOT_TTL_SEC=60 重启；新版 opensandbox-server 需在 `~/.sandbox.toml` 补 `runtime.execd_image`，见文末备注）。

| 用例 | 结果 | 备注 |
|---|---|---|
| T25.1 冷启动 rootfs | PASS | /workspace overlay，marker 写入，快照表 0 记录，冷启动秒级 |
| T25.2 idle 自动快照 | PASS | ~130s 进 creating（期间 sandbox killed 保留），76s 后 ready → destroyed，日志 `snapshot ready` |
| T25.3 快照恢复 | PASS | restoreFrom=d10db4e8…，MARKER 完整，快照 stale\|restored；VS_NA（slim 无 /tmp/pnpm-vs，同 08-20） |
| T25.3b 恢复来源真伪 | PASS | 方式 B 纯 curl 直连：恢复成功 5/5 沙箱均含完整 marker（真·快照恢复，非镜像降级假恢复）；多副本 NOT_FOUND 交替需重试命中（见根因分析） |
| T25.5 同会话多快照 | PASS | 新快照 ready 后旧快照 deleting\|superseded；**docker 镜像父子层冲突**（新快照 commit 基于旧快照镜像层）致删除报 conflict、queued for retry，会话删除链路中全部收敛 deleted；「每 session 至多一个有效快照」始终满足 |
| T25.6 会话删除清理 | PASS | deleted\|session deleted / superseded 全量收敛，远端 /v1/snapshots 0 残留 |
| T25.9 显式快照 | PASS* | keepAlive boot 拉起后 POST 返回 creating，70s ready，源沙箱全程 running 未销毁；派生会话（snapshotId 参数）marker/marker2 完整；快照期间 exec 被拒（getOrCreate → Sandbox creation failed，语义符合「snapshotting 期间拒绝新请求」）但 HTTP 表现为 500 UnknownError，未显式 "snapshot pending" 文案——文案待改进 |
| T25.13 metadata 回填 | PASS | `{"id":"c1d12b9e…","time":1787293397567}` 与最新 ready 快照一致 |
| T25.14 keepAlive 共存 | PASS | keepAlive 期间无 idle 回收，显式快照正常，快照后沙箱保持 running |
| T25.15 端到端 | PASS | clone → wip → 空闲 ~220s 进 creating（killed 保留）→ 300s ready+destroyed → 恢复+exec **2.3s**（restoreFrom=dbd4e2e4…，feature.txt/node_modules/.marker/git 历史完整）→ step2 续写 wip→step2 连续 → 删除后快照 deleted、远端零残留 |
| T25.4/T25.4b 故障注入 | 未跑 | 单测覆盖（同 08-20），HTTP 层注入待补 |
| T25.7 pvc 回归 | 未跑 | 单测覆盖（同 08-20） |
| T25.8 K8s | BLOCKED | RBAC 403（运维），维持 |
| T25.16 恢复失败降级 | PASS | 远端删快照 → kill → exec 降级冷启动，`failed\|restore failed` 落库 |
| T25.17 stale 回退 | PASS | stale 可重复恢复；显式 kill 丢恢复后写入（FS-only 回退语义，业务须知） |
| T25.18 TTL GC | PASS | TTL=60 下 ready 后 ~150s 收敛 `deleted\|ttl expired` |
| T25.19 坏 snapshotId | PASS | 降级冷启动成功；小瑕疵：日志仍打 `restoreFrom=<坏 id>`（误导，待修） |
| T25.20 creating 对账 | PASS/坑 | Ready 分支 `ready\|reconciled`+回填 ✓；404 分支 **keeping creating 不收敛**（坑已立档） |
| T25.21 快照期间消息 | PASS* | 纯文本正常；带 bash 工具 HTTP 200 但工具报 `Sandbox creation failed`（文案丢失 snapshot pending，待改进）；本机代理致 HTTP 000 的测试坑已记录 |
| T25.22 重启接管 | PASS | reconnect 复用原沙箱（sandboxID 不变、数据完整、131ms） |
| T25.23 混合部署 | **FAIL→PASS** | 初测 FAIL（safeParse 丢 persistMode 误挂 PVC 卷 + createSnapshot 静默 null）；**同日修复后复测 PASS**（rootfs overlay、快照/恢复全链路正常；危险组合 400 防护有效） |

**本轮新发现汇总**：
1. ~~**BUG**：`resolveSandboxOpts.safeParse` 丢弃 persistMode → 全局 pvc + 会话级 snapshot 固化失效（T25.23）~~ **已修复**：真实根因为 db.pg.ts jsonb parse 恒等返回字符串，新增 `parseSandboxColumn` 统一解析 string|object 双形态（sandbox-opts.ts），`dbResolvePersistMode` 同步修复
2. ~~**BUG（轻）**：createSnapshot 各 null 分支被 catchCause 静默吞掉，无任何日志（T25.23）~~ **已修复**：各分支补 reason 日志，catchCause 改 log.error
3. ~~**坑**：GC reconcile 对远端 404 的 creating 记录仅 warn + continue，永不收敛（T25.20）~~ **已修复**：404 判定 `failed|reconcile: not found on server`
4. ~~**文案**：snapshot pending 失败在工具/HTTP 层显示为通用 `Sandbox creation failed` / UnknownError（T25.9/T25.21）~~ **已修复**：`Deferred.await` 去掉 `orDie`（defect→fail）、`Deferred.fail` 透传原始 cause message、exec handler `Effect.catch` 保留错误。复测：exec 返回 HTTP 200 + stderr `Sandbox snapshot pending: <sid>/<sandboxid>`
5. ~~**瑕疵**：降级冷启动后 `sandbox created` 日志仍打 `restoreFrom=<坏 id>`（T25.19）~~ **已修复**：仅 restoredFromSnapshot 时打
6. **测试环境**：本机 http_proxy 会拦截 curl 致 HTTP 000，务必 `--noproxy '*'`；新版 opensandbox-server 必需 `runtime.execd_image`

**环境备注（新版 opensandbox-server）**：uvx 拉到的 opensandbox-server 新版配置 schema 强制要求 `runtime.execd_image`，缺失时启动报 pydantic `Field required`。需在 `~/.sandbox.toml` 的 `[runtime]` 段补：

```toml
[runtime]
type = "docker"
execd_image = "opensandbox/execd:v1.0.21"   # 以本地 docker images 实际版本为准
```

---

## 复测记录（2026-08-21 第二轮，mini 极简镜像 + 修复回归）

环境：宿主机直跑（本地 PG `opencode_test` + 本地 OpenSandbox 8080，镜像 **`opencode-opensandbox:mini`**，IDLE_REAP_SEC=3600 显式快照为主、TTL 用例单独以 SNAPSHOT_TTL_SEC=60 重启）。

> mini 镜像为路线 1 精简版（ubuntu:24.04 + node24 + pnpm10 + 功能工具，去语言运行时/context-mode/package-cache，rootfs 2.28G）。**快照创建由 ~86s 降至 ~10-15s**（waitedMs=10041 / 15089），恢复保持 ~2s。

| 用例 | 结果 | 备注 |
|---|---|---|
| T25.1 冷启动 rootfs | PASS | overlay、MARKER、快照表 0 记录 |
| T25.2/3 快照生命周期+恢复 | PASS | 显式快照 waitedMs=10.0s ready，kill 后恢复 2.0s，MARKER 完整，stale\|restored |
| T25.5 多快照 | PASS | 旧快照 deleting\|superseded → 会话删除收敛 deleted |
| T25.6 删除清理 | PASS | 全部 deleted\|session deleted |
| T25.9 显式快照 | PASS* | keepAlive 下 ready，沙箱 running 不销毁；派生会话数据完整；快照期间 exec 返回 **stderr `Sandbox snapshot pending: <sid>/<sandboxid>` HTTP 200**（文案修复生效，此前为 500 UnknownError） |
| T25.13 metadata | PASS | 与最新快照一致 |
| T25.14 keepAlive | PASS | 无 idle 回收，显式快照正常 |
| T25.15 端到端 | PASS | clone→wip→快照 ready→恢复 2.3s→step2 续写→删除清理 |
| T25.16 恢复失败降级 | PASS | `failed\|restore failed: Sandbox.create failed: Snapshot not found` |
| T25.17 stale 回退 | PASS | m2 在、post 丢（FS-only 回退语义） |
| T25.18 TTL GC | PASS | TTL=60 → ~290s `deleted\|ttl expired` |
| T25.19 坏 snapshotId | PASS | 降级冷启动；**日志瑕疵修复验证**（不再打 restoreFrom=<坏id>） |
| T25.20 creating 对账 | PASS | Ready 分支 `ready\|reconciled` ✓；**404 分支修复验证**：`failed\|reconcile: not found on server`（此前永不收敛） |
| T25.21 快照期间 exec | PASS | **文案修复验证**：HTTP 200 + stderr `Sandbox snapshot pending: <sid>/<sandboxid>`（此前 500 UnknownError）；ready 后回归正常 |
| T25.22 重启接管 | PASS | reconnect 复用同一 sandbox（126ms）、数据完整 |
| T25.23 混合部署 | PASS | **parseSandboxColumn 修复验证**：全局 pvc + 会话 snapshot → /workspace overlay（非 PVC 卷）、显式快照 creating（非 unavailable）、恢复正常 |
| T25.4/4b/7/8 | 未跑 | 单测覆盖（同前）；T25.8 维持 BLOCKED |

**结论**：修复（parseSandboxColumn / createSnapshot 日志 / reconcile 404→failed / snapshot pending 文案 / restoreFrom 日志）全部经复测验证生效；mini 镜像快照提速 ~85%（86s→10s）且功能无回归。

---

## 复测记录（2026-08-22，snapshotImage 分离 + 远端 K8s 实测）

环境：本地 PG + 远端 K8s 沙箱（useServerProxy=true），镜像含 snapshotImage 改动。

### snapshotImage 镜像分离

新增 `OPENCODE_SANDBOX_SNAPSHOT_IMAGE`（默认 `…opencode-sandbox:v1.0.0` mini 精简镜像）。镜像选择规则：

| 场景 | 镜像 |
|---|---|
| pvc/none 模式创建 | `OPENCODE_SANDBOX_IMAGE`（原镜像 session-terminal） |
| snapshot 模式冷启动（无快照） | `OPENCODE_SANDBOX_SNAPSHOT_IMAGE`（mini） |
| snapshot 模式恢复失败降级 | 同上（mini），保持后续快照一致性 |
| 快照恢复成功 | 不传 image（快照自带 rootfs） |
| 会话显式 `sandbox.image` | 最高优先，覆盖上述全部 |

实测（exec_log `sandbox-create` 记录，现记录实际镜像 + restoredFromSnapshot 标志）：pvc → session-terminal ✓；snapshot 冷启动 → v1.0.0 ✓（5.3s）。

### 远端 K8s 快照恢复 NOT_FOUND（根因已定位：多副本快照元数据不共享，待运维侧修复）

- 现象：快照 Ready（GET `/snapshots/{id}` 200，"Kubernetes snapshot image created successfully"）→ POST `/sandboxes` `{snapshotId}` 返回 `SNAPSHOT::NOT_FOUND`。
- **根因实锤**（2026-08-22 受控实验）：远端 OpenSandbox 为**双副本部署且快照元数据副本本地化、不共享**。同一请求连续重放呈完美 50% 交替：
  - GET 同一快照 12 次 → `404 200 404 200 …`（严格交替）
  - POST 恢复 8 次 → `NOT_FOUND OK NOT_FOUND OK …`，OK 的沙箱均真实创建且 Running
  - 即负载均衡打到持有快照数据的副本则成功，打到另一副本则报 NOT_FOUND。老快照（源沙箱早已销毁）同样「列表 Ready / 单查 404 交替」。
- 附带发现：快照列表中存在 `Failed | RegistryNotConfigured | snapshot-registry not configured in controller manager` 记录——远端未配置 snapshot-registry，快照 image 无法推送到共享仓库，这是副本间数据不共享的直接原因。
- **快照真实性验证**（2026-08-22 内容级对照实验）：纯 curl 绕开 opencode 全链路——建 mini 源沙箱 → proxy exec 写 `/workspace/mark.txt` → 快照 Ready → 删源沙箱 → 反复恢复 10 次（✓✗✓✗✓✗✓✗✓✗）→ 对 5 个恢复成功的沙箱逐一 `cat /workspace/mark.txt`：**全部输出 `REAL-SNAP-MARKER-822`，内容完整**。结论：快照数据是真的、rootfs 物化完整、恢复出的沙箱可用——缺陷纯粹在控制面元数据可见性（一半副本查无此快照），数据面无损。
- 排除过程：手动 curl 直连远端复现（排除 SDK/server 侧）；对比本地/远端 openapi.json 的 CreateSandboxRequest 字段一致（均有 snapshotId）；name/id 两种引用均报错。
- 我方语义保持 fail-fast：有就恢复、没有就走 markRestoreFailed + 镜像冷启动降级（已验证工作正常），不做重试绕过。

**运维侧处理建议**（二选一，推荐 b）：

1. OpenSandbox controller/API 收敛为单副本（快照数据天然一致；容量允许时最简单）
2. 配置 `snapshot-registry`（controller manager 启动参数）：快照物化 image 推送共享镜像仓库，所有副本/节点均可拉取——同时消除上面 RegistryNotConfigured 的 Failed 快照问题

修复后验证方法：

```bash
SNAP=<ready状态的快照id>; KEY=<OPEN-SANDBOX-API-KEY>
for i in $(seq 1 8); do
  curl -s -X POST http://<opensandbox>/sandboxes -H "OPEN-SANDBOX-API-KEY: $KEY" \
    -H 'Content-Type: application/json' \
    -d "{\"snapshotId\":\"$SNAP\",\"timeoutSeconds\":600,\"resourceLimits\":{\"cpu\":\"1\",\"memory\":\"2Gi\"}}" | head -c 80; echo
done
# 期望：8 次全部返回 sandbox id，无 SNAPSHOT::NOT_FOUND
```

- 历史：T25.3 恢复 PASS 是在**本地 OpenSandbox 单实例**（8080, python 0.2.2）验证的；T25.8 K8s 场景当时即 BLOCKED（RBAC 403）。K8s 多副本场景本次为首次实测。

### 附带发现

- `session_snapshot.session_id` 外键 `ON DELETE CASCADE`：`DELETE /session/:id` 会级联删除该会话全部快照记录（远端快照成孤儿，靠 TTL 清理）。**已确认维持现状**（2026-08-22）：「删会话=放弃一切」语义成立；正常恢复路径（session 存续 + 沙箱回收）不受影响，仅删会话后不可再恢复，孤儿快照由远端 TTL 过期兜底。

---

## 复测记录（2026-08-22 晚，resourceLimits 泄漏修复后全量回归）

> **根因修复**（`a5c4a91d01`）：`SandboxResource` 的会话级字段（persistMode/image/snapshotId）被整块塞进
> `resourceLimits` 传给远端，远端按非法资源规格处理 → Pod 永久 Pending → 服务端 60s 超时。
> 复现：同一请求体带 `"persistMode":"snapshot"` 于 resourceLimits → 61s 超时；剔除后 24s Running。
> 此前所有「池化排队/多副本/PG 切换」假设均为烟雾弹——之前没问题是因为旧会话从不传 sandbox.persistMode。

环境：本地 PG + 远程 K8s 沙箱（useServerProxy=true），镜像含 resource 泄漏修复 + snapshot 无卷 + SDK 默认超时。

| 用例 | 结果 | 备注 |
|---|---|---|
| T25.1 冷启动 | PASS | 5.3s，mini v1.0.0（snapshotImage 分离生效），快照表 0 记录 |
| T25.9 显式快照 | PASS | creating→ready ~20s，源沙箱保持 running |
| T25.3b 恢复来源真伪 | PASS | restoredFromSnapshot=true 且 marker 完整（真·快照恢复）；无 PVC（mount=0） |
| T25.3 快照恢复 | PASS | 杀沙箱→恢复 6.4s，restoreFrom=<id>，快照转 stale |
| T25.2 idle 自动快照 | PASS | 90s（idle 60s + 快照 15s + 销毁源沙箱），superseded 清理联动正确 |
| T25.5 同会话多快照 | PASS | S1 deleted\|superseded、S2 ready，仅保留最新 |
| T25.13 metadata 回填 | PASS | metadata.sandboxSnapshot 与最新 ready 一致 |
| T25.14 keepAlive 共存 | PASS | keep_alive=t，快照后源沙箱 running 不销毁 |
| T25.17 stale 回退 | PASS | 显式 kill 后从 stale 恢复，V2 数据完整，restored=true |
| T25.19 坏 snapshotId 降级 | PASS | 假 ID → 冷启动 9s，restored=false |
| T25.10 会话级 image 覆盖 | PASS | sandbox.image=session-terminal 实际生效（覆盖 mini 默认） |
| T25.11 app 参数失效 | PASS | pvcMode=app 创建 200，参数不报错 |
| T25.12 子会话继承 | PASS | 子会话 persistMode=snapshot 继承 |
| T25.15 端到端 | PASS | 开发→快照→杀→恢复 24s→续写 feature-v2 全链路 |
| T25.22 重启接管 | PASS | server 重启后 exec 0s 接管原沙箱（feature-v2 完整） |
| T25.23 混合部署 | PASS | 全局 pvc + 会话级 snapshot 并存互不影响 |
| T25.21 creating 期间路径 | PASS | creating 期间 exec 被拒/挂起，ready 后沙箱 running |
| T25.6 删除清理 | PASS | 删会话 PG 快照级联清零；远端快照不可查询（404） |
| T25.18 TTL GC | PASS(部分) | GC 删除链路 ✓（deleted\|ttl expired）；发现过期 ready 快照漏删 2 条（立档待查）；TTL 默认调整为 14 天 |

### 遗留与观察

- **远端 `/v1` BatchSandbox 波动**：同会话两次快照恢复一次 6.4s 一次 >30s（SDK 默认超时失败→降级冷启动）。
  fail-fast 兜底工作正常；如需消除偶发降级，可评估调大 SDK requestTimeoutSeconds（当前维持默认 30s）。
- **K8s 多副本快照 NOT_FOUND**（见上方根因分析）：本轮未复现（可能运气命中副本），仍待运维侧根治。
- snapshot 会话不再挂 package-cache 卷：T25.3 的 pnpm VS 断言不再适用（依赖缓存随快照 rootfs 持久化，
  首次冷启动无缓存属预期）。

---

## 复测记录（2026-08-26，补测 + 移除 SNAPSHOT_ENABLED guard）

环境：本地 PG + 远端 K8s 沙箱（useServerProxy=true），镜像 `opencode-saas-sandbox-test:skill-fix`，全局 `VOLUME_TYPE=pvc`，全局 `SNAPSHOT_ENABLED=true`，会话级 `persistMode=snapshot`。

**代码变更**：移除 `session.ts:794-796` 的 `SNAPSHOT_ENABLED` guard，用户显式传 `persistMode=snapshot` 不再需全局开关。

| 用例 | 结果 | 备注 |
|---|---|---|
| T25.1 冷启动 rootfs | PASS | 创建 5s，overlay，MARKER 写入，快照表 0 记录 |
| T25.9 显式快照 | PASS | creating→ready ~20s，源沙箱保持 running |
| T25.3 快照恢复 | PASS | 杀沙箱→恢复，MARKER 完整，stale\|restored |
| T25.5 同会话多快照 | PASS | 旧快照 deleted\|superseded，仅保留最新 ready |
| T25.13 metadata 回填 | PASS | `{"id":"<snapId>","time":<ms>}` 与最新一致 |
| T25.14 keepAlive 共存 | PASS | keepAlive 后显式快照正常，ready 后沙箱 running |
| T25.15 端到端 | PASS | clone→wip→快照 ready→恢复 6s→step2 续写→删除清理 |
| T25.6 删除清理 | PASS | `deleted\|session deleted`，远端零残留 |
| T25.19 坏 snapshotId | PASS | 降级冷启动成功，workspace 空 |
| T25.11 app 参数失效 | PASS | pvcMode=app 创建 200，参数不生效 |
| T25.12 子会话继承 | PASS | 子会话 persistMode=snapshot 继承 |
| T25.23 混合部署 | PASS | 全局 pvc + 会话 snapshot → overlay，快照恢复正常 |
| T25.22 重启接管 | PASS | 重启后 cleanup pending → 重建恢复（数据丢失因远端沙箱已销毁，符合预期） |
| T25.17 stale 回退 | PARTIAL | 第一次恢复 OK；第二次因远端快照 NOT_FOUND 降级冷启动（K8s 多副本已知问题） |
| T25.21 creating 期间消息路径 | PASS | 快照期间 exec 正常（沙箱未 busy），ready 后正常 |
| T25.10 会话级 image | PASS | 需用完整 registry URL，短名 `session-terminal` 远端无法解析 |
| T25.16 恢复失败降级 | 未单独跑 | T25.17 的降级冷启动路径已隐式覆盖 |
| T25.2 idle 自动快照 | 未跑 | 需缩短 IDLE_REAP_SEC 等待 |
| T25.4/4b 故障注入 | 未跑 | 单测覆盖 |
| T25.7 pvc 回归 | 未跑 | 单测覆盖 |
| T25.8 K8s | BLOCKED | RBAC 403（运维） |
| T25.18 TTL GC | 未跑 | 需专项环境缩短验证 |

**本轮新发现**：
1. `session.ts` 的 `SNAPSHOT_ENABLED` guard 已移除，会话级 `persistMode=snapshot` 不再依赖全局开关。
2. T25.10 远端 K8s 指定非默认镜像超时 — 非代码缺陷，环境限制。
3. T25.17 二次恢复因 K8s 多副本快照 NOT_FOUND 降级冷启动 — 已知环境问题，单实例本地 OpenSandbox 可复现完整 stale 回退。

---

## 复测记录（2026-09-07，运维侧问题复测）

环境：本地 PG + 远端 K8s 沙箱（30040 转发），纯 curl 直连 OpenSandbox（T25.3b 方式 B），镜像 mini v1.0.0。

| 运维问题 | 结果 | 证据 |
|---|---|---|
| RBAC 403（T25.8 前置） | **已解决** | mini 源沙箱 → snapshot → **Ready ~35s**，message `Kubernetes snapshot image created successfully`；快照列表 20 条全部 `Ready\|snapshot_runtime_ready`，无 `Failed\|RegistryNotConfigured` 记录 |
| K8s 多副本快照 NOT_FOUND | **未修复** | ① 同一 Ready 快照 GET 单查 x12 → 严格 `404 200` 交替；② 新快照（删源后）恢复循环 x10 → **5 OK / 5 `SNAPSHOT::NOT_FOUND`** 完美交替，恢复成功的 5 个沙箱 marker 全部完整（数据面仍无损）。与 08-22 根因（控制面元数据副本本地化）完全一致 |

**结论**：RBAC 已授权，T25.8 前置满足（可解除 BLOCKED）；多副本元数据不共享仍在，维持运维侧处理建议（二选一：controller/API 收敛单副本，或配置 `snapshot-registry`，推荐后者）。我方 fail-fast 降级语义持续工作正常（NOT_FOUND → markRestoreFailed → 镜像冷启动）。

**补充：交替机制实锤（2026-09-07 对照实验）**：LB 按 **TCP 连接**分发（非按请求）——单进程 curl 复用连接 x6 → 6/6 粘滞同副本全 404；独立 curl 新连接 x6 → 严格 `200 404` 交替；SDK `Sandbox.create` x7 全过（marker 完整，真·快照恢复）纯属连接粘在好副本的运气（SDK createSandbox 单发无重试）。**生产含义**：opencode server 对远端为池化长连接，粘在坏副本期间所有快照恢复 100% 失败降级，直至连接重建。另观察到第二故障形态 `KUBERNETES::POD_READY_TIMEOUT`（命中好副本但恢复 Pod Ready 超时，疑似高频建删压力/节点资源）。
**决议**：我方**不加重试兜底**——`Sandbox.create` 单发，成功即成功、失败即降级（fail-fast 语义维持）；根治依赖运维收敛单副本或上游支持共享快照存储（0.2.3 验尸确认 store 类型仍写死 `Literal["sqlite"]`，无共享后端选项）。

复测命令（修复后验收仍可用 T25.3b 脚本与上方 8 次恢复验证脚本）。

---

## 复测记录（2026-09-10，运维侧问题复测 + 脚本沉淀）

环境：本地直连远端 K8s OpenSandbox（172.18.32.15:30040），mini v1.0.0 镜像。

**新增自动化脚本**：[`scripts/snapshot_notfound_check.py`](scripts/snapshot_notfound_check.py)——完整链路（建源沙箱 → 写 marker → 快照 Ready → 删源 → GET 探测 + 恢复循环 + marker 校验 + 清理），退出码 0=FIXED / 1=BROKEN。

```bash
# 完整链路（base/key 已内置默认值，直接跑）
python3 docs/test-cases/sandbox/scripts/snapshot_notfound_check.py
# 快速探测（仅对已有快照 GET，不建资源）
python3 docs/test-cases/sandbox/scripts/snapshot_notfound_check.py --probe-snap <snapshotId>
```

> **连接粘性是探测的关键坑**：LB 按 TCP 连接分发——复用连接的客户端（`requests.Session`、SDK 连接池、`curl 多URL`）会粘滞单副本，得到「全 200」（误判已修复）或「全 404」（误判快照丢失）。脚本主判定每请求**独立新建 TCP 连接**，并附粘滞连接对照组佐证 LB 行为。

| 验证项 | 结果 | 证据 |
|---|---|---|
| 快照列表健康度 | 无 Failed | 20 条全部 `Ready\|Kubernetes snapshot image created successfully`，无 `Failed\|RegistryNotConfigured` |
| GET 单查 x12（独立连接） | **未修复** | 严格 `404 200` 交替（6/6），多副本元数据不共享典型特征 |
| 粘滞连接 GET x6 | 佐证 LB 行为 | 同一 TCP 连接全 404（粘在坏副本）；复用连接的探测结果不可信 |
| 新快照恢复 x10（独立连接） | **未修复** | 5 OK / 5 `SNAPSHOT::NOT_FOUND` 完美交替（快照 0a20a455，Ready ~30s） |
| 数据面完整性 | 无损 | 恢复成功的 5 个沙箱 `cat /workspace/mark.txt` 全部输出完整 marker |

**结论**：与 08-22 根因分析、09-07 复测完全一致，运维侧（收敛单副本或配置 snapshot-registry）仍未处理。我方 fail-fast 降级语义（NOT_FOUND → markRestoreFailed → 镜像冷启动）维持不变。

---

## 复测记录（2026-09-10 第二轮，运维修复后验收）

环境：同上，直连远端 K8s OpenSandbox。验证期间集群资源紧张（用户侧要求少量测试）。

| 验证项 | 结果 | 证据 |
|---|---|---|
| GET 单查 x8（独立连接） | **已修复** | 全 200，无 404（此前严格 `404 200` 交替） |
| 粘滞连接 GET x6 | 全 200 | 单一副本视角（对照成立） |
| 恢复循环 x8+x2（独立连接） | **已修复** | 8/10 OK + 2/2 OK；`SNAPSHOT::NOT_FOUND` **零出现**（此前 ~50%） |
| 失败形态变化 | 新现象 | 2 次失败均为 `KUBERNETES::POD_READY_TIMEOUT`（Pod Pending 60s，集群资源不足所致，与快照元数据无关；沙箱资源紧张期可复现） |

**结论**：多副本快照元数据不共享问题**已由运维修复**——GET 与恢复路径均无 NOT_FOUND。恢复失败的新原因是集群资源不足（POD_READY_TIMEOUT），属容量问题另案跟进。验证产物已即时清理（恢复出的沙箱全部 DELETE）。

> 复测命令：`python3 docs/test-cases/sandbox/scripts/snapshot_notfound_check.py`（资源紧张期建议 `--rounds 3` 并配合 `--probe-snap` 减少建沙箱）。

---

## 复测记录（2026-09-11，T25.24 连续复用修复）

环境：组合 1（本地 Docker，远端 PG + 远端 K8s Sandbox），默认 snapshot image。

| 验证项 | 结果 | 证据 |
|---|---|---|
| S1 后首次 kill | PASS | `snapshot reused (workspace unchanged)`，源 sandbox 销毁完成 |
| S1 恢复数据 | PASS | `cat /workspace/data.txt` 输出 `hello` |
| 恢复后无写入再次 kill（场景 6） | PASS | 同一 stale S1 再次 `snapshot reused`，快照数 `1 -> 1` |
| 快照状态 | PASS | S1 为 `stale|restored`，未创建 superseding snapshot |

会话 `ses_f7330077effeXMXs0OcHKhvGcj`，S1 `76a992da-1e23-463f-9303-7b40680bb9f1`。根因是恢复会重建 workspace 文件 ctime，原 ctime 快速筛查将未写入的恢复沙箱误判为 dirty；改为 mtime + 内容清单后通过。

---

## 复测记录（2026-09-11 第二轮，快照编排持久化 + 兼容性观测 + 分层准备）

环境：组合 2（本地 Docker，**本地 PG** + 远端 K8s Sandbox），默认 snapshot image，`OPENCODE_SANDBOX_SNAPSHOT_PRUNE=1`。

**改造内容**

1. **持久化操作队列（durable job）**：新增 `snapshot_operation` 表 + `src/tool/snapshot-operation.ts`。kill/idle 回收不再只依赖进程内 fiber，而是先 `enqueue` 落库，再由 worker 通过 `FOR UPDATE SKIP LOCKED` + 租约（5min）领取执行；失败指数退避（30s 起，上限 10min，5 次后转 `failed`），进程崩溃后其他实例可凭租约过期接管。执行体 `runSnapshotDestroy` 幂等，仍保持「快照 Ready 才销毁源沙箱」。
   - **fencing token**：`claim` 时单调递增，`complete`/`fail`/`heartbeat` 均带 token 校验；租约过期被接管后，旧执行者的写操作全部失效，不会覆盖新执行者状态。
   - **租约心跳**：执行体运行期间每 `LEASE_MS/3` 续租，续租失败即 `Effect.race` 中断执行体，避免旧执行者继续做销毁/快照副作用（快照最坏等 900s，超过 5min 租约）。
   - **幂等唯一索引**：`(session_id, COALESCE(sandbox_id,''), kind) WHERE state IN ('pending','running')` 部分唯一索引 + `ON CONFLICT DO NOTHING` + 回读，并发 enqueue 收敛为一条。
2. **兼容性元数据与观测**：`session_snapshot` 新增 `image` / `source_sandbox_id` / `restored_count` / `last_restored_at`；恢复前比对创建镜像与会话当前镜像，漂移记 warn 仍恢复。新增 `exec_log` 来源 `snapshot-create` / `snapshot-reuse` / `snapshot-restore` / `snapshot-fallback`，含 `durationMs` / `workspaceKb` / `pruned`。
3. **分层准备**：新增 `OPENCODE_SANDBOX_SNAPSHOT_PRUNE`（默认关），开启后快照前清理 `/root/.cache`、`/home/sandbox/.cache`、`/workspace/.cache` 等可重建产物（不删 `/tmp` 与 pnpm store）。完整 workspace/依赖分层仍受限于远端仅提供整机快照 API，记为后续项。
4. **兼容性元数据与阻断**：`session_snapshot` 新增 `arch` / `schema_version` / `runtime_version`。`SNAPSHOT_SCHEMA_VERSION` 标识快照内容布局版本，恢复前校验：`schema_version` 存在且不等于当前 → 标记 `failed|incompatible` 并冷启动；`arch` / `image` 漂移只记 warn 仍尝试恢复（远端失败会自动降级）。`arch` 取自 `SandboxInfo.platform.arch`，该远端实现可能不返回（当前记录为 null，仅跳过 arch 检查）。
5. **聚合统计接口**：新增 `GET /snapshot/stats`，从 `session_snapshot` + `exec_log` 聚合状态分布、各操作耗时 P50/P95、GC backlog（creating/deleting）、派生比率（复用命中率、fallback 比例）。**canary restore 评估后不做**：远端多副本快照元数据读不一致会误判 404，自动 canary 可能误杀可用快照，宜作为手动/运维工具。

**关键缺陷修复**：判定脚本原写法 `timeout N { find …; find …; }` 是非法 shell 语法（timeout 会把 `{` 当命令名）；execd 又把含命令源码的错误回显混入 stdout，其中的 `echo CLEAN` 字面量被 `includes("CLEAN")` 误判 → **写入后仍复用旧快照，导致数据丢失**。修复为子 shell 包裹两个 timeout，并将判定改为整行精确匹配 `CLEAN`。

| 验证项 | 结果 | 证据 |
|---|---|---|
| 迁移 | PASS | 26 条迁移应用；`snapshot_operation` 表与 `session_snapshot` 四个新列存在 |
| 复用主路径 | PASS | `snapshot-reuse` exec_log（`checkMs=142`）；`snapshot_operation` = `snapshot_destroy\|done\|attempts=1` |
| 恢复 | PASS | `snapshot-restore` exec_log 记录 image；`session_snapshot.restored_count=1`、`last_restored_at` 非空 |
| 写入后新快照 | PASS | `snapshot-create` exec_log（`durationMs=16558`、`workspaceKb=12`、`pruned=true`）；旧快照 superseded |
| 数据完整性 | PASS | 恢复后 `cat data.txt b.txt` = `hello\nmore`（修复前该场景会丢 b.txt） |
| 崩溃遗留接管 | PASS | 手动插入 pending 操作后，任意 kill 触发的 drain 将其领为 `done\|attempts=1\|fencing=1` |
| fencing/心跳/幂等 | PASS | 单测覆盖：旧 token complete 被拒、心跳失去租约返回 false、并发 enqueue 收敛为 1 条 |
| 多实例 SKIP LOCKED | PASS | A/B 双实例同时 drain 5 条 pending：全 `done\|attempts=1\|fencing=1`，无重复领取 |
| 租约保护 + 过期接管 | PASS | 租约未过期时另一实例不领取（仍 `running\|fencing=7`）；改过期后接管为 `done\|fencing=8\|attempts=2` |
| 跨实例并发创建 | PASS | 同一会话 A/B 并发 exec 均成功，仅创建 1 个沙箱（advisory xact lock 生效） |
| 兼容性元数据 | PASS | 快照记录 `schema_version=1`、`runtime_version`、`image`；`arch` 因远端未返回 platform 而为空 |
| schema 不兼容阻断 | PASS | 手动置 `schema_version=999` → 恢复时 `failed\|incompatible: schema 999 != 1`，冷启动（`a.txt` 不存在） |
| 正常路径不误阻断 | PASS | `schema_version=1` 快照正常复用 + 恢复（`cat k.txt` = `keep`） |
| 聚合统计接口 | PASS | `GET /snapshot/stats`：create p50=16.3s / restore p50=4.2s / reuse p50=114ms，`reuseHitRate=0.61` |
| 失败原因落库 | PASS | 远端 `status.reason` 写入 `session_snapshot.reason`（Failed/超时/GC 对账三路径） |
| 对应用例 | T25.25（操作队列+租约接管）、T25.26（fencing）、T25.27（幂等唯一索引）、T25.28（兼容性阻断）、T25.29（stats）、T25.30（prune）、T25.31（失败原因） |
| 单测 | PASS | `snapshot-operation`(10) / `sandbox-snapshot-reuse`(25) / `destroy-by-id`(9) / `session-snapshot-pg`(8) 共 52 pass |
| 类型检查 | PASS | 无本次文件新增错误 |

会话 `ses_f730d44e6ffeJsQ6yohH27pHkp`：S1 `dc6ea870…`（复用）→ 恢复 `7713763d…` → 写入后 S2 `08362a07…`（`ready`）。

---

## 复测记录（2026-09-11 第三轮，新增用例 T25.25~T25.31 执行）

环境：组合 2（本地 PG + 远端 K8s Sandbox），镜像 `snapshot-reuse`，`OPENCODE_SANDBOX_SNAPSHOT_PRUNE=1`。

| 用例 | 结果 | 证据 |
|---|---|---|
| T25.25 操作队列 + 接管 | PASS | 遗留 pending op → kill 触发 drain → `done\|attempts=1\|fencing=1` |
| T25.26 fencing | PASS | 租约未过期 `running\|fencing=7`；改过期后接管 `done\|fencing=8\|attempts=2` |
| T25.27 幂等唯一索引 | PASS | 并发 6 条同 `sandbox_id` → active=1（唯一索引收敛） |
| T25.28 兼容性元数据 + 阻断 | PASS | `schema=1` 落库；置 `999` → `failed\|incompatible: schema 999 != 1` + 冷启动（`a.txt` 不存在） |
| T25.29 聚合统计接口 | PASS | `keys=[derived,gc,operations,snapshots]`，`operations` 含 create/restore/reuse，`reuseHitRate=0.375` |
| T25.30 prune + workspaceKb | PASS | `snapshot-create` command 含 `workspaceKb=12,pruned=true` |
| T25.31 失败原因落库 | PASS（单测） | mock 远端 `Failed+reason` → `reason` 含 `RegistryNotConfigured`；集成制造 Failed 需故障注入，暂以单测覆盖 |

**结论**：新增用例 T25.25~T25.30 集成全部 PASS，T25.31 由单测覆盖。测试产物（`op_t25*`）已清理。

---

## 复测记录（2026-09-11 第四轮，评审缺口修复）

环境：组合 2（本地 PG + 远端 K8s Sandbox）。对评审指出的缺口逐项「验证存在 → 修复 → 验证通过」：

| 缺口 | 验证存在 | 修复 | 验证通过 |
|---|---|---|---|
| 恢复后无内容校验 | 恢复成功但内容损坏不可见 | 恢复后抽查 marker（`restoredMarkerCheckCommand`），`markerPresent` 落 `exec_log`，缺失记 warn 不阻断 | 恢复后 `markerPresent=true`，数据 `v1` 完整 |
| 显式快照无审计 | `POST /snapshot` 无任何 exec_log | `createSnapshot` 落 `snapshot-create` 且 `explicit=true`（自动快照 `explicit=false`） | 两条路径审计均落库 |
| stats 无健康评估 | 接口无告警信号 | 新增 `snapshotHealth` 纯函数（fallback 率>20%、creating>10、deleting>20 → degraded），`/snapshot/stats` 返回 `health` | `health={'status':'healthy','reasons':[]}`；单测 5 例覆盖各分支 |
| `arch` 形同虚设 | `session_snapshot.arch` 全 NULL（远端不返回 `platform`） | 改为快照前沙箱内 `uname -m`（`touchSnapshotMarker` 返回 `arch`，x86_64/aarch64 归一 amd64/arm64），并移除多余的 `getInfo` RPC | `arch=amd64` 落库 |
| 死代码 | `retired` 状态、`snapshot_delete` kind、`payload` 列均无使用 | 类型/写入点同步删除；迁移拆为「原版 `20260820000000` 不动 + 新增 `20260911000000`（ADD COLUMN + snapshot_operation 建表）」，保证已应用旧版迁移的共享 PG（远端 test）升级时 `CREATE TABLE IF NOT EXISTS` 跳过也不会缺列 | 双路径迁移验证：全新库顺序执行 ✓；模拟远端旧库（已应用原版 0808）升级补列 ✓ |
| RPO 语义未显式化 | — | 文档补充（见下） | — |

**RPO 说明**：快照模式的数据安全边界是「上次快照 Ready 时点」。运行中沙箱若被远端强制回收（节点故障/OOM），上次快照之后的写入会丢失——TTL/idle reap（默认 120s）内的崩溃最多丢一个回收窗口内的工作。业务对数据的要求超出此边界时，应在关键写入后显式 `POST /snapshot`。

**额外修复**：`runEphemeralCommand` 的 stdout 事件分片间不含换行符（SDK 实测 `["4","x86_64"]`），`join("")` 会把相邻行粘连成 `4x86_64` 导致清单解析失败——已改为 `join("\n")`，并为 `parseMarkerOutput` 补事件边界回归单测。

**单测**：60 pass（`snapshot-operation` 10 / `sandbox-snapshot-reuse` 33 / `destroy-by-id` 9 / `session-snapshot-pg` 8）；typecheck 59 既有错误无新增。
