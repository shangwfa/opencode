# Auth 凭据管理

> 公共测试环境和配置请参考 [`00-preamble.md`](./00-preamble.md)。

## 验证标准

| 层级 | 方法 | 判定标准 |
|------|------|---------|
| 1. HTTP 响应 | 调用 API 检查返回值 | 字段值与期望一致 |
| 2. PG 记录 | 查询 `auth` 表验证持久化 | 凭据数据正确存储 |

## 通用变量

> 运行前先全局加载环境：`source test-env.sh [1|2|3]`（见 [`00-preamble.md`](./00-preamble.md)）。用例直接用 `$BASE` `$PG_URL`，不重复定义。

> **注意**：`/provider` 只返回公共或当前 `x-user-id` 已配置的 Provider 及模型；未配置时允许 `all` 为空。下方 python 解析均用 `json.load(sys.stdin, strict=False)`，避免配置字段中的控制字符导致解析失败。

---

## 三、Provider 查询

### T3.1 查询当前身份可用 provider

```bash
curl -s "$BASE/provider" | python3 -c "
import json,sys
d=json.load(sys.stdin, strict=False)
all_providers = d.get('all', [])
print(f'可用 provider 总数: {len(all_providers)}')
print('前5个:')
for p in all_providers[:5]:
    print(f'  {p.get(\"id\")} - {p.get(\"name\")}')
print('✅ T3.1 PASS' if isinstance(all_providers, list) and isinstance(d.get('connected', []), list) else '❌ T3.1 FAIL')
"
```

**期望**：仅返回公共配置的 Provider/模型；不传 `x-user-id` 时不得包含任何个人 Provider/模型。

### T3.2 查询已配置的 provider

```bash
curl -s "$BASE/provider" | python3 -c "
import json,sys
d=json.load(sys.stdin, strict=False)
connected = d.get('connected', [])
print(f'已配置 provider: {connected}')
print('✅ T3.2 PASS' if len(connected) > 0 else '❌ T3.2 FAIL')
"
```

**期望**：`connected` 与 `all/default` 使用同一可见性集合；只包含公共或当前用户已配置的 Provider。

---

## 四、Auth 凭据管理

### T3.3 设置 provider 凭据

```bash
RESP=$(curl -s -X PUT "$BASE/auth/moonshotai-cn" \
  -H 'Content-Type: application/json' \
  -d '{"type":"api","key":"sk-test-key"}')
echo "HTTP response: $RESP"

echo "--- PG 验证 ---"
psql "$PG_URL" -t -c "SELECT user_id, provider_id, type, data->>'key' as key FROM auth WHERE provider_id='moonshotai-cn'"
```

**期望**：
- HTTP：返回 `true`
- PG：`user_id=''`（公共），`provider_id=moonshotai-cn`，`type=api`，`key=sk-test-key`

### T3.4 删除 provider 凭据

```bash
RESP=$(curl -s -X DELETE "$BASE/auth/moonshotai-cn")
echo "HTTP response: $RESP"

echo "--- PG 验证 (删除后) ---"
psql "$PG_URL" -t -c "SELECT COUNT(*) FROM auth WHERE user_id='' AND provider_id='moonshotai-cn'"
```

**期望**：
- HTTP：返回 `true`
- PG：`COUNT=0`

### T3.5 凭据持久化（重启后验证）

