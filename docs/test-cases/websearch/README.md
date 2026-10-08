# WebSearch 网络搜索

> AI 的联网搜索能力：模型经 `websearch` 工具或客户端经 HTTP 搜索一次。
> 未配置 provider 时弹表单征求用户授权（allow/choose/disable），选择持久化到 KV；
> "random" 模式带 429 冷却轮询与会话亲和性。
> 实现依据：`packages/core/src/websearch.ts`（providers/select/query/冷却/亲和）、
> `packages/core/src/tool/plugin/websearch.ts`（工具 + 表单流程 + 失败文案）、
> `packages/core/src/config/plugin/websearch.ts`（config 驱动的 default/false）、
> `packages/server/src/handlers/websearch.ts`（HTTP 错误映射）、
> `packages/protocol/src/groups/websearch.ts`（端点契约）。
> 内置 provider：`plugin/websearch/{exa,tavily,tinyfish,parallel,firecrawl}.ts` + opencode 自家（`plugin/provider/opencode.ts:244`）+ 插件注册（`plugin/host.ts:480`）。

## 核心语义（用例断言依据）

| 维度 | 语义 | 代码依据 |
|---|---|---|
| ProviderRequired | 无选择且无可用 provider → 表单三选一：`allow`（→"random"）/ `choose`（二次表单选 provider）/ `disable`（→select(false)）；1 分钟无应答自动取消 | `tool/plugin/websearch.ts:66-147` |
| 持久化 | `select()` 写 KV `websearch:provider`（ID / "random" / false）；进程内 cache 优先，KV 兜底；KV 值非法自动清除 | `websearch.ts:119-131,174-176` |
| config 驱动 | `config.websearch = {provider: <ID>\|"random"} \| false`：false → DisabledError + **工具从 tool/generate/compaction 三个 hook 的工具列表移除** | `config/plugin/websearch.ts`；`tool/plugin/websearch.ts:184-194` |
| 冷却轮询（仅 random） | 429（HTTP client error）→ 按 `retry-after` 头进冷却（默认 60s），换 provider 重试；全冷却→返回最后错误。非 random 或非 429 直接失败 | `websearch.ts:189-209,215-221` |
| 亲和性（仅 random） | 同一会话优先复用上次成功的 provider（preferred map）；会话 Deleted/Moved 事件清理 | `websearch.ts:92-101,183-188` |
| 工具输出 | `## [title](url)` + `Published: <ISO>` + content；0 结果 → `No search results found. Please try a different query.` | `tool/plugin/websearch.ts:149-164` |
| HTTP 错误映射 | ProviderRequired→400 `kind=websearch_provider_required`；ProviderNotFound→400 `kind=websearch_provider_not_found`；Disabled→400 `kind=websearch_disabled`；Request→503 | `handlers/websearch.ts:23-41` |
| 权限 | 工具执行前 `permission.assert(action=websearch, resources=[query])` | `tool/plugin/websearch.ts:49-57` |
| 列表 | `GET /api/websearch/provider` → `[{id,name}]`（按 name 排序） | `websearch.ts:164-169` |

**HTTP 端点**（Location 级，`query: {location:{directory?}}` 可选）：

| 端点 | 契约 |
|---|---|
| `GET /api/websearch/provider` | `{data: [{id, name}]}` |
| `POST /api/websearch` | payload `{query, providerID?}` → `{data: {providerID, results: [{url, title?, content?, time: {published?}}]}}` |

## 前置条件与通用变量

```bash
source docs/test-cases/test-env.sh
export OPENCODE_PASSWORD="${OPENCODE_PASSWORD:-ab123456}"
CURL_AUTH=()
[[ -n "$OPENCODE_PASSWORD" ]] && CURL_AUTH=(-u "opencode:${OPENCODE_PASSWORD}")

new_sid() {
  curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session" \
    -H 'Content-Type: application/json' \
    -d "{\"title\":\"websearch-t\",\"location\":{\"directory\":\"/workspace\"},\"model\":$V2_MODEL}" | jq -r '.data.id'
}
send() {
  curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$1/prompt" \
    -H 'Content-Type: application/json' \
    -d "{\"text\":$(jq -Rn --arg t "$2" '$t'),\"metadata\":{},\"delivery\":\"steer\"}" >/dev/null
}
wait_idle() {
  curl -fsS --noproxy '*' "${CURL_AUTH[@]}" --max-time 240 -X POST "$BASE/api/experimental/session/$1/wait" \
    -H 'Content-Type: application/json' -d '{}' -o /dev/null -w 'wait=%{http_code}\n'
}
ws_provider() { curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/websearch/provider" | jq -c '.data'; }
ws_query() {  # ws_query <query> [providerID]
  curl -sS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/websearch" \
    -H 'Content-Type: application/json' \
    -d "{\"query\":$(jq -Rn --arg t "$1" '$t')${2:+,\"providerID\":\"$2\"}}" 
}
kv_ws() { psql "$PG_URL" -At -c "SELECT value FROM kv WHERE key='websearch:provider';"; }
# 自动代答 websearch 表单（Form.Reply={answer:{...}}；参考 streaming-output-spec §6）
answer_ws_form() {
  local sid="$1" choice="${2:-allow}"
  for i in $(seq 1 20); do
    local form=$(curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/form" | jq -c '.data[0] // empty')
    [[ -z "$form" ]] && { sleep 3; continue; }
    local fid=$(echo "$form" | jq -r '.id')
    curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$sid/form/$fid/reply" \
      -H 'Content-Type: application/json' \
      -d "{\"answer\":{\"choice\":\"$choice\"}}" && return 0
    sleep 3
  done
  return 1
}
```

