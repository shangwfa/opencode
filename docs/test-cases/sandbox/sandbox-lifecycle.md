# 沙箱生命周期管理（SaaS / PG）

> 本文档由原 `sandbox-lifecycle.md`（T12 沙箱生命周期）与 `sandbox-idle-reap.md`（T30 空闲回收）合并而来。
> **仅适用于 opencode SaaS（PostgreSQL）**：沙箱记录持久化在 PG `sandbox` 表，多实例共享。
> 公共测试环境和配置请参考 `docs/local-test-env.md`；环境变量 `$BASE $PG_URL $MODEL` 由 `test-env.sh` 全局提供。

```bash
# 环境变量（测试环境）
export BASE=http://localhost:14096
export PG_URL='postgresql://app:<password>@127.0.0.1:15432/opencode'
export MODEL='{"modelID":"deepseek-v4-flash","providerID":"Yd-DeepSeek"}'
export NO_PROXY=localhost,127.0.0.1
LOG=/home/opencode/.local/share/opencode/log/opencode.log
```

---

## 〇、沙箱生命周期总览

```
创建（懒）          活跃（time_updated 刷新）        关闭
─────────────────  ───────────────────────────  ─────────────────────────────
会话创建            exec / AI 工具使用             onIdle（非 keepAlive → 即时销毁）
  │                │  ├─ dbTouchSandbox          idle-reap（超 idleReapMs → 兜底）
  └─ keepAlive         │  └─ 前台命令 heartbeat（detached/async 不心跳）          zombie（崩溃恢复，keep_alive=false）
     boot=true          │                              session 删除（destroy → Deleted）
     → getOrCreate ┘                                  destroy（显式 / dispose）
     boot=false                                       TTL 远程自杀 → reconnect 404 自愈重建
     → pending 占位
```

**回收防御三层**：

| 机制 | 触发 | 阈值 | 覆盖 keep_alive |
|------|------|------|----------------|
| `onIdle` 即时销毁 | Runner 转入 idle（AI loop 退出） | 即时 | ❌ 跳过 |
| Idle Reap | 后台周期扫描 | `idleReapMs`（`OPENCODE_SANDBOX_IDLE_REAP_SEC`，默认 1800s）超时未活跃 | ✅ |
| Zombie 清理 | 后台周期扫描 | `idleKillMs`（`OPENCODE_SANDBOX_IDLE_KILL_SEC`，默认 3600s，判定 ×2） | ❌ 只扫 `keep_alive=false` |

**关键常量（`sandbox-provider.ts`）**：
- `timeoutSeconds`=`OPENCODE_SANDBOX_TIMEOUT`（默认 600s，无 PVC 时的远程 TTL）
- `maxTtlSeconds`=`OPENCODE_SANDBOX_MAX_TTL_SEC`（默认 3600s，有 PVC 时的远程 TTL）
- `idleReapMs`=默认 1800s（30 分钟），`idleReapIntervalMs`=300_000（5 分钟，硬编码）
- `idleKillMs`=默认 3600s（1 小时），zombie 判定 `idleKillMs*2`
- keepAlive 沙箱创建时 TTL 放大 10 倍（`Math.max(baseTtl, maxTtlSeconds) * 10`）

---

## 一、创建与会话生命周期（原 T12）

### T12.1 懒创建：不使用沙箱工具不创建沙箱

**验证点**：创建会话后不调用任何沙箱工具（纯聊天），`sandbox` 表无该 session 记录。

```bash
SID=$(curl -s --noproxy '*' -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
psql "$PG_URL" -t -c "SELECT count(*) FROM sandbox WHERE session_id='$SID'"   # 期望 0
```
**期望**：无 sandbox 记录（懒创建，`tools.ts:80-85` `getSandbox()` 返回 lazy Promise，工具实际 await 才 `getOrCreate`）。

---

### T12.2 首次使用创建沙箱并持久化

**验证点**：exec / 文件工具触发 `getOrCreate`，PG 写入 `running` 记录。

```bash
curl -s --noproxy '*' -m 90 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' -d '{"command":"echo hello"}' \
  | python3 -c "import json,sys;print('exitCode:',json.load(sys.stdin).get('exitCode'))"
psql "$PG_URL" -c "SELECT id, state, keep_alive FROM sandbox WHERE session_id='$SID'"
```
**期望**：`exitCode=0`；`sandbox` 表出现 `running` 记录，id 为 UUID，`keep_alive=false`。

---

### T12.3 同一 session 复用同一沙箱

**验证点**：二次 exec 复用缓存/重连，sandbox id 不变。

```bash
SB1=$(psql "$PG_URL" -t -A -c "SELECT id FROM sandbox WHERE session_id='$SID'")
time curl -s --noproxy '*' -m 60 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' -d '{"command":"echo again"}' > /dev/null
SB2=$(psql "$PG_URL" -t -A -c "SELECT id FROM sandbox WHERE session_id='$SID'")
echo "SB1=$SB1 SB2=$SB2"; [ "$SB1" = "$SB2" ] && echo "PASS: 复用" || echo "FAIL: 重建"
```
**期望**：`SB1 == SB2`，二次调用耗时应远小于首次（缓存命中）。

---

### T12.4 keepAlive：显式设置后沙箱不随 onIdle 关闭

**验证点**：`exec/async` 启动长后台命令 + 显式 `keep-alive`，等待 idle 窗口后沙箱仍存活。

