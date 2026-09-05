# Auth 凭据管理

> 公共测试环境和配置请参考 [`00-preamble.md`](./00-preamble.md)。

## 验证标准

| 层级 | 方法 | 判定标准 |
|------|------|---------|
| 1. HTTP 响应 | 调用 API 检查返回值 | 字段值与期望一致 |
| 2. PG 记录 | 查询 `auth` 表验证持久化 | 凭据数据正确存储 |

## 通用变量

> 运行前先全局加载环境：`source test-env.sh [1|2|3]`（见 [`00-preamble.md`](./00-preamble.md)）。用例直接用 `$BASE` `$PG_URL`，不重复定义。

> **注意**：`/provider` 响应体积大（~450KB，151+ provider）且部分字段含未转义控制字符，下方 python 解析均用 `json.load(sys.stdin, strict=False)`，否则报 `Invalid control character`。

---

## 三、Provider 查询

### T3.1 查询所有可用 provider

```bash
curl -s "$BASE/provider" | python3 -c "
import json,sys
d=json.load(sys.stdin, strict=False)
all_providers = d.get('all', [])
print(f'可用 provider 总数: {len(all_providers)}')
print('前5个:')
for p in all_providers[:5]:
    print(f'  {p.get(\"id\")} - {p.get(\"name\")}')
print('✅ T3.1 PASS' if len(all_providers) > 0 else '❌ T3.1 FAIL')
"
```

**期望**：返回 100+ 个可用 provider

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

**期望**：`connected` 数组包含已配置的 provider（如 `zhipuai`）

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
psql "$PG_URL" -t -c "SELECT user_id, provider_id, data->>'key' as key FROM auth WHERE provider_id='moonshotai-cn'"

# 2) 重启容器
docker restart opencode-saas-test
sleep 12

echo "--- 重启后查询 connected ---"
curl -s "$BASE/provider" | python3 -c "
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
- 重启前 PG 有公共 + 个人两行记录
- 重启后 `connected` 包含 `moonshotai-cn`，且 u1 视图与匿名视图均可见（公共行），个人行保留

---

## 验收汇总

| 用例 | HTTP 响应 | PG 持久化 | 结果 |
|------|----------|----------|------|
| T3.1 查询可用 provider | 100+ 个 | — | ✅ |
| T3.2 查询已配置 provider | `connected` 数组 | — | ✅ |
| T3.3 设置凭据 | `true` | PG 记录存在 | ✅ |
| T3.4 删除凭据 | `true` | PG `COUNT=0` | ✅ |
| T3.5 持久化 | 重启后 `connected` 仍含 | PG 记录保留 | ✅ |
| T3.6 connected 含 credentials 的 provider（v1.18.18） | `connected` 包含配置了凭据的 provider | — | 见下方 |
| T3.7 个人凭据写隔离 | `true` | 各用户独立行，互不覆盖 | ✅ |
| T3.8 `connected` 读隔离 | 本人含个人+公共，匿名仅公共 | — | ✅ |
| T3.9 个人删除不影响他人/公共 | `true` | 仅删本行 | ✅ |
| T3.10 个人优先 + 删除回落公共 | `true` | 公私两行共存，删个人后公共保留 | ✅ |
| T3.11 异常 header 视为公共 | `true` | 只写 `user_id=''` 行 | ✅ |
| T3.12 个人 key 端到端（聊天生效） | 见下方 | 个人行被上游实际使用 | ✅ |
| T3.13 真实 key 冒烟（真回复） | 见下方 | 上游返回文本而非 error | ✅ |
| T3.14 OAuth 待授权隔离 | 见下方 | 各用户 pending 互不可见 | ✅ |
| T3.15 OAuth 刷新回写归属（需真实账号） | 见下方 | 刷新后 token 写回本人行 | ✅ |

### T3.6 connected 包含凭据 provider（v1.18.18）

> 验证：`GET /provider` 的 `connected` 字段不仅包含 `provider.list()` 的输出，还包含 `authStore.all()` 中配置了凭据的 provider（`provider.ts handler` 的 `connected: Object.keys(providers).filter((id) => id in connected || credentials[id])`）。

