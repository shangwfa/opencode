# SaaS 稳定性补充（V2）

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。

## ⚠️ V1 路径已失效（2026-09-29）

原文档全部使用 V1 路径，**V2 无兼容层**。V1 请求会命中 **SPA fallback 返回 HTML 200**，判定端点存在必须看 `content-type`。

| V1 | V2 |
|---|---|
| `POST /session` | `POST /api/session` |
| `POST /session/:id/message` | `POST /api/session/:id/prompt`（**异步接纳，返回 200 而非 204**）+ `wait` |
| `POST /session/:id/prompt_async` | 同上（V2 一律异步） |
| `POST /session/:id/abort` | `POST /api/session/:id/interrupt` → `{interrupted: bool}` |
| `POST /session/:id/exec`（同步 stdout） | `POST /api/session/:id/shell`（**204 异步**），终态从 PG `type='shell'` + `status='exited'` 读 |
| `GET /session/status` | `GET /api/session/active`（**只列运行中**） |
| `POST /instance/dispose` | **无此端点** |
| `PUT/DELETE /auth/*` | **无此端点** |
| 日志 `~/.local/share/opencode/log/dev.log` | `~/.local/share/opencode/log/opencode-local.log` |
| PG 表 `session` / `message` / `part` | `session_v2` / `session_message` /（V2 无 part 表） |

## 公共环境

```bash
export BASE="${BASE:-http://localhost:14096}"
export PG_URL="${PG_URL:-postgresql://local@127.0.0.1:5432/opencode-v2-up}"
export MODEL='{"id":"deepseek-v4-flash","providerID":"Yd-DeepSeek"}'
CURL_AUTH=(-u "opencode:${OPENCODE_PASSWORD}")
LOG=/home/opencode/.local/share/opencode/log/opencode-local.log
api(){ curl -sS --noproxy '*' "${CURL_AUTH[@]}" "$@"; }
pgval(){ psql "$PG_URL" -t -A -c "$1"; }
new_session(){ jq -nc --argjson m "$MODEL" '{location:{directory:"/workspace"}, model:$m}' \
  | api -X POST "$BASE/api/session" -H 'Content-Type: application/json' --data-binary @- \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])"; }
prompt(){ jq -nc --arg t "$2" '{text:$t,metadata:{},delivery:"queue"}' \
  | api -X POST "$BASE/api/session/$1/prompt" -H 'Content-Type: application/json' --data-binary @- >/dev/null; }
wait_sid(){ curl -s --noproxy '*' "${CURL_AUTH[@]}" -o /dev/null --max-time "${2:-180}" \
  -X POST "$BASE/api/experimental/session/$1/wait" -H 'Content-Type: application/json' -d '{}'; }
# V2 shell 替代 V1 同步 exec
run_shell(){ # $1=SID $2=cmd [超时]  -> $SHELL_OUT / $SHELL_EXIT
  local sid="$1" cmd="$2" to="${3:-60}" before
  before=$(pgval "SELECT coalesce(max(seq),0) FROM session_message WHERE session_id='$sid'")
  jq -nc --arg c "$cmd" '{command:$c}' | api -X POST "$BASE/api/session/$sid/shell" \
    -H 'Content-Type: application/json' --data-binary @- >/dev/null 2>&1
  for _ in $(seq 1 $((to*2))); do
    if [ "$(pgval "SELECT count(*) FROM session_message WHERE session_id='$sid' AND type='shell' AND seq>$before AND data::jsonb->>'status'='exited'")" -gt 0 ]; then
      SHELL_OUT=$(pgval "SELECT data::jsonb->'output'->>'output' FROM session_message WHERE session_id='$sid' AND type='shell' AND seq>$before AND data::jsonb->>'status'='exited' ORDER BY seq DESC LIMIT 1")
      SHELL_EXIT=$(pgval "SELECT coalesce((data::jsonb->>'exit')::text,'?') FROM session_message WHERE session_id='$sid' AND type='shell' AND seq>$before AND data::jsonb->>'status'='exited' ORDER BY seq DESC LIMIT 1")
      return 0; fi
    sleep 0.5
  done
  SHELL_OUT=""; SHELL_EXIT="timeout"; return 1
}
```

---

## 十三、SaaS 稳定性补充

### T13.1 单 session kill-sandbox

```bash
run_shell "$SID" "echo kill-test > /workspace/kill-test.txt"
api -X POST "$BASE/api/session/$SID/kill-sandbox" -H 'Content-Type: application/json' -d '{}'
pgval "SELECT state FROM sandbox WHERE session_id='$SID'"
```

**期望**：返回 `{"sessionID":"...","destroyed":true}`；PG 中该 sandbox `state=destroyed`。

### T13.2 kill-sandbox 后数据保留并自动重建

