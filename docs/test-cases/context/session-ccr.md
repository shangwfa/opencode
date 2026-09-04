# CCR（Compress-Cache-Retrieve 工具输出压缩）

> 借鉴 Headroom 的内容级压缩思路：在每次 LLM 请求前，对**大体积 tool output** 做确定性压缩（JSON / 日志 / 通用文本），原文存入 CCR 存储（PG `storage_data` 表），上下文中只留短 preview + `[ccr:<hash>]` marker，模型可随时调用 `ccr_retrieve` 取回原文。与 DCP（模型自主历史折叠）互补，DCP 兜底复杂历史，CCR 主攻高频大输出的确定性瘦身。

## 功能背景与效果

内置 compaction 整体摘要、DCP 按范围折叠，两者都以「历史消息」为对象；但 agent 会话中 token 大头往往是**单条 tool output**（read 全文件、bash 长日志、glob/mcp 大 JSON）。CCR 在消息视图层对这类输出做内容感知压缩：

| 能力                                              | 效果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 环境开关                                          | `OPENCODE_CCR_ENABLED=true` 注册内置插件；默认关闭，零开销                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 内容感知压缩                                      | 对照 Headroom 覆盖 **8.5/10 类**：JSON 数组（截断+itemCount+**query 相关性选 item**）、搜索结果（`file:line:content` 锚定+first/last/error+**query 评分**）、结构化配置（注释/空行折叠）、日志（error/fatal+**query 评分**）、**diff（hunk 头+变更行保、上下文行折叠 ≤2/hunk、≤10 hunk/文件）**、**表格（CSV/TSV/管道，列一致性检测+列名摘要）**、**HTML（剥 script/style/head/注释→文本）**、**代码（启发式：保 imports/装饰器/块开签名行，折叠函数体）**、通用文本 head+tail；全部本地确定性、零 LLM 成本、无收益 passthrough                                                                                           |
| 相关性评分                                        | 首轮固定版：用当轮 user query（word-overlap + CJK bigram）评分选保留项；replacement 与原文一起持久化，后续实例按 session+hash 复用完全相同的请求视图字节                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 内容恢复                                          | 不根据当轮 query 自动展开历史，避免历史在原文/marker 间翻转并破坏 provider prefix cache；需要原文时显式调用 `ccr_retrieve`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 代码语法安全                                      | Headroom CodeAwareCompressor parity：折叠后输出保持合法语法——保留块关闭行、折叠体用同语言注释占位（Python 额外 `pass` 保证空块可解析）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Savings 观测口径                                  | 不实现独立 savings 功能（Headroom 的 jsonl 账本+定价 CLI）：PG CCR entries 本身就是账本（并发安全、跨实例、随 session 清理），聚合用 SQL，定价人工乘 `opencode.jsonc` 固定模型单价。**每周观测 SQL**：`SELECT count(*), sum((data->>'originalTokens')::numeric) orig, sum((data->>'compressedTokens')::numeric) comp, round(100*(1-sum((data->>'compressedTokens')::numeric)/sum((data->>'originalTokens')::numeric)),1) pct, sum((data->>'retrievalCount')::numeric) rets FROM storage_data WHERE key LIKE 'plugin/ccr/%';` 缓存健康：`近7天 cache_read/(cache_read+input)`，突降=transform 链漂移警报（当前基线 93.4%） |
| 文本家族补齐（text-and-logs 对齐，Rust 源码为准） | ① diff `max_files=20`（超限文件只留 header 锚点）；② lines query-aware 分支：有 query 时按相关性摘录到 50% token（TextCrusher `target_ratio=0.5` parity），无 query 沿用 head+tail；③ log 四池选择：error（max_errors=10，首尾锚+query 排序）/warning（max_warnings=5 独立池+文本去重，不再挤占 error）/stack（≤3 trace×20 行，Python/JS/Go/Rust/Java opener）/summary（pytest/build 结算行全保）+ 每个保留 error 的 ±3 context 行。容器实证：pytest 大日志 log 5647→259（95%），grep 输出 search 3525→289（query 命中）。Kompress（ONNX ML）明确不做                                                                     |
| Search 全对齐                                     | 已核实 Rust 默认：5/30/15 + boost_errors + first/last 全一致，无改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 图像窗口降清                                      | Anthropic 协议按像素计费（(w×h)/750）：保护窗外的历史 image part（data URL）resize 到 ≤512×512（photon LANCZOS，-75% token/张），窗口内截图保持全保真。复用 opencode 已有 photon wasm 依赖（零新增），内容寻址缓存（进程内 LRU 200）保证每图只 resize 一次；任何失败原图透传。开关 `OPENCODE_CCR_IMAGE_ENABLED`（默认 true）。                                                                                                                                                                                                                                                                                            |