```bash
SID4=$(curl -s --noproxy '*' -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --noproxy '*' -m 15 -X POST "$BASE/session/$SID4/exec/async" -H 'Content-Type: application/json' -d '{"command":"sleep 3600","timeoutSeconds":3600}' > /dev/null
curl -s --noproxy '*' -X POST "$BASE/session/$SID4/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":true}' > /dev/null
sleep 40
curl -s --noproxy '*' -m 60 -X POST "$BASE/session/$SID4/exec" -H 'Content-Type: application/json' -d '{"command":"echo alive"}' \
  | python3 -c "import json,sys;print('alive:',json.load(sys.stdin).get('exitCode')==0)"
psql "$PG_URL" -c "SELECT id, state, keep_alive FROM sandbox WHERE session_id='$SID4'"
```
**期望**：`alive: True`；`sandbox.state=running` 且 `keep_alive=t`（40s 已过 idle 窗口仍存活）。

> **历史 bug（已修复 2026-08-08）**：async 创建期间并发调用 keepAlive 时，`createSandbox` 曾用创建前的 `existingRow` 快照覆盖 `keep_alive`，导致重建后 keepAlive 丢失、沙箱被重建。修复后 `createSandbox` 在 upsert 前重新读取 latest `keep_alive`（`sandbox-provider.ts:989-997`）。

---

### T12.5 onIdle 即时销毁（非 keepAlive）

**验证点**：AI 消息 loop 退出（session idle）时，非 keepAlive 沙箱被即时销毁为 `destroyed`。

```bash
SID5=$(curl -s --noproxy '*' -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --noproxy '*' -m 90 -X POST "$BASE/session/$SID5/exec" -H 'Content-Type: application/json' -d '{"command":"echo init"}' > /dev/null
# 触发 AI loop 并退出（onIdle）
curl -s --noproxy '*' --max-time 90 -X POST "$BASE/session/$SID5/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"回复 OK 即可\"}],\"model\":$MODEL}" > /dev/null
sleep 5
psql "$PG_URL" -t -A -c "SELECT state FROM sandbox WHERE session_id='$SID5'"   # 期望 destroyed
```
**期望**：`sandbox.state=destroyed`（`run-state.ts:66-93` onIdle → `!keepAlive` 则 destroy）。

---

### T12.6 keepAlive 阻止 onIdle 即时销毁

**验证点**：`keep_alive=true` 时 AI loop 退出，沙箱保持 `running`。

```bash
SID6=$(curl -s --noproxy '*' -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --noproxy '*' -m 90 -X POST "$BASE/session/$SID6/exec" -H 'Content-Type: application/json' -d '{"command":"echo init"}' > /dev/null
curl -s --noproxy '*' -X POST "$BASE/session/$SID6/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":true}' > /dev/null
curl -s --noproxy '*' --max-time 90 -X POST "$BASE/session/$SID6/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"回复 OK 即可\"}],\"model\":$MODEL}" > /dev/null
sleep 10
psql "$PG_URL" -c "SELECT state, keep_alive FROM sandbox WHERE session_id='$SID6'"  # 期望 running/t
```
**期望**：`state=running`，`keep_alive=t`。

---

### T12.7 instance/dispose 不销毁共享沙箱

**验证点**：PG 模式下沙箱是跨实例共享资源，`instance/dispose` 只释放实例自身资源，不销毁 sandbox 记录（由 idle-reap 兜底）。

```bash
SID7=$(curl -s --noproxy '*' -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --noproxy '*' -m 90 -X POST "$BASE/session/$SID7/exec" -H 'Content-Type: application/json' -d '{"command":"echo init"}' > /dev/null
curl -s --noproxy '*' -X POST "$BASE/instance/dispose" -o /dev/null -w "dispose HTTP: %{http_code}\n"   # 期望 200
sleep 2
psql "$PG_URL" -t -A -c "SELECT state FROM sandbox WHERE session_id='$SID7'"   # 期望仍 running（不清共享沙箱）
```
**期望**：`dispose` 返回 200，但 `sandbox.state` 保持 `running`（多实例共享语义；原全局 `destroyAll` 已移除，`sandbox-provider.ts:1603`）。

---

### T12.8 dispose 后服务可用，沙箱自动重建

**验证点**：dispose 后继续 exec，自动重建沙箱。

```bash
curl -s --noproxy '*' -X POST "$BASE/instance/dispose" > /dev/null
curl -s --noproxy '*' -m 90 -X POST "$BASE/session/$SID7/exec" -H 'Content-Type: application/json' -d '{"command":"echo after-dispose"}' \
  | python3 -c "import json,sys;print('stdout:',str(json.load(sys.stdin).get('stdout',''))[:60])"
psql "$PG_URL" -t -A -c "SELECT state FROM sandbox WHERE session_id='$SID7'"
```
**期望**：输出 `after-dispose`；sandbox 重建为 `running`。

---

### T12.9 PVC 数据在沙箱重建后持久

**验证点**：写入 `/workspace` 文件 → kill-sandbox → 重建后文件仍在（PVC 挂载）。

```bash
SID9=$(curl -s --noproxy '*' -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --noproxy '*' -m 90 -X POST "$BASE/session/$SID9/exec" -H 'Content-Type: application/json' -d '{"command":"echo init"}' > /dev/null
TS=$(date +%s)
curl -s --noproxy '*' -m 60 -X POST "$BASE/session/$SID9/exec" -H 'Content-Type: application/json' \
  -d "{\"command\":\"echo $TS > /workspace/restart-test.txt\"}" > /dev/null
curl -s --noproxy '*' -m 10 -X POST "$BASE/session/$SID9/kill-sandbox" > /dev/null
sleep 3
curl -s --noproxy '*' -m 90 -X POST "$BASE/session/$SID9/exec" -H 'Content-Type: application/json' \
  -d '{"command":"cat /workspace/restart-test.txt"}' \
  | python3 -c "import json,sys;print('read after rebuild:',str(json.load(sys.stdin).get('stdout','')).strip(),'期望 $TS')"
```
**期望**：重建后读回与写入一致的 timestamp（PVC 持久）。