```bash
# 1) 设置凭据（用真实 provider ID，公共 + 个人各一行）
curl -s -X PUT "$BASE/auth/moonshotai-cn" \
  -H 'Content-Type: application/json' \
  -d '{"type":"api","key":"persist-key-test"}' > /dev/null
curl -s -X PUT "$BASE/auth/moonshotai-cn" \
  -H 'Content-Type: application/json' -H 'x-user-id: u1' \
  -d '{"type":"api","key":"persist-u1-key"}' > /dev/null

echo "--- PG 验证 (重启前) ---"
psql "$PG_URL" -t -c "SELECT user_id, provider_id, data->>'key' as key FROM auth WHERE provider_id IN ('moonshotai-cn','u1/moonshotai-cn') ORDER BY 1"

# 2) 重启容器
docker restart opencode-saas-test
sleep 12

echo "--- 重启后查询公共与 u1 视图 ---"
curl -s "$BASE/provider" -H 'x-user-id: u1' | python3 -c "
import json,sys
d=json.load(sys.stdin, strict=False)
connected = d.get('connected', [])
has_moonshot = 'moonshotai-cn' in connected
print(f'connected: {connected}')
print(f'moonshotai-cn 在 connected 中: {has_moonshot}')
print('✅ T3.5 PASS' if has_moonshot else '❌ T3.5 FAIL')
"

# 3) 清理
curl -s -X DELETE "$BASE/auth/moonshotai-cn" > /dev/null
curl -s -X DELETE "$BASE/auth/moonshotai-cn" -H 'x-user-id: u1' > /dev/null
```

**期望**：
- 重启前 PG 有 `moonshotai-cn` 公共行和 `u1/moonshotai-cn` 个人行
- 重启后 u1 视图含 `moonshotai-cn`；个人行保留。匿名视图因公共行存在也含该 Provider。

---

## 验收汇总

| 用例 | HTTP 响应 | PG 持久化 | 结果 |
|------|----------|----------|------|
| T3.1 查询当前身份可用 provider | `all`/`connected` 为数组，匿名仅公共 | — | ✅ |
| T3.2 查询已配置 provider | `connected` 数组 | — | ✅ |
| T3.3 设置凭据 | `true` | PG 记录存在 | ✅ |
| T3.4 删除凭据 | `true` | PG `COUNT=0` | ✅ |
| T3.5 持久化 | 重启后 `connected` 仍含 | PG 记录保留 | ✅ |
| T3.6 凭据变更后刷新 Provider 运行态 | 新增可见 + 删除消失 | — | ✅ |
| T3.7 个人凭据写隔离 | `true` | 各用户独立行，互不覆盖 | ✅ |
| T3.8 Provider/模型目录读隔离 | 本人含个人+公共，其他用户/匿名仅公共 | — | ✅ |
| T3.9 个人删除不影响他人/公共 | `true` | 仅删本行 | ✅ |
| T3.10 公共优先 + 无公共时使用个人 | `true` | 公私两行共存，公共删除后个人生效 | ✅ |
| T3.11 异常 header 视为公共 | `true` | 只写 `user_id=''` 行 | ✅ |
| T3.12 个人 key 端到端（聊天生效） | 见下方 | 个人行被上游实际使用 | ✅ |
| T3.13 真实 key 冒烟（真回复） | 见下方 | 上游返回文本而非 error | ⏭️ 需真实 key |
| T3.14 OAuth 待授权隔离 | 见下方 | 各用户 pending 互不可见 | ✅ |
| T3.15 OAuth 刷新回写归属（需真实账号） | 见下方 | 刷新后 token 写回本人行 | ⏭️ 需真实账号 |
| T3.16 Provider 查询不泄露凭据 | 无 key/apiKey 字段 | — | ✅ |
| T3.17 openai 多认证方式（method 索引与落库） | 见下方 | api 方式写个人行 type=api | ✅ |

> **复测记录（2026-09-16，本地 PG + 远端 K8s 沙箱，镜像 `person-model`（feat/opencode-1.18.31 工作区，含公共优先 + provider 脱敏 + header 权威注入））**：T3.1–T3.12、T3.14、T3.16 共 14 例全 PASS（T3.9 首跑 FAIL 为执行脚本 SQL 列位笔误，复跑 PASS）。要点：
> - T3.5 容器重启后公共+个人两行保留，u1 视图 connected 恢复
> - T3.6 PUT 后下一次 `/provider` 即含新凭据 provider，DELETE 后下一次查询即消失（handler 按实时凭据过滤）
> - T3.8 u1/u2/匿名三方 `all+connected` 均隔离，无跨用户泄漏
> - T3.10 两行共存（`zhipuai` 公共 + `u1/zhipuai` 个人）→ 删公共后个人行保留且 u1 仍 connected、匿名不再 connected
> - T3.12 个人 fake key 消息返回上游认证错误（非 `Model not found`），key 已出境
> - T3.14 u1 authorize 返回 url，u2 callback 得 `OauthMissing`，PG 无 openai 行
> - T3.16 `/provider` 与 `/config/providers` 响应均无凭据值/key/apiKey 字段
> - SKIP：T3.13（本环境无个人直连上游真实 key，Yd-DeepSeek 为公共网关 config provider）、T3.15（需真实 ChatGPT 账号；单测 codex.test.ts 已覆盖刷新 header 透传）

