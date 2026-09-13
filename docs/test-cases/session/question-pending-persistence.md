# 挂起 question/permission 的重启持久化（已知缺陷钉住）

> 钉住缺陷：`question.ask()` / `permission.ask()` 的 pending 状态仅存于实例内存（`InstanceState` 的 `Map` + `Deferred`），
> 不落 PG。实例重启 / 多实例路由切换后 pending 全部丢失：`GET /question` 清空、reply/reject 返回 404、
> run 悬死等 stale-run 接管（默认 1800s）、permission 的 `always` 放行规则丢失。
>
> 代码位置：
> - `packages/opencode/src/question/index.ts:43` — `pending: Map<QuestionID, PendingEntry>`（内存）
> - `packages/opencode/src/permission/index.ts:25-26` — `pending` + `approved`（内存，`always` 规则）
> - 唯一善后是 `Effect.addFinalizer`（question:74-81 / permission:56-63），仅覆盖 graceful shutdown，且语义 = 全部按"用户拒绝"收场

## 验证标准

| 层级 | 方法 | 判定标准 |
|------|------|---------|
| 1. HTTP 响应 | 重启实例前后调用 question/permission API | 修复后：重启前可见的 pending，重启后仍可见且可 reply |
| 2. PG 记录 | 查 information_schema / event 表 | 修复后：pending 状态有持久化载体（当前缺陷：question 事件未标 durable，`question.asked` 连一次性记录都不落 event 表） |
| 3. run 行为 | 重启后观察 session 消息树与 run 状态 | 修复后：挂起 run 以明确语义收场（恢复或显式关闭），不悬死等待 stale-run 接管 |

## 通用变量

> 运行前先全局加载环境：`source test-env.sh [1|2|3]`。用例直接用 `$BASE` `$PG_URL` `$MODEL`。

**前置条件（重要）**：

- 本组用例包含 `docker restart`，**必须在本地容器组合执行**（容器 `opencode-saas-test`，`$BASE=http://localhost:14096`），禁止对远端共享测试环境重启。
- question 工具默认启用条件：client ∈ {app, cli, desktop}（`registry.ts:229`）。SaaS 容器未设 `OPENCODE_CLIENT` 时默认 `cli`，即默认启用。
- question 挂起已豁免 LLM stall 计时（见 [`llm-stall-recovery.md`](llm-stall-recovery.md)），等待用户回答不限时——这正是 pending 长期存活的场景。

---

## 一、T1 触发：构造挂起 question（建立基线）

### T1.1 异步消息让 AI 调用 question 工具

> question 挂起会阻塞 run，同步 `POST /message` 会一直等到回答；必须用 `prompt_async` 立即返回。

```bash
source test-lib.sh

SID=$(new_sid -k)
echo "SID: $SID"

# 后台异步发消息（prompt_async 立即返回，不等待 run 完成）
curl -s -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"请立即使用 question 工具向我提问：'测试流程是否继续？'，选项：[继续, 停止]。发完问题就停下来等我的回答，不要自己猜测答案。\"}],\"model\":$MODEL}" | jexec "d.get('info', d)"

# 轮询等待 question 挂起（最多 90s）
for i in $(seq 1 45); do
  QCOUNT=$(curl -s "$BASE/question" | jexec "len(d)")
  [ "$QCOUNT" = "1" ] && break
  sleep 2
done
echo "pending questions: $QCOUNT"
```

**期望**：
- HTTP：`GET /question` 返回 1 条 pending，`sessionID = $SID`，questions 含「继续/停止」选项
- SSE（可选）：`question.asked` 事件推送

### T1.2 pending 内容完整

```bash
curl -s "$BASE/question" | python3 -c "
import json, sys
d = json.load(sys.stdin, strict=False)
q = d[0]
print(f\"id={q['id']} session={q['sessionID']} questions={len(q['questions'])}\")
print('PASS' if len(q['questions']) == 1 else 'FAIL')
"
```

**期望**：id 非空、sessionID 正确、questions=1

### T1.3 对照组：正常 reply 后 AI 继续、run 完成

```bash
QID=$(curl -s "$BASE/question" | jexec "d[0]['id']")

curl -s -X POST "$BASE/question/$QID/reply" \
  -H 'Content-Type: application/json' \
  -d '{"answers":[["继续"]]}' | jexec "d.keys()"

# 轮询等待 run 完成（assistant 回复出现，最多 120s）
for i in $(seq 1 60); do
  DONE=$(curl -s "$BASE/session/$SID/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin, strict=False)
asst = [m for m in msgs if m.get('role') == 'assistant']
print('yes' if asst and any(p.get('type') == 'text' for p in asst[-1].get('parts', [])) else 'no')
" 2>/dev/null)
  [ "$DONE" = "yes" ] && break
  sleep 2
done
echo "run finished: $DONE"

# 回答已回填给模型：GET /question 应清空
curl -s "$BASE/question" | jexec "len(d)"
```

