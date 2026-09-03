# Session DCP（Dynamic Context Pruning 内置插件）

> 验证内置 DCP 插件（`OPENCODE_DCP_ENABLED`）的模型自主上下文压缩全链路：插件加载、compress 工具、nudge 触发、请求视图替换、state 持久化（PG `storage_data` 表）与开关行为。

## 功能背景与效果

上下文窗口被填满时，内置 compaction 会整体摘要替换历史（有损、且依赖 LLM 回传 usage）。DCP 采用互补思路：把压缩决策交给模型——暴露 `compress` 工具，模型在 nudge 提示下自主选择压缩**哪些**消息；会话存储永不修改，只在每次 LLM 请求前于内存中替换视图，压缩结果持久化到 DCP state（SaaS 下走 PG）。

| 能力               | 效果                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 环境开关           | `OPENCODE_DCP_ENABLED=true` 注册内置插件；默认关闭，零开销                                                              |
| 模型自主压缩       | `compress` 工具（range/message 双模式），nudge 按 token 阈值引导模型主动调用                                            |
| 请求前视图变换     | 消息 ID 标签注入、压缩块替换为合成摘要、工具输出占位符——**PG 中的历史只读**                                             |
| state 持久化       | `Storage.Service` 注入（PG `storage_data` 表，key `plugin/dcp/<sessionID>`）→ 多实例共享；无后端时回退实例本地文件      |
| 配置体系           | dcp.jsonc 三级（global → `$OPENCODE_CONFIG_DIR` → 项目 `.opencode/`），`minContextLimit`/`maxContextLimit` 控制提醒强度 |
| 与 compaction 并存 | DCP 改请求视图、内置 compaction 改存储历史——分层共存，无写冲突；DCP 阈值先触发，内置作为兜底                            |

## 实现位置

| 模块                                                                               | 内容                                                                                                   |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `packages/opencode/src/plugin/dcp/`                                                | vendor 自 @tarquinen/opencode-dcp（AGPL-3.0），裁剪 TUI 面板与 npm autoUpdate；`index.ts` 为内置适配器 |
| `packages/opencode/src/flag/flag.ts`                                               | `OPENCODE_DCP_ENABLED` 开关                                                                            |
| `packages/opencode/src/plugin/index.ts`                                            | `internalPlugins` 注册 + `EffectBridge` 桥接 `Storage.Service` 为 DCP 后端                             |
| `packages/opencode/src/storage/storage.ts`                                         | PG 分支（`dialect === "pg"` 时走 `storage_data` 表，文件实现保留为本地 TUI 默认）                      |
| `packages/opencode/migration-pg/20260902120000_storage_data/`                      | `storage_data` 表迁移（key text PK / data jsonb / time_updated）                                       |
| `packages/opencode/src/plugin/dcp/lib/state/persistence.ts`                        | `DcpStorageBackend` 注入点 + fs fallback                                                               |
| `test/plugin/dcp/`、`test/plugin/dcp-*.test.ts`、`test/storage/storage-pg.test.ts` | L0 单测（上游移植 + 新增）                                                                             |

## 公共配置

> 实测环境：**本地 PG + 远程沙箱**（本地 PG 用户 `local`，容器 `opencode-saas-test` @14096，镜像含 DCP：`opencode-saas-sandbox-test:local-dcp`）。

```bash
source docs/test-cases/test-env.sh 3 && source docs/test-cases/test-lib.sh
# 组合 3 的 PG_URL 即本地 PG；远程沙箱组合仅需保持 30040 转发与 OPENCODE_SANDBOX_* env 不变

# 容器启动（必须带 DCP 开关）：
docker rm -f opencode-saas-test
docker run -d --name opencode-saas-test \
  -p 14096:4096 \
  -e OPENCODE_DATABASE_URL="postgresql://local@host.docker.internal:15432/opencode" \
  -e OPENCODE_DCP_ENABLED=true \
  --env-file /tmp/opencode-saas.env \
  opencode-saas-sandbox-test:local-dcp serve --hostname 0.0.0.0 --port 4096

# 测试期把 DCP 阈值调低（默认 5 万/10 万 token，短会话无法触发）：
docker exec opencode-saas-test sh -c 'cat > ~/.config/opencode/dcp.jsonc <<EOF
{
  "debug": true,
  "compress": { "minContextLimit": 1000, "maxContextLimit": 2000 }
}
EOF'
docker restart opencode-saas-test && sleep 8

# DCP debug 日志位置（容器内）：
#   ~/.config/opencode/logs/dcp/daily/<date>.log
```