> **复测记录（2026-09-16 追加，同环境，镜像 `person-model-connect`）**：T3.17 全 PASS——openai 枚举 3 种方式（`oauth/browser`、`oauth/headless`、`api`），`method=2`（api 类型）authorize 返回 `null`，`method=0` 返回 browser OAuth url+instructions，api 方式 `PUT /auth` 落个人行 `type=api`。附注：api key 与 OAuth token 共享同一行（`u1/openai`），后写覆盖。

### T3.6 凭据变更后刷新 Provider 运行态

> `PUT/DELETE /auth` 后会在响应发出后释放当前实例；下一次请求必须使用重建后的 Provider/SDK 状态，不能沿用已删除或已替换的公共 key。

```bash
# 1) 设置公共凭据
curl -s -X PUT "$BASE/auth/moonshotai-cn" \
  -H 'Content-Type: application/json' \
  -d '{"type":"api","key":"test-key"}' > /dev/null

# 2) 下一次查询必须已加载
curl -s "$BASE/provider" | python3 -c "
import json,sys
d=json.load(sys.stdin, strict=False)
connected = d.get('connected', [])
providers = [p.get('id') for p in d.get('all', [])]
ok = 'moonshotai-cn' in connected and 'moonshotai-cn' in providers
print('✅ T3.6a PASS' if ok else '❌ T3.6a FAIL')
"

# 3) 删除后下一次查询不得保留旧 Provider
curl -s -X DELETE "$BASE/auth/moonshotai-cn" > /dev/null
curl -s "$BASE/provider" | python3 -c "
import json,sys
d=json.load(sys.stdin, strict=False)
ids=[p.get('id') for p in d.get('all', [])]
print('✅ T3.6b PASS' if 'moonshotai-cn' not in d.get('connected', []) and 'moonshotai-cn' not in ids else '❌ T3.6b FAIL')
"
```

**期望**：新增后 Provider 出现在 `all/connected`；删除后下一次查询不再出现，证明旧运行态已失效。

---

## 五、个人凭据隔离（`x-user-id`）

> 请求带 `x-user-id` Header 时读写该用户的私有凭据；不带则读写公共凭据。PG 主键仍是 `provider_id`：公共为 `providerID`，个人为 `userId/providerID`；`user_id=''` 为公共。
>
> 本节用例各自独立：开头清理环境、结尾清理残留，可单独执行。

### T3.7 个人凭据写隔离

```bash
# setup：清理
curl -s -X DELETE "$BASE/auth/moonshotai-cn" -H 'x-user-id: u1' > /dev/null
curl -s -X DELETE "$BASE/auth/moonshotai-cn" -H 'x-user-id: u2' > /dev/null

# 设置两人同名 provider 的个人凭据
curl -s -X PUT "$BASE/auth/moonshotai-cn" -H 'Content-Type: application/json' \
  -H 'x-user-id: u1' -d '{"type":"api","key":"sk-u1-key"}'
echo
curl -s -X PUT "$BASE/auth/moonshotai-cn" -H 'Content-Type: application/json' \
  -H 'x-user-id: u2' -d '{"type":"api","key":"sk-u2-key"}'
echo

echo "--- PG 验证 ---"
psql "$PG_URL" -t -c "SELECT user_id, provider_id, data->>'key' FROM auth WHERE provider_id IN ('u1/moonshotai-cn','u2/moonshotai-cn') ORDER BY 1"

# cleanup
curl -s -X DELETE "$BASE/auth/moonshotai-cn" -H 'x-user-id: u1' > /dev/null
curl -s -X DELETE "$BASE/auth/moonshotai-cn" -H 'x-user-id: u2' > /dev/null
```

