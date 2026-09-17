# 会话间通信：前后端跨会话联调

> 场景：会话 A（后端项目）开发完成接口后，会话 B（前端项目）获取接口契约、经跨沙箱代理对接 A 的后端服务并联调，问题/结果回传 A。
>
> 运行前先 `source test-env.sh [1|2|3] && source test-lib.sh`。以下用例直接使用 `$BASE`/`$MODEL`。
>
> 跨沙箱代理机制见 [`../../sandbox/sandbox-proxy-endpoint.md`](../../sandbox/sandbox-proxy-endpoint.md)。

## 概述

本场景的「会话间通信」由三条通道组成，全部基于现有功能，无需新增代码：

| 通道 | 问题 | 依赖功能 |
|------|------|----------|
| 信息流 | 接口契约 A→B、联调反馈 B→A | `POST /session/:id/prompt_async`（异步注入）、`POST /session/:id/message`（同步问答）、`GET /session/:id/message`（读取） |
| 网络流 | B 运行时请求 A 沙箱内的后端服务 | `/session/:A_id/proxy/:port/*` 通配代理（HTTP/WS） |
| 状态流 | B 是否空闲 / A 是否完成 | `GET /session/status` |

**流程**：

```
A 开发完成 → prompt_async 契约给 B → B 配置 API base 指向
/session/A_id/proxy/3000 → B 联调验证 → 问题经 prompt_async 回传 A → A 修复 → B 重测
```

**注意**：沙箱内 curl `$BASE` 需沙箱可出网访问该地址（组合 1/3 远端沙箱通常可达；组合 2 本地沙箱将 `$BASE` 换成 `http://host.docker.internal:4096` 等可达地址）。

---

## 前置：创建 A/B 两个会话

```bash
source docs/test-cases/test-env.sh 3 && source docs/test-cases/test-lib.sh

SID_A=$(new_sid -kb)   # A：后端，boot 沙箱
SID_B=$(new_sid -kb)   # B：前端，boot 沙箱
echo "A=$SID_A B=$SID_B"
```

**期望**：两个不同 sessionID，沙箱 boot 成功

---

### T21.1 A→B：prompt_async 注入接口契约

> 验证：A 完成开发后，可向 B 异步注入契约消息（204 接纳语义），消息进入 B 的消息流

```bash
CONTRACT='后端接口已就绪，请对接：GET /api/users?page=1 返回 {list,total}。API base 使用 http://'"$BASE"'/session/'"$SID_A"'/proxy/3000'

STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  -X POST "$BASE/session/$SID_B/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"$CONTRACT\"}],\"model\":$MODEL}")
echo "prompt_async: $STATUS"

# B 执行完成后检查契约已入 B 的消息流（视模型速度 sleep 30~60）
sleep 45
curl -s "$BASE/session/$SID_B/message" | jexec "len([m for m in d if m['role']=='user'])"
```

**期望**：`prompt_async` 返回 `204`；B 的消息列表中 user 消息数 ≥ 1，内容含接口契约

### T21.2 A 询问 B：同步驱动并取回结果

> 验证：同步 `POST /session/:id/message` 阻塞至 B 的 LLM 回复，响应即 B 的结果（`ask_session` 工具的服务端等价路径）

```bash
RESULT=$(curl -s --max-time 120 -X POST "$BASE/session/$SID_B/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用一句话汇报你当前的对接任务状态"}],"model":'$MODEL'}')
echo "$RESULT" | jexec "[p['text'] for p in d['parts'] if p['type']=='text'][0][:100]"
```

**期望**：响应为 assistant 消息，text 含任务状态描述；该消息追加进 B 的历史（后续轮次可追溯）

### T21.3 状态流：发送前查询目标会话状态

> 验证：`GET /session/status` 可判断 B 是否空闲，避免向执行中的会话注入消息（挂锁等待）

```bash
# B 空闲时查询
curl -s "$BASE/session/status" | jexec "d['$SID_B']"

# 注入长任务后再查（后台执行中）
curl -s -o /dev/null -X POST "$BASE/session/$SID_B/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"逐行解释 /etc/os-release 每个字段的含义"}],"model":'$MODEL'}'
sleep 5
curl -s "$BASE/session/status" | jexec "d['$SID_B']"
sleep 60   # 等长任务结束
```

**期望**：空闲时状态为 idle 类；执行中为 busy/active 类非 idle 值（字段结构以 `SessionStatus` 实现为准）

### T21.4 B→A：联调结果回传

> 验证：B 侧执行结果可反向注入 A，A 的消息流中出现回传内容

```bash
FEEDBACK='联调结果：GET /api/users 返回 200，total=42，对接完成。'
STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  -X POST "$BASE/session/$SID_A/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"$FEEDBACK\"}],\"model\":$MODEL}")
echo "prompt_async: $STATUS"

sleep 45
curl -s "$BASE/session/$SID_A/message" | jexec "'联调结果' in str(d)"
```

**期望**：`204`；A 的消息流（user 消息及其后 assistant 响应）中包含「联调结果」

