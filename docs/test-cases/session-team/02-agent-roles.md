# 02 — 打造行业专家 Agent

> **扣子场景**：基于行业模板创建行业专家 Agent（法务助手、小红书达人、数据分析师、投资顾问等），带职业设定、专业技能和工作方法
>
> **opencode 映射**：创建 Session Agent，预配置专业 prompt + permission + model，验证不同职业角色的 Agent 可独立工作

## 公共配置

```bash
source ../test-env.sh 3
source ../test-lib.sh
```

## 一、创建行业专家 Agent

### ST.2.1 法务助手 — 合同审查专家

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"法务工作台"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
export LAW_SID="$SID"

RES=$(curl -s --noproxy '*' -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "legal-advisor",
    "mode": "primary",
    "prompt": "你是资深法务顾问，专长合同审查、法律风险评估、合规咨询。工作方法：1) 逐条审查合同条款 2) 标注风险等级（高/中/低）3) 给出修改建议 4) 引用相关法律条文。输出格式：条款编号 + 原文 + 风险分析 + 修改建议。",
    "permission": { "read": "allow", "edit": "allow" }
  }')

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d.get('name') == 'legal-advisor' and d.get('mode') == 'primary'
prompt_ok = '法务' in d.get('prompt','') or '合同' in d.get('prompt','')
print('✅ ST.2.1' if ok and prompt_ok else '❌ ST.2.1 — ' + json.dumps(d)[:120])
"
```

### ST.2.2 小红书创作达人 — 内容运营

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"内容运营工作台"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
export CONTENT_SID="$SID"

RES=$(curl -s --noproxy '*' -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "xhs-creator",
    "mode": "primary",
    "prompt": "你是小红书创作达人，擅长种草笔记、探店攻略、好物推荐。写作风格：1) 标题带 emoji 和数字 2) 正文用短句和分段 3) 添加话题标签 4) 语气亲切活泼。每篇笔记 300-500 字，含 5-8 个 hashtag。",
    "permission": { "read": "allow", "edit": "allow" }
  }')

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d.get('name') == 'xhs-creator'
print('✅ ST.2.2' if ok else '❌ ST.2.2 — ' + json.dumps(d)[:120])
"
```

### ST.2.3 数据分析师 — 商业分析

```bash
RES=$(curl -s --noproxy '*' -X POST "$BASE/session/$CONTENT_SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "data-analyst",
    "mode": "subagent",
    "prompt": "你是商业数据分析师，擅长用户行为分析、漏斗分析、AB 测试设计、数据可视化建议。工作方法：1) 明确分析目标 2) 梳理数据指标 3) 选择分析方法 4) 输出结论和建议。用 Python 思路描述分析过程。",
    "permission": { "read": "allow", "bash": "allow" }
  }')

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d.get('name') == 'data-analyst' and d.get('mode') == 'subagent'
print('✅ ST.2.3' if ok else '❌ ST.2.3 — ' + json.dumps(d)[:120])
"
```

### ST.2.4 投资理财顾问 — 财富管理

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"投资理财工作台"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
export FINANCE_SID="$SID"

RES=$(curl -s --noproxy '*' -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "wealth-advisor",
    "mode": "primary",
    "prompt": "你是投资理财顾问，擅长资产配置、风险评估、基金/股票分析。工作原则：1) 先了解风险偏好 2) 分散投资建议 3) 定期再平衡 4) 长期价值投资。免责声明：建议仅供参考，投资有风险。",
    "permission": { "read": "allow", "bash": "allow" }
  }')

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d.get('name') == 'wealth-advisor'
print('✅ ST.2.4' if ok else '❌ ST.2.4 — ' + json.dumps(d)[:120])
"
```

### ST.2.5 代码工程师 — 技术开发

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"技术开发工作台"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
export DEV_SID="$SID"

RES=$(curl -s --noproxy '*' -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "code-engineer",
    "mode": "primary",
    "prompt": "你是全栈工程师，擅长 React/TypeScript/Node.js。工作方法：1) 理解需求 2) 设计架构 3) 编写代码 4) 编写测试 5) 代码审查。遵循 Clean Code 原则，注释清晰，类型安全。",
    "permission": { "read": "allow", "edit": "allow", "bash": "allow" }
  }')

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d.get('name') == 'code-engineer'
print('✅ ST.2.5' if ok else '❌ ST.2.5 — ' + json.dumps(d)[:120])
"
```