## 验收层级

| 层级         | 用例     | 验证目标                                                          | 状态                      |
| ------------ | -------- | ----------------------------------------------------------------- | ------------------------- |
| L0 单元      | T-DCP.1  | 4 套件单测：上游移植逻辑、backend 注入、入口开关、Storage PG 分支 | ✅ 119 pass / 0 fail      |
| L1 加载      | T-DCP.2  | env 开关注册插件、system prompt 注入、模型 limit 缓存             | ✅                        |
| L2 持久化    | T-DCP.3  | DCP state 落 PG `storage_data`（key `plugin/dcp/<sid>`）          | ✅                        |
| L3 压缩链路  | T-DCP.4  | 低阈值 nudge → 模型调用 compress → 压缩块 → 请求视图替换          | ✅                        |
| L4 恢复      | T-DCP.5  | 容器重启后 state 从 PG 恢复，压缩视图持续生效                     | ✅                        |
| L5 开关      | T-DCP.6  | 未设 env 时插件不加载、零副作用                                   | ✅                        |
| L6 兼容      | T-DCP.7  | 与内置 compaction 并存、既有测试回归                              | ✅                        |
| L7 多实例    | T-DCP.8  | 实例 B 从 PG 加载实例 A 写入的 state，压缩视图跨实例重放          | ✅                        |
| L8 自动策略  | T-DCP.9  | dedup 标记重复工具调用（purgeErrors 配置生效，视图级断言待办）    | ✅（purgeErrors 部分）    |
| L9 双模式    | T-DCP.10 | compress `mode: "message"` 单条消息粒度压缩                       | ✅                        |
| L10 清理     | T-DCP.11 | 删除会话时 DCP state 行同步清理                                   | ✅                        |
| L11 收益基准 | T-DCP.12 | 对比 DCP 开关前后的上下文 token、请求耗时与估算成本               | ⚠️ 已执行，需拆分稳态请求 |

> L0 的 storage-pg 套件连接**专用测试库**（`opencode_test`）并自建表——切勿指向日常开发库（见已知限制）。

## SaaS 按会话观测

线上不需要读取容器日志。通过以下接口查询单个会话的 DCP 效果：

```bash
curl -s "$BASE/session/$SID/dcp/stats" | jq
```

返回字段：

- `hasState`：该会话是否产生过 DCP state
- `totalTokensSaved`：累计裁剪/压缩 token 估算值
- `prunedTools`：被裁剪的工具调用数量
- `prunedMessages`：被压缩的消息数量
- `compressionBlocks` / `activeCompressionBlocks`：压缩块总数和当前生效数量
- `compressedTokens` / `summaryTokens`：原始压缩内容与摘要 token 估算值
- `compressionDurationMs`：当前生效压缩块累计耗时
- `lastUpdated`：DCP state 最近更新时间

没有产生 DCP state 的正常会话返回 `hasState: false`，其余数值为 `0`，不会返回 404。接口按 `sessionID` 校验会话权限，适合 SaaS 前端直接展示会话级压缩效果。

## 测试用例

### T-DCP.1 单元测试（L0）

> 必须从 `packages/opencode` 目录运行。

```bash
cd packages/opencode

# 1) DCP 上游移植 + persistence backend + 入口开关
bun test test/plugin/dcp/ test/plugin/dcp-persistence.test.ts test/plugin/dcp-entry.test.ts
# 期望: 112 pass / 0 fail（18 文件）

# 2) Storage PG 分支（专用测试库，套件自建 storage_data 表）
OPENCODE_DATABASE_URL="postgresql://local@localhost:15432/opencode_test" \
  bun test test/storage/storage-pg.test.ts
# 期望: 7 pass / 0 fail

# 3) 类型检查不新增错误（基线 57）
bun typecheck 2>&1 | grep -c 'error TS'
```

覆盖点：

- persistence：backend 注入/写读 roundtrip、缺失→null、畸形数据拒绝、anchors 去重、写失败吞噬、单例语义、fs fallback（子进程隔离）
- entry：未启用→`{}`、启用→6 hooks + compress 工具、backend 透传
- storage PG：roundtrip、upsert、update、remove、list 前缀排序与兄弟前缀隔离、缺失→NotFoundError

