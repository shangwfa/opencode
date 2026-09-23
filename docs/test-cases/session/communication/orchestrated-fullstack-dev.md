# 主会话编排：前后端分工开发与联调

> 场景：接收一个前后端开发任务。主会话 A 讨论并分解任务，创建子会话 B（后端）、C（前端）并行开发；B 完成后主动回传 A，A 被唤醒后通知 C 对 B 的接口进行联调，结果最终回传 A。
>
> 运行前先 `source test-env.sh [1|2|3] && source test-lib.sh`。以下用例直接使用 `$BASE`/`$MODEL`。
>
> 相关文档：[`backend-frontend-joint-debug.md`](./backend-frontend-joint-debug.md)（联调细节）、[`read-peer-sandbox.md`](./read-peer-sandbox.md)（跨沙箱读代码）

## 概述：事件驱动的多会话编排

```
任务 ──► A（主会话：讨论 + 分解）
           │
           │ POST /session {"parentID": SID_A}  ×2
           ├─► B（后端）：prompt_async 下发任务 ──► 开发 ──► 起服务 :3000
           │                                    └─► exec curl 回传 A（完成通知）
           └─► C（前端）：prompt_async 下发任务 ──► 开发
                                                  ▲
A 被回传唤醒（自动执行新一轮 LLM）─ prompt_async 契约+代理地址 ─┘
                                                  │
                              C 经 /session/SID_B/proxy/3000 联调 ──► 回传 A
```

**核心机制**：`prompt_async` 不只是投递消息——注入目标会话后会**触发该会话自动执行新一轮 LLM**，即「通知即唤醒」。整个编排无需轮询，靠「任务指令里预埋回传动作」形成事件驱动闭环。

| 能力 | 依赖功能 |
|------|----------|
| 父子关系 | `POST /session` 带 `parentID`，`GET /session/:id/children` 查询 |
| 任务分发 / 完成通知 / 联调指令 | `POST /session/:id/prompt_async` |
| 主动回传（子→父） | 子会话 LLM 用 exec 工具嵌套 curl server API |
| 联调网络 | `/session/:B_id/proxy/:port/*` |

> 产品化说明：本文用例以编排脚本（curl）执行 A 的分解/通知动作保证确定性；产品化时这些 curl 由 A 的 LLM 以 exec/bash 工具自主执行（指令写入 A 的任务描述即可，参考 T21.6 已验证的 LLM 自主模式）。

---

## 前置：创建主会话 A 并分解任务

```bash
source docs/test-cases/test-env.sh 3 && source docs/test-cases/test-lib.sh

SID_A=$(new_sid -kb)
echo "A=$SID_A"

# A 讨论并分解任务（同步对话，回复含分解结论）
curl -s --max-time 120 -X POST "$BASE/session/$SID_A/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"开发任务：用户列表页。后端提供 GET /api/users（返回 {list,total}），前端做列表展示。请给出分工要点（各一句话）"}],"model":'$MODEL'}' \
  | jexec "[p['text'][:150] for p in d['parts'] if p['type']=='text'][0]"
```

**期望**：A 的回复包含后端/前端两侧分工描述

---

### T23.1 A 创建子会话 B（后端）、C（前端）并建立父子关系

> 验证：`POST /session` 带 `parentID` 创建子会话，`GET /session/:id/children` 可查

```bash
SID_B=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d "{\"parentID\":\"$SID_A\",\"title\":\"后端：用户列表接口\"}" | jexec "d['id']")
SID_C=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d "{\"parentID\":\"$SID_A\",\"title\":\"前端：用户列表页\"}" | jexec "d['id']")
for s in $SID_B $SID_C; do
  curl -s -X POST "$BASE/session/$s/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":true,"boot":true}' >/dev/null
done
echo "A=$SID_A B=$SID_B C=$SID_C"

curl -s "$BASE/session/$SID_A/children" | jexec "sorted(x['id'] for x in d)"
```

**期望**：children 返回恰好包含 `SID_B`、`SID_C` 两个会话

### T23.2 A 分发任务：向 B、C 异步注入各自任务

> 验证：`prompt_async` 分别注入 B、C，任务进入两会话消息流并触发各自开发。**B 的任务里预埋「完成后回传 A」的动作指令**（地址已展开为实际 URL）