> 提问自动代答、SSE 实时观察遵循 `docs/test-cases/skills/streaming-output-spec.md`；
> 表单列表 API 只返回 pending 表单。真实搜索依赖外部 API key（见"真实搜索前置"）。

## 真实搜索前置（provider 配置）

内置 provider（exa/tavily/tinyfish/parallel/firecrawl）均需 API key（integration/credential 域），
opencode 自家 provider 依赖 opencode 账号（`config.websearch`）。**执行前先探查环境**：

```bash
ws_provider                     # 看注册了哪些 provider
kv_ws                           # 看当前持久化选择
```

- **W1.x 的错误分支（ProviderRequired/NotFound/Disabled）不依赖 key**，必跑。
- **真实搜索断言**（有可用 provider/key 时）：按实际 providers 数量执行；若环境无任何可用 provider，
  真实搜索用例标注 `SKIPPED-no-provider` 并记录 providers 列表（避免误判为失败）。

---

## W1 HTTP 接口面

### W1.1 列出 providers

```bash
ws_provider
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/websearch/provider?location[directory]=/workspace" | jq '.data | length'
```

**期望**：200；`data` 为 `[{id,name}]` 数组（空数组合法=无注册）。带 location 查询参数与不带均可（Location 级路由）。

### W1.2 未配置时查询 → 400 websearch_provider_required

```bash
psql "$PG_URL" -c "DELETE FROM kv WHERE key='websearch:provider';"   # 确保无选择
ws_query "what is the weather today" | jq -c '._tag, .kind, .message' | head -3
```

**期望**：HTTP 400；`kind == "websearch_provider_required"`（no selection + 不传 providerID）。

### W1.3 指定不存在的 provider → 400 websearch_provider_not_found

```bash
ws_query "test" "no-such-provider" | jq -c '._tag, .kind' | head -2
```

**期望**：400；`kind == "websearch_provider_not_found"`（providerID 优先于 selection，直接 requireProvider）。

### W1.4 config 禁用 → 400 websearch_disabled + 工具消失

```bash
# config.websearch = false（写 location 的 opencode.json；注意 PATCH /api/experimental/config
# 只支持 shell 字段（Config.Patch），websearch 选择只能走配置文件或工具表单）
sid0=$(new_sid); loc=$(curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid0" | jq -r '.data.location.directory')
docker exec opencode-saas-test sh -c "mkdir -p $loc && echo '{\"websearch\":false}' > $loc/opencode.json"
sleep 3
ws_query "test" | jq -c '.kind'
sid=$(new_sid)
send "$sid" '列出你当前可用的工具名称（一行一个），其中是否有 websearch？'
wait_idle "$sid"
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=assistant" \
  | jq -r '.data[].content[]? | select(.type=="text") | .text' | grep -ci 'websearch' || echo "0（工具已隐藏）"
# 清理：删除配置文件
docker exec opencode-saas-test sh -c "rm -f $loc/opencode.json"
```

**期望**：400 `kind=websearch_disabled`；模型视角无 `websearch` 工具（context/generate/compaction 三 hook 删除）。
（config 形态：`websearch: false` 或 `websearch: {provider: <ID>\|"random"}`，`schema/src/config/websearch.ts`。）

## W2 工具面（模型触发 + 表单流程）

### W2.1 未配置 → 表单三选一，allow 执行搜索

**用户故事**：AI 第一次联网搜索，弹窗征求我同意——选"允许"后继续完成任务。