```bash
run_shell "$SID" "cat /workspace/kill-test.txt 2>&1"
pgval "SELECT state FROM sandbox WHERE session_id='$SID'"
```

**期望**：读到 `kill-test`（kill 只销毁 runtime，不删数据）；sandbox 自动重建为 `running`。

### T13.3 同 session 并发首条消息只创建一个 sandbox

```bash
for i in 1 2 3; do prompt "$SID3" "回复 $i 即可" & done; wait; wait_sid "$SID3" 200
pgval "SELECT count(*) FROM sandbox WHERE session_id='$SID3' AND state='running'"
```

**期望**：`count=1`。

### T13.4 dispose 与正在执行的 prompt 并发

⛔ **不适用**。V2 无 `instance/dispose` 端点（openapi 实测 0 条）。V2 用重启（`docker restart`）替代，语义见 T13.23。

### T13.9 服务重启后 session/message 仍可查询

```bash
prompt "$SID9" '回复 restart-pg-ok'; wait_sid "$SID9" 120
docker restart opencode-saas-test
# 等 /api/info 可用后
api -o /dev/null -w '%{http_code}\n' "$BASE/api/session/$SID9"
pgval "SELECT count(*) FROM session_message WHERE session_id='$SID9'"
```

**期望**：重启后 session GET 200，message 数 > 0。

### T13.10 prompt 落库与 interrupt 状态

```bash
api -X POST "$BASE/api/session/$SIDA/prompt" -H 'Content-Type: application/json' \
  -d '{"text":"写一篇很长的文章，持续输出","metadata":{},"delivery":"queue"}'   # 期望 200
api -X POST "$BASE/api/session/$SIDA/interrupt" -H 'Content-Type: application/json' -d '{}'
pgval "SELECT string_agg(type||'='||c,' ') FROM (SELECT type,count(*) c FROM session_message WHERE session_id='$SIDA' GROUP BY type) t"
```

**期望**：prompt **200**（V1 是 204）；interrupt `{"interrupted":true}`；user 已落库；最终进入 `idle` 终态而非永久 running。

### T13.11 PG FK 完整性与删除级联

```bash
pgval "SELECT count(*) FROM session_message WHERE session_id='$SIDD'"   # 删除前 > 0
api -o /dev/null -X DELETE "$BASE/api/session/$SIDD"
pgval "SELECT count(*) FROM session_message WHERE session_id='$SIDD'"   # 0
pgval "SELECT count(*) FROM session_v2 WHERE id='$SIDD'"                # 0
```

**期望**：删除后 message/session 级联清零，无 orphan。

### T13.12 订阅额度与 rate limit 单测

```bash
cd packages/console/core && bun test test/subscription.test.ts
cd packages/console/app   && bun test test/rateLimiter.test.ts
```

### T13.13 rate limit 命中后不执行工具

⛔ **不适用**（依赖外部限流网关，本地无法构造）。

### T13.14–T13.16 沙箱安全三连

```bash
run_shell "$SID" "ls /Users /var/run/docker.sock /home/opencode/.ssh 2>&1 || true"
run_shell "$SID" "cd /workspace && ln -sf /etc/passwd escape-pw 2>/dev/null; cat escape-pw 2>&1 | head -3; echo '---REL---'; cat ../../etc/passwd 2>&1 | head -3"
run_shell "$SID" "env | grep -Ei 'TOKEN|SECRET|KEY|PASSWORD|COOKIE|DATABASE_URL' || true"
```

**期望**：
- 宿主路径 / docker.sock / .ssh 均 `No such file` 或权限拒绝
- 路径逃逸读到的 `/etc/passwd` 是**沙箱容器自身**内容，不含宿主机用户
- 环境变量**无** DB 连接串、API key、provider key 泄露

### T13.17 幂等性：重复 dispose

⛔ **不适用**（无 dispose 端点）。

### T13.18 幂等性：重复 kill-sandbox

```bash
for i in 1 2 3; do api -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/session/$SID/kill-sandbox" -H 'Content-Type: application/json' -d '{}'; done
```

**期望**：均返回 200，不产生 500。

### T13.19 幂等性：重复删除

```bash
code -X DELETE "$BASE/api/session/$SIDDEL"   # 首次 204
code -X DELETE "$BASE/api/session/$SIDDEL"   # 重复 404
```

**期望**：首次 204，重复 **404**（非 500）。V2 无 `/auth/*` 端点，凭据部分不适用。

### T13.20 / T13.21 观测性：日志可关联 sessionID

```bash
prompt "$SIDL" '用 shell 工具执行 echo log-observe'; wait_sid "$SIDL" 120
docker exec opencode-saas-test grep -c "$SIDL" "$LOG"
```

**期望**：日志能按 sessionID 关联到 sandbox 生命周期与错误记录。

