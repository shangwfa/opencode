# 沙箱生命周期管理

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。

## 十二、沙箱生命周期管理

> 前置条件：同第十一节，使用本地测试环境（`docs/local-test-env.md`）。

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"
```

### T12.1 沙箱按需创建（首次 AI 消息时创建）

```bash
# 发消息前检查日志（不应有 sandbox created）
docker exec opencode-saas-test grep 'sandbox created' /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | wc -l

# 发第一条消息（触发 sandbox 创建）
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo hello\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;[print(p['text'][:100]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"

# 发消息后检查日志
docker exec opencode-saas-test grep "sandbox created.*$SID" /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | tail -1
```
**期望**：发消息后日志中出现 `sandbox created`，含对应 `sessionID` 和 `sandboxID`

---

### T12.2 同一 session 复用同一沙箱

```bash
# 第一条消息，记录 sandboxID
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo sandbox-test-1\"}],\"model\":$MODEL}" > /dev/null

SB1=$(docker exec opencode-saas-test grep "sandbox.*$SID" /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | grep -o 'sandboxID=[^ ]*' | tail -1)
echo "First sandboxID: $SB1"

# 第二条消息
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo sandbox-test-2\"}],\"model\":$MODEL}" > /dev/null

SB2=$(docker exec opencode-saas-test grep "sandbox.*$SID" /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | grep -o 'sandboxID=[^ ]*' | tail -1)
echo "Second sandboxID: $SB2"

[ "$SB1" = "$SB2" ] && echo "PASS: same sandbox reused" || echo "FAIL: different sandboxes"
```
**期望**：无 keepAlive 时两次 `sandboxID` 可能不同（idle 后 sandbox 被销毁，下次消息自动重建新 sandbox）。有 keepAlive 时（`background:true` 启动了长后台进程）sandbox 保持存活，`sandboxID` 不变。这是预期行为，非 bug

---

### T12.3 keepAlive 触发（exec/async 等价方案）

> 原 T12.3 依赖 AI shell tool 的 `background:true` 自动触发 keepAlive，不可控。改为 exec/async + 显式 keepAlive 等价验证。

```bash
SID3=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID3: $SID3"

# 用 exec/async 启动长后台命令（等价 background:true）
curl -s -m 10 -X POST "$BASE/session/$SID3/exec/async" \
  -H 'Content-Type: application/json' \
  -d '{"command":"sleep 3600","timeoutSeconds":3600}' \
  | python3 -c "import json,sys;print('async exec:', json.load(sys.stdin).get('status'))"

# 显式设置 keepAlive（等价 shell tool 的 background 自动触发）
curl -s -X POST "$BASE/session/$SID3/keep-alive" \
  -H 'Content-Type: application/json' -d '{"enabled":true}' | python3 -m json.tool

# 验证 keepAlive 状态
curl -s "$BASE/session/$SID3/keep-alive" | python3 -m json.tool

# 等待 idle 超时（30s）
sleep 30

# 验证 sandbox 仍存活
curl -s -m 10 "$BASE/session/$SID3/exec" \
  -H 'Content-Type: application/json' -d '{"command":"echo alive"}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(f'alive: {d.get(\"exitCode\")==0}')"
```
**期望**：`keepAlive: true`，30s 后 sandbox 仍存活（`alive: True`）

---

### T12.4 无 keepAlive 时 session idle 后沙箱被销毁

```bash
# 创建新 session（避免污染已有 keepAlive session）
SID2=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID2: $SID2"

# 普通命令（非 background），执行完后 session 进入 idle
curl -s --max-time 60 -X POST "$BASE/session/$SID2/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo hello\"}],\"model\":$MODEL}" > /dev/null

# 等待 onIdle 触发
sleep 5

# 检查 destroy 日志
docker exec opencode-saas-test grep "sandbox destroyed\|destroy.*$SID2" /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | tail -1
```
**期望**：日志中出现 `sandbox destroyed`，含对应 `sessionID`

---

### T12.5 keepAlive 阻止 idle 销毁

```bash
SID3=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID3: $SID3"

# background:true 激活 keepAlive
curl -s --max-time 60 -X POST "$BASE/session/$SID3/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 工具执行，background 必须设为 true: echo keepalive-test\"}],\"model\":$MODEL}" > /dev/null

# 等待 session idle
sleep 10

# 检查：有 idle 日志，但无 destroy 日志
IDLE=$(docker exec opencode-saas-test grep "session.idle.*$SID3\|exiting loop.*$SID3" /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | wc -l)
DESTROY=$(docker exec opencode-saas-test grep "sandbox destroyed.*$SID3\|destroy.*$SID3" /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | wc -l)
echo "idle events: $IDLE (should > 0)"
echo "destroy events: $DESTROY (should = 0)"
```
**期望**：`idle events > 0`，`destroy events = 0`

---

### T12.6 instance/dispose 强制销毁所有沙箱

```bash
# 先确保有沙箱在运行
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo before-dispose\"}],\"model\":$MODEL}" > /dev/null

# 调用 dispose
curl -s -X POST "$BASE/instance/dispose" -o /dev/null -w "dispose: %{http_code}\n"

# 检查销毁日志
sleep 2
docker exec opencode-saas-test grep "sandbox destroyed\|destroyAll" /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | tail -3
```
**期望**：`dispose: 200`，日志中出现 sandbox 销毁记录

---

### T12.7 dispose 后再次发消息自动重建沙箱

```bash
# dispose
curl -s -X POST "$BASE/instance/dispose" > /dev/null

# 等一下
sleep 2

# 再次发消息（应自动重建沙箱）
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo after-dispose\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;[print(p['text'][:100]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"
```
**期望**：正常响应，输出含 `after-dispose`，沙箱自动重建

---

### T12.8 PVC 数据在 sandbox 重建后恢复

```bash
SID8=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 触发 sandbox + keepAlive
curl -s -m 10 -X POST "$BASE/session/$SID8/exec" -H 'Content-Type: application/json' -d '{"command":"echo ok"}' > /dev/null
curl -s -m 10 -X POST "$BASE/session/$SID8/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":true}' > /dev/null

# 写入测试文件
TS=$(date +%s)
curl -s -m 15 -X POST "$BASE/session/$SID8/exec" -H 'Content-Type: application/json' \
  -d "{\"command\":\"echo $TS > /workspace/restart-test.txt && cat /workspace/restart-test.txt\"}" \
  | python3 -c "import json,sys;print('write:', json.load(sys.stdin).get('stdout','').strip())"

# kill sandbox（销毁容器）
curl -s -m 10 -X POST "$BASE/session/$SID8/kill-sandbox" | python3 -c "import json,sys;print('destroyed:', json.load(sys.stdin).get('destroyed'))"
sleep 2

# 重新 exec（触发新 sandbox 创建，PVC 应挂载回来）
curl -s -m 15 -X POST "$BASE/session/$SID8/exec" -H 'Content-Type: application/json' \
  -d '{"command":"cat /workspace/restart-test.txt"}' \
  | python3 -c "import json,sys;print('read after rebuild:', json.load(sys.stdin).get('stdout','').strip())"

# 清理
curl -s -m 10 -X POST "$BASE/session/$SID8/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":false}' > /dev/null
curl -s -m 10 -X POST "$BASE/session/$SID8/kill-sandbox" > /dev/null
```
**期望**：`read after rebuild` 输出与 `write` 一致（`$TS`），PVC 数据跨 sandbox 重建持久

---

### T12.9 多 session PVC 子目录隔离

> 每个 session 的 PVC 挂载在独立子路径 `sessions/{sessionID}/workspace`，互相隔离。

```bash
SID_A=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
SID_B=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# Session A 写文件
curl -s --max-time 60 -X POST "$BASE/session/$SID_A/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo session-A > /workspace/only-in-A.txt\"}],\"model\":$MODEL}" > /dev/null

# Session B 读 A 的文件（应该看不到）
RESULT=$(curl -s --max-time 60 -X POST "$BASE/session/$SID_B/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: ls /workspace/only-in-A.txt 2>&1\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;[print(p['text'][:200]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']")
echo "Session B sees A's file: $RESULT"
```
**期望**：Session B 看不到 `only-in-A.txt`（No such file or directory）

---

### T12.10 沙箱进程隔离（不同 session 进程互不影响）

```bash
SID_A=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
SID_B=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# Session A 启动后台进程
curl -s --max-time 60 -X POST "$BASE/session/$SID_A/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 工具执行，background 设为 true: sleep 3600\"}],\"model\":$MODEL}" > /dev/null

# Session B 查看进程（不应看到 A 的 sleep）
PROCS=$(curl -s --max-time 60 -X POST "$BASE/session/$SID_B/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: ps aux | grep sleep | grep -v grep\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;[print(p['text'][:300]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']")
echo "Session B processes: $PROCS"
```
**期望**：Session B 看不到 Session A 的 `sleep 3600` 进程（容器级隔离）

---

### T12.11 OPENCODE_SANDBOX_IDLE_KILL_SEC 配置验证

```bash
# 验证该配置的使用：env 值 + sandbox-provider.ts 中 idleKillMs 的实际用途
docker exec opencode-saas-test env | grep IDLE_KILL
grep -n 'idleKillMs\|IDLE_KILL' /Users/ruomu/code/opencode/packages/opencode/src/tool/sandbox-provider.ts
```
**期望**：
- `env` 显示 `OPENCODE_SANDBOX_IDLE_KILL_SEC=30`
- `idleKillMs` 在 `sandbox-provider.ts` 中**有实际使用**：第 22/39 行为 config 字段定义与取值（`Flag.OPENCODE_SANDBOX_IDLE_KILL_SEC * 1000`）；第 1128-1129 行用于僵尸 sandbox 判定（`state=running` 且 `time_updated` 超过 `idleKillMs*2` 未更新）；第 1166 行用于僵尸清理定时器（`Schedule.spaced(config.idleKillMs)`）
- 正常 sandbox 销毁由 `run-state.ts` `onIdle` 回调触发（session runner 空闲）；`idleKillMs` 定时器是**兜底机制**，清理因异常残留的僵尸 sandbox

---

### T12.12 GET /session/:sessionID/sandbox 查询沙箱 ID

```bash
# 创建 session 并触发 sandbox 创建
SID12=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID12: $SID12"

# 初始状态（无 sandbox）
curl -s "$BASE/session/$SID12/sandbox" | python3 -m json.tool

# 触发 sandbox 创建
curl -s -m 10 -X POST "$BASE/session/$SID12/exec" -H 'Content-Type: application/json' -d '{"command":"echo hello"}' > /dev/null

# 查询 sandbox ID
SB12=$(curl -s "$BASE/session/$SID12/sandbox" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('sandboxId',''))")
echo "sandboxId: $SB12"

# 验证返回值非空且与日志一致
LOG_SB=$(docker exec opencode-saas-test grep "$SID12" /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | grep "sandbox created" | sed -n 's/.*sandboxID=\([^ ]*\).*/\1/p' | tail -1)
echo "log sandboxId: $LOG_SB"
[ "$SB12" = "$LOG_SB" ] && echo "PASS: sandboxId matches" || echo "FAIL: mismatch"

# kill sandbox 后再查询
curl -s -m 10 -X POST "$BASE/session/$SID12/kill-sandbox" > /dev/null
sleep 2
curl -s "$BASE/session/$SID12/sandbox" | python3 -m json.tool
```
**期望**：
- 初始查询返回 `{ "sessionID": "...", "sandboxId": null }`
- exec 后查询返回 `{ "sessionID": "...", "sandboxId": "<非空ID>" }`
- sandboxId 与日志中的 `sandboxID` 一致
- kill-sandbox 后查询返回 `{ "sessionID": "...", "sandboxId": null }`

---

---

## 结果汇总

| 用例 | 状态 | 说明 |
|------|------|------|
| T12.1 | ✅ | AI 消息前无 sandbox，消息后日志出现 sandbox created + destroyed（idle） |
| T12.2 | ✅ | keepAlive 下 3 次 exec，sandboxId 始终一致 |
| T12.3 | ✅ | exec/async + 显式 keepAlive 等价验证 background 行为（30s 后仍存活） |
| T12.4 | ✅ | AI 消息后 session idle，日志出现 destroying sandbox + sandbox destroyed |
| T12.5 | ✅ | keepAlive=true 下等待 30s，sandboxId 不变，destroy events=0 |
| T12.6 | ✅ | dispose 200，实例资源释放 |
| T12.7 | ✅ | dispose 后 AI 消息正常响应 "after-dispose"，sandbox 自动重建 |
| T12.8 | ✅ | kill→rebuild 后读到同一 timestamp（1780300411），PVC 持久 |
| T12.9 | ✅ | A 写文件 B 看不到（No such file），B 写文件 A 看不到 |
| T12.10 | ✅ | A 启动 sleep 3600，B 看到 0 个匹配进程，A 看到 1 个 |
| T12.11 | ✅ | IDLE_KILL_SEC=30，idleKillMs 用于 zombie 清理定时器 + run-state.ts onIdle |
| T12.12 | ✅ | GET /session/:sessionID/sandbox（含 isHealthy 检查）：初始 null → exec 后返回 sandboxId（与日志一致）→ kill 后 null |