---

### T12.10 多 session PVC 子目录隔离

**验证点**：A 写文件，B 看不到（独立 PVC subPath `sessions/{sessionID}/workspace`）。

```bash
SID_A=$(curl -s --noproxy '*' -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
SID_B=$(curl -s --noproxy '*' -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --noproxy '*' -m 60 -X POST "$BASE/session/$SID_A/exec" -H 'Content-Type: application/json' -d '{"command":"echo A > /workspace/only-in-A.txt"}' > /dev/null
curl -s --noproxy '*' -m 60 -X POST "$BASE/session/$SID_B/exec" -H 'Content-Type: application/json' -d '{"command":"ls /workspace/only-in-A.txt 2>&1"}' \
  | python3 -c "import json,sys;print('B sees:',str(json.load(sys.stdin).get('stdout','')).strip())"
```
**期望**：B 输出 `No such file or directory`。

---

### T12.11 沙箱进程隔离

**验证点**：A 后台 `sleep 3600`，B 看不到该进程（容器级隔离）。

```bash
curl -s --noproxy '*' -m 15 -X POST "$BASE/session/$SID_A/exec/async" -H 'Content-Type: application/json' -d '{"command":"sleep 3600","timeoutSeconds":3600}' > /dev/null
sleep 3
curl -s --noproxy '*' -m 60 -X POST "$BASE/session/$SID_B/exec" -H 'Content-Type: application/json' -d '{"command":"ps aux | grep sleep | grep -v grep | wc -l"}' \
  | python3 -c "import json,sys;print('B count:',str(json.load(sys.stdin).get('stdout','')).strip())"   # 期望 0
curl -s --noproxy '*' -m 60 -X POST "$BASE/session/$SID_A/exec" -H 'Content-Type: application/json' -d '{"command":"ps aux | grep sleep | grep -v grep | wc -l"}' \
  | python3 -c "import json,sys;print('A count:',str(json.load(sys.stdin).get('stdout','')).strip())"   # 期望 1
```
**期望**：B=0，A=1。

---

### T12.12 配置验证：OPENCODE_SANDBOX_IDLE_KILL_SEC

**验证点**：测试环境 `IDLE_KILL_SEC=30`；代码默认 3600；`idleKillMs` 用于 zombie 判定（×2）和清理定时器。

```bash
docker exec opencode-saas-test env | grep IDLE_KILL    # 期望 OPENCODE_SANDBOX_IDLE_KILL_SEC=30
grep -n 'idleKillMs' packages/opencode/src/tool/sandbox-provider.ts  # 25/45 定义; 1491 zombie×2; 1544 定时器
grep -n 'OPENCODE_SANDBOX_IDLE_KILL_SEC' packages/opencode/src/flag/flag.ts  # 默认 3600
```

---

### T12.13 GET /session/:sessionID/sandbox 查询沙箱 ID

**验证点**：初始 `null` → exec 后返回 UUID（与 DB 一致）→ kill 后 `null`。

```bash
SID13=$(curl -s --noproxy '*' -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --noproxy '*' "$BASE/session/$SID13/sandbox" | python3 -m json.tool    # sandboxId:null
curl -s --noproxy '*' -m 90 -X POST "$BASE/session/$SID13/exec" -H 'Content-Type: application/json' -d '{"command":"echo hi"}' > /dev/null
SB=$(curl -s --noproxy '*' "$BASE/session/$SID13/sandbox" | python3 -c "import json,sys;print(json.load(sys.stdin).get('sandboxId',''))")
DB=$(psql "$PG_URL" -t -A -c "SELECT id FROM sandbox WHERE session_id='$SID13'")
[ "$SB" = "$DB" ] && echo "PASS: sandboxId 一致 ($SB)" || echo "FAIL"
curl -s --noproxy '*' -m 10 -X POST "$BASE/session/$SID13/kill-sandbox" > /dev/null
sleep 2
curl -s --noproxy '*' "$BASE/session/$SID13/sandbox" | python3 -c "import json,sys;print('after kill sandboxId:',json.load(sys.stdin).get('sandboxId'))"  # null
```

---

### T12.14 keepAlive 持久：destroy 保留，重建继承

**验证点**：`keep_alive` 是 session 维度的持久偏好。`destroy`/kill-sandbox **不清 keepAlive**；重建后新沙箱仍 `keep_alive=true`。

```bash
SID14=$(curl -s --noproxy '*' -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --noproxy '*' -m 90 -X POST "$BASE/session/$SID14/exec" -H 'Content-Type: application/json' -d '{"command":"echo init"}' > /dev/null
curl -s --noproxy '*' -X POST "$BASE/session/$SID14/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":true}' > /dev/null
curl -s --noproxy '*' -m 10 -X POST "$BASE/session/$SID14/kill-sandbox" > /dev/null
sleep 2
curl -s --noproxy '*' "$BASE/session/$SID14/keep-alive" | python3 -c "import json,sys;print('after destroy keepAlive:',json.load(sys.stdin).get('keepAlive'))"  # true
curl -s --noproxy '*' -m 90 -X POST "$BASE/session/$SID14/exec" -H 'Content-Type: application/json' -d '{"command":"echo rebuilt"}' > /dev/null
psql "$PG_URL" -c "SELECT id, state, keep_alive FROM sandbox WHERE session_id='$SID14'"   # running / t
```
**期望**：destroy 后 `keepAlive=true`（`sandbox-provider.ts:1266-1268` destroy 不再调 `dbSetKeepAlive(false)`）；重建后 `state=running, keep_alive=t`。