- **面积法**（优于 Headroom maxEdge）：预算是像素面积 512²（Anthropic 按 (w×h)/750 计费），任意长宽比恒定 ≈349 tok；200×1600 长截图 → 181×1448 而非 64×512 糊条。
- **意图 preserve**：细节类 query（读/数/精确/序列/对比/transcribe/count/exact/serial…）本轮跳过 resize——启发式替代 ML router。容器实证：细节 query 轮 0 resized，切普通 query 后 resize 3。**评估记录**：ML router（MiniLM/SigLIP）不追（Python ML 栈 vs TS 插件）；曾因测试环境图像占比仅 3.4% 挂起，用户决策实现——成本大头在长会话重发，窗口语义天然匹配「新图看细节、老图看意思」。容器实证：7 消息会话窗口推进后 `images: 1→2 resized`，保护窗内不动 |
  | Docstring FIRST_LINE | CodeAwareCompressor `DocstringMode.FIRST_LINE`（默认值）对齐：Python `"""`/`'''` docstring 的首行在折叠中保留（函数意图陈述是最有价值的被折叠上下文），其余行计入折叠。注：Headroom 用 tree-sitter AST 实现且作为可选依赖（`headroom-ai[code]`，~50MB），我们采用行级启发式等价于其 fallback 位。**AST 实现决策：不做**——① 骨架视图的消费者是 LLM 而非编译器，容错高；② CCR 的 retrieve 闭环兜底信息损失；③ 50MB 依赖 + transform 同步链延迟 + 镜像复杂度远超收益（Headroom 自己也把 AST 作为可选，fallback 启发式是官方支持模式）。**重新评估触发条件**（届时按语言渐进，TS/JS 可用 opencode 已有 typescript compiler API）：线上 rets 频繁且集中在 code 类 entry / 任务失败归因到折叠视图误导 / code 类 rets 分布显著异于其他策略 |
  | 日志 back-heavy | middle 尾部 10% routine 行保留（最近日志常携带结果）；ERROR 首尾锚定且总量最多 10，最后 5 行的 ERROR/WARN 不再被过滤 |
  | 保护窗口 | protectRecent 默认 **4**（Headroom protect_recent=4）：最近 4 条消息输出全保真，同时保证 retrieve 取回的内容在后续多轮可见 |
  | CCR 可恢复 | 原文按内容 hash 存 PG（key `plugin/ccr/<sessionID>/<hash>`），多实例共享；`ccr_retrieve(hash)` 工具取回 |
  | Headroom 对齐 | hash=SHA-256[:24]（96bit）、marker `Retrieve original: hash=`、entry 带 compressedTokens/item 数/retrievalCount、多 marker 幂等（含 `<<ccr:`）、miss 结构化 status+hint、可选 TTL、内存 LRU 1000 |
  | 幂等稳定 | 同内容同 hash 同替换字节 → 请求前缀稳定，利于 provider KV cache；含任一已知 marker 形态的输出不再二次压缩（防 hash 孤儿，Headroom #2694） |
  | 收益护栏 | `minTokens` 以下不动、最近 `protectRecent` 条消息不动、edit/write/question 输出不动、preview 需 ≥30% 缩减 |
  | 自适应 preview（方案 B） | 中等输出（< previewTokens×3 tok）的保留预算按自身 1/3 比例收缩（json/lines 两处），使低 `minTokens` 不侵蚀收益——每次压缩仍净省 ≈2/3；大输出预算不变。配合各压缩器 0.7 ratio 门槛，压不出收益的自动透传 |
  | JSON 三路压缩（SmartCrusher 行为对齐） | 按代码级核实（crates/headroom-core）补齐三项行为：① **Lossless-first**——同构数组（键集一致+标量值）重编码为 `ccr_table{columns,rows}`，全部 item 保留，字节节省 ≥15% 才采用（`lossless_min_savings_ratio=0.15`，注意文档写 30% 已过时），否则 fallback；② **keep/drop 五维优先级**——must_keep error（12 关键词硬约束：error/exception/failed/failure/critical/fatal/crash/panic/abort/timeout/denied/rejected）→ first 30%（5 个）→ last 15%（2 个）→ query 相关填充，总 cap 15；③ **dedup_identical_items**——归一化相同的 item 折叠为首现 + `unique_items` 计数。容器实证：uniform 300 item→table 全保留省 49%；400 重复→2 项省 99%；异构 error 数组 error 项必在保留集 |
  | 默认值 | `min_tokens_to_compress=250`、`protect_recent=4`、`DEFAULT_CCR_TTL_SECONDS=1800`、`max_items_after_crush=15`、`max_errors=10`。replacement LRU 1000、image LRU 200、diff context=2/hunks=10 |
  | TTL 语义变化 | `ttlSeconds` 默认从 0（随 session）改为 **1800**（Headroom session-scale）——条目 30 分钟后 retrieve 返回 expired+hint；需要跨长会话检索的场景显式设 `OPENCODE_CCR_TTL_SEC=0` |
  | PG 原文只读 | 压缩只改请求视图，`part.state.output` 原文始终留在 PG；session 删除时 CCR 条目同步清理 |