```bash
# 1) 找一个未连接的 provider ID（如 hpc-ai、ai-router 等）
UNCONNECTED=$(curl -s "$BASE/provider" | python3 -c "
import json,sys
d=json.load(sys.stdin, strict=False)
all_ids=[p['id'] for p in d.get('all',[])]
connected=d.get('connected',[])
unconnected=[x for x in all_ids if x not in connected]
print(unconnected[0] if unconnected else '')
")
echo "测试 provider: $UNCONNECTED"

# 2) 设置凭据
curl -s -X PUT "$BASE/auth/$UNCONNECTED" \
  -H 'Content-Type: application/json' \
  -d '{"type":"api","key":"test-key"}' > /dev/null

# 3) 查询 provider，验证 connected 包含该凭据的 provider
curl -s "$BASE/provider" | python3 -c "
import json,sys
d=json.load(sys.stdin, strict=False)
connected = d.get('connected', [])
has_test = '$UNCONNECTED' in connected
print(f'connected: {connected}')
print(f'$UNCONNECTED 在 connected 中: {has_test}')
print('✅ T3.6 PASS' if has_test else '❌ T3.6 FAIL')
"

# 4) 清理
curl -s -X DELETE "$BASE/auth/$UNCONNECTED" > /dev/null
```

**期望**：凭据设置后，即使该 provider 未通过 `provider.list()` 连接，也出现在 `connected` 中。

---

## 五、个人凭据隔离（`x-user-id`）

> 请求带 `x-user-id` Header 时读写该用户的私有凭据；不带则读写公共凭据。PG `auth` 表主键为 `(user_id, provider_id)`，`user_id=''` 为公共。
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
psql "$PG_URL" -t -c "SELECT user_id, provider_id, data->>'key' FROM auth WHERE provider_id='moonshotai-cn' ORDER BY 1"

# cleanup
curl -s -X DELETE "$BASE/auth/moonshotai-cn" -H 'x-user-id: u1' > /dev/null
curl -s -X DELETE "$BASE/auth/moonshotai-cn" -H 'x-user-id: u2' > /dev/null
```

**期望**：
- HTTP：两次都返回 `true`
- PG：同时存在 `(u1,moonshotai-cn,sk-u1-key)` / `(u2,moonshotai-cn,sk-u2-key)` 两行，互不覆盖

### T3.8 `connected` 读隔离

```bash
# setup
curl -s -X PUT "$BASE/auth/moonshotai-cn" -H 'Content-Type: application/json' \
  -H 'x-user-id: u1' -d '{"type":"api","key":"sk-u1-key"}' > /dev/null

echo "--- u1 的 connected ---"
curl -s "$BASE/provider" -H 'x-user-id: u1' | python3 -c "
import json,sys
connected=json.load(sys.stdin, strict=False).get('connected',[])
print('moonshotai-cn 在 u1 connected 中:', 'moonshotai-cn' in connected)
print('✅ T3.8 PASS' if 'moonshotai-cn' in connected else '❌ T3.8 FAIL')
"

echo "--- 匿名的 connected ---"
curl -s "$BASE/provider" | python3 -c "
import json,sys
connected=json.load(sys.stdin, strict=False).get('connected',[])
print('moonshotai-cn 在匿名 connected 中:', 'moonshotai-cn' in connected)
print('✅ T3.8 PASS' if 'moonshotai-cn' not in connected else '❌ T3.8 FAIL')
"

# cleanup
curl -s -X DELETE "$BASE/auth/moonshotai-cn" -H 'x-user-id: u1' > /dev/null
```

**期望**：u1 的 `connected` 含 `moonshotai-cn`（个人合成条目）+ 公共；匿名的不含个人 provider。

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
psql "$PG_URL" -t -c "SELECT user_id, provider_id FROM auth WHERE provider_id IN ('moonshotai-cn','zhipuai') ORDER BY 1,2"

# cleanup
curl -s -X DELETE "$BASE/auth/moonshotai-cn" -H 'x-user-id: u2' > /dev/null
curl -s -X DELETE "$BASE/auth/zhipuai" > /dev/null
```

**期望**：只删 `(u1,moonshotai-cn)`，u2 的行与公共行保留。

### T3.10 个人优先 + 删除回落公共

> 个人与公共同名 provider 共存时，用户视图个人优先；删个人后回落公共。注意：`GET /provider` 只暴露 `connected` 名单不暴露 key，
> “用哪个 key 生效”属运行面（聊天时），本用例在管理面验证可观测部分：两行共存 + 删除回落。

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
psql "$PG_URL" -t -c "SELECT user_id, provider_id, data->>'key' FROM auth WHERE provider_id='zhipuai' ORDER BY 1"