**期望**：
- HTTP：reply 200；run 正常完成；`GET /question` 归零
- 消息树中 question tool call 有 result，内容含「继续」（答案回填）

---

## 二、T2 预期 vs 当前缺陷：重启后 pending 丢失

> 按 T1.1 重新构造一个挂起 question（新 SID），再执行以下步骤。
> 每条用例标注**当前（缺陷行为）**与**修复后（验收标准）**。

### T2.1 重启实例后 GET /question 清空

```bash
# （已按 T1.1 构造挂起 question）
QID_BEFORE=$(curl -s "$BASE/question" | jexec "d[0]['id']")
echo "QID before restart: $QID_BEFORE"

docker restart opencode-saas-test

# 等 server 恢复
for i in $(seq 1 30); do
  curl -s -o /dev/null "$BASE/session" && break
  sleep 2
done

echo "pending after restart: $(curl -s "$BASE/question" | jexec "len(d)")"
```

**期望**：
- 当前（缺陷）：pending = 0，`QID_BEFORE` 彻底消失
- 修复后：pending ≥ 1，`QID_BEFORE` 仍在列表中，可继续 reply

### T2.2 reply 旧 requestID 返回 404

```bash
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/question/$QID_BEFORE/reply" \
  -H 'Content-Type: application/json' \
  -d '{"answers":[["继续"]]}')
echo "reply status: $HTTP_CODE"

HTTP_CODE2=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/question/$QID_BEFORE/reject")
echo "reject status: $HTTP_CODE2"
```

**期望**：
- 当前（缺陷）：404（`Question.NotFoundError`，新实例内存 Map 无此条目）——多实例路由切换是同一表现，无需重启也可复现（见第四节）
- 修复后：200，答案正确送达（重启场景若修复方案选择"显式关闭"，则应返回明确的状态语义而非裸 404）

### T2.3 PG 无 pending 持久化载体（架构证据）

```bash
# 1) 查无 question/permission 状态表
pgval "SELECT count(*) FROM information_schema.tables WHERE table_name LIKE '%question%' OR table_name LIKE '%permission%'"

# 2) question 事件也未落 event 表：question.asked 等 3 个事件均未标注 durable
#    （packages/schema/src/v1/question.ts:58-60，define() 无 durable 字段 → 不入 durable manifest → 不落 PG）
pgval "SELECT count(*) FROM event WHERE type LIKE 'question%'"
```

**期望**：
- 当前（缺陷）：两查询均 = 0——不仅「还在等」无状态载体，连「问过」的一次性痕迹都不落 PG（事件仅走内存事件桥/SSE；对比 durable 事件如 `session.*` 会落 event 表）
- 修复后：pending 状态有持久化载体（新表或复用 event 表将 `question.asked` 标注 durable），重启后可据此恢复

### T2.4 挂起 run 悬死，等 stale-run 接管

```bash
# 重启后查看该 session 消息树：question tool call 无 result（悬空）
curl -s "$BASE/session/$SID/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin, strict=False)
for m in msgs:
    for p in m.get('parts', []):
        if p.get('type') == 'tool' and p.get('tool') == 'question':
            print(f\"tool call {p.get('callID')[:16]}... state={p.get('state')}\")
"

# run 状态：挂起直到 OPENCODE_SESSION_STALE_RUN_SEC（默认 1800s）后被接管
```

**期望**：
- 当前（缺陷）：question tool call 的 state 长期处于 pending/无 result；旧 run 不被任何人关闭，直到 stale-run 接管（默认 30 分钟）；接管时悬空 question 无显式处理语义
- 修复后：重启恢复或接管时，挂起 run 以明确原因收场（如「实例重启，问题未回答」），消息树中 tool call 有终态 result

### T2.5 answered-lost：已答未消费的答案回填（最佳实践修正后新增）

> 场景：用户已提交 reply（PG 行 status=replied），但持有实例在消费前死亡。修复后答案不丢——清扫时把答案回填进悬空 tool part，下一次发消息 LLM 能引用。

```bash
# 1) 按 T1.1 构造挂起 question（新 SID），然后在实例消费前重启
#    （模拟方式：reply 与 restart 之间竞态较难稳定构造，可用「reply 打到无该 pending 的另一实例」
#     即 T4.1 多实例场景，或直接 docker stop -t 0 硬杀 + 手工把行置 replied）
QID=$(curl -s "$BASE/question" | jexec "d[0]['id']")
curl -s -X POST "$BASE/question/$QID/reply" \
  -H 'Content-Type: application/json' -d '{"answers":[["继续"]]}' > /dev/null
docker restart opencode-saas-test   # 若 reply 已送达原实例则退化为 T2.1 场景

# 2) 等 server 恢复 + 清扫（租约过期，最长 ~2min）后，再发一条消息触发新 run
curl -s -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"刚才我的回答是什么？请原样复述\"}],\"model\":$MODEL}" > /dev/null

# 3) 验证 assistant 回复引用了「继续」
```