## 实现位置

| 模块                                                                       | 内容                                                                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `packages/opencode/src/plugin/ccr/`                                        | 内置插件（高内聚独立模块）：`index.ts` 入口 + `lib/{config,compressors,store,transform}.ts` |
| `packages/opencode/src/flag/flag.ts`                                       | `OPENCODE_CCR_ENABLED` 开关                                                                 |
| `packages/opencode/src/plugin/index.ts`                                    | `internalPlugins` 注册 + `EffectBridge` 桥接 `Storage.Service` 为 CCR 后端                  |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` | session remove 时清理 `plugin/ccr/<sid>` 条目                                               |
| `test/plugin/ccr-*.test.ts`                                                | L0 单测（compressors / store / transform 三套件）                                           |

## 配置

| 环境变量                      | 默认    | 说明                                                                                        |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| `OPENCODE_CCR_ENABLED`        | off     | 开关注册插件                                                                                |
| `OPENCODE_CCR_MIN_TOKENS`     | **250** | tool output 估算 token 低于该值不压缩（Headroom `min_tokens_to_compress=250` 对齐）         |
| `OPENCODE_CCR_PROTECT_RECENT` | 4       | 最近 N 条消息的输出保持原样（活跃上下文）                                                   |
| `OPENCODE_CCR_PREVIEW_TOKENS` | 300     | preview 的近似 token 预算                                                                   |
| `OPENCODE_CCR_TTL_SEC`        | 1800    | entry 过期秒数；设为 `0` 时随 session 保留。过期后 retrieve 返回 expired 状态并提示重跑来源 |

**Marker 格式**（Headroom 对齐）：

```text
[ccr:<hash>] (json) {"ccr_truncated":true,"total_items":148,"showing":3,"items":[...]}
[148 items compressed to 3. ~5200 tokens compressed to ~300. Retrieve original: hash=<hash>. Call the ccr_retrieve tool with this hash if you need the full content.]
```

TTL 启用时追加 ` Expires in 30m.`。幂等识别四种形态：`[ccr:`、`Retrieve original: hash=`、`Retrieve more: hash=`、`<<ccr:`。

## 验收层级

| 层级         | 用例     | 验证目标                                                                                                                                                                                                                                         | 状态                                  |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| L0 单元      | T-CCR.1  | 五套件单测：压缩器路由与误判防御、query 相关性、跨 session/实例稳定性、store 元数据/TTL/LRU/retrievalCount、transform 保护、图片预算与输入限制                                                                                                   | ✅ 97 pass / 0 fail（2026-09-04）     |
| L1 加载      | T-CCR.2  | env 开关注册插件、`ccr_retrieve` 工具暴露                                                                                                                                                                                                        | ✅ 容器实测（镜像 `ccr`，2026-09-03） |
| L2 压缩链路  | T-CCR.3  | completed 大 tool output（10KB 日志）在请求视图被替换为 `[ccr:<hash>]` marker，log 策略 6349→391 tokens（省 94%）                                                                                                                                | ✅ 容器实测                           |
| L3 取回      | T-CCR.4  | 模型真实调用 `ccr_retrieve` 拿到完整原文并回答细节                                                                                                                                                                                               | ✅ 容器实测                           |
| L4 持久化    | T-CCR.5  | CCR entry 落 PG `storage_data`（key `plugin/ccr/<sid>/<hash>`，含 strategy/tool/tokens/retrievalCount）                                                                                                                                          | ✅ 容器实测                           |
| L5 幂等      | T-CCR.6  | 多轮后同内容不重复建条目（同 hash 覆盖）；PG part 原文 25357 字符原封未动                                                                                                                                                                        | ✅                                    |
| L6 清理      | T-CCR.7  | 删除会话时 `plugin/ccr/<sid>` 条目同步清理（实测 3→0）                                                                                                                                                                                           | ✅ 容器实测                           |
| L7 开关      | T-CCR.8  | 未设 env 时插件不加载、零副作用                                                                                                                                                                                                                  | ✅（无插件容器对照实验）              |
| L8 多实例    | T-CCR.9  | 实例 B 从 PG 复用实例 A 持久化的 replacement，并可取回 A 存的原文                                                                                                                                                                                | ✅ 修复镜像双实例 + 真实 PG           |
| L9 收益基准  | T-CCR.10 | **provider 真实 usage 对比：未压缩轮 input=16591 tok → 压缩后 271~734 tok（省 95.6%）**；retrieve 轮 8254（原文取回预期内，下轮再折叠）                                                                                                          | ✅ 容器实测                           |
| L10 异常路径 | T-CCR.11 | 错误 hash → not_found + 「重跑来源」hint；TTL 过期（注入过去 expiresAt）→ expired + 「不要重试同 hash」hint                                                                                                                                      | ✅ 容器实测                           |
| L11 兼容     | T-CCR.12 | 与 DCP 同开：**CCR 必须先于 DCP 注册**（plugin/index.ts 顺序已固化）——DCP 的 injectMessageIds 会向 tool output 尾部追加 `<dcp-message-id>` tag，污染整体解析型策略（JSON）的输入；CCR 先行则始终基于 PG 原文视图压缩。容器实测 6 类策略全压缩 ✅ | ✅                                    |
| L12 重启恢复 | T-CCR.13 | CCR 重启后从 PG 读取持久化 replacement，同 session+hash 注入相同 marker 字节                                                                                                                                                                     | ✅ 独立容器进程读取验证               |
| L13 延迟     | T-CCR.14 | transform 压缩耗时（10KB 输出，毫秒级，无感知延迟）                                                                                                                                                                                              | ✅（请求无延迟劣化）                  |

> **复测方法**：不依赖沙箱工具执行——直接向 PG seed 一条 `status=completed` 的大 output tool part（模拟历史工具调用），发消息触发 transform。CCR 是纯消息层功能（内存视图压缩 + PG storage_data），与沙箱无关。
>
> **测试期间发现的环境问题**（与 CCR 无关，见会话记录）：远端沙箱 172.18.32.15:30040 间歇性 `Sandbox.create` 超时；bash/read 工具 stream 路径输出 >~1KB 挂起且换行被转义为字面 `\n`（exec API 正常）；旧镜像代码导致容器首次验证未触发。

## 公共配置

> **镜像默认开启**：Dockerfile 已内置 `ENV OPENCODE_CCR_ENABLED=true`（与 DCP 同待遇），容器无需额外传参。
> 生产阈值即代码默认值，已与 Headroom 默认配置全量对齐（`minTokens=250`、`protectRecent=4`、`ttlSeconds=1800`、自适应 preview），零 env 配置即生效；需微调时用下表 env 覆盖。

```bash
source docs/test-cases/test-env.sh 3 && source docs/test-cases/test-lib.sh

# 测试期调低阈值让短会话也能触发（容器测试标准命令）：
docker rm -f opencode-saas-test
docker run -d --name opencode-saas-test \
  -p 14096:4096 \
  -e OPENCODE_DATABASE_URL="postgresql://local@host.docker.internal:15432/opencode" \
  -e OPENCODE_DCP_ENABLED=true \
  -e OPENCODE_CCR_ENABLED=true \
  -e OPENCODE_CCR_MIN_TOKENS=200 \
  -e OPENCODE_CCR_PREVIEW_TOKENS=300 \
  --env-file /tmp/opencode-saas.env \
  opencode-saas-sandbox-test:<tag> serve --hostname 0.0.0.0 --port 4096
```

## SaaS 按会话观测

```sql
-- CCR 条目数与原文 token 统计
SELECT key, data->>'tool' AS tool, data->>'strategy' AS strategy,
       (data->>'originalTokens')::numeric AS original_tokens
FROM storage_data
WHERE key LIKE 'plugin/ccr/%'
ORDER BY time_updated DESC LIMIT 20;
```

## 已知限制

- 压缩发生在请求视图层：`session.messages` API 返回的仍是 PG 原文；与 DCP 行为一致。
- 日志/文本截断保留 head+tail 与 error 行，中间内容需 retrieve 取回——模型按 marker 提示自行决策。
- CCR preview 对 provider 是稳定前缀字节，但首次替换该输出时仍会使该点之后缓存失效（与 DCP prune 同级影响）。

## 缺陷回归用例（2026-09-04 审查）

> 本组用例遵循“先复现、再修复、最后复测”。L0 使用纯内存 backend，不依赖模型和沙箱；L2/L4 在镜像重建后复核请求视图与 PG。生产费用不作为自动化断言，改用“相同历史生成相同字节”作为 provider prefix cache 的必要条件。

| 编号     | 问题与复现断言                                                                                                   | 修复验收                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| T-CCR.15 | 两个 session 压缩相同原文；修复前 B 命中进程缓存但没有 `plugin/ccr/B/<hash>`，`retrieve(B)` 返回 `not_found`     | replacement 缓存按 session 隔离，A/B 均可取回                        |
| T-CCR.16 | backend 首次 write 抛错；修复前仍返回 marker，且第二次命中缓存不重试                                             | 写失败透传原文（返回 `undefined`）；后续调用重试写入并可 retrieve    |
| T-CCR.17 | 两个 `CcrStore` 模拟两个实例，以不同 query 压缩同一 session/原文；修复前 preview 不同                            | entry 持久化 replacement；后续实例先读 backend，marker 字节完全一致  |
| T-CCR.18 | query 相关/不相关两轮使用同一历史；修复前 proactive expansion 使历史在原文/marker 间翻转，并且每轮 list 全量条目 | 不按 query 改写既有历史；CCR backend 不再暴露 `list`，无全量读取路径 |
| T-CCR.19 | 日志最后 5 行放置最新 ERROR/WARN                                                                                 | 压缩 preview 必须保留最新 ERROR/WARN；普通长文本不得误路由为 log     |
| T-CCR.20 | hunk 内删除内容以 `-- ` 开头，diff 行变为 `--- text`                                                             | 不得将其误判为文件头，后续 `+` 变更行必须保留                        |
| T-CCR.21 | 连续处理超过 200 张不同小图；另传超长 data URL                                                                   | image cache 始终 `<=200`；超限输入在 hash/Base64/WASM 解码前拒绝     |
| T-CCR.22 | 同一图片先以大预算调用、再以小预算调用；另测极窄长图                                                             | cache key 包含预算；输出面积严格 `<=maxPixels`                       |
| T-CCR.23 | 设置 `OPENCODE_CCR_TTL_SEC=0`                                                                                    | `loadCcrConfig().ttlSeconds === 0`                                   |
| T-CCR.24 | 中文普通技术 query“分析数据/检查函数/解释参数”配历史图片                                                         | 不触发细节保真；明确的“数一下按钮/看清文字”仍保真                    |
| T-CCR.25 | 中文与 ASCII 等长文本调用 `estimateTokens`                                                                       | CJK 按字符保守估算，ASCII 保持约 4 chars/token                       |

L0 命令：

```bash
cd packages/opencode
bun test test/plugin/ccr-transform.test.ts test/plugin/ccr-compressors.test.ts \
  test/plugin/ccr-image.test.ts test/plugin/ccr-retrieve.test.ts test/plugin/ccr-store.test.ts
```

修复前最小复现记录：

| 日期       | 版本                    | 结果                                                                                                                                                                                                                                  |
| ---------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-04 | 修复前工作树            | 现有 87 pass；额外脚本确认：跨 session `marker=true/sessionBStored=false/retrieve=not_found`；双实例不同 query `different=true`；最新 ERROR/WARN 丢失；diff 后续新增行丢失；`TTL_SEC=0` 实得 1800                                     |
| 2026-09-04 | 修复后工作树            | 97 pass / 0 fail；T-CCR.15～25 的 L0 断言全部通过                                                                                                                                                                                     |
| 2026-09-04 | 镜像 `ccr-fix-20260904` | digest `sha256:81542a27...`；实例 A/B（14097/14098）均 healthy，均暴露 `ccr_retrieve`；真实 PG 双实例 marker SHA-256 同为 `8c205fc3...4776ae`，B retrieve `available` 且原文一致；跨 session 同原文落 2 条独立 entry，B retrieve 成功 |

真实 PG 条目核验：

| 场景             | JSONB 类型 | strategy | original chars | replacement chars | retrievalCount |
| ---------------- | ---------- | -------- | -------------: | ----------------: | -------------: |
| 双实例同 session | object     | lines    |          10719 |              5432 |              1 |
| 跨 session A     | object     | json     |          60391 |              1123 |              0 |
| 跨 session B     | object     | json     |          60391 |              1123 |              1 |