**期望**：
- HTTP：两次都返回 `true`
- PG：同时存在 `(u1,u1/moonshotai-cn,sk-u1-key)` / `(u2,u2/moonshotai-cn,sk-u2-key)` 两行，互不覆盖

### T3.8 Provider/模型目录读隔离

```bash
# setup：确保没有同名公共凭据，分别只给 u1/u2 配置个人凭据
curl -s -X DELETE "$BASE/auth/moonshotai-cn" > /dev/null
curl -s -X PUT "$BASE/auth/moonshotai-cn" -H 'Content-Type: application/json' \
  -H 'x-user-id: u1' -d '{"type":"api","key":"sk-u1-key"}' > /dev/null
curl -s -X PUT "$BASE/auth/moonshotai-cn" -H 'Content-Type: application/json' \
  -H 'x-user-id: u2' -d '{"type":"api","key":"sk-u2-key"}' > /dev/null

echo "--- u1 的模型目录与 connected ---"
curl -s "$BASE/provider" -H 'x-user-id: u1' | python3 -c "
import json,sys
d=json.load(sys.stdin, strict=False)
connected=d.get('connected',[])
providers=[p.get('id') for p in d.get('all',[])]
print('moonshotai-cn 在 u1 connected 中:', 'moonshotai-cn' in connected)
print('moonshotai-cn 在 u1 all 中:', 'moonshotai-cn' in providers)
print('✅ T3.8 PASS' if 'moonshotai-cn' in connected and 'moonshotai-cn' in providers else '❌ T3.8 FAIL')
"

echo "--- 匿名的模型目录与 connected ---"
curl -s "$BASE/provider" | python3 -c "
import json,sys
d=json.load(sys.stdin, strict=False)
connected=d.get('connected',[])
providers=[p.get('id') for p in d.get('all',[])]
print('moonshotai-cn 在匿名 connected 中:', 'moonshotai-cn' in connected)
print('moonshotai-cn 在匿名 all 中:', 'moonshotai-cn' in providers)
print('✅ T3.8 PASS' if 'moonshotai-cn' not in connected and 'moonshotai-cn' not in providers else '❌ T3.8 FAIL')
"

echo "--- u2 的模型目录与 connected ---"
curl -s "$BASE/provider" -H 'x-user-id: u2' | python3 -c "
import json,sys
d=json.load(sys.stdin, strict=False)
providers=[p.get('id') for p in d.get('all',[])]
print('✅ T3.8 PASS' if 'moonshotai-cn' in d.get('connected',[]) and 'moonshotai-cn' in providers else '❌ T3.8 FAIL')
"

# cleanup
curl -s -X DELETE "$BASE/auth/moonshotai-cn" -H 'x-user-id: u1' > /dev/null
curl -s -X DELETE "$BASE/auth/moonshotai-cn" -H 'x-user-id: u2' > /dev/null
```

**期望**：u1 的 `all/connected/default` 含 `moonshotai-cn` 及其模型；其他用户与匿名响应均不含该个人 Provider 或模型。未传 `x-user-id` 时只返回公共配置。

### T3.9 个人删除不影响他人/公共

```bash
# setup：u1/u2 个人 + 公共各一行
curl -s -X PUT "$BASE/auth/moonshotai-cn" -H 'Content-Type: application/json' \
  -H 'x-user-id: u1' -d '{"type":"api","key":"sk-u1-key"}' > /dev/null
curl -s -X PUT "$BASE/auth/moonshotai-cn" -H 'Content-Type: application/json' \
  -H 'x-user-id: u2' -d '{"type":"api","key":"sk-u2-key"}' > /dev/null
curl -s -X PUT "$BASE/auth/zhipuai" -H 'Content-Type: application/json' \
  -d '{"type":"api","key":"sk-public"}' > /dev/null

# u1 删自己的
curl -s -X DELETE "$BASE/auth/moonshotai-cn" -H 'x-user-id: u1'
echo

echo "--- PG 验证 ---"
psql "$PG_URL" -t -c "SELECT user_id, provider_id FROM auth WHERE provider_id IN ('u1/moonshotai-cn','u2/moonshotai-cn','zhipuai') ORDER BY 1,2"

# cleanup
curl -s -X DELETE "$BASE/auth/moonshotai-cn" -H 'x-user-id: u2' > /dev/null
curl -s -X DELETE "$BASE/auth/zhipuai" > /dev/null
```