> **历史 bug（已修复）**：`destroy` 曾无条件 `dbSetKeepAlive(false)`，导致 kill-sandbox 后重建丢失 keepAlive。现 destroy 只销毁沙箱，keepAlive 仅由 `release()` 清除。

---

### T12.15 session 删除同步关闭沙箱

**验证点**：删除会话时，若关联沙箱存在，同步关闭后再删除会话（避免孤儿记录）。

```bash
SID15=$(curl -s --noproxy '*' -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --noproxy '*' -m 90 -X POST "$BASE/session/$SID15/exec" -H 'Content-Type: application/json' -d '{"command":"echo init"}' > /dev/null
echo "删除前: $(psql "$PG_URL" -t -A -c "SELECT id, state FROM sandbox WHERE session_id='$SID15'")"   # running
curl -s --noproxy '*' -X DELETE "$BASE/session/$SID15" -o /dev/null -w "DELETE HTTP: %{http_code}\n"   # 200
sleep 3
echo "删除后 sandbox: $(psql "$PG_URL" -t -A -c "SELECT id, state FROM sandbox WHERE session_id='$SID15'")"  # destroyed
echo "删除后 session: $(psql "$PG_URL" -t -A -c "SELECT count(*) FROM session WHERE id='$SID15'")"          # 0
```
**期望**：`DELETE /session/:id` 返回 200；sandbox 状态变 `destroyed`（`session.ts` `remove` 在发布 Deleted 前无条件 `SandboxProvider.destroy`）；session 记录删除。

---

### T12.16 创建期间并发 keepAlive 不被 upsert 覆盖

**验证点**：sandbox 远程创建耗时期间调用 keepAlive，创建完成后 `keep_alive` 仍为 true（回归 T12.4 历史 bug）。

```bash
# 集成测试覆盖（单元）：packages/opencode/test/tool/sandbox-idle-reap.test.ts
# "创建期间并发 keepAlive 不会被 upsert 覆盖"
OPENCODE_DATABASE_URL=$PG_URL bun test test/tool/sandbox-idle-reap.test.ts -t "创建期间并发"
```

---

### T12.17 keepAlive boot 参数：boot=true 立即创建 / boot=false 懒创建

**验证点**：`POST /session/:id/keep-alive` 的 `boot` 参数控制是否立即创建沙箱（`sandbox-proxy.ts:620-624`）：
- `{enabled:true, boot:true}` → 设置 keepAlive + **立即 `getOrCreate`**，创建时 `isKept=true` → TTL 放大 10 倍
- `{enabled:true, boot:false}` → 只设置 keepAlive（写 pending 占位），**不创建**沙箱，等待后续工具使用时懒创建
- `{enabled:false}` → release（清除 keepAlive）

**boot=true：设置 keepAlive + 立即创建**

```bash
SID_A=$(curl -s --noproxy '*' -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
# boot=true → 立即创建沙箱
RESP=$(curl -s --noproxy '*' -X POST "$BASE/session/$SID_A/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":true,"boot":true}')
echo "$RESP"   # {keepAlive:true, sandboxId:"<UUID>"}（非 null）
SB_ID=$(echo "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('sandboxId',''))")
psql "$PG_URL" -c "SELECT id, state, keep_alive FROM sandbox WHERE session_id='$SID_A'"
# 期望：id=UUID（与 sandboxId 一致），state=running，keep_alive=t
# 日志含 creating sandbox ... keepAlive=true timeoutSeconds=<10倍值>
```

**boot=false：只设置 keepAlive，不创建**

```bash
SID_B=$(curl -s --noproxy '*' -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
RESP=$(curl -s --noproxy '*' -X POST "$BASE/session/$SID_B/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":true,"boot":false}')
echo "$RESP"   # {keepAlive:true, sandboxId:null}（未创建）
SB_ID=$(echo "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('sandboxId',''))")
[ -z "$SB_ID" -o "$SB_ID" = "None" ] && echo "PASS: boot=false 未创建沙箱"
psql "$PG_URL" -c "SELECT id, state, keep_alive FROM sandbox WHERE session_id='$SID_B'"
# 期望：id=pending-<SID>（占位），state=destroyed，keep_alive=t

# 后续 exec 触发懒创建（此时 isKept=true → TTL 放大）
curl -s --noproxy '*' -m 90 -X POST "$BASE/session/$SID_B/exec" -H 'Content-Type: application/json' -d '{"command":"echo lazy"}' \
  | python3 -c "import json,sys;print('exitCode:',json.load(sys.stdin).get('exitCode'))"
psql "$PG_URL" -c "SELECT id, state, keep_alive FROM sandbox WHERE session_id='$SID_B'"
# 期望：id 变为 UUID（非 pending），state=running，keep_alive=t
```

**enabled=false：release**

```bash
curl -s --noproxy '*' -X POST "$BASE/session/$SID_B/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":false}' \
  | python3 -c "import json,sys;print('release:',json.load(sys.stdin))"
curl -s --noproxy '*' "$BASE/session/$SID_B/keep-alive" | python3 -c "import json,sys;print('keepAlive:',json.load(sys.stdin).get('keepAlive'))"  # false
```

