# 未实现功能清单（2026-10-24 审核）

审核方式：按代码事实逐条核对（不是靠记忆）。每条给出**证据位置**与**性质**（缺口 / 有意不做 / 环境受限）。

---

## 一、上下文洞察（对比 dsh-context）

### 1. 明确未实现

| 功能 | 现状证据 | 性质 | 说明 |
| --- | --- | --- | --- |
| **Live：下一个请求预览** | `grep labels.live` 在组件中无任何使用 | 缺口（需核心开口） | 需要调用 `SessionModelRequest.prepare` 组合"未发送"的请求。prepare 会触发 session hooks 并分配标识，旁路调用会污染真实执行状态，因此未做。要做需在 prepare 增加 dry-run 开关。 |
| **图片（Images）类别** | `FileActivity.action` 只有 `read\|write\|search`；事件流只带工具入参 | 缺口（数据不可得） | 图片读取的结果内容不在事件里；按扩展名猜测会误判。当前以「附件」筛选项呈现快照里的 media 项。 |
| **技能独立类别** | `Item.origin === "skills"` 仅作为标签 | 部分 | 原项目是独立 `Skill Injections` 类别；我们复用了 6 类分类并打标签，未单列类别。 |
| **DNA 的「引入步骤」列与分组收尾** | `RequestBrowser` 的 dna 模式只是平铺 + `#序号` | 部分 | 缺少"该内容首次出现在第几次请求"（需要跨请求按 hash 比对，当前只加载单请求详情）与工具/系统提示分组行。 |
| **趋势图悬停联动浏览器** | 只有点击选中，无 hover 预览 | 部分 | 原项目 hover 可预览、移出恢复；我们的实现是点击选中。 |
| **Fleet 卡片运行时长** | 卡片展示 Token/成本/窗口占用/请求数，无时长 | 缺口 | 需要在 card 查询里补 `time_created` 与运行区间。 |
| **总览时间范围「今天 / 全部」** | `[7, 30, 90]` 硬编码 | 部分 | 原项目有 today / 7d / 30d / all。 |
| **每页自动步骤上限（overviewAutoSteps）** | 无 | 不适用 | SaaS 无"每页自动步骤"概念，固定 500 会话上限。 |
| **Prune / 计划模式事件** | `ContextEvent.type` 只有 compaction/inject/skill/model/agent/execution | 不适用 | 本仓库没有 prune / plan-mode 事件可采，不伪造。 |
| **事件 Token 净变化** | 已实现（压缩前后请求估算差） | — | 仅压缩事件有；其它事件没有 token 增量数据。 |
| **插件 vs 内置工具来源** | `Tool.Snapshot.definitions` 是扁平 `ToolDefinition[]` | 有意不做 | 需扩展工具注册表契约（用户已明确不动核心逻辑）。界面保持"不标注"。 |

### 2. 已完成（本轮及之前，勿重复开发）

步骤摘要三行、事件来源/轮次、压缩事件标记、趋势总览带/横向滚动、时长曲线、附件卡片与筛选、工具结果与调用参数配对、每类别独立搜索、文件操作日志与合计、文件预览跳转、搜索结果按文件归因、输出预留条纹、Fleet 组成条/窗口占用/血缘配色/悬停详情、偏好（placement/fleetTab/overviewRange/fileSort/trendView/deltaBase/toolSort/insightsEntry/durationCurve）。

---

## 二、自由对话 / 会话壳（V1→V2 迁移）