### T-DCP.2 插件加载与 system prompt 注入（L1）

```bash
SID=$(new_sid)
# 发一条消息（触发首次 LLM 请求 → DCP transform/system 注入）
curl -s -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"providerID\":\"Yd-DeepSeek\",\"modelID\":\"deepseek-v4-flash\",\"parts\":[{\"type\":\"text\",\"text\":\"hi\"}]}" \
  -o /dev/null -w "POST %{http_code}\n"

# DCP debug 日志应出现（容器内）：
docker exec opencode-saas-test sh -c \
  'grep -E "Cached model context limit|Session changed" ~/.config/opencode/logs/dcp/daily/*.log | tail -3'
```

**期望**：

- POST 返回 200，assistant 正常回复（DCP 不干扰正常对话）
- 日志含 `Cached model context limit | limit=1000000`（读自 opencode.jsonc 模型 limit）
- 日志含 `Session changed: null -> $SID`（state 生命周期启动）

### T-DCP.3 state 持久化到 PG（L2）

```bash
# 发送一段较长的背景资料（使上下文估算超过 minContextLimit=1000）
LONG=$(python3 -c "print('背景资料: ' + ('分布式一致性模型包括线性一致性、顺序一致性、因果一致性与最终一致性。' * 40))")
curl -s -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "$(python3 -c "
import json,sys
print(json.dumps({'providerID':'Yd-DeepSeek','modelID':'deepseek-v4-flash','parts':[{'type':'text','text':sys.argv[1]+' 资料完毕，请回复: 已了解。'}]}))" "$LONG")" \
  -o /dev/null -w "POST %{http_code}\n"
sleep 25

pgval "SELECT key FROM storage_data;"
```

**期望**：

- `storage_data` 出现行 `plugin/dcp/$SID`（`data` 为完整 PersistedSessionState JSON：prune/nudges/stats）
- debug 日志出现 `Saved session state to storage backend | sessionId=$SID`

### T-DCP.4 压缩链路：nudge → compress → 视图替换（L3）

前置：T-DCP.3 的会话已超过 maxContextLimit=2000。

```bash
# 继续追问，触发下一次 LLM 请求（DCP 重新评估视图并维持压缩块生效）
curl -s -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"providerID\":\"Yd-DeepSeek\",\"modelID\":\"deepseek-v4-flash\",\"parts\":[{\"type\":\"text\",\"text\":\"我刚让你记住的背景资料主题是什么? 简短回答。\"}]}" \
  -o /dev/null -w "POST %{http_code}\n"
sleep 25

docker exec opencode-saas-test sh -c \
  'grep -E "Recorded compression start|Injected compress summary|totalTokensSaved" ~/.config/opencode/logs/dcp/daily/*.log | tail -5'
```

**期望**：

- 日志按顺序出现：`Recorded compression start`（模型调用 compress）→ `Injected compress summary | summaryLength>0`（视图替换）
- `Saved session state ... totalTokensSaved=N`（N > 0）
- PG 中 `data->'prune'->'messages'->'blocksById'` 出现压缩块（含 `topic`、`summary`、`anchorMessageId`）
- 会话对话不受影响：assistant 仍正常回复（旧内容以摘要形式保留在视图中）

### T-DCP.5 容器重启后 state 从 PG 恢复（L4）

```bash
docker restart opencode-saas-test && sleep 10
SID=$(cat /tmp/dcp-sid.txt)   # 复用 T-DCP.4 的会话
curl -s -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"providerID\":\"Yd-DeepSeek\",\"modelID\":\"deepseek-v4-flash\",\"parts\":[{\"type\":\"text\",\"text\":\"我之前让你记住的背景资料讲的是什么?\"}]}" \
  -o /dev/null -w "POST %{http_code}\n"
sleep 15

pgval "SELECT key FROM storage_data;"
docker exec opencode-saas-test sh -c \
  'grep -E "Loaded session state|Injected compress summary" ~/.config/opencode/logs/dcp/daily/*.log | tail -3'
```

**期望**：

- 重启后 `storage_data` 行仍在（PG 持久化，不随实例丢失）
- 日志出现 `Injected compress summary`（压缩视图从 PG state 重放，而非重新压缩）
- assistant 能通过摘要回答背景资料主题（信息经压缩块保留）