### T21.5 网络流：B 经 proxy 访问 A 沙箱内的后端服务

> 验证：A 沙箱内起"后端服务"（http.server 模拟 `GET /api/users`），B 的 LLM 经 `/session/$SID_A/proxy/3000/` 调通接口——跨沙箱运行时链路成立

```bash
# 1. A 沙箱内起模拟后端：:3000 返回固定 JSON
curl -s --max-time 30 -X POST "$BASE/session/$SID_A/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"mkdir -p /workspace/api && printf \"{\\\"list\\\":[{\\\"id\\\":1,\\\"name\\\":\\\"alice\\\"}],\\\"total\\\":42}\" > /workspace/api/users.json && cd /workspace/api && (python3 -m http.server 3000 >/dev/null 2>&1 &) && sleep 1 && curl -s http://localhost:3000/users.json"}' \
  | jexec "d['stdout'].strip()"

# 2. B 沙箱内（前端视角）经 server proxy 调 A 的接口
curl -s --max-time 30 -X POST "$BASE/session/$SID_B/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"curl -s --max-time 15 http://'"$BASE"'/session/'"$SID_A"'/proxy/3000/users.json"}' \
  | jexec "d['stdout'].strip()"

# 3. 宿主机直接验证代理（不依赖沙箱出网）
curl -s --max-time 15 "$BASE/session/$SID_A/proxy/3000/users.json"
```

**期望**：三处均输出 `{"list":[{"id":1,"name":"alice"}],"total":42}`；A 沙箱重启服务后代理 target 在 TTL(10s) 内自动恢复，无需干预

### T21.6 端到端：契约传递 → B 联调 → 结果回传（完整场景）

> 验证：全链路编排。A 写接口文件并起服务 → prompt_async 通知 B（契约 + 代理地址）→ B 的 LLM 自主读契约、经 proxy 调接口并汇报 → 结果回传 A

```bash
# 1. A 侧：生成"接口文档"（模拟 A 开发完成）
curl -s --max-time 60 -X POST "$BASE/session/$SID_A/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"printf \"GET /users.json -> {list,total}\\n\" > /workspace/api/API.md && cat /workspace/api/API.md"}' \
  | jexec "d['stdout'].strip()"   # 依赖 T21.5 的服务已起

# 2. A→B：注入契约消息，让 B 的 LLM 自主联调
export MODEL   # 确保 test-env.sh 的 model 片段可被 python 读取
MSG=$(python3 -c "
import json, os
base='$BASE'; a='$SID_A'
text=f'''后端接口已就绪。请完成联调：
1. 读取接口文档: curl -s {base}/session/{a}/proxy/3000/API.md
2. 调用文档中的接口验证返回（API base = {base}/session/{a}/proxy/3000）
3. 把联调结论（HTTP 状态 + 返回体摘要）作为你的最终回复'''
print(json.dumps({'parts':[{'type':'text','text':text}],'model':json.loads(os.environ['MODEL'])}))")
curl -s -o /dev/null -w "prompt_async: %{http_code}\n" --max-time 10 \
  -X POST "$BASE/session/$SID_B/prompt_async" -H 'Content-Type: application/json' -d "$MSG"

# 3. 等 B 的 LLM 完成联调（视模型速度 sleep 60~120），取 B 的最终回复
sleep 90
B_REPLY=$(curl -s "$BASE/session/$SID_B/message" | jexec "
[last['parts'][0]['text'][:200] for last in [m for m in d if m['role']=='assistant'][-1:]][0]")
echo "B 回复: $B_REPLY"

# 4. B→A：回传结论
curl -s -o /dev/null -w "feedback: %{http_code}\n" --max-time 10 \
  -X POST "$BASE/session/$SID_A/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"前端联调完成：$B_REPLY\"}],\"model\":$MODEL}"
sleep 45
curl -s "$BASE/session/$SID_A/message" | jexec "'联调完成' in str(d)"
```

**期望**：B 的回复中包含 `200` 及 `alice`/`total` 等接口返回内容（证明 B 自主完成了「读契约 → 经 proxy 调 A 接口 → 汇报」）；A 的消息流中出现「联调完成」回传

> **扩展**：A 直接读取 B 沙箱代码（不经 B 的 LLM）的两种方式见 [`read-peer-sandbox.md`](./read-peer-sandbox.md)。

---

## 已知坑

- **消息排序勿按 ID**：消息 ID 前缀是时间编码，跨回绕边界后字典序翻转；断言「最后一条」应依赖接口返回顺序或 `time_created`
- **A 沙箱被回收**：空闲回收后 proxy 返回 "sandbox unreachable"，需先 keep-alive/唤醒 A 再联调（T21.5/21.6 前置用了 `-kb` boot + keepAlive 规避）
- **B 忙时注入排队**：`prompt_async` 在 B 执行中注入会排队而非拒绝；需要快速失败语义时先按 T21.3 查状态
- **模型余额**：本地 API key 余额不足返回 429，表现为消息挂死——先查余额

## 复测记录

| 日期 | 组合 | 用例 | 结果 | 备注 |
|------|------|------|------|------|
| | | | | |