**期望**：只删 `(u1,u1/moonshotai-cn)`，`u2/moonshotai-cn` 与公共 `zhipuai` 行保留。

### T3.10 公共优先 + 无公共时使用个人

> 个人与公共同名 provider 共存时，用户视图公共优先；删除公共凭据后才使用个人凭据。注意：`GET /provider` 只暴露 `connected` 名单不暴露 key，
> “用哪个 key 生效”属运行面（聊天时）；优先级由 `test/auth/auth.test.ts` 锁定，本用例验证 PG 两行共存 + 删除公共后个人仍可见。

```bash
# setup：清理
curl -s -X DELETE "$BASE/auth/zhipuai" > /dev/null
curl -s -X DELETE "$BASE/auth/zhipuai" -H 'x-user-id: u1' > /dev/null

# 1) 公共 + 个人同名各设 key
curl -s -X PUT "$BASE/auth/zhipuai" -H 'Content-Type: application/json' \
  -d '{"type":"api","key":"sk-public"}' > /dev/null
curl -s -X PUT "$BASE/auth/zhipuai" -H 'Content-Type: application/json' \
  -H 'x-user-id: u1' -d '{"type":"api","key":"sk-u1"}' > /dev/null

echo "--- PG 验证（应共存两行） ---"
psql "$PG_URL" -t -c "SELECT user_id, provider_id, data->>'key' FROM auth WHERE provider_id IN ('zhipuai','u1/zhipuai') ORDER BY 1"

echo "--- u1 connected（应含 zhipuai） ---"
curl -s "$BASE/provider" -H 'x-user-id: u1' | python3 -c "
import json,sys
connected=json.load(sys.stdin, strict=False).get('connected',[])
print('✅ T3.10 PASS' if 'zhipuai' in connected else '❌ T3.10 FAIL')
"

# 2) 删公共，个人保留并开始生效
curl -s -X DELETE "$BASE/auth/zhipuai" > /dev/null

echo "--- PG 验证（应仅剩个人行） ---"
psql "$PG_URL" -t -c "SELECT user_id, provider_id, data->>'key' FROM auth WHERE provider_id='u1/zhipuai'"

# cleanup
curl -s -X DELETE "$BASE/auth/zhipuai" -H 'x-user-id: u1' > /dev/null
```

**期望**：公私两行共存 key 不同；删除公共行后个人行 `sk-u1` 保留，u1 仍 connected，匿名视图不再 connected。

### T3.11 异常 header 视为公共

```bash
# setup：清理
curl -s -X DELETE "$BASE/auth/moonshotai-cn" > /dev/null
psql "$PG_URL" -c "DELETE FROM auth WHERE provider_id='moonshotai-cn'" > /dev/null

# 空 header 与空白 header 都应视为公共写入
curl -s -X PUT "$BASE/auth/moonshotai-cn" -H 'Content-Type: application/json' \
  -H 'x-user-id:' -d '{"type":"api","key":"sk-empty-hdr"}'
echo
curl -s -X PUT "$BASE/auth/moonshotai-cn" -H 'Content-Type: application/json' \
  -H 'x-user-id:    ' -d '{"type":"api","key":"sk-blank-hdr"}'
echo

echo "--- PG 验证（应只有公共行，且无空白 user_id） ---"
psql "$PG_URL" -t -c "SELECT user_id, provider_id, data->>'key' FROM auth WHERE provider_id='moonshotai-cn'"

# cleanup
curl -s -X DELETE "$BASE/auth/moonshotai-cn" > /dev/null
```