| 功能 | 现状 | 证据 | 性质 |
| --- | --- | --- | --- |
| 会话创建/列表/消息/发送/中止/事件流/模型目录 | 已迁移 V2 | `lib/rest.ts` 全部 `/api/...`；`adaptV2Messages` 适配消息形状 | 完成 |
| 消息时间线渲染 | 已适配 `{type, content}` → `{message, parts}` | 同上 | 完成 |
| 流式重复 / 卡"思考中" | 已修（part id 对齐 + `time.end` + 合并优先级） | `mergeStreamedParts`、`adaptV2Messages` | 完成 |
| 失败提示 | 已修（`assistant.error` → 红色气泡） | `adaptV2Messages` | 完成 |
| **斜杠命令（`/xxx`）** | 已迁移：`commandList()` 读 `/api/command`，`sessionCommand()` 转成 V2 `{name,text,files}`，自由对话匹配后执行 | `lib/rest.ts`、`free-chat.tsx` | 完成（`/init`、`/review` 实测 204 + 注入命令提示词） |
| **附件/图片发送** | 本轮补：`file` part → V2 `files: [{uri,name}]` | `sessionPromptAsync` | 已补，未做图片链路实测 |
| 工具调用渲染 | 已用真实工具调用验证（网关模式一次对话出现 `skill` / `websearch` / `webfetch`） | `session-messages.ts` | 完成 |
| `/file/content`（V1） | `fileContent()` 仍打 V1 路径 | `rest.ts:343`、`requirement-chat.tsx:79` | **缺口**：V2 应走 `/api/session/:id/fs/read/...`；预览在纯 SaaS 形态下可能 404 |
| `sessionStatus` | 仍映射 `/api/session/active`，但无调用方 | — | 死代码，可删除 |
| SDK 直连分支（`client.promptAsync`） | 所有页面调用方都传 `sessionSource().sendMessage`，该分支仅在"带 userInfo 的 SDK 模式"命中 | `submit.ts:174-193` | 未使用路径，暂不迁移 |
| 服务器 401 时 `/api/event` 重试风暴 | 未处理 | `docs/console-free-tier-403-fix.md` 遗留 | 缺口（低优先级） |
| 初始认证失败无密码引导 | 未处理 | 同上 | 缺口（低优先级） |

---

### 网关模式（hn-base-server）

| 功能 | 现状 | 证据 |
| --- | --- | --- |
| 登录/会话/消息/发送/中止/事件 | 已迁移：detail `{data}` 解包、abort→`interrupt`、children→`parentID` 过滤、messages 复用 `timelineMessages` | `routes/sessions.ts` |
| 文件列表/内容/签名直链 | 已迁移到 `session.fs.list` / `session.fs.read`，文本包 JSON、二进制透传 | `routes/sessions.ts`、`routes/public-fs.ts` |
| **模型目录 `/api/models`** | 新增：网关代理 SaaS `/api/model`，浏览器据此分组（此前网关无此路由 → 选择器为空） | `routes/models.ts` |
| 网关模式端到端 | 已实测：登录 → 自由对话 → 真实模型回复（含 websearch/webfetch 工具调用） | 截图 `gateway-final2.png` |

## 三、环境受限（代码已就绪，未验收）

| 项 | 说明 |
| --- | --- |
| 真实沙箱工具执行 | OpenSandbox 控制面不可用（`sandboxExecutionVerified: false`）；文件读写类工具、Code Mode Runner、工具来源标签的正向链路都未跑通真实验收 |
| 工具来源 `mcp:<server>` / `session` | PG 用例已覆盖解析逻辑，但没有真实 MCP 会话端到端验证 |
| 图片附件链路 | 发送已映射 `files`，但未用真实图片验证模型接收与回显 |

---

## 四、其它产品面（非本次范围，但有 V1 残留）

- `apps` / `requirement` / knowledge / connectors 页面走 `hn-base-server`（`baseFetch`，`/api/...`），与 SaaS 直连模式是两套；其中 `requirement-chat` 的附件预览仍用 V1 `fileContent`。
- `packages/hn-app/src/types/opencode.ts` 仍是 V1 形状（`model.modelID`、`role`），适配层把 V2 转成它；长期看应改为 V2 类型并删除适配层。

---

## 五、建议优先级

1. **斜杠命令 V2 迁移**（`/context`、`/compact` 等入口都在这里，功能直接不可用）
2. **`/file/content` → `/fs/read`**（文件预览在 SaaS 直连形态下才可用）
3. **Live 下一个请求预览**（需核心 dry-run，风险最高，建议单独评审）
4. **工具调用渲染真实验证**（等沙箱恢复）
5. Fleet 运行时长、总览 today/all、DNA 引入步骤列（体验补齐）
