# Context Insights：SaaS 原生能力交付与验收

## 当前交付范围

原生集成于 OpenCode SaaS，不依赖 DeepSeek Harness 或 Cordis。三阶段全部交付：采集与 API、分析 API、`packages/hn-app` 可视化。

自由对话 V1→V2 迁移（本轮）：创建/列表/发送/中止/事件流/模型目录改走 V2（`/api/session`、`/prompt`、`/interrupt`、`/api/event`、`/api/model`），消息时间线新增 `adaptV2Messages` 适配（`{type, content}` → `{message, parts}`）；首页健康检查改打 `/api/info`；下拉框改为自绘 chevron 的 `Select`。

对照原项目补齐轮：附件卡片、工具结果与调用参数配对、每类别独立搜索、文件操作日志与合计、事件来源/轮次、压缩事件标记、趋势总览带与横向滚动、总览近 7 天图与组成合计、Fleet 卡片窗口占用/请求数/血缘配色/悬停详情、偏好（trendView/deltaBase/toolSort/insightsEntry），以及首页健康检查端点修正。

补充交付（不改核心契约）：工具来源标注（`mcp:<server>` / `session`，见「口径与边界」）、上下文事件类型筛选、文件活动动作筛选与行数增减、组成条「输出预留 / 剩余可用」条纹、技能目录来源标注、压缩请求逐点 usage 关联、偏好项（默认时间范围、面板位置、家族标签显隐、文件排序）。

### 采集与内容 API

| 接口 | 返回内容 |
| --- | --- |
| `GET /api/session/:sessionID/context-insights` | 已采集请求数、最近请求摘要；没有历史时返回零与 null |
| `GET /api/session/:sessionID/context-insights/requests?limit=20&before=<next>` | 按事件序号倒序分页，limit 范围 1–100，不携带正文 |
| `GET /api/session/:sessionID/context-insights/requests/:requestID` | 请求摘要及有序内容清单 |
| `GET /api/session/:sessionID/context-insights/requests/:requestID/items/:index` | 单项正文；超限省略项返回 null 与原因 |

### 分析 API

| 接口 | 返回内容 |
| --- | --- |
| `GET /api/session/:sessionID/context-insights/analysis?limit=100&before=<next>` | 每次模型调用的请求点（含轮次、delta、状态、实际 usage、耗时区间）、上下文事件、文件活动；`scope: request-page` 与 `eventsTruncated` 明确可观测边界 |
| `GET /api/session/:sessionID/context-insights/family` | 沿父级链路的 Agent 家族成员（不含 fork）；成员含累计 usage、最近请求组成 |
| `POST /api/context-insights/overview` | 显式授权会话集合的每日 Token/成本（UTC 结算事件归因）、会话卡片、时间范围；`attribution: settlement-utc`、`coverage: available-durable-events` |

### 前端（`packages/hn-app`）

| 入口 | 内容 |
| --- | --- |
| 侧边栏「上下文洞察」/ `/context-insights` | 跨会话总览：KPI、每日用量热力图、会话卡片、搜索/排序/日期筛选 |
| `/session/:sessionId` 或 `/free-chat/session/:sessionId` 右侧「上下文」按钮 | Context 标签页：组成、趋势（Step/Turn、Total/Delta）、请求浏览器（分类/排序/DNA 顺序 + 逐类别 vs 上一轮 diff 徽标）、上下文事件、文件活动、Agent 家族（SVG 关系网络图：父子连线、悬停高亮链、运行态脉冲）；中文/英文；大屏侧栏内嵌、小屏对话框 |
| 自由对话输入 `/context` | 快捷打开当前会话的上下文面板 |

沿用 `GET /api/session/:sessionID/event` 发布 `session.context.captured`，事件仅携带请求摘要。接口继承现有会话访问边界；请求及内容查询始终同时限定 sessionID，不能凭 requestID 或哈希跨会话读正文。

Schema、Protocol/OpenAPI、Promise/Effect 客户端已同步。生成客户端时也同步了此前已在源码中存在、但生成物尚未同步的接口，不代表本次新增了这些业务功能。

## 采集口径