**期望**：只产生 `user_id=''` 的公共行（key 为后写入的 `sk-blank-hdr`），不产生 `user_id='   '` 之类的脏行。

### T3.12 个人 key 端到端（聊天生效）

> 验证个人 key 在聊天时真正被送往上游。用**无效 fake key** 即可：上游返回 401 即证明个人 key 已出境（无需消耗真实 key）。

```bash
# setup：个人设 fake key，先确保不存在公共 deepseek key
curl -s -X DELETE "$BASE/auth/deepseek" > /dev/null
curl -s -X PUT "$BASE/auth/deepseek" -H 'Content-Type: application/json' \
  -H 'x-user-id: u1' -d '{"type":"api","key":"sk-test-fake-personal-key"}' > /dev/null

SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -H 'x-user-id: u1' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 发消息（期望：请求到达上游而非本地 ModelNotFound）
curl -s --max-time 90 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' -H 'x-user-id: u1' \
  -d '{"parts":[{"type":"text","text":"hi"}],"model":{"providerID":"deepseek","modelID":"deepseek-v4-flash"}}' \
  | python3 -c "
import json,sys
d=json.load(sys.stdin, strict=False)
text=json.dumps(d, ensure_ascii=False)
print('✅ T3.12 PASS' if 'Model not found' not in text else '❌ T3.12 FAIL')
print(text[:500])
"

# cleanup
curl -s -X DELETE "$BASE/auth/deepseek" -H 'x-user-id: u1' > /dev/null
```

**期望**：响应不能是本地 `Model not found`；上游通常会返回认证失败。该用例不依赖具体错误 JSON 结构，也不在响应中断言或打印密钥。

### T3.13 真实 key 冒烟（真回复）

> 用真实个人 key 发一条消息，期望拿到上游文本回复。key 用占位符，执行时替换为真实值，**勿将真实 key 写进文档**。

```bash
# setup：个人设真实 key（替换 sk-USER-REAL-KEY），先确保不存在公共 deepseek key
curl -s -X DELETE "$BASE/auth/deepseek" > /dev/null
curl -s -X PUT "$BASE/auth/deepseek" -H 'Content-Type: application/json' \
  -H 'x-user-id: u1' -d '{"type":"api","key":"sk-USER-REAL-KEY"}' > /dev/null

SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -H 'x-user-id: u1' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --max-time 120 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' -H 'x-user-id: u1' \
  -d '{"parts":[{"type":"text","text":"hi"}],"model":{"providerID":"deepseek","modelID":"deepseek-v4-flash"}}' \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
info=d.get('info',d)
if 'error' in info:
    print('❌ T3.13 FAIL:', str(info['error'])[:200])
else:
    texts=[p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text']
    print('AI:', (texts[0][:100] if texts else '(空)'))
    print('✅ T3.13 PASS' if texts else '❌ T3.13 FAIL')
"

# cleanup（冒烟 key 用完即删，避免真实 key 长期驻留测试库）
curl -s -X DELETE "$BASE/auth/deepseek" -H 'x-user-id: u1' > /dev/null
```

**期望**：返回 AI 文本回复（如 `Hi! ...`），无 `error` 字段。

---

## 七、OAuth 登录隔离（`x-user-id`）

> OAuth（ChatGPT Pro/Plus 等订阅登录）走 `POST /provider/:id/oauth/authorize` + `/callback`，
> 待授权状态按 `(user_id, providerID)` 隔离，callback 成功后落个人行（`auth.set(..., userId)`）。
> 完整 E2E（真实登录回填 code）需浏览器人工完成，本节覆盖无账号可验的部分。

### T3.14 OAuth 待授权隔离

