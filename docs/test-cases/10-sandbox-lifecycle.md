# 沙箱生命周期管理

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。

## 十二、沙箱生命周期管理

> 前置条件：同第十一节，使用本地测试环境（`docs/local-test-env.md`）。

```bash
BASE="http://localhost:14096"
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'
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

### T12.3 background:true 触发 keepAlive

```bash
# 用 background:true 执行命令
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 工具执行，background 必须设为 true: sleep 1 && echo done\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;[print(p['text'][:100]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"

# 检查 keepAlive 是否被设置
docker exec opencode-saas-test grep "keep alive enabled.*$SID" /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | tail -1
```
**期望**：日志中出现 `sandbox keep alive enabled`，含对应 `sessionID`

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

### T12.8 沙箱容器重启后 PVC 数据恢复

```bash
# Step 1: 写入测试文件
TS=$(date +%s)
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo $TS > /workspace/restart-test-$TS.txt\"}],\"model\":$MODEL}" > /dev/null

echo "Wrote restart-test-$TS.txt"

# Step 2: 重启 opencode 容器（模拟 Pod 重启）
docker restart opencode-saas-test
sleep 10

# Step 3: 重启 TCP 转发（容器重启后可能需要）
# （若转发正常则跳过）

# Step 4: 重新发消息，验证文件仍存在
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: cat /workspace/restart-test-$TS.txt\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;[print(p['text'][:100]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"
```
**期望**：重启后仍能读到 `$TS`，PVC 数据跨容器重启持久

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
# 验证该配置当前未被 opencode 代码使用（只传给 SDK）
docker exec opencode-saas-test env | grep IDLE_KILL
grep -n 'idleKillMs\|IDLE_KILL' /Users/ruomu/code/opencode/packages/opencode/src/tool/sandbox-provider.ts
```
**期望**：
- `env` 显示 `OPENCODE_SANDBOX_IDLE_KILL_SEC=30`
- `grep` 只在 config 定义处出现（第 19、35 行），**无实际使用**
- 回收逻辑在 `run-state.ts` `onIdle` 回调中，由 session runner 空闲触发，非定时器

---

### T12.12 proxy 访问不触发 keepAlive（当前行为）

```bash
SID4=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 先通过 AI 启动 dev server（不用 background:true）
curl -s --max-time 60 -X POST "$BASE/session/$SID4/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo started\"}],\"model\":$MODEL}" > /dev/null

# 直接访问 proxy（不触发 keepAlive）
curl -s "$BASE/session/$SID4/proxy/3000/" -o /dev/null

# 等待 session idle + sandbox destroy
sleep 10

DESTROY=$(docker exec opencode-saas-test grep "destroy.*$SID4" /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | wc -l)
echo "destroy events: $DESTROY (should > 0, proxy access does NOT prevent destroy)"
```
**期望**：`destroy events > 0`，说明直接访问 proxy 不触发 keepAlive，sandbox 仍被回收

> 这是当前的设计行为。如需 proxy 访问自动保活，需修改 `sandbox-proxy.ts` 在 `getEndpoint` 后调用 `keepAlive`（见 `sandbox-proxy-design.md` 相关讨论）。



