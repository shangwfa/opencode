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
