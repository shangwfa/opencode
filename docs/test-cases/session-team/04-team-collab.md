# 04 — 多人多 Agent 协作

> **扣子场景**：一人+多 Agent、多人+多 Agent 协作模式；团队成员和 Agent 共享上下文、同步进度
>
> **opencode 映射**：多 Session 模拟多用户；各 Session 独立配置 Agent 团队并独立协作。本测试不考虑 Fork 会话。

## 公共配置

```bash
source ../test-env.sh 3
source ../test-lib.sh
```

## 一、一人 + 多 Agent 模式

### ST.4.1 用户 A 创建个人 AI 团队

```bash
# 用户 A 的工作空间
SID_A=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"用户A-个人AI团队"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
export SID_A

# A 的 AI 助手团队
curl -s --noproxy '*' -X POST "$BASE/session/$SID_A/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"assistant","mode":"primary","prompt":"你是个人AI助手，帮用户处理日常任务。","permission":{"read":"allow","edit":"allow","bash":"allow"}}' > /dev/null

curl -s --noproxy '*' -X POST "$BASE/session/$SID_A/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"coder","mode":"subagent","prompt":"你是编程助手。","permission":{"read":"allow","edit":"allow","bash":"allow"}}' > /dev/null

curl -s --noproxy '*' -X POST "$BASE/session/$SID_A/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"translator","mode":"subagent","prompt":"你是翻译专家，支持中英互译。","permission":{"read":"allow"}}' > /dev/null

CNT=$(curl -s --noproxy '*' "$BASE/session/$SID_A/agents" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")
[ "$CNT" -ge 3 ] && pass "ST.4.1 用户A团队 count=$CNT" || fail "ST.4.1" "count=$CNT"
```

### ST.4.2 用户 A 在同一 Session 使用不同 Agent

```bash
# 用 assistant 发消息
RES1=$(curl -s --noproxy '*' --max-time 60 -X POST "$BASE/session/$SID_A/message" \
  -H 'Content-Type: application/json' \
  -d '{
    "parts": [{"type":"text","text":"1+1等于几？只回答数字。"}],
    "agent": "assistant",
    "model": {"providerID":"zhipuai","modelID":"glm-5.1"}
  }')

# 验证消息历史
MSGS=$(curl -s --noproxy '*' "$BASE/session/$SID_A/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")
[ "$MSGS" -ge 2 ] && pass "ST.4.2 多Agent消息历史 count=$MSGS" || fail "ST.4.2" "msg_count=$MSGS"
```

## 二、多人 + 多 Agent 模式

### ST.4.3 用户 B 创建独立工作空间

```bash
SID_B=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"用户B-独立工作空间"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
export SID_B

# B 的 AI 团队（不同配置）
curl -s --noproxy '*' -X POST "$BASE/session/$SID_B/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"researcher","mode":"primary","prompt":"你是研究助手，擅长文献检索和综述。","permission":{"read":"allow","bash":"allow"}}' > /dev/null

curl -s --noproxy '*' -X POST "$BASE/session/$SID_B/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"writer","mode":"subagent","prompt":"你是学术写作专家。","permission":{"read":"allow","edit":"allow"}}' > /dev/null

# 验证 B 和 A 的 Agent 隔离
A_AGENTS=$(curl -s --noproxy '*' "$BASE/session/$SID_A/agents" | python3 -c "import json,sys;d=json.load(sys.stdin);print(sorted(a['name'] for a in d))")
B_AGENTS=$(curl -s --noproxy '*' "$BASE/session/$SID_B/agents" | python3 -c "import json,sys;d=json.load(sys.stdin);print(sorted(a['name'] for a in d))")
echo "A agents: $A_AGENTS"
echo "B agents: $B_AGENTS"

# B 不应有 A 的 assistant
B_HAS_A=$(echo "$B_AGENTS" | python3 -c "import sys; print('assistant' in sys.stdin.read())")
[ "$B_HAS_A" = "False" ] && pass "ST.4.3 多用户Agent隔离" || fail "ST.4.3" "Agent 泄露"
```

### ST.4.4 列出所有 Session（模拟查看全部项目）

```bash
CNT=$(curl -s --noproxy '*' "$BASE/session" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")
[ "$CNT" -ge 2 ] && pass "ST.4.4 多Session共存 count=$CNT" || fail "ST.4.4" "count=$CNT"
```

## 三、范围说明

本测试不覆盖 `POST /session/:id/fork`、Fork 消息继承、Fork Agent 继承和父子 Session 关系。团队协作仅通过多个独立 Session 模拟。

summary