### T-DCP.6 关闭开关零副作用（L5）

```bash
docker rm -f opencode-saas-test
# 同镜像重建，但不设 OPENCODE_DCP_ENABLED（其余 env 不变）
docker run -d --name opencode-saas-test \
  -p 14096:4096 \
  -e OPENCODE_DATABASE_URL="postgresql://local@host.docker.internal:15432/opencode" \
  --env-file /tmp/opencode-saas.env \
  opencode-saas-sandbox-test:local-dcp serve --hostname 0.0.0.0 --port 4096
sleep 10

SID=$(new_sid)
curl -s -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"providerID\":\"Yd-DeepSeek\",\"modelID\":\"deepseek-v4-flash\",\"parts\":[{\"type\":\"text\",\"text\":\"hi\"}]}" \
  -o /dev/null -w "POST %{http_code}\n"
sleep 10

docker exec opencode-saas-test sh -c 'ls ~/.config/opencode/logs/dcp/ 2>/dev/null'
pgval "SELECT count(*) FROM storage_data WHERE key LIKE 'plugin/dcp/$SID%';"
```

**期望**：

- 对话正常（HTTP 200）
- 无 `~/.config/opencode/logs/dcp/` 目录（插件函数体未执行）
- `storage_data` 无该 session 的行
- 完成后恢复带开关的容器（见公共配置）

### T-DCP.7 与内置 compaction 并存（L6）

```bash
# 1) 确认内置 compaction 配置未被 DCP 改动（用户库语义不变）
pgval "SELECT data->'compaction' FROM session WHERE id='$SID';" | head -1

# 2) 存储完整性：DCP 压缩后 PG 历史仍完整
pgval "SELECT count(*) FROM message WHERE session_id='$SID';"
```

**期望**：

- DCP 压缩发生后 `message`/`part` 表行数不减（只读存储，压缩块仅存于 DCP state）
- 长会话下若触发内置 overflow compaction（需 usage 回报 + limit 配置），其摘要消息正常生成，DCP 在后续请求中安全跳过匹配不上的旧消息 ID（无报错）
- 单测基线保持：`bun test test/storage/ test/plugin/` 中除既有失败（pg-integration 4 fail，stash 验证与本次改动无关）外无新增失败

### T-DCP.11 删除会话时清理 DCP state（L10）

```bash
SID11=$(new_sid)
# 发长消息触发 state 写入（同 T-DCP.3）
# ... 发消息后确认 storage_data 有行 ...
curl -s -X DELETE "$BASE/session/$SID11" -o /dev/null -w "DELETE %{http_code}\n"
pgval "SELECT count(*) FROM storage_data WHERE key = 'plugin/dcp/$SID11';"
```

**期望**：DELETE 200 后 `storage_data` 中 `plugin/dcp/$SID11` 行数为 0（会话删除联动清理 state，`handlers/session.ts` 的 remove 内 `storage.remove` 实现，失败不阻塞删除）。

### T-DCP.8 多实例 state 共享（L7）

```bash
# 实例 B：同 DB、不同端口（先按公共配置完成实例 A 的压缩链路 T-DCP.4）
docker run -d --name opencode-saas-test-b \
  -p 14097:4096 \
  -e OPENCODE_DATABASE_URL="postgresql://local@host.docker.internal:15432/opencode" \
  -e OPENCODE_DCP_ENABLED=true \
  --env-file /tmp/opencode-saas.env \
  opencode-saas-sandbox-test:local-dcp serve --hostname 0.0.0.0 --port 4096
sleep 12

SID=$(cat /tmp/dcp-sid.txt)   # 实例 A 上已压缩的会话
curl -s -X POST "http://localhost:14097/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash","parts":[{"type":"text","text":"我刚让你记住的背景资料主题是什么?"}]}' \
  -o /dev/null -w "B-POST %{http_code}\n"
sleep 20

docker exec opencode-saas-test-b sh -c \
  'grep -E "Loaded session state|Injected compress summary" ~/.config/opencode/logs/dcp/daily/*.log | tail -4'
```

**期望**：

- 实例 B 日志出现 `Loaded session state from ... | sessionId=$SID`（A 写入的 state 从 PG 加载）
- `Injected compress summary` 出现，anchorMessageId 与 A 写入的压缩块一致（视图从 PG 重放，而非 B 重新压缩）
- B 正常回复

