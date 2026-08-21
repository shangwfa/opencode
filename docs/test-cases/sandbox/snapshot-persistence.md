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

### T25.4 快照失败降级（源容器已死）

场景：快照 Creating 期间源容器被外部回收（如实例重启窗口的孤儿清理）→ server 端 commit 失效。

**期望**（当前语义）：快照记录 `failed`（reason=server reported Failed）；沙箱**保留**（行保持 killed）→ 下轮 reap 重试时发现沙箱已死 → 直接 killByID + destroyed；下次创建走镜像冷启动；GC 对账将遗留 `creating` 修正为 `failed`。

> **本地实测**（2026-08-20，旧语义下执行）：PASS — server 重启窗口内容器被回收，快照 bf0e222e 标记 failed，会话删除时正常清理
> **待复测**：新语义下"failed → 保留 → 下轮发现已死直接回收"链路

### T25.4b 快照失败保留沙箱（代码安全承诺）

场景：idle 回收时快照发起失败或 Failed/超时（如沙箱 server 故障）。

**期望**：沙箱**不被销毁**（保留代码），sandbox 行保持 killed；idle reap 的 killed 重试分支（每轮，≥300s）重试快照；期间用户消息返回 "cleanup pending" 错误（不无快照杀沙箱）；沙箱 server 侧 TTL 兜底最终回收。三条销毁路径（idle reap / zombie / killed 重试）语义一致。

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
# 会话 A 用指定镜像（需在沙箱 registry 存在）
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' \
  -d '{"sandbox":{"cpu":"1","memory":"2Gi","image":"opencode-opensandbox:slim"}}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s -X POST "$BASE/session/$SID/exec" -d '{"command":"node --version"}' -H 'Content-Type: application/json'
```

**期望**：沙箱用指定镜像创建；日志 `creating sandbox` 带 image（非全局默认）；`sandbox.image` 缺省时行为与之前一致（用全局镜像）。

> **本地实测**（2026-08-20）：PASS — 指定 `opencode-opensandbox:local` 后沙箱容器确认用该镜像创建

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

> **状态**：BLOCKED — 远端 RBAC 403（2026-08-19 实测）

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

# 清理
curl -s -X DELETE "$BASE/session/$SID" -o /dev/null -w "cleanup: %{http_code}\n"
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

---

## 复测记录（2026-08-21，commit 13b750953b，镜像重建后全量回归 + 缺口用例补充）

环境：宿主机直跑（本地 PG `opencode_test` + 本地 OpenSandbox 8080，镜像 `opencode-opensandbox:slim`；缺口用例阶段 IDLE_REAP_SEC=3600 排除回收干扰、TTL 用例单独以 SNAPSHOT_TTL_SEC=60 重启；新版 opensandbox-server 需在 `~/.sandbox.toml` 补 `runtime.execd_image`，见文末备注）。

| 用例 | 结果 | 备注 |
|---|---|---|
| T25.1 冷启动 rootfs | PASS | /workspace overlay，marker 写入，快照表 0 记录，冷启动秒级 |
| T25.2 idle 自动快照 | PASS | ~130s 进 creating（期间 sandbox killed 保留），76s 后 ready → destroyed，日志 `snapshot ready` |
| T25.3 快照恢复 | PASS | restoreFrom=d10db4e8…，MARKER 完整，快照 stale\|restored；VS_NA（slim 无 /tmp/pnpm-vs，同 08-20） |
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