```bash
psql "$PG_URL" -c "DELETE FROM kv WHERE key='websearch:provider';" > /dev/null
sid=$(new_sid)
send "$sid" '用 websearch 工具搜索 "opencode AI" 的最新信息，摘要给我。'
answer_ws_form "$sid" allow &   # 自动代答 allow
wait_idle "$sid"
echo "[表单] 曾弹出: $(psql "$PG_URL" -At -c "SELECT count(*) FROM session_form WHERE session_id='$sid';" 2>/dev/null || echo n/a)"
echo "[KV] select 持久化: $(kv_ws)（allow → random）"
echo "[回复] $(curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=assistant" | jq -r '.data[].content[]? | select(.type=="text") | .text' | head -6)"
```

**期望**：表单（kind=websearch.provider，choice 三选项 allow/choose/disable）出现；应答 allow 后 `kv_ws == "random"`；工具执行（真实搜索有 key 时有结果；无 key 时工具失败文案为 HTTP 401/429/`Unable to search the web for ...`）。

### W2.2 disable → 持久化 false + 工具消失

```bash
psql "$PG_URL" -c "DELETE FROM kv WHERE key='websearch:provider';" > /dev/null
sid=$(new_sid)
send "$sid" '用 websearch 工具搜索 "test"。'
answer_ws_form "$sid" disable &
wait_idle "$sid"
echo "[KV] $(kv_ws)（disable → false）"
# 同会话续问工具可见性
send "$sid" '现在列出你可用的工具名，包含 websearch 吗？只回答是或否并列出清单。'
wait_idle "$sid"
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=assistant" \
  | jq -r '.data[].content[]? | select(.type=="text") | .text' | tail -3
```

**期望**：KV 为 `false`；后续轮次工具列表无 websearch（三 hook 删除生效）；本次搜索报 `Web search is disabled`（DisabledError→ToolFailure fallback 文案）。

### W2.3 choose → 二次表单选定 provider

```bash
psql "$PG_URL" -c "DELETE FROM kv WHERE key='websearch:provider';" > /dev/null
sid=$(new_sid)
send "$sid" '用 websearch 工具搜索 "latest news"。'
# 第一张表单选 choose，第二张表单选 providers 里的某个 id
answer_ws_form "$sid" choose &
sleep 5
fid2=$(curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/form" | jq -r '.data[0].id // empty')
pid=$(ws_provider | jq -r '.[0].id // empty')
[[ -n "$fid2" ]] && curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$sid/form/$fid2/reply" \
  -H 'Content-Type: application/json' -d "{\"answer\":{\"provider\":\"$pid\"}}"
wait_idle "$sid"
echo "[KV] $(kv_ws)（应为所选 provider id）"
```

**期望**：两张表单（allow/choose/disable → provider 单选）；KV 持久化所选 provider id；随后以该 provider 执行查询。

### W2.4 表单 1 分钟无应答 → 自动取消

```bash
psql "$PG_URL" -c "DELETE FROM kv WHERE key='websearch:provider';" > /dev/null
sid=$(new_sid)
send "$sid" '用 websearch 工具搜索 "anything"。'
# 不应答，等 80 秒
sleep 80
wait_idle "$sid"
echo "[回复] $(curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=assistant" | jq -r '.data[].content[]? | select(.type=="text") | .text' | tail -3)"
echo "[KV] $(kv_ws)（应仍为空——超时路径不写 select）"
```

**期望**：工具失败（`Web search cancelled`）；KV 无值；模型收到失败后正常收尾（不挂死）。

### W2.5 输出格式与 0 结果

```bash
sid=$(new_sid)
send "$sid" '用 websearch 工具搜索 "opencode docs"，然后原样转述工具返回文本的前 5 行。'
wait_idle "$sid"
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message" \
  | jq -r '[.data[] | select(.type=="assistant") | .content[]? | select(.type=="tool")][0].state.metadata.provider // "no-tool"'
```

**期望**：
- 工具 content 格式：`## [title](url)` + 可选 `Published: <ISO>` + content（`tool/plugin/websearch.ts:153-163`）。
- 0 结果固定文案 `No search results found. Please try a different query.`：**外部搜索引擎不保证 0 结果**（实测 firecrawl 对乱码串仍返回匹配内容），e2e 无法稳定断言，该分支由单测覆盖（`test/tool-websearch.test.ts`）。

## W3 持久化与清理

### W3.1 select 跨重启生效

```bash
psql "$PG_URL" -P pager=off -c "DELETE FROM kv WHERE key='websearch:provider';" > /dev/null
# 通过 W2.1 写入 random（或 W2.3 写入具体 provider id）
docker restart opencode-saas-test >/dev/null; sleep 20
export OPENCODE_PASSWORD=ab123456
psql "$PG_URL" -At -c "SELECT value FROM kv WHERE key='websearch:provider';"   # 重启后仍在（KV 持久化）
# 冷启动竞态防护：先等 providers 就绪再查（实测重启后 20s 内插件激活可能未完成）
for i in $(seq 1 10); do n=$(curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/websearch/provider" | jq '.data | length'); [[ "$n" -gt 0 ]] && break; sleep 3; done
curl -sS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/websearch" -H 'Content-Type: application/json' -d '{"query":"probe"}' \
  -o /tmp/w31.json -w 'http=%{http_code} '
jq -c '{providerID: .data.providerID, n: (.data.results|length), kind}' /tmp/w31.json
```