### T13.22 usage/计费记录关联 session

```bash
pgval "SELECT 'cost='||cost||' in='||tokens_input||' out='||tokens_output FROM session_v2 WHERE id='$SIDU'"
```

**期望**：token 计数按 session 落库（`cost` 取决于 provider 是否计价）。

### T13.23 / T13.24 重启后无 running 残留与孤儿 sandbox

```bash
prompt "$SIDR" '用 shell 工具执行 sleep 60 && echo after-restart'; sleep 6
docker restart opencode-saas-test
# 等服务就绪
api "$BASE/api/session/active" | jq -c --arg s "$SIDR" '.data[$s] // empty'   # 应为空
```

**期望**：重启后该会话不在 `active` 中；无孤儿 running sandbox。

---

## 2026-09-29 V2 实测记录

环境：SaaS `opencode-saas-sandbox-test:9d86bde786-t4`、沙箱 `opencode-opensandbox:local`（`7057c941ec64`）、本地 PG + 本地 OpenSandbox。**26 条断言 PASS，0 FAIL，4 条不适用。**

| 用例 | 结果 | 实际观察 |
|---|---|---|
| T13.1 | ✅ | `{"destroyed":true}`；PG `state=destroyed` |
| T13.2 | ✅ | kill 后读到 `kill-test`；sandbox 自动重建为 `running` |
| T13.3 | ✅ | 并发 3 条消息，`running` sandbox **count=1** |
| T13.4 | ⏭️ 不适用 | V2 无 `instance/dispose`（openapi 0 条） |
| T13.9 | ✅ | 重启前 message=3 → 重启后 GET 200、message=3 |
| T13.10 | ✅ | prompt **200**；interrupt `{"interrupted":true}`；消息 `user=1 assistant=1 idle=1` |
| T13.11 | ✅ | 删除前 message=4 → 删除后 message=0、session=0、orphan=0 |
| T13.12 | ✅ | subscription **6 pass**、rateLimiter **3 pass**，0 fail |
| T13.13 | ⏭️ 不适用 | 依赖外部限流网关 |
| T13.14 | ✅ | `/Users`、`/var/run/docker.sock`、`/home/opencode/.ssh` 均 `No such file` |
| T13.15 | ✅ | 软链与相对路径逃逸读到的都是**沙箱容器自身** `/etc/passwd`（root/daemon/bin），无宿主机用户 |
| T13.16 | ✅ | 敏感变量匹配结果为**空** —— 无 DB 连接串 / API key 泄露 |
| T13.17 | ⏭️ 不适用 | 无 dispose 端点 |
| T13.18 | ✅ | 三次 kill-sandbox 均 **200** |
| T13.19 | ✅ | 首次删除 **204**，重复删除 **404**（非 500）；auth 部分不适用 |
| T13.20 | ✅ | 日志中出现该 sessionID **10 次** |
| T13.21 | ✅ | 错误场景日志中出现 sessionID |
| T13.22 | ✅ | `session_v2` 落库 token 计数（in/out 均有值），`cost=0` |
| T13.23 | ✅ | 重启前 `active={"type":"running"}` → 重启后**不在 active 中** |
| T13.24 | ✅ | 无本轮遗留的孤儿 running sandbox |

**不适用**：T13.4、T13.13、T13.17（无 dispose/rate-limit 环境）、T13.19 的 auth 部分。

### 与 V1 记录的差异

| 用例 | V1 | V2 |
|---|---|---|
| T13.1/13.18 | kill-sandbox | 路径仅加 `/api` 前缀，语义一致 |
| T13.4 / T13.17 | `POST /instance/dispose` 200 | **无 dispose 端点** |
| T13.10 | prompt_async **204** | prompt **200** + `interrupt` 替代 `abort` |
| T13.12 | console 单测 | 路径变为 `packages/console/{core,app}`，6+3 用例全过 |
| T13.19 | 含 `/auth/test-provider` 幂等 | V2 **无 `/auth/*` 端点** |
| T13.20/21/24 | 日志 `dev.log` | 日志 `opencode-local.log` |
| T13.16 | 暴露 JUPYTER_TOKEN | **本轮无任何敏感变量命中**（沙箱镜像已加固） |

**清理**：本轮 11 个会话已全部删除，直接 `count` 复查为 0。

---

## 历史记录（V1 时期，保留备查）

> 2026-09-16 复测（镜像 `person-model-connect`，本地 PG + 远端 K8s 沙箱）：T13.1–T13.24 全部通过（T13.13 依赖外部网关 SKIP）。其中 T13.15 记录「sandbox 内 /etc/passwd 可读（容器自身）」、T13.16 记录「暴露 JUPYTER_TOKEN」为**已知可接受项**。