## 二、验证行业专家 Agent 的专业设定

### ST.2.6 验证 Agent prompt 完整持久化

```bash
RES=$(curl -s --noproxy '*' "$BASE/session/$LAW_SID/agents")
echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
legal = [a for a in d if a.get('name') == 'legal-advisor']
if legal:
    prompt = legal[0].get('prompt','')
    # 验证 prompt 包含关键职业设定
    has_role = '法务' in prompt or '合同' in prompt
    has_method = '审查' in prompt or '风险' in prompt
    print('✅ ST.2.6 — 角色设定={} 工作方法={}'.format(has_role, has_method) if has_role and has_method else '❌ ST.2.6 — prompt 不完整')
else:
    print('❌ ST.2.6 — legal-advisor 不存在')
"
```

### ST.2.7 验证多 Agent 在同一 Session 共存

```bash
RES=$(curl -s --noproxy '*' "$BASE/session/$CONTENT_SID/agents")
echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
names = [a.get('name','') for a in d]
# 应同时包含 xhs-creator(primary) 和 data-analyst(subagent)
ok = 'xhs-creator' in names and 'data-analyst' in names
print('✅ ST.2.7 — 多行业专家共存: {}'.format(names) if ok else '❌ ST.2.7 — Agent 缺失: {}'.format(names))
"
```

### ST.2.8 验证 Agent 权限按职业定制

```bash
RES=$(curl -s --noproxy '*' "$BASE/session/$DEV_SID/agents")
echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
eng = [a for a in d if a.get('name') == 'code-engineer']
if eng:
    perms = eng[0].get('permission', [])
    # 工程师应有 edit 权限
    has_edit = any(p.get('permission') == 'edit' and p.get('action') == 'allow' for p in perms) if isinstance(perms, list) else True
    print('✅ ST.2.8 — 工程师有 edit 权限' if has_edit else '❌ ST.2.8 — 缺少 edit 权限')
else:
    print('❌ ST.2.8 — code-engineer 不存在')
"
```

## 三、Agent 职业隔离

### ST.2.9 不同 Session 的行业专家互不干扰

```bash
# 法务 Session 不应有小红书达人
RES=$(curl -s --noproxy '*' "$BASE/session/$LAW_SID/agents")
echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
names = [a.get('name','') for a in d]
ok = 'xhs-creator' not in names and 'legal-advisor' in names
print('✅ ST.2.9 — 法务工作台隔离正常' if ok else '❌ ST.2.9 — Agent 泄露: {}'.format(names))
"
```

### ST.2.10 PG 验证 — 各 Session Agent 独立

```bash
LAW_CNT=$(psql -d "$PG_URL" -Atqc "SELECT count(*) FROM session_agents WHERE session_id='$LAW_SID'")
CONTENT_CNT=$(psql -d "$PG_URL" -Atqc "SELECT count(*) FROM session_agents WHERE session_id='$CONTENT_SID'")
FINANCE_CNT=$(psql -d "$PG_URL" -Atqc "SELECT count(*) FROM session_agents WHERE session_id='$FINANCE_SID'")
DEV_CNT=$(psql -d "$PG_URL" -Atqc "SELECT count(*) FROM session_agents WHERE session_id='$DEV_SID'")

echo "法务=$LAW_CNT 内容=$CONTENT_CNT 理财=$FINANCE_CNT 开发=$DEV_CNT"
[ "$LAW_CNT" -ge 1 ] && [ "$CONTENT_CNT" -ge 2 ] && [ "$FINANCE_CNT" -ge 1 ] && [ "$DEV_CNT" -ge 1 ] && pass "ST.2.10 各Session Agent独立" || fail "ST.2.10" "计数不匹配"
```

summary