### T-DCP.9 自动策略：dedup 与 purgeErrors（L8）

前置：dcp.jsonc 增配 `"strategies": { "purgeErrors": { "enabled": true, "turns": 1 } }` 与低阈值 + `nudgeFrequency: 1`。

```bash
SID9=$(new_sid)
# 一条消息让 agent 依次：写文件 → 读同一文件两次(相同参数) → 制造一个失败命令 → 调用 compress
curl -s --max-time 240 -X POST "$BASE/session/$SID9/message" -H 'Content-Type: application/json' \
  -d '{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash","parts":[{"type":"text","text":"请依次完成(每步都要执行): 1) bash 写入 /workspace/dcp-demo.txt 2) read 读取该文件 3) 完全相同参数再读一次 4) bash cat /workspace/no-such-file-xyz (预期失败) 5) 调用 compress 压缩之前的工具调用过程,然后汇报"}]}'
sleep 90

docker exec opencode-saas-test sh -c \
  'grep -iE "deduplication|Marked .* duplicate" ~/.config/opencode/logs/dcp/daily/*.log | tail -3'
pgval "SELECT data->'prune'->'tools' FROM storage_data WHERE key='plugin/dcp/$SID9';"
```

**期望**：

- 日志出现 `deduplication: Marked N duplicate tool calls for pruning`（重复 read 被标记）
- `prune.tools` 非空（被剪工具 callID → token 数）
- 已知缺口：purgeErrors 的视图级断言（错误工具 input → `[input removed due to failed tool call]`）需请求级抓包，暂以「配置被接受 + 策略随 compress 运行无报错」为通过标准

> ⚠️ 避免让 agent read `/tmp` 下文件——远程沙箱对该路径的读取曾出现卡死（watchdog abort → 会话锁僵尸，属既有问题，见 `session/llm-stall-recovery.md`）。用 `/workspace` 下文件。

### T-DCP.10 compress 的 message 模式（L9）

```bash
# dcp.jsonc 改 "compress": { "mode": "message", ... } 后重启，继续会话：
curl -s -X POST "$BASE/session/$SID9/message" -H 'Content-Type: application/json' \
  -d '{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash","parts":[{"type":"text","text":"请调用 compress 工具,以单条消息为粒度压缩之前的工具调用过程。"}]}'
sleep 30

pgval "SELECT jsonb_extract_path_text(block,'mode'), substring(jsonb_extract_path_text(block,'summary'),1,80)
  FROM storage_data, jsonb_each(data->'prune'->'messages'->'blocksById') AS t(block_id, block)
  WHERE key='plugin/dcp/$SID9' ORDER BY block_id DESC LIMIT 3;"
```

**期望**：`blocksById` 最新块 `mode` 为 `"message"`（区别于 range），summary 以单条消息粒度生成；旧 range 块共存不受影响。

### T-DCP.12 收益基准：token、耗时与估算成本（L11）

使用相同模型、相同会话脚本和相同请求内容，分别执行 DCP 关闭与开启两组，至少各重复 5 次。不要直接比较不同模型或不同上下文长度的请求。

```bash
# A 组：不设置 OPENCODE_DCP_ENABLED，执行固定的长背景资料 + 3 轮追问
# B 组：设置 OPENCODE_DCP_ENABLED=true，使用相同脚本和低阈值触发 compress
# 两组分别保存 API 请求日志中的 inputTokens、outputTokens、durationMs

python3 - <<'PY'
import json
from pathlib import Path

baseline = json.loads(Path("/tmp/dcp-baseline-metrics.json").read_text())
dcp = json.loads(Path("/tmp/dcp-enabled-metrics.json").read_text())

def avg(items, key):
    return sum(item[key] for item in items) / len(items)

print("baseline_input_tokens", avg(baseline, "inputTokens"))
print("dcp_input_tokens", avg(dcp, "inputTokens"))
print("baseline_duration_ms", avg(baseline, "durationMs"))
print("dcp_duration_ms", avg(dcp, "durationMs"))
print("input_token_reduction", 1 - avg(dcp, "inputTokens") / avg(baseline, "inputTokens"))
print("duration_change", avg(dcp, "durationMs") / avg(baseline, "durationMs") - 1)
PY
```