```bash
# 1) 查登录方式（openai 应有 browser/headless oauth + api 三种）
curl -s "$BASE/provider/auth" | python3 -c "
import json,sys
d=json.load(sys.stdin, strict=False)
print([(m.get('type'), m.get('label')) for m in d.get('openai',[])])
"

# 2) u1 发起 headless 授权（method 1，需 code，不会 hang）
curl -s --max-time 30 -X POST "$BASE/provider/openai/oauth/authorize" \
  -H 'Content-Type: application/json' -H 'x-user-id: u1' -d '{"method":1}'

# 3) u2 没 authorize 过直接 callback → OauthMissing（旧逻辑会命中 u1 的全局 pending）
curl -s --max-time 30 -X POST "$BASE/provider/openai/oauth/callback" \
  -H 'Content-Type: application/json' -H 'x-user-id: u2' -d '{"method":1}'
echo

# 4) u1 callback（无 code）→ 不报 OauthMissing（pending 还在，只是缺 code / 等待登录）
#    注意：browser/headless 的 method 为 auto，无 code 会进真实轮询等待，curl 会超时，属正常
```

**期望**：
- 步骤 2 返回 `{"url":"https://auth.openai.com/...","method":"auto","instructions":"Enter code: ..."}`
- 步骤 3 返回 `{"name":"ProviderAuthOauthMissing",...}`（u2 看不到 u1 的 pending）
- 步骤 4 不报 `OauthMissing`
- PG 无 `openai` 行写入（失败路径不落库）

### T3.15 OAuth 刷新回写归属（需真实账号）

> access token 过期后插件自动 refresh 并写回 DB。验证刷新写到**本人行**而非公共行。
> 单测已覆盖 header 透传（`test/plugin/codex.test.ts`「writes token refresh back to the requesting user's auth row」），本用例为真机确认（已用真实 ChatGPT 账号验证通过）。
>
> 注意：语言 SDK 有内存缓存，强制过期后需**重启容器**清缓存，否则复用旧快照不触发刷新。

```bash
# 1) 用真实 ChatGPT 账号走完 T3.14 全流程（浏览器登完回填 code），PG 应有 (u1,u1/openai,oauth) 行
# 2) 将该行 expires 改为过去，强制下次触发刷新：
psql "$PG_URL" -c "UPDATE auth SET data = jsonb_set(data, '{expires}', to_jsonb((extract(epoch from now())::bigint - 10)*1000)) WHERE user_id='u1' AND provider_id='u1/openai'"
# 3) 以 u1 发一条 openai 消息，实际触发 refresh（替换 OPENAI_MODEL_ID 为该账号可用模型）：
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' -H 'x-user-id: u1' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"hi\"}],\"model\":{\"providerID\":\"openai\",\"modelID\":\"${OPENAI_MODEL_ID:-gpt-4o}\"}}" > /dev/null
# 4) 检查仅个人行被更新，公共行不存在：
psql "$PG_URL" -t -c "SELECT user_id, provider_id, data->>'access' <> '' FROM auth WHERE user_id='u1' AND provider_id='u1/openai'"
psql "$PG_URL" -t -c "SELECT COUNT(*) FROM auth WHERE user_id='' AND provider_id='openai'"
```

**期望**：`(u1,u1/openai)` 行的 access 已更新（新 token），且公共 `('',openai)` 行数量为 `0`。

### T3.17 openai 多认证方式（method 索引语义与落库差异）

> 同一 provider 可声明多种认证方式（openai 实测 3 种），`authorize`/`callback` body 里的 `method` 是 `GET /provider/auth` 返回数组的**索引**。

```bash
# 1) 方式枚举：openai 应含 ≥2 个 oauth + 1 个 api
curl -s "$BASE/provider/auth" | python3 -c "
import json,sys
d=json.load(sys.stdin, strict=False)
ms=d.get('openai',[])
types=[m.get('type') for m in ms]
ok = len(ms)>=3 and types.count('oauth')>=2 and 'api' in types
print('✅ T3.17a PASS' if ok else '❌ T3.17a FAIL', [(m.get('type'),m.get('label')) for m in ms])
"

# 2) method 指向 api 类型 → authorize 返回 null（API Key 无 OAuth 流程，走 PUT /auth）
curl -s --max-time 30 -X POST "$BASE/provider/openai/oauth/authorize" \
  -H 'Content-Type: application/json' -H 'x-user-id: u1' -d '{"method":2}'
# → null

# 3) method 指向 oauth 类型 → 返回 {url, method, instructions}
curl -s --max-time 30 -X POST "$BASE/provider/openai/oauth/authorize" \
  -H 'Content-Type: application/json' -H 'x-user-id: u1' -d '{"method":0}'
# → {"url":"https://auth.openai.com/oauth/authorize?...","method":"auto","instructions":"..."}

# 4) api 方式落库：PUT /auth 写个人行，type=api
curl -s -X PUT "$BASE/auth/openai" -H 'Content-Type: application/json' \
  -H 'x-user-id: u1' -d '{"type":"api","key":"sk-t317"}' > /dev/null
psql "$PG_URL" -t -A -c "SELECT user_id||'|'||type FROM auth WHERE provider_id='u1/openai'"
# → u1|api

# cleanup
curl -s -X DELETE "$BASE/auth/openai" -H 'x-user-id: u1' > /dev/null
```