> **代码路径**（`sandbox-proxy.ts:615-625`）：
> - `enabled !== false` → `sandbox.keepAlive()` 设置 pending
> - `boot === true` → `sandbox.getOrCreate()` 立即创建（返回 sandboxId）
> - `boot !== true` → 跳过创建（sandboxId=null）
> - `enabled === false` → `sandbox.release()` 清除 keepAlive
>
> pending 记录 `state=destroyed`，`getOrCreateUnlocked` 遇到 destroyed 不走 killed cleanup（`:1167`），直接进入 `createSandbox` → `existingRow.keep_alive=true` → `isKept=true` → TTL 放大 10 倍。

---

## 二、空闲沙箱定期回收（原 T30）

> **推荐**：以下真实环境用例需等待扫描周期（默认 5 分钟），可用 **单测短阈值**（`sandbox-idle-reap.test.ts`，`idleReapMs=5s`）加速验证核心逻辑；PG 冒烟用例保留用于验证真实链路。

### T30.1 超时沙箱被自动回收

**验证点**：idle reap 扫描 `state=running 且 time_updated < now - idleReapMs` 的记录，销毁并标记 `destroyed`；不修改 `keep_alive`。

```bash
SID=$(curl -s --noproxy '*' -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
psql "$PG_URL" -c "INSERT INTO sandbox (id, session_id, host, state, keep_alive, command_session_id, time_created, time_updated)
VALUES ('sb_reap_basic','$SID','http://127.0.0.1:1','running',false,NULL,
  (extract(epoch from now()-interval '32 minute')*1000)::bigint,
  (extract(epoch from now()-interval '31 minute')*1000)::bigint)
ON CONFLICT (session_id) DO UPDATE SET state='running', keep_alive=false, time_updated=(extract(epoch from now()-interval '31 minute')*1000)::bigint"
for i in $(seq 1 66); do
  sleep 5
  ST=$(psql "$PG_URL" -t -A -c "SELECT state FROM sandbox WHERE session_id='$SID'")
  [ "$ST" = "destroyed" ] && { echo "PASS [$((i*5))s]"; break; }
done
psql "$PG_URL" -c "DELETE FROM sandbox WHERE session_id='$SID'"
```
**期望**：330s 内 `state=destroyed`；日志含 `idle sandbox reap scan ... count=`。

---

### T30.2 keep_alive=true 的沙箱也被回收

**验证点**：idle reap 不区分 keep_alive；回收后 `keep_alive` 保持不变。

```bash
# 同上，插入时 keep_alive=true；回收后断言 keep_alive=t 仍保留
```
**期望**：`state=destroyed` 且 `keep_alive=t`。区别于 zombie 清理（仅扫 `keep_alive=false`）。

---

### T30.3 未超时沙箱不被误杀

**验证点**：`time_updated` 在阈值内的记录不被回收。

```bash
# 插入 time_updated=now 的记录，等待 330s 后 state 仍 running
```
**期望**：`state=running`；scan `count=0`（或不含该 session）。

---

### T30.4 CAS 保护：扫描后活跃刷新则跳过

**验证点**：idle reap 查到候选后在 `lock` 内重新校验 `time_updated`；若扫描后又被使用（刷新），跳过不误杀（`sandbox-provider.ts:832-856` `dbClaimIdleSandbox` 条件 UPDATE）。

```bash
# 插入超时记录后持续刷新 time_updated（每 60s，覆盖一个扫描周期）
for i in $(seq 1 8); do
  psql "$PG_URL" -c "UPDATE sandbox SET time_updated=(extract(epoch from now())*1000)::bigint WHERE session_id='$SID'" >/dev/null
  sleep 60
done
psql "$PG_URL" -t -A -c "SELECT state FROM sandbox WHERE session_id='$SID'"   # running
```
**期望**：持续活跃的沙箱保持 `running`。

---

### T30.5 沙箱使用会刷新 time_updated

**验证点**：`getOrCreate` 缓存命中、健康重连、`get`、`runInSession`、`runDetached` 均调用 `dbTouchSandbox` 刷新 `time_updated`。

```bash
BEFORE=$(psql "$PG_URL" -t -A -c "SELECT time_updated FROM sandbox WHERE session_id='$SID'")
psql "$PG_URL" -c "UPDATE sandbox SET time_updated=(extract(epoch from now()-interval '31 minute')*1000)::bigint WHERE session_id='$SID'"
curl -s --noproxy '*' -m 60 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' -d '{"command":"echo alive"}' > /dev/null
AFTER=$(psql "$PG_URL" -t -A -c "SELECT time_updated FROM sandbox WHERE session_id='$SID'")
echo "BEFORE=$BEFORE AFTER=$AFTER"; [ "$AFTER" -gt "$BEFORE" ] && echo "PASS: time_updated 刷新"
```
**期望**：二次使用后 `time_updated` 显著大于之前。

---

### T30.6 命令 heartbeat 防误回收（仅前台命令）

**验证点**：长命令执行期间，heartbeat 每 `COMMAND_HEARTBEAT_MS`（不超过 `idleReapMs/3`）刷新 `time_updated`，跨越 idle 阈值不被回收。

> **2026-08-19 语义变更**：heartbeat 仅覆盖**前台命令**（`runInSession`，AI 同步等待中）；`runDetached`（`exec/async` 后台命令）**不再心跳**——后台命令不阻止 idle-reap，无人使用的会话沙箱 30 分钟后连同后台命令一起回收（对应单测「detached 长命令不阻止 idle-reap 回收」）。