```bash
export MODEL
NOTIFY_URL="$BASE/session/$SID_A/prompt_async"   # B 完成后回传 A 的地址

TASK_B=$(python3 -c "
import json, os
notify='$NOTIFY_URL'
text=f'''开发后端接口 GET /api/users：在 /workspace/api 写 users.json（内容 {{\\\"list\\\":[{{\\\"id\\\":1,\\\"name\\\":\\\"alice\\\"}}],\\\"total\\\":1}}），并在 :3000 端口起静态服务（python3 -m http.server 3000，后台运行）。
完成后必须执行以下命令向主会话回传（否则主会话不知道你完成了）：
curl -s -X POST {notify} -H 'Content-Type: application/json' -d '{{\"parts\":[{{\"type\":\"text\",\"text\":\"后端就绪：GET /api/users，端口 3000\"}}],\"model\":' + os.environ['MODEL'] + '}}'
最后回复「已回传」。'''
print(json.dumps({'parts':[{'type':'text','text':text}],'model':json.loads(os.environ['MODEL']))})")

TASK_C=$(python3 -c "
import json, os
text='开发前端用户列表页：在 /workspace/web 创建 index.html，预留 fetch 用户数据的代码（API 地址稍后单独通知你），完成后回复「前端骨架完成」。'
print(json.dumps({'parts':[{'type':'text','text':text}],'model':json.loads(os.environ['MODEL']))})")

curl -s -o /dev/null -w "B: %{http_code}\n" --max-time 10 \
  -X POST "$BASE/session/$SID_B/prompt_async" -H 'Content-Type: application/json' -d "$TASK_B"
curl -s -o /dev/null -w "C: %{http_code}\n" --max-time 10 \
  -X POST "$BASE/session/$SID_C/prompt_async" -H 'Content-Type: application/json' -d "$TASK_C"

sleep 90   # 等两侧开发（视模型速度可加长）
curl -s "$BASE/session/$SID_B/message" | jexec "'已回传' in str(d)"
curl -s "$BASE/session/$SID_C/message" | jexec "'前端骨架完成' in str(d)"
```

**期望**：两个 `204`；B 的消息流含「已回传」、C 的含「前端骨架完成」

### T23.3 B 完成后主动回传：A 被唤醒

> 验证：T23.2 预埋的回传命令已执行——A 的消息流出现 B 的完成通知（`prompt_async` 注入即唤醒 A 的新一轮 LLM 执行）

```bash
# A 的消息流中出现 B 的通知
curl -s "$BASE/session/$SID_A/message" | jexec "'后端就绪' in str(d)"

# A 被唤醒后产生了新的 assistant 消息（对通知的响应）
curl -s "$BASE/session/$SID_A/message" | jexec "len([m for m in d if m['role']=='assistant'])"

# B 的服务确实在跑：宿主机经代理验证
curl -s --max-time 15 "$BASE/session/$SID_B/proxy/3000/users.json"
```

**期望**：A 的消息流含「后端就绪」且 assistant 消息数 ≥ 2（分解轮 + 唤醒轮）；代理返回 users.json 内容

### T23.4 A 通知 C 联调（契约 + 代理地址）

> 验证：A（被唤醒的这轮）向 C 注入联调指令，含 B 的接口契约与代理地址。脚本模式直接注入；产品化时由 A 的 LLM 自主执行等价 curl

```bash
TASK_JOINT=$(python3 -c "
import json, os
base='$BASE'; b='$SID_B'
text=f'''后端已就绪，开始联调：
1. 读取你 /workspace/web/index.html，把 fetch 的 API 地址改为：{base}/session/{b}/proxy/3000/users.json
2. 用 exec 执行 curl -s {base}/session/{b}/proxy/3000/users.json 验证连通
3. 回复联调结论（HTTP 状态 + 返回体摘要）'''
print(json.dumps({'parts':[{'type':'text','text':text}],'model':json.loads(os.environ['MODEL']))})")

curl -s -o /dev/null -w "C: %{http_code}\n" --max-time 10 \
  -X POST "$BASE/session/$SID_C/prompt_async" -H 'Content-Type: application/json' -d "$TASK_JOINT"

sleep 90
curl -s "$BASE/session/$SID_C/message" | jexec "str(d)[-600:]"
```

**期望**：`204`；C 的最新回复含 `200` 及 `alice`/`total`（C 自主完成了「改代码 → 经代理调 B 接口 → 汇报」）