- 主请求、标题、生成、压缩在实际模型调用前采集，返回 `boundary: model-call-semantic-request`。
- prepare 本身不产生快照；插件直接提供结果、没有调用模型时，不产生虚假的模型请求快照。
- 压缩的最终摘要指令、修正指令及重试分别采集。主请求关联 assistantMessageID；每次采集有独立 requestID。
- 这是提供给 LLM 客户端的语义请求，不是 provider 编码、HTTP/WS hooks 或底层传输自动重试后的线上报文。
- 组成采用 `text-characters-div-4` 启发式估算，包含固定结构开销，绝不是精确 tokenizer 或计费数字。缺失图片、加密/原生内容、超限项会设置 incomplete；估算不能据此冒充完整上下文占用率。
- 现阶段分类为 system、tools、user、inject、assistant、tool；技能来源细分留待下一阶段。
- 工具来源只标注**可从持久化会话状态准确判定**的两类：`mcp:<服务器名>`（按注册表同名规则 `<server>_<tool>` 前缀匹配）与 `session`（会话自定义工具精确匹配）。其余工具（内置与插件）在注册表中不可区分，保持不标注，界面不显示来源而不是猜一个。来源解析是 `context-origin.ts` 纯函数，只读 `session_mcps` / `session_tools`，不修改工具注册表或 `Tool.Snapshot` 契约。
- 组成条在已知模型上下文窗口时，按窗口画底并在末尾叠加条纹的「剩余可用」区域；窗口未知时退化为按已估算用量铺满，且不显示剩余量。
- 实际 Token/成本仍由现有结算链路维护，本功能不重复累计。

## 存储与容量

- `session_context_request` 保存摘要、有序清单与关联事件序号。
- `session_context_content` 以 `(session_id, hash)` 去重正文；不跨会话共享内容读取入口。
- 每项最多保留 256 KiB，单次采集最多保留 4 MiB 去重正文、2,000 个清单项。超限显式标注，不静默冒充完整内容。
- 不复制图片/base64、加密推理、provider 元数据、HTTP 头或 provider 配置；用户消息/工具结果本身仍可能包含敏感业务内容，遵循会话正文相同的授权要求。
- 摘要事件与快照通过 Bus commit 在同一 PG 事务内写入；回滚不留下半份快照。重放摘要不重复写快照。
- 正文不是事件摘要的可重建投影；备份/恢复必须包含上述两张表。现有会话导出格式尚未扩展为携带这些快照。
- 目前按会话生命周期保留，删除会话级联删除快照与正文；尚未提供独立 TTL/清理策略。正式大流量上线前需要明确保留政策与容量预算。
- 上线前的历史请求不伪造还原，摘要声明 `history: captured-requests-only`。

## 已执行验证（2026-10-23）

### 自动测试

核心重点回归覆盖采集、请求 hooks、主运行器、普通/原生压缩、标题、生成及 Bus。另执行专用 PG 测试、HTTP 路由/SSE 测试、分析折叠纯函数测试、Schema 测试、hn-base-server 网关鉴权测试、hn-app 组件测试与类型检查。具体数量以本轮执行日志为准，不将未运行的全仓库测试算作通过。

本轮结果：核心重点回归 144/144、PG 8/8、Server HTTP/SSE 1/1（扩展断言至 36 项）、分析折叠纯函数 4/4、新增 Schema 测试 2/2、hn-base-server 网关 84/84、hn-app 组件 3/3。

补充轮（工具来源 / 行数增减 / 压缩 usage / 技能目录 / 输出预留 / 偏好）：context 相关核心 24/24（含新增来源纯函数、快照 origin、折叠行数与压缩结算用例）、PG 1/1（新增工具来源断言）、Schema 2/2、Server HTTP 1/1、hn-base-server 网关 3/3、hn-app 组件 9/9 与全量 527/528（唯一失败为既有 `route-repo.test.ts > detects unsupported preview appId`）；core / schema / server / hn-base-server / hn-app 类型检查通过，hn-app 生产构建通过（`context-insights` 5.82 kB、`session-insights` 10.96 kB、`views` 116.48 kB 仍为独立懒加载 chunk）；本地真实 SaaS + 同一 e2e 脚本 17/17。Core、Server、Client、hn-app、hn-base-server 类型检查通过，hn-app 生产构建通过（context-insights 相关 chunk 独立懒加载），数据库迁移对齐和 Protocol 生成物校验通过。

主要用例：