**期望**：KV 值重启后保留；providers 就绪后查询不再 ProviderRequired（选择生效，随机模式实际执行搜索）。

> **实测观察（2026-10-08）**：重启后立即查询会在插件激活完成前触发 `websearch_provider_required`
> （providers 暂空），即使 KV 选择存在——冷启动竞态下错误信号有误导性（客户端会以为未配置而弹表单）。
> 非本专项缺陷范围，记录待讨论（合理行为应为等待服务图构建或 503）。

### W3.2 session 删除/moved 清理 preferred（随机亲和性）

> preferred 是进程内存态（`websearch.ts:92`），无直接读接口。间接断言：random 模式下同会话两次查询
> 亲和同一 provider（onProvider 进度事件）；删除会话后再查新会话不再指向旧亲和。
> e2e 信号弱，**行为逻辑由单测覆盖**（`packages/core/test/websearch.test.ts`），此处仅 smoke 观察 onProvider 进度事件一致性。

## W4 冷却轮询（random 模式 429）

> 429 冷却（retry-after 头、60s 默认、换 provider 重试、全冷却返回最后错误）**依赖外部 provider 返回 429**，
> e2e 无法稳定模拟。**单测已覆盖**（`test/websearch.test.ts` random/cooldown 系列用例），e2e 不设用例。
> 如真实 provider 触发 429，顺带观察：工具失败文案为 `Web search rate limited (HTTP 429)`（`tool/plugin/websearch.ts:15-18`）。

---

## 覆盖矩阵

| 代码路径 / 行为 | 用例 |
|---|---|
| GET providers 列表 + Location query | W1.1 |
| ProviderRequiredError→400 kind | W1.2 |
| ProviderNotFoundError→400 kind（providerID 优先） | W1.3 |
| config false→DisabledError + 三 hook 工具删除 | W1.4、W2.2 |
| 表单三选一 allow→random+KV | W2.1 |
| 表单 disable→select(false) | W2.2 |
| 表单 choose→二次表单→select(id) | W2.3 |
| 表单 1min 超时取消 | W2.4 |
| 工具输出格式 / NO_RESULTS 文案 | W2.5 |
| KV select 持久化跨重启 | W3.1 |
| preferred 会话亲和 + Deleted/Moved 清理 | W3.2（smoke）/ 单测 |
| 429 冷却轮询 | 单测（W4 说明） |
| permission.assert(action=websearch) | 隐含于 W2.x（session-permission 专项可加显式断言） |

## 执行记录（2026-10-08，W1.1-W2.5、W3.1 通过）

环境：单实例 docker（固定密码）+ 本地 PG + **tavily/exa/firecrawl 均有可用 key**（真实搜索全部跑通）。
- W1.1 ✅ 5 个内置 provider（exa/firecrawl/parallel/tavily/tinyfish）+ location query 200
- W1.2 ✅ 400 `websearch_provider_required`
- W1.3 ✅ 400 `websearch_provider_not_found`
- W1.4 ✅ 配置文件 `websearch:false` → 400 `websearch_disabled` + 模型工具清单 25 个无 websearch
  （**实现修正**：`Config.Patch` 仅支持 `shell` 字段（schema/config.ts:113），websearch 选择只能走配置文件/工具表单）
- W2.1 ✅ 表单 allow → KV=`"random"` → tavily 真实搜索（8 条结果）
- W2.2 ✅ 表单 disable → KV=`false` + 搜索被拒
- W2.3 ✅ 表单 choose → 二次表单 → KV=`"exa"` → exa 真实搜索
- W2.4 ✅ 表单 1 分钟超时自动取消（`Web search cancelled`）、KV 不写、模型正常收尾
- W2.5 ✅ 输出格式 `## [title](url)` + content 验证；0 结果文案转单测（外部不保证 0 结果：firecrawl 对乱码串仍返回真实内容）
- W3.1 ✅ KV 跨重启持久化；**观察**：重启后 20s 内查询触发冷启动竞态（providers 未激活时返回 provider_required），已记录
- W3.2/W4：preferred 亲和与 429 冷却由单测覆盖（`test/websearch.test.ts`、`test/tool-websearch.test.ts`、`test/config/websearch.test.ts`）