### T23.5 闭环：C 联调结果回传 A

> 验证：与 T23.2 相同的回传机制用于 C → A，编排闭环完成

```bash
RESULT=$(curl -s "$BASE/session/$SID_C/message" | jexec "
[last['parts'][0]['text'][:200] for last in [m for m in d if m['role']=='assistant'][-1:]][0]")

curl -s -o /dev/null -w "C→A: %{http_code}\n" --max-time 10 \
  -X POST "$BASE/session/$SID_A/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"前端联调完成：$RESULT\"}],\"model\":$MODEL}"

sleep 45
curl -s "$BASE/session/$SID_A/message" | jexec "'联调完成' in str(d)"
```

**期望**：`204`；A 的消息流出现「联调完成」及 C 的结论——主会话掌握全流程结果

---

## B/C 如何感知 A 的存在

B/C 的 LLM 只能看到自己上下文里的信息，「感知 A」分两层实现：

**语义层（推荐，零成本）**——A 注入任务时把身份信息写进消息文本：

```bash
# A 给 B 的任务消息里自我介绍 + 署名（userName 显示在 B 的消息流中）
curl -s -X POST "$BASE/session/$SID_B/prompt_async" -H 'Content-Type: application/json' -d '{
  "parts":[{"type":"text","text":"你是本任务的「后端子会话」。我是主会话（编排者），负责分解任务和协调联调；另有「前端子会话」并行开发，联调阶段由我通知你。你的任务是：…完成后向主会话回传…"}],
  "model":'$MODEL',
  "userName":"主会话A",
  "userId":"'"$SID_A"'"
}' 
```

- `userName`/`userId` 是消息级属性：B 的 LLM 看到的每条来自 A 的消息都带「主会话A」署名（`userId` 存 sessionID 可反查）
- 预埋的回传命令本身就是 A 存在的运行时证明（B 执行 curl 时若 A 不存在会 404）

**数据层（结构化查询）**——B 的 LLM 用 exec curl 主动查询：

```bash
# 1. 查自己：从返回的 parentID 知道父会话是谁
curl -s $BASE/session/$SID_B | jexec "d['parentID']"
# 2. 查父的 children：发现父 + 兄弟会话（含创建时 A 起的标题）
curl -s $BASE/session/$SID_A/children | jexec "[(x['id'], x['title']) for x in d]"
# 3. 全局列表兜底：同 project 全部会话
curl -s $BASE/session | jexec "[(x['id'], x['title']) for x in d]"
```

**约定固化**：若希望 B/C 无需每次注入都自我介绍，可把编排约定写入项目 `AGENTS.md`（同 project 会话共享），声明「本项目采用主会话编排模式，子会话收到任务后须向主会话回传结果」。

## 编排要点

1. **「通知即唤醒」是编排核心**：`prompt_async` 注入即触发目标会话新一轮 LLM，无需轮询驱动；脚本轮询 `GET /session/status` 仅作为兜底（B/C 卡住时）
2. **回传动作必须预埋进任务指令**：子会话没有「主动通知父会话」的内建语义，靠任务描述里写明回传命令（exec curl prompt_async）
3. **地址在注入时展开**：任务消息里的 `$BASE`/sessionID 在生成 JSON 时就替换为实际 URL，子会话 LLM 无需知道变量
4. **串行化保护**：向同一会话连续注入多条任务会排队执行；需要 B 先于 C 的顺序保证时，等 B 的回传到达后再给 C 注入下一阶段任务

## 已知坑

- **sleep 时长依赖模型速度**：本地 key 余额不足返回 429，表现为会话挂死——先查余额；权威判断用 `GET /session/status` 轮询替代固定 sleep
- **子会话沙箱回收**：长开发流程中 B/C 空闲超阈值会被回收（服务丢失）——用例用 keep-alive 规避；生产编排对长任务子会话开启 keep-alive
- **A 的消息流膨胀**：每次回传都是一条 user + 一条 assistant 消息，长流程注意 A 的上下文长度（可用 `POST /session/:id/summarize` 压缩）
- **消息排序勿按 ID**：断言「最新回复」依赖接口返回顺序（如本文件 jexec 取法），勿按消息 ID 字典序

## 复测记录

| 日期 | 组合 | 用例 | 结果 | 备注 |
|------|------|------|------|------|
| | | | | |