成本按 provider 的实际价格计算：

`input_cost = inputTokens / 1_000_000 * inputPricePerMillion`

**期望**：

- B 组日志和 PG state 中 `totalTokensSaved` 大于 0
- B 组平均 input token 数低于 A 组
- 使用同一 provider 价格表计算后，B 组平均 input 成本低于 A 组
- 记录平均值和 p95 耗时；压缩后的 p95 耗时不应出现明显回归，若有回归需区分压缩 LLM 调用耗时与后续请求耗时

## 已知限制

- **config hook 裁剪**：内置版不注入 `experimental.primary_tools` 与宿主 permission 联动——compress 工具对 subagent 亦可见（但 DCP transform 在 subagent 默认跳过）；如需恢复原语义，在 opencode.jsonc 配 `"experimental": { "primary_tools": ["compress"] }`
- **TUI 裁剪**：`/dcp` 面板与 `/dcp-compress` 自动命令注册不可用（server 场景无影响；TUI 场景需手动配 command）
- **阈值默认值过小**：上游默认 min/max 5 万/10 万 token 是为小窗口模型设计；100 万窗口建议 `minContextLimit: 700000, maxContextLimit: 900000`
- **storage-pg 套件自建表**：只对 `opencode_test` 测试库安全；勿将 `OPENCODE_DATABASE_URL` 指向日常开发库跑 `test/storage/`（`pg-integration.test.ts` 会 DROP ALL TABLES）
- **token 估算偏差**：DCP 本地估算（@anthropic-ai/tokenizer）对 GLM/DeepSeek 有 ±10-20% 偏差，阈值语义为软提醒，可接受
- **purgeErrors 视图级断言待办**：策略随 compress 运行且配置生效，但「错误工具 input 被替换为占位符」发生在请求视图层，需请求级抓包才能断言
- **远程沙箱 read `/tmp` 卡死**：测试构造工具调用场景时，agent read 沙箱 `/tmp` 下文件曾卡死触发 watchdog abort（既有问题，非 DCP 引入）——工具场景用 `/workspace` 下文件

## 复测记录

### 2026-09-02 首测（本地 PG + 远程沙箱，镜像 local-dcp，deepseek-v4-flash）

| 用例                   | 结果                 | 备注                                                                                |
| ---------------------- | -------------------- | ----------------------------------------------------------------------------------- |
| T-DCP.1 单测（L0）     | ✅ 119 pass / 0 fail | DCP 测试 112 + storage-pg 7；typecheck 仅有仓库既有错误                             |
| T-DCP.2 加载（L1）     | ✅                   | `limit=1000000` 缓存、session 生命周期日志正常                                      |
| T-DCP.3 持久化（L2）   | ✅                   | `plugin/dcp/<sid>` 落 `storage_data`；`Saved session state to storage backend`      |
| T-DCP.4 压缩链路（L3） | ✅                   | 模型自主调用 compress（1916ms），压缩块 topic/summary 生成，`totalTokensSaved=1879` |
| T-DCP.5 恢复（L4）     | ✅                   | 库重建+容器重启后 state 从 PG 重放，`Injected compress summary` 复现                |
| T-DCP.6 开关（L5）     | ✅                   | 未设 env：无 dcp 日志目录、storage_data 无行、对话正常                              |
| T-DCP.7 兼容（L6）     | ✅                   | DCP 压缩后 message/part 行数不减；pg-integration 4 fail 为 stash 验证的存量基线     |

**结论**：DCP 内置插件全链路（加载→nudge→模型自主 compress→视图替换→state PG 持久化→重启恢复）验证通过；与内置 compaction 分层共存无冲突。

### 2026-09-02 二测（补充用例 T-DCP.8~11 + session 删除清理钩子，本地 PG + 远程沙箱）

| 用例                        | 结果                   | 备注                                                                                                                                         |
| --------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| T-DCP.8 多实例（L7）        | ✅                     | 实例 B（14097）从 PG 加载 A 写入的 state，A 的两个压缩块在 B 视图重放（anchorMessageId 一致），B 正常回复                                    |
| T-DCP.9 自动策略（L8）      | ✅（purgeErrors 部分） | `deduplication: Marked 1 duplicate tool calls for pruning`；`prune.tools={"toolu_c1f5...":61}`；purgeErrors turns=1 配置生效，视图级断言待办 |
| T-DCP.10 message 模式（L9） | ✅                     | `mode:"message"` 块生成（单条消息粒度），与旧 range 块共存                                                                                   |
| T-DCP.11 删除清理（L10）    | ✅                     | DELETE session 200 → `storage_data` 对应行归零                                                                                               |