```bash
# 集成测试覆盖（单元）："长命令跨越 idle 阈值时 heartbeat 防止误回收"
OPENCODE_DATABASE_URL=$PG_URL bun test test/tool/sandbox-idle-reap.test.ts -t "heartbeat"
```

---

### T30.11 detached/async 长命令不阻止 idle-reap 回收（2026-08-19 新增）

**验证点**：`exec/async` 启动的后台长命令（如 dev server）**不维持心跳**——`time_updated` 不被刷新，无人使用的会话沙箱超过 `idleReapMs` 后被 idle-reap 回收（连同后台命令）。

```bash
# 加速验证：容器启动时设 OPENCODE_SANDBOX_IDLE_REAP_SEC=120（扫描间隔硬编码 300s）
SID=$(curl -s --noproxy '*' -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --noproxy '*' -m 90 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' -d '{"command":"echo init"}' > /dev/null
# 启动后台长命令后不再做任何操作（模拟无人使用）
curl -s --noproxy '*' -m 15 -X POST "$BASE/session/$SID/exec/async" -H 'Content-Type: application/json' -d '{"command":"sleep 3600","timeoutSeconds":3600}' > /dev/null

# 轮询：观察 time_updated 不再刷新（idle_age 持续增长），最终 state 变 destroyed
for i in $(seq 1 60); do
  sleep 15
  ROW=$(psql "$PG_URL" -t -A -F'|' -c "SELECT state, time_updated FROM sandbox WHERE session_id='$SID'")
  ST=${ROW%%|*}; TU=${ROW##*|}
  AGE=$(( ($(date +%s) - TU/1000) ))
  echo "[$i] state=$ST idle_age=${AGE}s"
  [ "$ST" = "destroyed" ] && { echo "PASS: reaped"; break; }
done
```
**期望**：`idle_age` 持续增长（无 ~20-60s 周期的心跳刷新）；超过阈值 + 一个扫描周期（≤300s）内 `state=destroyed`。

> **动机**：历史行为中 detached 命令也包 `withCommandHeartbeat`，导致「AI 会话早已结束、但 async dev server 让沙箱永不空闲」——实测有会话挂了 8+ 小时直到 10h TTL。2026-08-19 起 `runDetached` 去掉心跳包装（`sandbox-provider.ts` runDetached 内，注释「async/detached 命令不维持心跳」），防误杀只保留给 `runInSession`（AI 同步等待的前台命令）。

**2026-08-19 实测**（镜像 `detached-no-heartbeat`，本地 IDLE_REAP_SEC=120）：async `sleep 3600` 启动后 idle_age 持续增长（20s → 82s，无心跳刷新），约 97s 后 `state=destroyed`。前台命令心跳保护由单测「长命令跨越 idle 阈值时 heartbeat 防止误回收」（runInSession）继续覆盖。

> **实测注意（共享 PG 多实例干扰）**：回收方不一定是本地容器——共享同一 PG 的**远端 K8s 实例**（test-opencode，同 Dockerfile，内置 `IDLE_KILL_SEC=30` → zombie 阈值 60s）也会回收 `keep_alive=false` 的沙箱，可能在本地 idle-reap（120s）之前抢先命中。本地容器日志无 `reap scan`/`zombie cleanup` 记录而 state 已变 `destroyed` 即为此情况。核心断言（detached 无心跳 → idle_age 持续增长 + 最终回收）不受影响；**纯 idle-reap 路径**的精确验证依赖单测（`sandbox-idle-reap.test.ts`「detached 长命令不阻止 idle-reap 回收」）。若要本地独占验证，需远端实例停服或使用独立 PG。

---

### T30.7 可观测性：扫描日志

**验证点**：每次扫描输出 `count`。

```bash
docker exec opencode-saas-test sh -c 'grep "idle sandbox reap scan" '"$LOG"' | tail -3'
```
**期望**：含 `count=`；有候选时 `count>0`。

---

### T30.8 配置注入：OPENCODE_SANDBOX_IDLE_REAP_SEC

**验证点**：`OPENCODE_SANDBOX_IDLE_REAP_SEC=60` 覆盖默认 1800s，1 分钟前的记录被回收。

```bash
# 启动容器时设 OPENCODE_SANDBOX_IDLE_REAP_SEC=60；插入 time_updated=90s ago 的记录，等待回收
```
**期望**：90s 前的记录在扫描周期内被回收（自定义阈值生效）。

---

### T30.9 多实例并发 claim 只回收一次

**验证点**：多个 pgLayer（Pod）同时扫描同一候选，`dbClaimIdleSandbox` 条件 UPDATE 保证只有一个删除。

```bash
# 集成测试覆盖（单元）："多个 pgLayer 同时扫描只会 claim 和删除一次"
OPENCODE_DATABASE_URL=$PG_URL bun test test/tool/sandbox-idle-reap.test.ts -t "多个 pgLayer"
```

---

### T30.10 reconnect 404 自动重建

**验证点**：DB 记录 `running` 但远端沙箱已不存在（TTL/外部删除），`Sandbox.connect` 返回 404 → 自动 cleanup 并重建，不重复创建。

```bash
# 集成测试覆盖（单元）："reconnect 返回 404 时自动重建并替换 lifecycle 记录"
OPENCODE_DATABASE_URL=$PG_URL bun test test/tool/sandbox-idle-reap.test.ts -t "404"
```
**期望**：404 视为"远端不存在"→ 重建新 sandbox；500/网络错误保持原 `running` 记录（不误重建，`sandbox-provider.ts:918-934` `reconnectIfPresent`）。

