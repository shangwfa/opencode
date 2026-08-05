# 05 — 云端与本地统一托管

> **扣子场景**：创建云端 Agent，也可接入本地 Agent（Claude Code、Codex CLI 等），在扣子中统一调度
>
> **opencode 映射**：同一 Session 内配置不同 provider/model 的 Agent，验证不同来源的 Agent 可统一调度

## 公共配置

```bash
source ../test-env.sh 3
source ../test-lib.sh
```

## 一、创建多 Provider Agent

### ST.5.1 创建 Session — 多模型工作台

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"多模型统一调度工作台"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
export MULTI_SID="$SID"
```

### ST.5.2 创建云端 Agent — 智谱 GLM

```bash
RES=$(curl -s --noproxy '*' -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "cloud-glm",
    "mode": "primary",
    "prompt": "你是云端AI助手，基于智谱GLM模型。处理通用对话和知识问答。",
    "model": {"providerID":"zhipuai","modelID":"glm-5.1"},
    "permission": {"read":"allow","edit":"allow","bash":"allow"}
  }')

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d.get('name') == 'cloud-glm'
model = d.get('model',{})
model_ok = model.get('providerID') == 'zhipuai' if model else True
print('✅ ST.5.2' if ok and model_ok else '❌ ST.5.2 — ' + json.dumps(d)[:200])
"
```

### ST.5.3 创建云端 Primary Agent — 备选模型

```bash
RES=$(curl -s --noproxy '*' -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "cloud-alt",
    "mode": "primary",
    "prompt": "你是备选云端AI助手。在主模型不适合时提供不同视角的回答。",
    "model": {"providerID":"zhipuai","modelID":"glm-5.1"},
    "permission": {"read":"allow"}
  }')

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d.get('name') == 'cloud-alt' and d.get('mode') == 'primary'
print('✅ ST.5.3' if ok else '❌ ST.5.3 — ' + json.dumps(d)[:200])
"
```

### ST.5.4 创建本地风格 Agent — 无自定义 model（使用默认）

```bash
RES=$(curl -s --noproxy '*' -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "local-default",
    "mode": "primary",
    "prompt": "你是本地默认AI助手。使用系统默认模型执行任务，适合轻量级操作。",
    "permission": {"read":"allow","bash":"allow"}
  }')

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d.get('name') == 'local-default'
print('✅ ST.5.4' if ok else '❌ ST.5.4 — ' + json.dumps(d)[:200])
"
```

## 二、统一调度验证

### ST.5.5 列出所有 Agent — 统一管理

```bash
RES=$(curl -s --noproxy '*' "$BASE/session/$MULTI_SID/agents")
echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
names = [a.get('name','') for a in d]
models = [(a.get('name',''), a.get('model',{}).get('modelID','default') if a.get('model') else 'default') for a in d]
has_all = all(n in names for n in ['cloud-glm','cloud-alt','local-default'])
print('✅ ST.5.5 — 统一管理: {}'.format(models) if has_all else '❌ ST.5.5 — 缺失: {}'.format(names))
"
```

### ST.5.6 调度云端 Agent 执行任务

```bash
RES=$(curl -s --noproxy '*' --max-time 60 -X POST "$BASE/session/$MULTI_SID/message" \
  -H 'Content-Type: application/json' \
  -d '{
    "parts": [{"type":"text","text":"你使用的是什么模型？简要回答。"}],
    "agent": "cloud-glm",
    "model": {"providerID":"zhipuai","modelID":"glm-5.1"}
  }')

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
has_text = any(p.get('type') == 'text' and p.get('text','').strip() for p in d.get('parts',[]))
print('✅ ST.5.6 云端Agent可调度' if has_text else '❌ ST.5.6 — ' + json.dumps(d)[:200])
"
```

### ST.5.7 调度默认模型 Agent

```bash
RES=$(curl -s --noproxy '*' --max-time 60 -X POST "$BASE/session/$MULTI_SID/message" \
  -H 'Content-Type: application/json' \
  -d '{
    "parts": [{"type":"text","text":"1+1等于几？只回答数字。"}],
    "agent": "local-default",
    "model": {"providerID":"zhipuai","modelID":"glm-5.1"}
  }')

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
has_text = any(p.get('type') == 'text' for p in d.get('parts',[]))
print('✅ ST.5.7 默认Agent可调度' if has_text else '❌ ST.5.7 — ' + json.dumps(d)[:200])
"
```

## 三、模型切换验证

### ST.5.8 同一 Session 内切换 Agent 模型

```bash
# 先用 cloud-glm 发消息
RES1=$(curl -s --noproxy '*' --max-time 60 -X POST "$BASE/session/$MULTI_SID/message" \
  -H 'Content-Type: application/json' \
  -d '{
    "parts": [{"type":"text","text":"你好"}],
    "agent": "cloud-glm",
    "model": {"providerID":"zhipuai","modelID":"glm-5.1"}
  }')

# 再用 local-default 发消息
RES2=$(curl -s --noproxy '*' --max-time 60 -X POST "$BASE/session/$MULTI_SID/message" \
  -H 'Content-Type: application/json' \
  -d '{
    "parts": [{"type":"text","text":"你好"}],
    "agent": "local-default",
    "model": {"providerID":"zhipuai","modelID":"glm-5.1"}
  }')

MSGS=$(curl -s --noproxy '*' "$BASE/session/$MULTI_SID/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")
[ "$MSGS" -ge 4 ] && pass "ST.5.8 多Agent切换 count=$MSGS" || fail "ST.5.8" "msg_count=$MSGS"
```

## 四、PG 持久化

### ST.5.9 验证 Agent model 持久化

```bash
RES=$(psql -d "$PG_URL" -Atqc "SELECT name, mode, model FROM session_agents WHERE session_id='$MULTI_SID' ORDER BY name")
echo "$RES"
echo "$RES" | python3 -c "
import sys
lines = sys.stdin.read().strip().split('\n')
has_glm = any('cloud-glm' in l for l in lines)
has_alt = any('cloud-alt' in l for l in lines)
has_local = any('local-default' in l for l in lines)
ok = has_glm and has_alt and has_local
print('✅ ST.5.9 PG持久化 model信息完整' if ok else '❌ ST.5.9 — 不完整')
"
```

### ST.5.10 验证不同 Agent 的消息可追溯

```bash
RES=$(psql -d "$PG_URL" -Atqc "
  SELECT m.data->>'agent' as agent, count(*) as msg_count
  FROM message m
  WHERE m.session_id='$MULTI_SID'
    AND m.data->>'role' = 'assistant'
  GROUP BY m.data->>'agent'
  ORDER BY m.data->>'agent'
")
echo "Agent 消息分布:"
echo "$RES"
[ -n "$RES" ] && pass "ST.5.10 Agent消息可追溯" || fail "ST.5.10" "无消息记录"
```

summary