**期望**：
- 当前（缺陷）：答案彻底丢失，LLM 无法复述
- 修复后：悬空 question tool part 被清扫回填为 completed（output 含「继续」），LLM 复述正确——用户已提交的答案不因实例死亡丢失

---

## 三、T3：permission pending 同类缺陷

### T3.1 触发 permission ask

```bash
SID_P=$(new_sid -k)

# 会话级规则：bash rm* → ask
curl -s -X PATCH "$BASE/session/$SID_P" \
  -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"bash","pattern":"rm*","action":"ask"}]}' > /dev/null

# 异步触发（rm 命令命中 ask 规则）
curl -s -X POST "$BASE/session/$SID_P/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"执行命令 rm -rf /tmp/perm-ask-test，直接执行不要询问我\"}],\"model\":$MODEL}" > /dev/null

for i in $(seq 1 45); do
  PCOUNT=$(curl -s "$BASE/permission" | jexec "len(d)")
  [ "$PCOUNT" = "1" ] && break
  sleep 2
done
echo "pending permissions: $PCOUNT"
```

**期望**：`GET /permission` 返回 1 条，permission=bash、pattern 命中 `rm*`、sessionID 正确

### T3.2 重启后 reply 404、`always` 放行丢失

```bash
PID_BEFORE=$(curl -s "$BASE/permission" | jexec "d[0]['id']")

docker restart opencode-saas-test
for i in $(seq 1 30); do curl -s -o /dev/null "$BASE/session" && break; sleep 2; done

# 1) 旧 requestID reply → 404
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/permission/$PID_BEFORE/reply" \
  -H 'Content-Type: application/json' \
  -d '{"reply":"once"}')
echo "reply status: $HTTP_CODE"

# 2) always 规则丢失：重启前先 reply always，重启后同 pattern 再次触发 → 仍 ask
```

**期望**：
- 当前（缺陷）：404；重启前点过 `always` 的 pattern，重启后再次触发仍弹 ask（`approved` 数组在内存，`permission/index.ts:26`）
- 修复后：reply 可达或返回明确状态语义；`always` 规则持久化（如落 `session.permission` 列），重启后同 pattern 不再 ask

---

## 四、多实例路由（说明 + 可选执行）

SaaS 多实例共享 PG 时请求按入口路由。实例 A 上挂起的 question，接入方请求打到实例 B：

```bash
# 可选（组合 3，本地 PG）：起第二个容器共享同一 PG，$BASE2 指向它
QID=$(curl -s "$BASE/question" | jexec "d[0]['id']")
# 对实例 B reply 实例 A 的 question
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BASE2/question/$QID/reply" \
  -H 'Content-Type: application/json' -d '{"answers":[["继续"]]}'
```

**期望**：
- 当前（缺陷）：404（B 的内存 Map 无此条目）——比 pod 重启更高频的触发路径
- 修复后：经 PG 路由回持有等待的实例（PG NOTIFY/轮询），或 reply 幂等落库后由对应实例消费

---

## 验收汇总

| 用例 | 触发动作 | 修复后验收标准 | 当前状态（缺陷） |
|------|---------|--------------|----------------|
| T1.1 异步触发 question | prompt_async + 轮询 | pending=1，sessionID 正确 | —（基线，应 PASS） |
| T1.2 pending 内容 | GET /question | id/session/questions 完整 | —（基线，应 PASS） |
| T1.3 正常 reply 链路 | reply + 轮询 run | run 完成，答案回填，pending 归零 | —（基线，应 PASS） |
| T2.1 重启后清空 | docker restart | pending 保留可恢复 | FAIL：清空 |
| T2.2 reply 404 | reply/reject 旧 ID | 200 或明确状态语义 | FAIL：404 |
| T2.3 PG 无载体 | information_schema / event | 有持久化载体 | FAIL：状态表与事件均不落 PG |
| T2.4 run 悬死 | 消息树 + run 状态 | 明确语义收场 | FAIL：等 stale 接管 30min |
| T2.5 answered-lost 回填 | reply + restart + 补发消息 | 答案回填 part，LLM 可复述 | FAIL：答案丢失 |
| T3.1 permission ask | bash ask 规则 + rm | pending=1 | —（基线，应 PASS） |
| T3.2 重启后 404/always 丢 | restart + reply | 可达 / always 持久化 | FAIL：404 + always 丢 |
| T4.1 多实例 reply（可选） | 双容器共享 PG | 跨实例路由成功 | FAIL：404 |

---

> 复测记录：待首测。本文档为缺陷钉住型用例——T2/T3/T4 系列在修复前**预期 FAIL**，FAIL 即缺陷复现成功；修复后按「修复后验收标准」列复测并回填。