- 产品代码新增：session 删除联动清理 DCP state（`handlers/session.ts` remove 内 `storage.remove(["plugin","dcp",sid])`，`Storage.node` 已在 server deps）
- typecheck：60（基线 worktree 验证 73，其中 handlers/session 11 个为存量；dcp 相关 0）
- 事故记录：验证过程中误将 pg-integration.test.ts（clean-slate，DROP ALL TABLES）指向开发库，本地库历史 session 数据丢失（详见已知限制的测试库警告）——新用例已固定使用 `opencode_test`

**结论**：补充用例全部通过；多实例共享（PG 化核心动机）、自动策略、双模式、生命周期清理均已覆盖。

### 2026-09-03 收益基准（T-DCP.12，本地 PG + 远程沙箱，5 组对照）

| 组别     | 样本数 | 两轮请求平均耗时 | session 累计 input tokens | provider cost |
| -------- | -----: | ---------------: | ------------------------: | ------------: |
| DCP 关闭 |      5 |            13.1s |                       891 |             0 |
| DCP 开启 |      5 |            85.7s |                     4,393 |             0 |

本次开启组的第二轮明确要求模型调用 `compress`，因此统计包含额外的压缩模型调用；DCP 日志显示每组生成了压缩块，`totalTokensSaved` 约 1,564～1,636，但不能将两组总耗时和累计 tokens 直接比较为收益。provider 当前未返回价格（`cost=0`），无法直接计算金额。

**结论**：T-DCP.12 的采集链路已验证，但收益结论暂不判定。正式对比应把压缩调用单独计列，并比较压缩完成后的下一次相同请求（稳态 input tokens、p95 延迟和按 provider 价目表换算的成本）。

### 2026-09-03 三测（本地 PG + 远程沙箱，镜像 local-dcp，deepseek-v4-flash）

| 用例                         | 结果                 | 本次证据                                                                                          |
| ---------------------------- | -------------------- | ------------------------------------------------------------------------------------------------- |
| T-DCP.1 单测与 PG 存储       | ✅                   | DCP 112 pass / 0 fail；storage-pg 7 pass / 0 fail                                                  |
| T-DCP.2 加载                 | ✅                   | HTTP 200；`limit=1000000`、session 生命周期日志正常                                                |
| T-DCP.3 持久化               | ✅                   | PG `plugin/dcp/<sid>`；`Saved session state to storage backend`                                     |
| T-DCP.4 压缩链路             | ✅                   | `Recorded compression start`、summary 注入；stats `compressionBlocks=1`、`activeCompressionBlocks=1` |
| T-DCP.5 重启恢复             | ✅                   | 重启后 HTTP 200；PG state 保留，日志从 `storage backend` 加载并重新注入 summary                    |
| T-DCP.6 关闭开关             | ✅                   | HTTP 200；无 DCP 日志目录                                                                              |
| T-DCP.7 兼容                 | ✅                   | DCP state 生成且 PG 会话历史未由 DCP 删除                                                            |
| T-DCP.8 多实例               | ✅                   | 实例 B HTTP 200；从 PG 加载 A 的 state 并注入多个 summary                                            |
| T-DCP.9 dedup/purgeErrors    | ✅（purgeErrors 部分） | 日志 `Marked 1 duplicate tool calls`；PG `prune.tools` 非空；视图级错误占位符仍未抓包               |
| T-DCP.10 message 模式        | ✅                   | PG `blocksById` 同时存在 `range` 与 `message` 模式块                                                 |
| T-DCP.11 删除清理            | ✅                   | DELETE HTTP 200；`storage_data` 对应行数为 `0`                                                       |
| T-DCP.12 收益基准            | ⚠️ 未重采集           | 保留上一轮结论；本次未重复 5 组稳态对照                                                                |

本次同时修正了 persistence 日志的来源标记：PG backend 加载不再误报为 `from disk`。测试结束后已恢复生产建议配置：`range` 模式、`minContextLimit=700000`、`maxContextLimit=900000`、dedup 开启、purgeErrors `turns=4`。