1. 角色与 namespace 分类、估算、UTF-8 容量边界、单项/总量/项数限制。
2. 图片、加密内容、provider 元数据隔离，循环工具参数降级。
3. 重复正文只存一次，但每次请求的 Token 贡献分别保留。
4. PG 事务失败回滚；摘要重放不重复采集；会话删除级联清理。
5. 两个独立服务实例并发采集 12 次，跨实例读取与分页、正文去重均正确。
6. HTTP 参数校验、空态、404、跨会话正文隔离、SSE 摘要无正文。
7. 准备请求不自动采集，最终调用传入的修改后请求才被记录。
8. 分析折叠：并行工具耗时按区间并集不重复扣减；请求点只关联匹配 assistantMessageID 的结算事件；缺失 usage 为 unknown 而非伪造零；Code Mode 嵌套调用计入文件活动；搜索目标标注 scope 而非命中文件；上下文事件不回显指令文本。
9. 网关鉴权：私有会话的任何 context-insights 路径在触达上游前即 404；家族返回时移除不可见成员的标题、成本、父标识与根标识；总览 scope 由服务端授权派生而非信任客户端传入的 sessionIDs；非法时间范围 400。
10. 组件：上下文浏览器正文按需加载且展开前不取正文；不可信内容渲染为纯文本不执行脚本；过期在途响应不会覆盖新会话数据；偏好设置拒绝未知值；缓存命中率分母不含输出 Token。
11. 工具来源：快照只给 `source` 回调命中的工具打标签；`mcp:<server>` 取最长服务器前缀、`session` 精确匹配且按注册表规则做字符替换；PG 用例断言同一次请求内 `docs_search`=`mcp:docs`、`deploy`=`session`、`read` 无来源。
12. 事件与文件筛选：按事件类型、按文件动作（读取/写入/搜索）与路径关键字筛选保持各自维度；文件排序（最近/调用次数/路径）只重排不丢项。
13. 行数增减：`write` 取 `content` 行数；`edit` 取 `newString`/`oldString` 行数；`patch` 按分段统计 `+`/`-` 行并跳过 `*** `/`@@` 结构行；`read` 与未提供内容的输入**不产生 0**，而是不显示。
14. 压缩请求 usage：每个压缩请求点取「自身采集时间之后的第一条 `compaction.ended|failed`」，因此同一页多次压缩各取各的用量；主请求不会借用压缩结算。
15. 技能目录：仅当文本同时包含渲染器的目录前言与 `<available_skills>` 标记时才标为技能目录，避免把引用其中一个标记的用户文本误标。
16. 输出预留：模型声明的输出上限记入 `outputReserve`，组成条按 `estimated + outputReserve + remaining = contextWindow` 分段；窗口未知时不显示这两段。

扩展回归发现子会话标题测试只插入子会话、未插入其声明的父会话，资源继承查询因此失败；已补齐该测试夹具并复验，没有放宽生产代码的父会话检查。

### Docker / API / SSE / PG

执行器：`docs/test-cases/scripts/session-context-insights-v2.mjs`。

以两个 Docker SaaS 容器连接专用 `opencode-v2-test` PG，使用确定性 OpenAI-compatible 模型响应；独立订阅会话 SSE 实时观察两轮对话及压缩过程。该模型故意返回不符合压缩模板的文本，以触发第二次修正请求。

补充轮复跑（本地 `opencode serve` + 隔离 HOME + `OPENCODE_EVENTS_PERSIST=1`，同一 PG 与同一脚本）达到 **17/17**：新增两项断言——压缩请求按自身结算归属（最后一次尝试拿到用量，早期尝试保持 `unknown` 不伪造）、模型声明的输出预留随请求落库且不超窗口。此轮同时暴露并确认了一个**本地运行前提**：CLI 起的服务必须设 `OPENCODE_EVENTS_PERSIST=1`，否则事件不入库、分析接口取不到事件（请求点全部退化为 `unknown`），这是环境配置而非代码缺陷。

首次 Docker 交付时最终 **16/16** 验收通过。另独立镜像 `opencode-saas:context-insights-20261023`（2.06GB）**构建成功**——先前 `no space left on device` 系 OrbStack 磁盘不足，清理构建缓存后重试即通过；视觉验证使用该镜像起免鉴权实例。

- 两轮主请求与两轮压缩调用，对应 **4 次模型调用、4 份快照、4 条通知事件**。
- 快照包含 prepare 后追加的摘要和修正指令；修改指令不覆盖历史快照。
- 分析接口把每次模型调用映射为一个请求点；主请求状态 completed 且带实际 usage，压缩请求状态 completed/failed；delta、turn、耗时区间、事件、文件活动齐全。
- PG 保留 24 项去重正文，实际用量累计 528 Token，与 fixture 的四次 132 Token 响应一致。
- 默认 Code Mode 的 `execute` schema 在模型输入及快照工具组成中可见。
- 另一容器能读取同一请求正文；跨会话访问 404，未认证访问 401。
- 家族只含本会话且 rootID 正确；总览按 UTC 结算事件归因、拒绝非法时间范围。

证据目录：`/private/var/folders/zk/8qd0lv657wn8kvpp__hwjj400000gn/T/opencode/context-insights-20261023/e2e-phase2-rerun/`，包含 `result.json`、`events.json`、`provider-requests.json`。