echo "--- u1 connected（应含 zhipuai） ---"
curl -s "$BASE/provider" -H 'x-user-id: u1' | python3 -c "
import json,sys
connected=json.load(sys.stdin, strict=False).get('connected',[])
print('✅ T3.10 PASS' if 'zhipuai' in connected else '❌ T3.10 FAIL')
"

# 2) 删个人，公共保留并回落可见
curl -s -X DELETE "$BASE/auth/zhipuai" -H 'x-user-id: u1' > /dev/null

echo "--- PG 验证（应仅剩公共行） ---"
psql "$PG_URL" -t -c "SELECT user_id, provider_id, data->>'key' FROM auth WHERE provider_id='zhipuai'"

# cleanup
curl -s -X DELETE "$BASE/auth/zhipuai" > /dev/null
```

**期望**：公私两行共存 key 不同；删个人后公共行 `sk-public` 保留，u1/匿名 `connected` 仍含 `zhipuai`。

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
# setup：个人设 fake key（无公共 deepseek key）
curl -s -X PUT "$BASE/auth/deepseek" -H 'Content-Type: application/json' \
  -H 'x-user-id: u1' -d '{"type":"api","key":"sk-test-fake-personal-key"}' > /dev/null

SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -H 'x-user-id: u1' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 发消息（期望：上游 401，而非 ModelNotFound）
curl -s --max-time 90 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' -H 'x-user-id: u1' \
  -d '{"parts":[{"type":"text","text":"hi"}],"model":{"providerID":"deepseek","modelID":"deepseek-v4-flash"}}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['info']['error']['data']['message'][:120])"

# cleanup
curl -s -X DELETE "$BASE/auth/deepseek" -H 'x-user-id: u1' > /dev/null
```

**期望**：assistant 错误信息含 `Authentication Fails` + `statusCode 401` + `url https://api.deepseek.com/...`，
且 key 被打码为 `****-key`（个人 fake key 已送达上游）。若回退到 `Model not found: deepseek/...` 则为运行面回退。

### T3.13 真实 key 冒烟（真回复）

> 用真实个人 key 发一条消息，期望拿到上游文本回复。key 用占位符，执行时替换为真实值，**勿将真实 key 写进文档**。

```bash
# setup：个人设真实 key（替换 sk-USER-REAL-KEY）
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
# 1) 用真实 ChatGPT 账号走完 T3.14 全流程（浏览器登完回填 code），PG 应有 (u1,openai,oauth) 行
# 2) 将该行 expires 改为过去，强制下次触发刷新：
psql "$PG_URL" -c "UPDATE auth SET data = jsonb_set(data, '{expires}', to_jsonb((extract(epoch from now())::bigint - 10)*1000)) WHERE user_id='u1' AND provider_id='openai'"
# 3) 以 u1 发一条 openai 消息，成功后检查：
psql "$PG_URL" -t -c "SELECT user_id, provider_id, data->>'access' <> '' FROM auth WHERE provider_id='openai'"
```

**期望**：`(u1,openai)` 行的 access 已更新（新 token），且**没有**产生/更新 `('',openai)` 公共行。

---

## 六、使用说明（个人模型）

> 前提：调用方（一般是接入网关统一注入）**每个请求都带 `x-user-id` Header**，值为用户唯一 ID；不带则视为公共身份。

三步使用个人模型：

1. **配 key**：`PUT /auth/:providerID` 带 `x-user-id`，body 同公共凭据（如 `{"type":"api","key":"sk-..."}`），只写入该用户行，不影响他人与公共。
2. **确认可见**：`GET /provider` 带同样 header，`connected` 出现该 provider 即配好；匿名/他人看不到。
3. **发消息**：`POST /session/:id/prompt`（或 `/message`）带同样 header，body 里 `model` 照常写 `{"providerID":"...","modelID":"..."}`，无需换模型名。后端按 header 取该用户的 key 调上游（个人独有 provider 走 models.dev 目录回落，无公共 key 也可用）。

> 已交付（含运行面，T3.12 覆盖）：prompt handler 将 header 注入 `userId` → `llm.run` 取个人 auth → `Provider.getLanguageForUser` 按用户建 SDK（缓存按用户+key 隔离）。
> `agent.ts` / `goal.ts` / 标题生成等后台路径仍走公共 key（无 user 上下文），不受个人 key 影响。

---