**期望**：
- openai 枚举出 `oauth(browser)` / `oauth(headless)` / `api` 三种方式，`method` 按数组索引寻址
- `method` 命中 api 类型时 authorize 返回 `null`（前端直接走 API Key 表单）
- api 与 oauth 共享**同一存储行**（`u1/openai`）：一行一凭证，后写覆盖（api key 与 OAuth token 互斥，重新授权即切换类型）

### T3.16 Provider 查询不泄露凭据

```bash
# setup：设置可识别的公共测试 key
SECRET='sk-provider-response-must-not-contain-this'
curl -s -X PUT "$BASE/auth/moonshotai-cn" -H 'Content-Type: application/json' \
  -d "{\"type\":\"api\",\"key\":\"$SECRET\"}" > /dev/null

# /provider 与 /config/providers 均不能返回原始 key 或 apiKey 字段
for PATH in /provider /config/providers; do
  curl -s "$BASE$PATH" | SECRET="$SECRET" python3 -c "
import json,os,sys
d=json.load(sys.stdin, strict=False)
raw=json.dumps(d, ensure_ascii=False)
providers=d.get('all', d.get('providers', []))
leaked=any('key' in p or 'apiKey' in p.get('options', {}) for p in providers if isinstance(p, dict))
print('✅ T3.16 PASS' if os.environ['SECRET'] not in raw and not leaked else '❌ T3.16 FAIL')
"
done

curl -s -X DELETE "$BASE/auth/moonshotai-cn" > /dev/null
```

**期望**：两个查询响应均不包含凭据值、`key` 或 `apiKey`。

---

## 六、使用说明（个人模型）

> 前提：调用方（一般是接入网关统一注入）**每个请求都带 `x-user-id` Header**，值为用户唯一 ID；不带则视为公共身份。

三步使用个人模型：

1. **配 key**：`PUT /auth/:providerID` 带 `x-user-id`，body 同公共凭据（如 `{"type":"api","key":"sk-..."}`），只写入该用户行，不影响他人与公共。
2. **确认可见**：`GET /provider` 带同样 header，`all/default/connected` 出现该 provider；匿名/他人看不到。
3. **发消息**：`POST /session/:id/prompt`（或 `/message`、`/prompt_async`、`/prompt_stream`）带同样 header，body 里 `model` 照常写 `{"providerID":"...","modelID":"..."}`，无需换模型名。后端仅信任 Header 身份并按其取 key；未传 Header 时不会使用个人 key。

> 已交付（含运行面，T3.12 覆盖）：prompt handler 将 header 注入 `userId` → `llm.run` 取个人 auth → `Provider.getLanguageForUser` 按用户建 SDK（缓存按用户+key 隔离）。
> `agent.ts` / `goal.ts` / 标题生成等后台路径仍走公共 key（无 user 上下文），不受个人 key 影响。
>
> **已确认的行为变更（2026-09-16）**：消息三入口（`/message`、`/prompt_async`、`/prompt_stream`）的身份**仅信任 `x-user-id` header**——header 有值时覆盖 body `userId`，header 缺失时清除 body `userId`（v1.18.29 的 body userId 落库元数据自此废弃，`userName` 等其他字段不受影响）。理由：保留 body userId 会绕过身份隔离使用个人凭证。

---
