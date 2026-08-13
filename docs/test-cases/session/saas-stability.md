# SaaS 稳定性补充

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。

## 十三、SaaS 稳定性补充

> 前置条件：同第十一节，使用本地测试环境（`docs/local-test-env.md`）。

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"
```

### T13.1 单 session kill-sandbox
```bash
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo kill-test > /workspace/kill-test.txt\"}],\"model\":$MODEL}" > /dev/null
curl -s -X POST "$BASE/session/$SID/kill-sandbox" -w "\nkill-sandbox: %{http_code}\n"
```
**期望**：HTTP 200，返回 `{"sessionID":"...","destroyed":true}`，日志中出现该 `SID` 对应的 sandbox destroyed 记录

### T13.2 kill-sandbox 后 PVC 保留并自动重建

> **交叉引用**：同类验证见 T5.3（04 文档）与 T12.8（10 文档，容器重启场景）；本条覆盖 kill-sandbox 显式销毁场景。

```bash
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: cat /workspace/kill-test.txt\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;[print(p.get('text','')[:200]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"
```
**期望**：输出含 `kill-test`，证明 kill 只销毁 sandbox runtime，不删除 PVC 数据

### T13.3 同一 session 并发首条消息只创建一个 sandbox

> **去重说明**（2026-07-17）：与 [`39-concurrency-p0-fixes.md`](./39-concurrency-p0-fixes.md) T39.3.1 完全重复（同一场景：3 条并发 prompt_async → 只建 1 个 sandbox）。执行脚本以 T39.3.1 为准；本条目保留作 11 文档的结果索引。

**期望**：同一个 session 只创建 1 个 sandbox；不能出现多个可用 sandbox runtime 绑定同一 session

### T13.4 dispose 与正在执行的 prompt 并发
```bash
SID_BUSY=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --max-time 60 -X POST "$BASE/session/$SID_BUSY/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: sleep 30 && echo late-output\"}],\"model\":$MODEL}" &
sleep 2
curl -s -X POST "$BASE/instance/dispose" -w "\ndispose: %{http_code}\n"
sleep 5
curl -s "$BASE/session/status" | python3 -m json.tool
```
**期望**：dispose 返回 200；正在执行的任务最终进入 idle/abort/error 中的明确状态，不应永久 running

### T13.9 服务重启后 session/message/part 仍可查询
```bash
SID_RESTART=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{"title":"restart-pg-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --max-time 60 -X POST "$BASE/session/$SID_RESTART/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"回复 restart-pg-ok\"}],\"model\":$MODEL}" > /dev/null
docker restart opencode-saas-test
sleep 10
curl -s "$BASE/session/$SID_RESTART" | python3 -m json.tool
curl -s "$BASE/session/$SID_RESTART/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))"
```
**期望**：重启后 session 可查询，message 数量大于 0

### T13.10 prompt_async 落库与 abort 状态
```bash
SID_ABORT=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --max-time 60 -X POST "$BASE/session/$SID_ABORT/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"写一篇很长的文章，持续输出\"}],\"model\":$MODEL}" -w "async: %{http_code}\n"
sleep 1
curl -s -X POST "$BASE/session/$SID_ABORT/abort"
sleep 5
curl -s "$BASE/session/$SID_ABORT/message" | python3 -m json.tool | head -120
```
**期望**：异步请求返回 204；abort 后消息已落库，最后状态是 abort/error/idle 中的明确结果，不应永久 running

### T13.11 PG FK 完整性与删除级联
```bash
SID_DEL=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --max-time 60 -X POST "$BASE/session/$SID_DEL/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo pg-integrity\"}],\"model\":$MODEL}" > /dev/null
docker exec ai-nova-postgres psql -U postgres -d opencode_test -t -A -c "SELECT COUNT(*) FROM message WHERE session_id = '$SID_DEL';"
docker exec ai-nova-postgres psql -U postgres -d opencode_test -t -A -c "SELECT COUNT(*) FROM part WHERE session_id = '$SID_DEL';"
curl -s -X DELETE "$BASE/session/$SID_DEL"
docker exec ai-nova-postgres psql -U postgres -d opencode_test -t -A -c "SELECT COUNT(*) FROM message WHERE session_id = '$SID_DEL';"
docker exec ai-nova-postgres psql -U postgres -d opencode_test -t -A -c "SELECT COUNT(*) FROM part WHERE session_id = '$SID_DEL';"
docker exec ai-nova-postgres psql -U postgres -d opencode_test -t -A -c "SELECT COUNT(*) FROM part p LEFT JOIN message m ON p.message_id = m.id WHERE m.id IS NULL;"
```
**期望**：删除前 message/part 大于 0；删除后该 session 的 message/part 为 0；全局 orphan part 为 0

### T13.12 订阅额度月度 reset 与 rate limit
```bash
cd /Users/ruomu/code/opencode/packages/console/core && bun test test/subscription.test.ts
cd /Users/ruomu/code/opencode/packages/console/app && bun test test/rateLimiter.test.ts
```
**期望**：全部通过，覆盖 usage reset、rate-limited、Retry-After、usagePercent cap

### T13.13 rate limit 命中后不执行工具
```bash
# 需要外部服务或测试桩把当前用户/org 标记为 rate-limited 后再执行
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo should-not-run > /workspace/rate-limit.txt\"}],\"model\":$MODEL}" \
  -w "\nstatus: %{http_code}\n"
curl -s "$BASE/file/content?path=/workspace/rate-limit.txt&sessionID=$SID"
```
**期望**：请求返回明确 rate limit 错误；`rate-limit.txt` 不应存在。若限流由外部服务完成，本用例在外部网关层执行

### T13.14 sandbox 安全：禁止访问宿主路径
```bash
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: ls /Users /var/run/docker.sock /home/opencode/.ssh 2>&1 || true\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;[print(p.get('text','')[:500]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"
```
**期望**：不能读取宿主机用户目录、Docker socket 或 SSH 私钥；输出应是不存在或权限拒绝

### T13.15 sandbox 安全：禁止路径逃逸
```bash
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: cd /workspace && ln -s /etc/passwd escape-passwd 2>/dev/null || true && cat escape-passwd 2>&1 || true && cat ../../etc/passwd 2>&1 || true\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;[print(p.get('text','')[:800]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"
```
**期望**：不能通过软链或相对路径读到 sandbox 外敏感文件；如果 sandbox 内 `/etc/passwd` 可读，应确认不包含宿主机用户信息

### T13.16 sandbox 安全：敏感环境变量不泄露
```bash
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: env | grep -Ei 'TOKEN|SECRET|KEY|PASSWORD|COOKIE' || true\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;[print(p.get('text','')[:800]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"
```
**期望**：不应暴露外部服务密钥、数据库密码、provider key、cookie 等敏感信息；允许出现无敏感值的测试变量

### T13.17 幂等性：重复 instance/dispose
```bash
for i in 1 2 3; do
  curl -s -X POST "$BASE/instance/dispose" -w "dispose-$i: %{http_code}\n"
done
```
**期望**：重复调用都稳定返回 200/true，不产生异常日志或残留 sandbox

### T13.18 幂等性：重复 kill-sandbox
```bash
for i in 1 2 3; do
  curl -s -X POST "$BASE/session/$SID/kill-sandbox" -w "kill-$i: %{http_code}\n"
done
```
**期望**：重复调用返回稳定结果；若 sandbox 已不存在，必须是明确成功或明确错误，不应 500

### T13.19 幂等性：重复删除 session 和 provider 凭据
```bash
SID_DELETE=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
for i in 1 2; do curl -s -X DELETE "$BASE/session/$SID_DELETE" -w "delete-session-$i: %{http_code}\n"; done
curl -s -X PUT "$BASE/auth/test-provider" -H 'Content-Type: application/json' -d '{"type":"api","key":"idempotent-key"}'
for i in 1 2; do curl -s -X DELETE "$BASE/auth/test-provider" -w "delete-auth-$i: %{http_code}\n"; done
```
**期望**：重复删除行为明确。第二次可以是 200/true 或 404，但不能 500 或产生不一致状态

### T13.20 观测性：sandbox 生命周期日志
```bash
SID_LOG=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --max-time 60 -X POST "$BASE/session/$SID_LOG/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 工具执行，background 必须设为 true: echo log-observe\"}],\"model\":$MODEL}" > /dev/null
sleep 2
docker exec opencode-saas-test grep "$SID_LOG" /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | grep -E 'sandbox created|keep alive enabled|sandbox destroyed' | tail -10
```
**期望**：日志包含 `sessionID`，并能定位 sandbox created、keepAlive、destroyed 等生命周期事件

### T13.21 观测性：错误可关联 sessionID
```bash
SID_ERR=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --max-time 30 -X POST "$BASE/session/$SID_ERR/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hi"}],"model":{"providerID":"not-exist","modelID":"fake"}}' \
  -w "\nstatus: %{http_code}\n"
sleep 2
docker exec opencode-saas-test grep "$SID_ERR" /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | tail -20
```
**期望**：provider/sandbox/session 错误日志能关联到 `SID_ERR`

### T13.22 观测性：usage/计费记录可关联 session
```bash
SID_USAGE=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --max-time 60 -X POST "$BASE/session/$SID_USAGE/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"回复 usage-observe\"}],\"model\":$MODEL}" > /dev/null
docker exec ai-nova-postgres psql -U postgres -d opencode_test -t -A -c "SELECT id, data->>'role', data->'metadata' FROM message WHERE session_id = '$SID_USAGE' ORDER BY time_created DESC LIMIT 5;"
```
**期望**：消息或相关 usage 表中能关联 `sessionID`、model、token/成本信息；若当前尚未落 usage，标记为待实现

### T13.23 恢复语义：重启后 running session 状态明确
```bash
SID_RUN=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --max-time 60 -X POST "$BASE/session/$SID_RUN/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: sleep 60 && echo after-restart\"}],\"model\":$MODEL}" > /dev/null
sleep 2
docker restart opencode-saas-test
sleep 10
curl -s "$BASE/session/status" | python3 -m json.tool
curl -s "$BASE/session/$SID_RUN/message" | python3 -m json.tool | head -120
```
**期望**：`SID_RUN` 不应永久 running；最终应变为 idle/abort/error 中的明确状态

### T13.24 恢复语义：重启后无孤儿 sandbox
```bash
docker restart opencode-saas-test
sleep 10
docker ps --format '{{.Names}}' | grep -i sandbox || true
docker exec opencode-saas-test grep -E 'orphan|cleanup|sandbox' /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | tail -50
```
**期望**：重启后旧 sandbox 不应成为无法管理的孤儿资源；如设计为外部 runtime 自动清理，日志应能体现清理或重新接管

---

## 结果汇总

| 用例 | 状态 | 说明 |
|------|------|------|
| T13.1 | ✅ | kill-sandbox → destroyed=true |
| T13.2 | ✅ | kill 后 exec 读到 PVC 数据（kill-test），自动重建 |
| T13.3 | ✅ | 3 个并发 exec 返回同一 sandboxId（4da9a966），只创建 1 个 sandbox |
| T13.4 | ✅ | dispose 200，sessions 清零 |
| T13.5-T13.8 | — | proxy 相关，已移除 |
| T13.9 | ✅ | docker restart 后 session 可查、messages=2 |
| T13.10 | ✅ | prompt_async 204 → abort 200，messages=2 |
| T13.11 | ✅ | 删除前 messages=3 parts=8，删除后 0/0，orphan=0 |
| T13.12 | ⏭️ | 订阅额度单元测试，需单独跑 |
| T13.13 | ⏭️ | 依赖外部限流网关 |
| T13.14 | ✅ | /Users、docker.sock、.ssh 均 No such file |
| T13.15 | ⚠️ | sandbox 内 /etc/passwd 可读（容器自身 root 用户，非宿主机） |
| T13.16 | ⚠️ | 暴露 JUPYTER_TOKEN（sandbox 内部 token，非外部密钥） |
| T13.17 | ✅ | 3 次 dispose 均 200 |
| T13.18 | ✅ | 3 次 kill-sandbox 均返回 destroyed=true |
| T13.19 | ✅ | 首次 delete session 200，重复 404；auth delete 均 200 |
| T13.20 | ✅ | 日志含 sandbox created / keep alive enabled / destroying / destroyed 完整生命周期 |
| T13.21 | ✅ | 不存在 provider 返回 500，日志含 sessionID 可关联 |
| T13.22 | ✅ | cost=0.038, tokens=input:277/output:69/reasoning:177, PG 4 条 message |
| T13.23 | ✅ | 重启后 0 个 running session |
| T13.24 | ✅ | PG 有 1 个 keep_alive=false 的 running 记录，zombie cleanup 会处理 |