---

## 三、keep_alive 状态机（2026-08-08 梳理）

keep_alive 是 **session 维度的持久偏好**：一旦设置就持续生效，后续 sandbox 创建/重建都继承；只有显式 `release()` 才能清除。

```
设置 keepAlive()  ── dbEnsureKeepAlive
                       ├─ 无 sandbox 记录 → INSERT pending(killed, keep_alive=true) 持久占位
                       └─ UPDATE 该 session 行 keep_alive=true
清除 release()    ── dbSetKeepAlive(false)              ← 唯一清除途径
销毁 destroy()    ── 只销毁 sandbox，不改 keepAlive     ← 修复：不再清 keepAlive
创建/重建 createSandbox ── keep_alive = latest ?? existingRow ?? false（upsert 前读最新）
onIdle           ── 仅当 !isKeepAlive 才 destroy        ← keepAlive=true 不即时销毁
idle-reap(30min) ── 含 keep_alive=true 兜底回收，dbMarkDestroyed 保行 keep_alive 不变
zombie           ── 仅清理 keep_alive=false 的 running 僵尸
```

语义要点：

- **持久**：keepAlive 记录在 `sandbox` 行上；所有销毁路径（`destroy`/idle-reap/zombie/session 删除）都用 `dbMarkDestroyed`（保留行、只改 state），`keep_alive` 不丢。只有 `release()` 置 false。
- **继承**：`createSandbox` 在 `Sandbox.create` 完成后、`dbUpsert` 前重新读取 latest `keep_alive`（`sandbox-provider.ts:989-997`），创建期间并发设置的 keepAlive 不丢；destroy 后重建继承 destroyed 行的 keep_alive。
- **清除**：`release()` 是唯一途径；`destroy()`/kill-sandbox 不再隐式清除（`sandbox-provider.ts:1263`）。
- **兜底**：keepAlive=true 的沙箱不随 onIdle 销毁，但超过 `idleReapMs`（默认 30min）仍会被 idle-reap 回收（T30.2）。
- **TTL 放大时机**：`createSandbox` 的 `isKept` 用**创建前** `existingRow` 判定（`:961`）。`boot=true`（先设置再创建）→ `isKept=true` → TTL 10 倍 ✅；`async` 创建期间并发设置（T12.4）→ `isKept=false` → TTL 不放大（`latest` 只保证 `keep_alive` 写入，不影响已创建的远端 TTL）。
- **会话删除**：`session.remove` 在发布 Deleted 事件前无条件 `SandboxProvider.destroy`（`session.ts:660-676`），不依赖 instance 上下文，避免孤儿。

---

## 四、单元测试清单（PG 集成，`packages/opencode/test/tool/sandbox-idle-reap.test.ts`）

```bash
OPENCODE_DATABASE_URL="$PG_URL" \
bun test test/tool/sandbox-idle-reap.test.ts
```

| 用例 | 验证 | 状态 |
|------|------|------|
| 远端资源已不存在时超时记录被幂等标记为 destroyed | 基本回收（T30.1） | ✅ 通过 |
| keep_alive=true 的超时记录也进入回收 | keepAlive 回收（T30.2） | ✅ 通过 |
| 生命周期 API 删除失败时保持 killed，等待重试 | 删除失败保留重试 | ✅ 通过 |
| 单个候选删除失败不会阻断同批其他候选 | 批次错误隔离 | ✅ 通过 |
| reconnect 返回 404 时自动重建并替换 lifecycle 记录 | 404 自愈（T30.10） | ✅ 通过 |
| reconnect 返回 500 时保留 running 且不创建重复 sandbox | 500 不误重建（T30.10） | ✅ 通过 |
| 创建期间并发 keepAlive 不会被 upsert 覆盖 | keepAlive 持久（T12.16） | ✅ 通过 |
| destroy 保留 keepAlive，重建后仍保持 keepAlive | keepAlive 持久（T12.14） | ✅ 通过 |
| 多个 pgLayer 同时扫描只会 claim 和删除一次 | 多实例并发（T30.9） | ✅ 通过 |
| 长命令跨越 idle 阈值时 heartbeat 防止误回收 | heartbeat（T30.6，仅 runInSession） | ✅ 通过 |
| detached 长命令不阻止 idle-reap 回收 | detached 无心跳（T30.11） | ✅ 通过 |
| 未超时记录（time_updated < idleReapMs）不被回收 | 阈值边界（T30.3） | ✅ 通过 |
| 持续更新 time_updated 的沙箱不被误杀（CAS 保护） | CAS（T30.4） | ✅ 通过 |
| 阈值边界：低于阈值不被回收，超过被回收 | 边界 | ✅ 通过 |
| 自定义 SandboxConfig.idleReapMs 生效 | 配置注入（T30.8） | ✅ 通过 |
| PG layer scope 关闭不会全局销毁 running sandbox | dispose 语义（T12.7） | ✅ 通过 |
| getOrCreate 与 idle reap 并发不互相干扰 | 并发 | ✅ 通过 |

其它相关测试：`test/tool/sandbox-provider-pg.test.ts`（DB CRUD/keep_alive/版本保护）、`test/tool/sandbox-provider-concurrency.test.ts`、`test/tool/sandbox-lazy-no-create.test.ts`、`test/tool/sandbox-command-queue.test.ts`。

---

## 五、排查场景对照表