发现并修复：初版在 prepare 采集，导致 4 次模型调用只记录 3 份快照；现已下移至调用边界，并增加调用数一致与最终指令内容的回归断言。分析 PG 查询需为重复 JSON 表达式加显式列别名，否则驱动层取值错位。

### 浏览器视觉验证（2026-10-23）

起免鉴权 SaaS（`OPENCODE_PASSWORD` 由 CLI 生成，经 agent-browser init script 注入 Basic 鉴权头，不改生产代码）+ mock 模型生成真实上下文数据（2 轮对话 + 压缩，4 个请求快照），`hn-app` dev server 直连。用 agent-browser 在 1440 / 768 / 390 三档宽度、中英双语下截图核验。

- 跨会话总览：KPI、每日用量热力图、会话卡片组成条与图例、搜索/排序/日期筛选在各宽度下正确折叠，**390/768/1440 均无横向溢出**。
- 会话 Context 标签页：5 个标签（组成与趋势、上下文浏览器、Agent 家族、上下文事件、文件活动）、请求选择器、组成条、堆叠趋势图、耗时指标全部渲染。
- 英文标签（截断压力用例）在图例中允许换行但不重叠、不截断。
- 修复一处 390px 瑕疵：KPI 数值从 `break-all` 改为 `whitespace-nowrap`，避免 `$0.000512` 在数字中间断行；修复后三档宽度复验无溢出、数值单行。

截图证据：`/private/var/folders/zk/8qd0lv657wn8kvpp__hwjj400000gn/T/opencode/context-insights-20261023/visual/`（overview-{1440,768,390}-zh、overview-1440-en、session-1440-en、overview-390-zh-fixed）。

## 验证限制

- 本地 OpenSandbox 控制面端口 30040 不可达，且无仓库内启动脚本（属外部服务），本轮未执行真实沙箱工具，结果明确记录 `sandboxExecutionVerified: false`。Code Mode 的 schema 验证不等于沙箱执行验证。此项仍待 OpenSandbox 环境恢复后补做。
- SDK 嵌入式包类型检查/构建未通过：`packages/sdk/src/internal/host.ts:35`、`packages/sdk/src/effect/opencode.ts:36` 两处，且连带 `packages/connector` 十余处 TS 兼容错误（Uint8Array、fetch preconnect、ReadableStream）。**均为既有问题，非本次改动引入**（本次仅在 `packages/sdk/src/contracts.ts` 加一行 re-export），属 monorepo 范围 TS 版本兼容，不在本次交付范围；未为修复而改动无关的连接器/嵌入式宿主代码。
- hn-app 全量 vitest 中 `route-repo.test.ts > detects unsupported preview appId` 为既有失败（文件未被本次改动触及），不属本次回归。
- 工具来源标注的已知边界：MCP 前缀匹配理论上会把恰好以 `<server>_` 开头的内置/插件工具误标为该 MCP 服务器（例如存在名为 `ccr` 的 MCP 服务器时的内置 `ccr_retrieve`）。这是为避免改动工具注册表契约而付出的代价，已在徽标文案上限定为「MCP <server>」并在本文档记录；若后续需要零歧义，须在注册表快照层携带 source 元数据。
- 压缩请求的结算归属：一次压缩若发生模板修正，`compaction.ended/failed` 只出现在最后一次尝试之后，因此早期尝试显示 `unknown`（不借用后一条结算）。这是当前事件模型的真实边界，未做跨尝试摊派。
- 仍未覆盖：插件 vs 内置工具的区分（工具注册表不携带归属信息，需扩展注册表契约，已按"不动核心逻辑"决定不做，界面保持不标注）；压缩**阈值**（compaction 触发比例）未作为独立条纹预留，只画了模型声明的输出预留与剩余窗口；行数增减是**请求侧**改动量（`edit` 的 `newString/oldString`、`patch` 的 `+`/`-` 行），不是应用后的真实 diff；时间轴上的注入/压缩精确时间点仍待补。
- 全量 core 单测用 `bun run test`（`script/test.ts`）跑出 6014 pass / 111 skip / 12 fail。12 个失败全部落在 Config 迁移、MCP 连接、Session.move/remove、Watcher、shell 扫描、原生窗口解码、SSE 触发恢复等模块，这些模块的源码与测试在本次工作区**均无改动**（`git diff` 为空），也不经过 context-insights 代码路径；本轮未采集"干净 HEAD 全量绿"的基线，故只声明其不在本功能范围内，不声明其历史上为通过。注意：直接用 `bun test` 会因缺失 HOME/XDG 隔离与 `OPENCODE_CODEMODE_EXECUTOR` 覆盖而产生十余个假阳性，必须以 `bun run test` 为准。
