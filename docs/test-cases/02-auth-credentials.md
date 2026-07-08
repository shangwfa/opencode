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
psql "$PG_URL" -t -c "SELECT provider_id, type, data->>'key' as key FROM auth WHERE provider_id='moonshotai-cn'"
```

**期望**：
- HTTP：返回 `true`
- PG：`provider_id=moonshotai-cn`，`type=api`，`key=sk-test-key`

### T3.4 删除 provider 凭据

```bash
RESP=$(curl -s -X DELETE "$BASE/auth/moonshotai-cn")
echo "HTTP response: $RESP"

echo "--- PG 验证 (删除后) ---"
psql "$PG_URL" -t -c "SELECT COUNT(*) FROM auth WHERE provider_id='moonshotai-cn'"
```

**期望**：
- HTTP：返回 `true`
- PG：`COUNT=0`

### T3.5 凭据持久化（重启后验证）

```bash
# 1) 设置凭据（用真实 provider ID）
curl -s -X PUT "$BASE/auth/moonshotai-cn" \
  -H 'Content-Type: application/json' \
  -d '{"type":"api","key":"persist-key-test"}' > /dev/null

echo "--- PG 验证 (重启前) ---"
psql "$PG_URL" -t -c "SELECT provider_id, data->>'key' as key FROM auth WHERE provider_id='moonshotai-cn'"

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
```

**期望**：
- 重启前 PG 有记录
- 重启后 `connected` 包含 `moonshotai-cn`

---

## 验收汇总

| 用例 | HTTP 响应 | PG 持久化 | 结果 |
|------|----------|----------|------|
| T3.1 查询可用 provider | 100+ 个 | — | ✅ |
| T3.2 查询已配置 provider | `connected` 数组 | — | ✅ |
| T3.3 设置凭据 | `true` | PG 记录存在 | ✅ |
| T3.4 删除凭据 | `true` | PG `COUNT=0` | ✅ |
| T3.5 持久化 | 重启后 `connected` 仍含 | PG 记录保留 | ✅ |

---