| 现象 | 可能原因 | 验证用例 | 日志关键字 |
|------|---------|---------|-----------|
| keep_alive 沙箱长时间不回收 | idle reap 未启动或阈值过大 | T30.2 | `idle sandbox reap scan ... count=` |
| 活跃沙箱被误杀 | CAS 校验未生效 | T30.4 | 销毁前 `current.time_updated > threshold` 应跳过 |
| 使用中的沙箱仍被回收 | 使用路径未刷新 `time_updated` | T30.5/T30.6 | 检查 `dbTouchSandbox` 调用路径 |
| 新建沙箱立即被回收 | 阈值配置过小 | T30.8 | 检查 `OPENCODE_SANDBOX_IDLE_REAP_SEC` |
| kill-sandbox 后重建丢失 keepAlive | destroy 曾清 keep_alive（已修复） | T12.14 | `sandbox-provider.ts:1263` 不再 dbSetKeepAlive(false) |
| 删除会话后 sandbox 残留 | session.remove 未关沙箱（已修复） | T12.15 | `session.ts:660-676` remove 前置 destroy |
| 远端沙箱已死但本地 running | TTL 自杀 / 外部删除 | T30.10 | `sandbox no longer exists; rebuilding` |
| 命令执行中沙箱被回收 | detached/async 命令不再心跳（2026-08-19 起，设计行为） | T30.6 | `withCommandHeartbeat` 仅 `runInSession` |
| destroyed 记录再次被扫 | 查询条件缺 `state=running` | T30.1 | `count` 不应含 destroyed |

---

## 六、结果汇总（2026-08-19 复测，全量执行，镜像 `dd06ab0` / commit dd06ab076b）

| 用例 | 状态 | 说明 |
|------|------|------|
| T12.1 懒创建 | ✅ | 纯聊天无 sandbox 记录 |
| T12.2 首次创建 | ✅ | exec 后 DB running 记录，keep_alive=false |
| T12.3 复用 | ✅ | 二次 exec 0.37s，id 不变 |
| T12.4 keepAlive 存活 | ✅ | 40s 后 alive=True，state=running keep_alive=true |
| T12.5 onIdle 即时销毁 | ✅ | loop 退出后 state=destroyed |
| T12.6 keepAlive 阻止 onIdle | ✅ | loop 退出后仍 running/true |
| T12.7 dispose 不清共享沙箱 | ✅/⚠️ | dispose 200；沙箱保持 running（多实例共享语义） |
| T12.8 dispose 后重建 | ✅ | exec "after-dispose" 成功，重建 running |
| T12.9 PVC 持久 | ✅ | 重建后读到同一 timestamp（1786150846） |
| T12.10 目录隔离 | ✅ | B 看不到 A 的文件（No such file） |
| T12.11 进程隔离 | ✅ | A=1，B=0 个 sleep 进程 |
| T12.12 配置 | ✅ | IDLE_KILL_SEC=30，代码默认 3600 |
| T12.13 GET /sandbox | ✅ | null → UUID（与 DB 一致）→ null |
| T12.14 keepAlive 持久 | ✅ | destroy 后 keepAlive=True，重建 running/true |
| T12.15 session 删除关沙箱 | ✅ | DELETE 200，sandbox destroyed，session count=0 |
| T12.16 创建期并发 keepAlive | ✅ | 单测通过（upsert 不覆盖） |
| T12.17 boot=true/false | ✅ | boot=true 立即创建 running/true；boot=false pending destroyed/true；懒创建后 running/true；release→false |
| T30.5 time_updated 刷新 | ✅ | exec 后 time_updated 刷新（远大于调旧值），state=running |
| T30.7 可观测性 | ✅ | scan 日志正常运行（无超时候选时 count=0 不落日志） |
| 单测全量 | ✅ | idle-reap 17（含 detached 无心跳新用例）+ provider-pg/concurrency/lazy/queue 35 = 52 pass / 0 fail（2026-08-19 临时本地 PG `opencode_test`，5 文件合跑 3 轮均 52/0） |

> 2026-08-19 复测补充：
> - 全部 T12.x（含 T12.1–T12.15、T12.17）+ T30.5/T30.7 通过；T12.16/T30.x 单测覆盖部分在临时本地 PG（`docker run postgres:16-alpine` + `/opencode_test`）上通过（远端 PG `app` 用户无 CREATE DATABASE 权限，无法使用共享库跑单测 guard）。
> - 代码核对：`sandbox-proxy.ts` keep-alive 端点实际位于 :661-677（文档旧引用 :615-625，行号漂移，逻辑一致）；`createSandbox` latest keep_alive 读取实际位于 :1009-1016（文档旧引用 :989-997，逻辑一致）；`isKept` TTL 放大（:962-965）、zombie 判定 `idleKillMs*2`（:1511）、heartbeat ≤ `idleReapMs/3`（:1094）、run-state onIdle `!keep` 才 destroy、session.remove 前置 destroy 均与文档描述一致。

> **备注**：
> - 容器内实际日志文件为 `opencode.log`（文档旧路径 `dev.log` 不存在）；INFO 级 sandbox 生命周期日志未落盘，断言以 PG `sandbox` 表为准。
> - DB 中累积大量 `pending-ses_xxx` 前缀的 `killed` 记录（历史 exec/async 创建残留，未回收为 `destroyed`），属于 killed 重试清理的遗留问题，由 idle-reap killed 分支兜底。
> - 本地单元测试 `test/session/session.test.ts` 等因既有 SQLite schema 缺 `pvc_mode` 列无法运行（仅影响 SQLite 路径；SaaS PG 不受影响）。
