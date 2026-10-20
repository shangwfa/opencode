# hn-app 迁移地图（xybot-front-opencode-ui → React + shadcn）

> 源项目：`/Users/ruomu/yd/xybot-front-opencode-ui`（SolidJS，965 个 TS/TSX 文件，约 18 万行）
> 目标：`packages/hn-app`（React 19 + Vite 7 + Tailwind 4 + shadcn + zustand + react-router 7）
> 策略：**领域核心 1:1 移植（带测试）→ 基础设施重写 → UI 用 shadcn 重建 → 本文档持续追踪**。
> 源项目 AGENTS.md 的「上游可同步」约束在这里同样成立：需求业务不 fork 核心会话壳，改共享代码打 `// [MIGRATION]` 标记。

## 一、当前状态

- `bun run typecheck` ✅ 通过
- `bun run test` ✅ 152/153（唯一失败为上游已知红测试，见 §四）
- `bun run build` ✅（360KB JS / gzip 116KB）
- `bun run dev` ✅ :3001，首页健康检查、requirement-chat（StageBar/产物面板/阶段推进）截图验证通过

## 二、已移植（逻辑 1:1 + 测试通过）

| 源路径 | 目标路径 | 说明 |
|---|---|---|
| `src/features/requirement/flows/{config,loader,registry,utils}.ts` | 同路径 | 流程配置体系（5 套 JSON：default / universal-dynamic / boss-micro / plain / product-design） |
| `src/features/requirement/flows/*.json` + 3 个 flow 测试 | 同路径 | 原样拷贝 |
| `src/features/requirement/stage-runtime.ts` (+test) | 同路径 | 纯函数：planAdvance / canAdvanceNow / buildStageEnterPrompt 等 |
| `src/features/requirement/stage-machine.ts` (+2 test) | 同路径 | **Solid store → zustand 重写**，公开 API 不变；`state`→`getState()`/`store`，派生 memo→普通函数，新增 `use(selector)`；`showToast` → 注入 `onToast` |
| `artifact-pipeline / parse-artifact-content / artifact-event` (+tests) | 同路径 | 产物管道 |
| `route-repo / requirement-chat-mode / derive-copy-branch / opencode-directory / create-harness-session` (+tests) | 同路径 | 路由/模式/分支推导、Harness init-session 接缝 |
| `src/features/workspace/entry-path.ts` (+test) | 同路径 | |
| `src/features/browser-cdp/line-diff.ts` (+test) | 同路径 | |
| `src/api/requirement/client.ts` | 同路径 | 鉴权（cookie test_accessToken / localStorage ACCESS_TOKEN）、401 跳登录、`window.YD.BOSS_API_URL` → `/boss/api/v3/harness` |
| `src/api/requirement/harnessInitSession.ts` (+test) | 同路径 | `POST /opencode/init-session`（session+reqId 一步创建） |
| `src/api/agent-registry/*` | 同路径 | `resolveAgentRegistryNames` |
| `src/utils/opencode-saas-base.ts` | 同路径 | `window.YD.API_URL` → opencode SaaS base |
| `src/env.d.ts`（window.YD 声明） | `src/env.d.ts` | 去 solid-js 引用 |
| `src/api/requirement/types.ts`（GitlabBranchItem 起步） | 同路径 | 按需扩充 |

## 三、UI 重建（shadcn，功能骨架）

| 源 | 目标 | 状态 |
|---|---|---|
| `src/pages/requirement/requirementCreateChat/*`（StageStepper / StagePeekBanner / RollbackStageDialog） | `src/components/requirement/stage-stepper.tsx` | ✅ 已重建（三态 StageBar：working/done/viewing + skipped；PeekBanner；回退对话框） |
| RequirementChatInner 页面 | `src/pages/requirement-chat.tsx` | 🟡 骨架可用：flow registry + StageMachine + StageBar + 产物面板 + 阶段推进/回退/确认 |
| `src/ui/components/toast` | `src/components/toast.tsx` | ✅ 极简版（可换 sonner） |
| 上游布局/导航 | `src/components/layout.tsx` | ✅ 侧边导航 |
| `src/pages/session.tsx` + composer/* | `src/pages/session.tsx` | 🔴 骨架：timeline / composer / diff 面板待迁 |
| `src/pages/free-chat` | 同名 | 🔴 骨架（plain flow 可经 requirement-chat?workflow=plain 预览） |
| `src/pages/project-intake` | 同名 | 🔴 骨架 |
| `src/pages/dashboard` | 同名 | 🔴 骨架 |
| `src/pages/agent-registry` | 同名 | 🟡 API 层已迁，UI 骨架 |
| `src/features/workspace/*` | entry-path 已迁；其余（upload/download/mkdir/preview-panel/agents-md） | 🔴 待迁 |
| `src/features/browser-cdp/*` | line-diff 已迁；BrowserPanel/use-cdp-viewer/PublishScriptDialog | 🔴 待迁 |
| `src/features/openui/*` | 未迁 | 🔴 React 侧反而更自然（openui-react-runtime 是 React 渲染器） |
| `src/ui/**`（1797 个 Solid 组件） | `src/components/ui/*`（shadcn） | 🟡 已建 11 个核心组件（button/badge/card/input/textarea/separator/scroll-area/tabs/dialog/tooltip/skeleton），按需用 shadcn CLI 补 |

## 四、已知差异 / 注意事项

1. **上游已知红测试**：`route-repo.test.ts:52`（`xybot-front-homepage-v3`）在源项目同样失败——const 中该 ID 已被注释而测试未同步。迁移保持原样未改。
2. **路由**：源用 Solid Router（browser history）；hn-app 用 **HashRouter**（嵌入微前端/`window.YD.__PROJECT_APP_BASE_ROUTE__` 场景更稳）。如需 history 模式改 `src/main.tsx` 一行。
3. **SDK**：`@opencode-ai/sdk ^1.15.6`；`createSdkForServer` 从 ServerConnection context 收敛为纯参数（`src/lib/opencode.ts`）。
4. **stage-machine**：`use(selector)` 为 React 订阅入口；命令式用 `getState()/setState()`；toast 由 `input.onToast` 注入。
5. 依赖：react 系不在仓库 catalog（Solid 仓库），按版本直接锁定；vite/tailwind/typescript/@types 走 catalog。

## 五、会话窗口逻辑专项核对（2026-10-16 二轮审计）

> 用户重点：会话窗口（session window / 对话窗口）。下列为源项目会话窗口的完整逻辑清单与迁移状态。

### 5.1 已移植（本轮补齐）

| 源文件 | 目标 | 说明 |
|---|---|---|
| `send-stage-enter-prompt.ts` (+test) | 同路径 | 阶段进入 prompt 发送（SDK promptAsync + 产物上下文 hidden part） |
| `send-stage-sync-message.ts` | 同路径 | 阶段同步消息 |
| `phase-tag.ts` / `phase-tag-store.ts` | 同路径 | 阶段标签（store 为 zustand 重写） |
| `requirement-chat-session-cache.ts` | 同路径 | 会话缓存 |
| `artifact-generation-context.ts` (+test) | 同路径 | composer 发送的产物生成上下文 hidden part |
| `automation-context.ts` (+test) | 同路径 | 自动化上下文 |
| `parent-app-sync.ts` (+test) | 同路径 | 父应用（需求中心）同步 |
| `skills-inject.ts`（384 行） | 同路径 | 代码生成前 Skill 注入（jszip + aiScene） |
| `resolve-current-template-id.ts` (+test) | 同路径 | 模版解析 |
| `aggregate-projects.ts` / `global-event-debug.ts` (+test) / `product-suggestion-attachments.ts` (+test) | 同路径 | |
| `stage-helpers/`（confirm-plan-stage + test / parse-template-judgment + test / template-selection-storage） | 同路径 | confirm-plan-stage 的 `machine.state` → `machine.getState()`（[MIGRATION] 标记） |
| `artifact-panel/{types,preview-url,preview-harness-config}.ts` | 同路径 | types 为 React 适配版（Accessor 风格保留；preview UI 成员待 ArtifactPanel UI 迁移） |
| `config/requirement-chat-config.tsx → .ts` (+test) | 同路径 | Solid Provider → zustand + React Context（纯函数 1:1） |
| `utils/{id,vcs-diff}.ts`、`shared/util/window-message.ts` | 同路径 | vcs-diff 的 ServerConnection 内联为最小类型 |
| `api/requirement/{aiScene,requirements-v2}.ts` + types（AggregateRequirement 全套） | 同路径 | |
| `utils/{agent,requirement/debug,requirement/reqChatStorage}.ts` | 同路径 | 会话窗口依赖 |
| `shared/util/session.ts` (+test) | 同路径 | `byMessageCreated` / `isToolPartStalledByError` / `shouldShowTurnThinking` 1:1；`createEffectiveWorking`（Solid）→ `useEffectiveWorking`（React，2s 轮询语义一致，可测核心抽为 `resolveEffectiveWorkingOverride`） |
| `use-polled-requirement-status.ts` | `src/pages/requirement/` | React hook（2.5s 轮询 / 401 / 需求不存在 / preparing 循环语义一致） |
| `context/requirement-sync/shared.ts`（pickModel/mergeAgents） | 同路径 | 死导入 useSDK 移除 |
| `features/openui/{openui-segments,openui-render-preference,openui-commit,openui-react-runtime}` (+tests) | 同路径 | preference 为 zustand 重写；runtime 为 React（@openuidev 依赖已加）；CSS 副作用导入移至 index.css |

### 5.2 会话窗口剩余缺口（ChatArea.tsx 2051 行 + requirement-sync.tsx 386 行，均为 Solid，需 React 重写）

**requirement-sync.tsx（`RequirementSyncProvider`）**——会话窗口状态心脏：flow 解析、StageMachine 创建/ hydrate、session 事件订阅、syncArtifact 调度、send-stage 消息发送。React 版应做成 Context Provider + `useRequirementSync()`（源为 `withContext({use, provider})`）。

**ChatArea.tsx 逻辑块清单**（迁移时逐块勾销）：
1. 消息流：`sessionMessages` / `sliceTurnMessages`（按 user 消息切 turn）/ `SessionTurn` 渲染 / `createAutoScroll` 自动滚动 / `SessionRetry` / `TurnStallHint`
2. 阶段消息过滤：`stageFilteredMessages` / `isHiddenUserMessage`（切阶段隐藏其他阶段消息）/ `suppressStageFilter`
3. abort + 重发：`handleAbortAndResend`（`session.abort` 后按原 parts `promptAsync` 重放）
4. 产物卡片：`handleArtifactCardClick`（ArtifactEvent → 打开产物面板定位）
5. 提交/复制：`handleCommitClick` / `handleCopyRequirementClick` / `resolveCopyTargetGitlab`（gitlabBranches API）
6. `handleSkipStage` 跳过阶段
7. composer：`validateComposerDraft` / `transformComposerDraft`（FollowupDraft → prompt parts）
8. chat 模式切换：`switchChatMode` / `chatModeSwitcher`（requirement-chat-mode.ts 已迁，UI 待接）
9. turn 状态：`sessionStatus` / `effectiveWorking`（✅ 逻辑已迁）/ 输入区 tint
10. 生命周期横幅：`useRequirementChatLifecycle`（isLastStage / showSpecerIntroBanner / showCompletionBanner）
11. 需求信息对话框 / 回退对话框（RollbackStageDialog ✅）/ 完成横幅
12. OpenUI 提交结果：`latestOpenUICommitResult`（openui-commit.ts ✅ 已迁，UI 待接）
13. 外壳：`RequirementChatShell`（dock 布局 + artifact dock tab）/ `RequirementPreparationOverlay`（preparing/failed 遮罩）/ `useSync`（上游 session_status）

**上游会话壳**（`src/pages/session.tsx` + `session/composer/*` + `ui/components/session-*`）：opencode 官方 web 的时间线与 composer，逻辑量最大，建议对照本仓库 `packages/app`（Solid 同源）按组件翻译。

### 5.3 composer / chat 消息渲染专项（2026-10-16 三轮审计，按实际截图核对）

截图会话窗口 = 消息时间线（思考过程/Shell 工具块/已探索摘要/工具执行中）+ composer（附件/agent/模型/变体/上下文用量/停止）+ 预览 dock。逐块核对结果：

**已补齐（本轮新增，全部带测试）：**
| 源文件 | 目标 | 说明 |
|---|---|---|
| `prompt-input/build-request-parts.ts` (+504 行测试) | 同路径 | composer → SDK request parts 组装（核心） |
| `prompt-input/history.ts` (+test) | 同路径 | 输入历史 |
| `prompt-input/{editor-dom,files,paste,placeholder,session-mcps,session-skills}` (+tests) | 同路径 | 编辑器 DOM/文件 mime/粘贴规范化/MCP·Skills 引用 |
| `prompt-input/session-token-usage.ts` (+test) → `src/components/session/` | 同路径 | **composer 的上下文用量百分比（截图 3%）** |
| `hooks/use-turn-phase.ts` (+test) | `src/hooks/` | **"工具执行中/思考中/子代理执行中" + 卡顿提示/重试阈值**（纯核心抽出，2 项子代理语义 1:1） |
| `prompt-input/attachments.ts` → React hook `usePromptAttachments` | 同路径 | 粘贴/拖拽/上传三级降级（sync→OSS→uploadError 标记）；上下文改注入式 |
| `prompt-input/session-reference-adapter.ts` (+test) | 同路径 `.tsx` | 会话引用 pill：lucide-solid render → lucide-react + flushSync |
| `prompt-input/slash-popover.ts`（纯逻辑抽取） | 同路径 `.ts` | 斜杠命令分组/排序 |
| `utils/{uuid,comment-note}`、`constants/file-picker`、`shared/util/path`、`context/file/{types,path}` (+test) | 同路径 | 依赖闭包 |
| `api/requirement/{aiScene,sandbox-file,uploads,ossUpload}` (+tests) | 同路径 | |
| `features/workspace/{workspace-sync,workspace-config}` | 同路径 | 附件上传沙箱同步 |
| `context/prompt.ts`（类型层） | 同路径 | Prompt/ContentPart 全套类型 + DEFAULT_PROMPT（完整 Solid store 随会话壳迁） |

**composer 缓迁决定：**
- `prompt-input/submit.ts`（770 行，聊天发送管线）——耦合 global-sync/language/layout/local/permission/prompt/sdk/sync 共 10 个 context，必须与会话壳的 context 图一起重写（submit.test.ts 506 行用例保留在源仓库参照）
- `prompt-input/{context-items,drag-overlay,image-attachments,slash-popover 的 UI}`——Solid UI 组件，随 React composer 重写
- `ui/components/message-part.tsx`（**3747 行**，思考过程/Shell 工具块渲染）+ `session-turn.tsx`（671 行）——时间线渲染主体，随上游会话壳迁移（对照 `packages/app` 同源）
- `ui/components/session-context-usage.tsx`（UI 壳，纯逻辑已迁）、`features/workspace/preview-panel`、`RequirementChatShell`（预览 dock：正在创建预览环境轮播 + URL 栏 + 设备切换）——UI 层待重建

### 5.3.1 去 SDK 化 + chat 数据流接通（2026-10-16 四轮，按用户要求全部直连 REST）

**架构决定：`@opencode-ai/sdk` 依赖完全移除**，全部直连 opencode REST API：

| 模块 | 说明 |
|---|---|
| `src/types/opencode.ts` | 自有类型：Message/UserMessage/AssistantMessage、Part 全联合（text/reasoning/tool/step/file/snapshot/agent/patch/subtask/retry/compaction）、SessionStatus、FileContent、VcsFileDiff、FileNode、PartInput（Text/Agent/File）、Event、ProviderList |
| `src/lib/rest.ts` | REST 客户端：sessionMessages（GET /session/{id}/message）、sessionPromptAsync（POST /session/{id}/prompt_async）、sessionCommand、sessionAbort、sessionStatus、fileContent（GET /file/content）、providerList、subscribeEvents（GET /event SSE，EventSource + 3s 断连重连） |
| `src/context/sdk.tsx` → ServerProvider | baseUrl/directory（无 client） |
| `src/context/data.tsx` | **实时数据层**：message[sessionID]（byMessageCreated 序）/ part[messageID]（Binary.search 按 id 序）/ session_status；SSE 事件归约 applyDataEvent（协议 1:1 对齐 event-reducer.ts）；乐观插入/回滚 |
| `src/context/local.tsx` | agent/model/variant 选择（localStorage 持久化） |
| `src/context/prompt-store.tsx` | 草稿 store（zustand）：current/cursor/set/reset + context items |
| `prompt-input/submit.ts` | 发送管线接通 REST：promptAsync / command（slash）/ abort；乐观回显 + 回滚 |
| `pages/requirement-chat.tsx` | **真实数据流接通**：loadMessages + SSE 实时更新、SessionTimeline 渲染、Composer 发送/停止、fetchArtifact 接通 GET /file/content、useTurnPhase 状态行、usePolledRequirementStatus（已迁备用） |

**UI 层（shadcn 风格 + React Bits 动画，图标 lucide-react）：**
| 组件 | 说明 |
|---|---|
| `components/session/message-part.tsx` | 思考过程（可折叠）/工具块（Shell 命令摘要 + 状态图标 + 详情折叠）/text Markdown（marked + DOMPurify）/文件 chip |
| `components/session/session-timeline.tsx` | sliceTurnMessages 按 user 消息切 turn、自动贴底、tool-error 卡住提示 |
| `components/session/markdown.tsx` | marked + DOMPurify 消毒 |
| `components/prompt-input/composer.tsx` | shadcn DropdownMenu 选择 agent/model、上下文用量圈（tokenBreakdownFromSession）、发送/停止互切、拖拽视觉态 |
| `components/ui/dropdown-menu.tsx` | shadcn 规范组件（radix） |
| `lib/animations.css` | React Bits 风格：fade-up 消息入场、思考三点、脉冲环（composer working 态）、shimmer；prefers-reduced-motion 全关 |

**渲染层剩余**（需连上游 context 图整体重写）：`message-part.tsx` 的特殊 tool 视图（文件树/媒体预览/待办列表）、`session-turn.tsx` 的 agent 徽章色/重试 UI、preview dock 轮播、slash/at 浮层 UI、submit 的排队/worktree 路径。

### 5.3.2 本地 SaaS 直连 + 模型选择 + 自由对话（2026-10-16 五轮）

1. **服务连接切换**：默认 base 从测试环境 `test-opencode.shadow-rpa.net` → **本仓库 docker SaaS `http://localhost:14096`**（v2 API，容器 4096）。优先级：window.YD.API_URL → VITE_OPENCODE_API_URL → local。CORS 已验证全开。
2. **模型选择修复**（对齐源 `ModelSelectorPopover` 交互）：`GET /provider` → 归一化（过滤 deprecated）→ DropdownMenu 按 provider 分组（已连接标记）→ 选中持久化 local → 未选时自动挑第一个已连接模型（`pickFirstModel`）。
3. **自由对话迁移**：会话列表（GET /session）+ 新建（POST /session）+ 会话页（timeline/composer/abort/发送自动建会话）；路由 `/free-chat`、`/free-chat/session/:id`。
4. **时间线修复**：消息接口实际返回 `[{info, parts}]`（非 `{message}`）；DataProvider stale closure 修复（state 不得被 useMemo 缓存捕获）。

**渲染层剩余**：特殊 tool 视图（文件树/媒体预览/待办）、session-turn 徽章色/重试 UI、preview dock、slash/at 浮层、submit 排队/worktree 路径、AgentConfigPanel / 子代理页 / rrweb 回放（free-chat 高级功能）。

### 5.3.3 第六轮：模型下拉语义对齐 + 消息 UI 细节（2026-10-16）

**1. 模型下拉只显示「可用模型 + 免费可用模型」**（1:1 对齐源 `models.tsx` + `dialog-select-model-unpaid.tsx`）

| 语义 | 源实现 | 本仓实现（`src/hooks/use-provider-list.ts`） |
|---|---|---|
| available | `providers.connected()` 全量模型 | 已连接 provider 全量 |
| visible | 用户覆盖 → `latestSet` 命中 → 无 `release_date` 则显示，否则隐藏 | `applyVisibility`：6 个月内 per-family 最新 → 显示；无 `release_date` → 显示；更旧 → 隐藏 |
| latest | `name.includes("(latest)")` | `toDisplayModel().latest`，展示名去后缀 |
| 免费 | `provider.id === "opencode" && (!cost \|\| cost.input === 0)` | `isFreeModel(provider, model)` 同规则 |
| 分区顺序 | 已连接在上、免费在下 | 已连接组在前，`opencode` 免费组在后 |

本地实测（`GET /provider`：232 provider / 9009 模型）：下拉从 **1024 项收敛到 13 项** = Yd-DeepSeek 2 + Yd-GLM 2 + OpenCode 免费 9（其余 100 个 provider 的 0 成本模型不再误标「免费」）。

**2. 路由补全**：`/free-chat/session/:sessionId`、`/requirement-chat/:repo`（此前点会话列表 404、裸 repo 路由无 textarea）；`requirement-chat` 无会话时发送自动 `POST /session` 并 `replace` 跳转。

**3. REST 空响应容错**：`prompt_async`/`abort` 返回空 body，`rest()` 改为 `text()` → 空则 `undefined`，非空再 `JSON.parse`（此前报 `Unexpected end of JSON input`）。

**4. 消息 UI 细节**：
- 工具行去掉行首折叠箭头（原「箭头 + `>_` 图标 + 状态圈」三重箭头），脚本执行改 `SquarePlay` 执行语义图标；状态圈右置。
- 思考过程**流式展开、完成自动收起**：`time.end` 未写入 → 自动展开 + 贴底滚动 + 「思考中」三点动画；写入后自动收起，用户可再手动开合。

**新增测试**：`src/hooks/use-provider-list.test.ts`（16 例：免费判定、latest/展示名、connected/free 分组、visible 时间窗、分区顺序、pickFirstModel 兜底）。测试基线 **344/345**（唯一失败仍为上游继承的 `route-repo.test.ts > detects unsupported preview appId`）。

### 5.3.4 第七轮：全局视觉精修（2026-10-16）

**根因定位（先取证再改）**

1. **字体割裂**：先前引入 `@fontsource-variable/inter` 做西文、中文 fallback PingFang SC，两套字形混排 → 视觉不自然。源项目 `theme.css` 明确用**系统字体栈**（`ui-sans-serif, system-ui, -apple-system`）不加载西文字体包 → 已删除 Inter import，改为 `@theme` 声明 `--font-sans` / `--font-mono`（对齐 `theme.css:2-5`）。
2. **截图伪影排除**：1x 截图放大后中文看似「压扁重影」。逐项排除：字体栈替换（A–E）、`font-smoothing`（F）、headed 模式（G）、入场动画残留（I/J）、`line-height`（K）、ScrollArea 合成层（M）、同页干净对照块（L）→ 均不改变；`deviceScaleFactor: 2` 原生像素（N）完全正常 → 判定为**截图插值伪影，非页面问题**（结论基于 8 组对照实验，非猜测）。
3. **内边距错位**：Card header（默认 px-6）与内容（p-4/px-5）不一致，肉眼可见 4–8px 错位 → 全量统一为 `px-5`。
4. **truncate 失效**：会话列表 `<span>` 上 `items-start` 使子元素按内容宽度撑开，`text-overflow: ellipsis` 不触发 → 去掉 `items-start`（默认 stretch）。

**视觉层级重做**（改动文件）

| 文件 | 改动 |
|---|---|
| `src/index.css` | 系统字体栈 token；`antialiased`；`::selection`；细滚动条（10px / 3px 透明边框） |
| `components/layout.tsx` | 侧栏 `w-60` + `bg-muted/40` + logo 图标块；选中项=白卡 `shadow-xs ring-1`（原 `bg-accent` 在白底上几乎不可见）；项高统一 `h-9`；图标色分级；footer 加 `border-t` 并淡化 |
| `components/session/session-timeline.tsx` | 消息列 `max-w-3xl mx-auto`（阅读列宽）；turn 间距 6；气泡 `bg-muted rounded-2xl rounded-br-md shadow-xs` |
| `components/session/message-part.tsx` | 工具行=图标底块 + 13px 标签 + hover 底色；展开面板 `ml-[34px]` 缩进对齐；思考块改淡竖线 + hover 高亮；箭头 3.5px |
| `components/session/markdown.tsx` | 14px/1.75（源 `--font-size-base`）；完整排版：标题层级、悬挂缩进列表、行内码/代码块分级、引用/表格/图片/链接、`first:mt-0` 节奏 |
| `components/prompt-input/composer.tsx` | `rounded-2xl` + `shadow-sm` + `focus-within` 双层环；输入区 15px 自适应（去固定 `rows=2`）；内容渐隐遮罩；按钮 `rounded-lg`、模型名 `max-w-52 truncate`；移除无信息量的「默认」文案 |
| `components/requirement/stage-stepper.tsx` | 圆点 18px；upcoming 加 `ring-1 ring-border`（原白底无边界）；连接线 `bg-foreground/70`；未到达文字 70% 透明 |
| `pages/home.tsx` | 重写：连接卡=图标+状态点（emerald/amber/destructive）+ 重新检测 loading 旋转；入口卡=可点击 hover（图标反色 + 右上箭头浮现）；容器 `max-w-5xl` |
| `pages/free-chat.tsx` | 列表 `w-64` + 标题/日期两行（修 `items-start` 导致日期不换行）+ 选中白卡；空状态加图标容器；消息列宽对齐 composer |
| `pages/requirement-chat.tsx` | 双层边框（Card + ScrollArea）→ 单层；header `border-b` + `px-5`；产物面板 38%→34% 并加文件图标 |

### 5.3.5 第八轮：思考态去重 + 沙箱 HTML 可点击预览（2026-10-16）

**1. 「两个思考中」去重**

- 根因：流式中 reasoning 块内已渲染「思考中 + 三点」，时间线底部又渲染一行「● ● ● 思考中」，同一状态表达两次。
- 处理：`hasStreamingReasoningPart(parts)`（纯函数 + 6 例单测）判定是否存在流式思考块；为真时底部状态行不再渲染。流式但尚未产出文本时同样以块内为准。
- 附带：流式 reasoning 尚无正文时不再画空竖线（`hasText` 才渲染内容区）。
- 实测：会话流式期间底部重复行 `bottomPhaseRows` 恒为 0。

**2. 沙箱 HTML 产物点击预览**

事实（`docs/test-cases/sandbox/files-api.md` + 本地 14096 实测）：

| 端点 | 本地 14096 实测 | 结论 |
|---|---|---|
| `/api/session/:id/fs/read/*`（文档 V2 权威端点） | 返回 SPA `text/html` | 本仓网关层未挂载到本地实例 |
| `/session/:id/fs/read/*` | 同上 | 上游无此路由 |
| `/file/content?path=` | ✅ `{type,content}` | 可用 |
| `POST /session/:id/shell` | ✅ | 写入靠 shell（与文档一致） |

实现（`lib/rest.ts` → `readSandboxFile` 双通道）：
- 通道 A：`/api/session/:id/fs/read/<workspace 相对路径>`，按 `content-type` 判定是否真实可用（SPA 兜底同为 `text/html` → 视为未挂载），不可用静默回退；
- 通道 B：`/file/content?path=&directory=`。**实测带 `sessionID` 会解析到空内容，故只传 `directory`**；绝对路径未带 directory 时由 `parentDirectoryOf()` 推导父目录。
- 链接化：marked/GFM 的 autolink 只认 http(s)/www/mailto，**裸 `file://` 不会自动链接** → 新增 `linkifySandboxFileUrls()`（DOMParser 遍历文本节点，跳过 `a/code/pre`，6 例单测）。
- 交互：消息正文链接、用户气泡链接、工具输出内链接均可点 → `FilePreviewDialog`（HTML 用 `iframe srcdoc` + `sandbox="allow-scripts allow-forms allow-popups"` 不给 same-origin；另有源码切换、复制、下载；图片/Markdown/文本各自分支；读取失败/不支持/空文件各有明确空态）。
- 已知限制（沙箱文件不经 HTTP 暴露、无端口代理）：HTML 的**相对路径资源**不解析，内联 CSS/JS 的单文件产物可完整呈现。

新增测试：`file-preview-url.test.ts`（13 例）、`markdown.test.ts`（15 例）、`session-timeline.test.ts`（6 例）。

### 5.3.6 第九轮：Shell 图标、file 链接失效、粘贴图片（2026-10-16）

**1. Shell 工具图标语义修正**：`SquarePlay`（播放三角，像媒体播放器）→ `SquareTerminal`（终端语义，方块包裹不与折叠箭头混淆）。

**2. 模型写的 `[x](file://…)` 点击无反应（真 bug）**

- 根因：DOMPurify 默认 `ALLOWED_URI_REGEXP` 不含 `file:`，sanitize 时把 href 剥掉 → DOM 上 `href=""`，点击既不预览也不导航。裸路径 linkify 走 `createElement` 绕过 sanitize，所以那条路径正常，两条路径行为不一致。
- 处理：sanitize 加 `file:` 白名单 → linkify 阶段统一改写为 `data-sandbox-href` 并**移除 href**（DOM 中不留可导航的 file: 地址，点击由事件委托接管）；委托改读 `data-sandbox-href ?? href`。
- 实测：真实浏览器中 `<script>`/`onerror` 仍被 DOMPurify 正常剥离（jsdom 下不剥离事件属性属测试环境差异，已在测试注释说明）。

**3. `/file/content` 参数纠错（上一轮结论是错的）**

- 误判：「带 sessionID 会返回空内容」→ 实际是**那次会话的沙箱里本就没有该文件**（沙箱无持久卷，重建即丢）。
- 实测（126151 字节的 HTML）：带 sessionID → 200/126151；不带 sessionID → 200/空；`workspace` 参数 → 500。
- 修正：通道 B 恢复传 `sessionID`（定位沙箱的**必需**参数），代码注释同步纠正。

**4. 粘贴图片打通**

- 根因一：`usePromptAttachments` 传 `editor: () => undefined` → `add()` 取光标位置处直接 `return false`，粘贴被静默丢弃。现传 `editorRef.current`，并把 hook 的 `editor` 类型由 `HTMLDivElement` 泛化为 `HTMLElement`（本项目 composer 用 textarea）。
- 根因二（更隐蔽）：页面 `handleSubmit` 里 `prompt.set([{type:"text"}])` **整块覆盖** prompt parts，附件在发送前被清空。新增 `withDraftText(parts, text)`（5 例单测）更新/补写 text part 并保留附件，两个会话页共用。
- 接线：textarea `onPaste` → `handlePaste`；`onDrop` 接文件；`+` 按钮接隐藏 file input（`ACCEPTED_IMAGE_TYPES`）；缩略图条（64px、删除、上传中 spinner、上传失败标记）；纯图片也可发送。
- 踩坑：`useStore(store, s => s.parts.filter(...))` selector 每次返回新数组 → zustand 判定 getSnapshot 未缓存 → 无限循环白屏。改为选稳定引用 `s.parts` 再 `useMemo` 派生。
- 实测：请求体为 `[text, file(image/png, data:image/png;base64,…)]`，附件同时上传 OSS 并以 `[Attached file]` 上下文注入消息。

新增测试：`draft-text.test.ts`（5 例）。基线 **383/384**（唯一失败仍为上游继承的 `route-repo` 红测试）。

> 注：当前模型 `deepseek-v4-pro` 自身不支持图像输入，会回复「无法读取图片内容」——属模型能力限制，附件链路（dataUrl + OSS URL + mime）已验证打通。

### 5.3.7 第十轮：左侧两列导航重构 + L1 可收起（2026-10-16）

**问题定位（实测，非观感猜测）**

| 不协调点 | 实测证据 |
|---|---|
| 两列底色相同 | 均为 `bg-muted/40`，视觉上像一整块被两条竖线切开 |
| 顶部不对齐 | L1 `h-14` 带 `border-b` vs L2 `p-3` 无边框 → 两条顶线一高一低 |
| 选中态撞车 | 两列都用「白卡 + shadow-xs」 |
| 图标语义重复 | 导航 `MessagesSquare` ↔ 会话项 `MessageSquareText` |
| 密度不一致 | 导航 36px 单行 ↔ 会话项 44px 两行 |
| 底部割裂 | L1 有「React + shadcn 重写版…」开发痕迹，L2 空 |

**重构：三级深度** `L1 bg-muted/70 w-56` → `L2 bg-muted/30 w-60` → `内容区 bg-background`
- 两列顶部统一 `h-14` + `border-b border-border/60`
- 选中态分工：L1 左指示条（`before:` 伪元素）+ 极浅底；L2 白卡 —— 用底色深度区分层级而非复制卡片
- 会话项改单行「标题 truncate + 日期右对齐」，`h-9` 与导航一致；日期改**今天/昨天/MM-DD**（此前全显示 `10/16` 无法区分）；去掉与导航重复的图标；移除侧栏开发痕迹；「新建会话」黑底 primary → header 右侧轻量 ghost

**修掉真 bug：会话项 truncate 失效**

实测按钮宽 **292px > 列宽 240px**。根因：Radix `ScrollArea` 的 viewport 是 `display:table; min-width:100%`，宽度由**内容**决定，`w-full`/`min-w-0` 都无法约束。改用原生滚动容器（`overflow-y-auto` + `min-w-0`）后实测 219px，截断正常。

**L1 收起/展开**

- `src/hooks/use-sidebar.ts`：`readCollapsed` / `writeCollapsed` / `isToggleShortcut`（纯函数，含存储异常回退）+ `useSidebarCollapsed`（localStorage 持久化 `hn-app:sidebar-collapsed`，⌘/Ctrl+B 切换，输入框内不拦截）
- 折叠态 `w-14` 纯图标列：图标居中、hover 出右侧 tooltip、选中改用 `bg-foreground/10`（折叠态下 2px 指示条会被圆角裁切不可辨）、底部常驻展开按钮（展开态入口在头部，保持唯一）
- 宽度过渡 `transition-[width] duration-200`

新增测试：`use-sidebar.test.ts`（10 例）。基线 **393/394**（唯一失败仍为上游继承的 `route-repo` 红测试）。

### 5.3.8 第十一轮：侧栏 className 被写坏的真 bug + 图标调整（2026-10-16）

**核心 bug：`class` 属性里塞的是函数源码，导致样式成片失效**

现象：每个导航项左侧出现黑色竖条、图标与文字重叠。
根因链（实测）：

1. `NavLink` 的函数式 `className` 被 Radix `TooltipTrigger asChild`（Slot）的 props 合并**原样透传**，函数从未被调用
2. 浏览器把函数源码按空格切词当作 class 名：引号包裹的类拿到**带引号前缀**的 class 名而失效
3. 实测失效项：`padding: 0`（`"px-2.5`）、`gap: normal`（`"gap-2.5`）、`::before position: static`（`"before:absolute`）
4. 而 `before:left-0 / h-4 / w-0.5 / bg-foreground / content-['']` **生效**（无引号前缀）→ 伪元素以 static 定位，在每项渲染出一条黑竖条

修复：去掉 Radix Tooltip 包裹，改用 `useLocation()` 自行判定激活态 + **字符串** className；折叠提示用原生 `title`（零依赖、行为可预期）。修复后实测 `padding: 0px 10px`、`gap: 10px`、`::before position: absolute`、**仅 1 项**带指示条。

**图标调整**

- logo：Terminal(`>_`) 在 14px 下过于细碎 → Command(`⌘`) `size-4 stroke-2.2`，线条饱满、形状紧凑
- 导航图标色阶：常态 `foreground/55` → 悬停 `/80` → 选中 `foreground`（原 `muted-foreground/70` 在 muted 底色上发糊）；选中 stroke 2.1 / 常态 1.9
- 导航文字色同步提到 `foreground/65`（非选中），与图标色阶呼应

> 经验：项目内任何 `asChild` 包裹 + 函数式 `className` 的组合都要警惕——Slot 只做字符串合并，遇到函数会原样透传。

### 5.3.10 第十三轮：L1 改常驻图标栏（参考 ChatGPT）+ 顶部去横线（2026-10-16）

**调研结论（shadcn/ui 官方 Sidebar 文档 + 业界共识）**

- `SidebarTrigger` = 常驻切换控件；`SidebarRail` = 把手（icon 模式下可 toggle）；快捷键 `SIDEBAR_KEYBOARD_SHORTCUT="b"` → ⌘B/⌘B；折叠宽度 `16rem → 3rem`
- 折叠图标栏**必须配 tooltip**（GitHub issue 原话：collapsed 时用户看不出图标对应哪个页面）

**最终决策**：不做展开/收起两态，**L1 固定为 64px 图标栏**（用户决策，参考 ChatGPT 桌面端）——入口恒定、位置不跳动。

- 顶部 logo 居中；中部两组图标（主流程 / 工具）用短横线分隔；图标 16px、点击区 40×40px、右侧 tooltip 280ms
- 选中态用圆角方块底色 `bg-foreground/10`（替代原先的左指示条——窄栏里指示条会被圆角裁切）
- 删除：收起把手、`⌘B` 快捷键、`use-sidebar.ts` 及其 10 例测试（无引用即删，避免死代码）

**同时移除三列顶部的 `border-b`**

问题：三列顶部各画一条 `border-b`，形成三条被列间隙打断的横线，且三块底色不同 + 内容性质不同（logo / 文字 / 标题），横线纯属冗余。
处理：图标栏 / 会话列表 header / 主区 CardHeader 统一为 `h-14`（56px）并保留 `border-b`，让三段横线**连成一条完整线**。保留 `StageBar` 的 `border-b`——那是**同一列内**「阶段条 / 聊天卡片」的内容分区线，性质不同。

对齐问题的实测根因：主区外层包了 `p-4`，导致它相对 L2 整体下移/右移 16px，横线错位约 18px 且各自悬空。去掉该层 padding 后实测三段几何为 `y=0..56` + `x 0-64 / 64-304 / 304-1440`，横线连续。

**L2 会话列表可收起**

- `src/hooks/use-session-panel.ts`：持久化 `hn-app:session-panel-collapsed`，`⌘/Ctrl+B` 切换（输入框内不拦截），10 例单测
- 收起：列宽 `240 → 0`（`transition-[width] duration-200` + `overflow-hidden`），主区占满；入口在主区 header 左侧（`PanelLeftClose`/`PanelLeftOpen`），位置与 ChatGPT 一致
- 实测宽度序列：`240 →(点击) 0 →(⌘B) 240 →(刷新) 240`

**图标体系与面板对称（第十四轮）**

- 面板图标体系最终定案（用户澄清：改的是 **toggle 按钮**而非 logo）：
  - 左侧会话列表 toggle → **`PanelLeft`**（展开/收起两态同一图标，靠位置表达语义）
  - 右侧阶段产物 toggle → **`PanelRight`**（与左侧成对）
  - logo → `Terminal`（`>_`），不占用 PanelLeft 语义、避免与 toggle 撞车
- 自由对话页主区 header 精简：去掉标题前的 `MessageSquareText` 图标与 `206 tokens` 徽标，只留「toggle + 标题 + 运行态」；随之清理不再使用的 `lastAssistant`/`totalTokens` 计算
- 导航项尺寸 40×40 → **32×32**（`size-8`），与 64px 图标栏比例更协调
- 新增右侧面板收起：`src/hooks/use-artifact-panel.ts`（持久化 `hn-app:artifact-panel-collapsed`，`⌘/Ctrl+.` 切换，8 例单测）
  - 展开态：`阶段产物` header 右侧 `PanelRightClose`
  - 收起态：入口放在**聊天卡片 header 内**（`PanelRightOpen`）——最初放在主区外侧，视觉上按钮游离于面板之外，已修正
- 聊天卡片 header 统一 `h-14`（56px），与顶部横线对齐

### 5.3.9 第十二轮：收起控件改为边缘把手（2026-10-16）

- 原 header 常驻收起按钮（`PanelLeftClose`）与 logo 挤在同一行、视觉抢焦点 → 改为**侧栏右边缘中部把手**：24px 圆形 `bg-background` + 细边 + `shadow-sm`，hover 加宽到 28px 并转 `bg-muted`。
- 图标语义化：`PanelLeftClose` → `ChevronsLeft` / `ChevronsRight`（双箭头，收/展方向一眼可辨）。
- 折叠态把手同样贴在 56px 图标列的右缘（实测展开态 `x=211`、折叠态 `x=41`，均与各自列宽对齐）。
- header 仅保留 logo + 名称；`⌘/Ctrl+B` 与 localStorage 持久化行为不变。
- 把手进一步弱化（用户反馈「弱化点、小点」）：展开态 `18×18`、折叠态 `20×20`，去掉底色/边框/阴影，常态 `text-foreground/35` 近乎隐形，hover 才浮现 `border-border` + `bg-background` 并加宽到 20/24px，图标 `size-3`。
- 把手图标最终定为 **Chevron 单箭头**（`ChevronLeft`/`ChevronRight`）：曾在真实页面同尺寸并排对比 6 个候选（Chevrons / Chevron / PanelLeftClose / SidebarClose / ArrowLeftToLine / MoveHorizontal），单箭头在 18px 下最清晰、无尖括号堆叠感。

### 5.3.11 第十六轮：项目接入页（骨架 → 可用实现）（2026-10-17）

- 源范围：`src/pages/project-intake/`（StatusBoard 431 / ChatCore 397 / SessionPage 273 / SubAgentPage 155 ≈ 1100 行 UI + 1944 行含测试）+ `src/api/project-intake/`。
- **数据源结论（实测）**：这套不走 opencode SaaS REST，而是 harness（`window.YD.BOSS_API_URL` + `/boss/api/v3/harness`）。本地 `localhost:14096/doc` 的 194 条路径里无 project-intake 相关端点；探测 8080/3000/5173/8000/14107/3002/4000 均无 harness 服务（8080 为 404，其余无响应）。
- 纯逻辑 1:1 迁移（源测试直接通过，无需改写）：`projectIntakeStatusBoardLogic.ts`(9 例) + `projectIntakeChatLogic.ts`(1 例) + API `confirmJob.ts`(6 例) + `createIntake.ts`。
- 新增 `board-view.ts`：把源 StatusBoard JSX 里的 class/label 函数抽成可测模块（`jobStatusLabel` / `childStatusLabel` / `stepsOf` / `jobStats` / `shouldPoll` / `isJobTerminal`），避免逻辑散在 JSX 里重复实现。
- 新增 `ProjectIntakeStatusBoard.tsx`（React + shadcn）：2s 静默轮询（终态自动停）、状态摘要四宫格、失败重试（复用 `retryProjectIntakeConfirmJob`）、子任务卡片（应用·分支 / GitLab 地址 / 三步进度 / 错误 / 打开子会话）。`w-[360px]` + `border-l` + `h-14` header。
- 新增 `ProjectIntakeSessionPage.tsx`：复用通用 `SessionTimeline` + `Composer`，agent 锁定 `DEFAULT_PROJECT_INTAKE_AGENT`，不引入源项目特有的 `matchProjectIntakeAgent`（源只做一次列表匹配取默认值）。左侧补 `h-14` header（与看板对齐，横线连成一条）与空态引导。
- 入口页 `pages/project-intake.tsx` 替换骨架：填工作目录 + 需求标题 → 调 `createProjectIntake` 拿到 `masterSessionId` → 跳 `/project-intake/:dir/:sessionId`；无 harness 时退化为普通会话创建并明确 toast 说明。
- 无 harness 时的错误态**必须给准确原因**：直接短路显示「未配置接入服务（window.YD.BOSS_API_URL），无法查询项目创建进度」，而不是让请求落到 vite dev 的 `index.html` 后报「响应格式无效」。
- Composer agent 名去掉 `capitalize`：agent 名为 kebab-case（`project-requirement-parser`），首字母大写会显示成 `Project-Requirement-Parser` 与源不符。
- 测试基线 **417/418**（唯一失败为上游继承的 `route-repo` 红测试，按约定不修）；typecheck / build 通过。

### 5.3.12 第十八轮：仪表盘（骨架 → 需求大盘）（2026-10-17）

- 源范围：`src/pages/dashboard/`（index 151 / components 163 / aggregate 217 ≈ 531 行）。骨架页原写的「会话状态概览」在源项目里**并不存在**，按源实现为准（纯需求维度大盘）。
- `aggregate.ts` 1:1 迁移（仅类型 import 由 `@/api/requirement` 改为 `@/api/requirement/types`），并补 19 例单测锁定：状态/类型/优先级/仓库/人员/合并请求各维度计数、时间范围过滤、趋势序列补零与粒度（近 N 天按天、`all` 按月）。
- **查询层**：项目未引入查询库（源用 solid-query），新增 `use-requirements-all.ts`：把拉取+校验做成可测纯函数 `loadAll(fetcher, repo)`，hook 只管 `useState`/定时器/竞态丢弃。60s 轮询与源的 `refetchInterval` 一致；失败时保留上一次成功数据（对齐 solid-query 行为）。6 例单测。
- `components.tsx` React 重写 4 个组件 + 面板外壳：`StatusPipeline`（hero 总数/占比条/图例/完成率环）、`DistributionBar`、`BarRankList`、`TrendChart`（纯 CSS flex 柱，无图表库）。配色沿用源的内联 hex（`#1677ff`/`#faad14`/`#52c41a`）——它们编码数据语义而非主题色。
- 补齐两个源项目 UI 基础件（我们此前没有）：`components/animated-number.tsx`（rAF + easeOutCubic，尊重 `prefers-reduced-motion`）、`components/progress-circle.tsx`（纯 SVG 圆环）。
- 页面 toolbar：仓库过滤用 `Popover` + `ScrollArea`（不引入 select 依赖）、时间范围按钮组、自动刷新开关（自绘 `role="switch"`）。
- **重写时踩到的真 bug**：`TrendChart` 的柱高 `style={{height}}` 在重写中漏掉，只剩 `min-h-[3px]`，导致柱子全贴底（实测 `styleH: ""`、柱高 3px）。补回 inline height 后为 12/179/179/107px，与 count 比例一致。
- **可用性修正（偏离源）**：源 `.distLabel` 固定 `width:72px`，仓库 URL 被截成 `https://git…` 完全不可辨。给 `DistributionBar` 加可选 `labelWidth`（仓库分布传 `190px`），其余调用保持源默认 72px。
- 测试基线 **442/443**（唯一失败为上游继承的 `route-repo` 红测试，按约定不修）；typecheck / build 通过；Playwright 实测筛选（40→4）、下拉（4 项）、柱高比例均正确，无页面错误。

### 5.3.13 第十九轮：harness「HTML 回退」错误可读化（2026-10-17）

- **现象**：本地未配置 `window.YD.BOSS_API_URL` 时，`requirementApiBase` 为空 → URL 退化为相对路径（`/v2/requirements/all`）→ 请求打到 vite dev → 拿到 SPA 的 `index.html` → 业务层 `res.json()` 抛 `Unexpected token '<', "<!doctype "... is not valid JSON`。
- **判断**：这不是仪表盘的问题，而是**所有 harness API 的共性缺口**（需求列表、项目接入看板等同样中招），所以修在 fetch 层而非页面层。
- 在 `authorizedFetch` 中统一兜底：成功响应但 `content-type: text/html` 时抛 `ApiHtmlFallbackError`，文案区分两种原因——相对路径（base 未配）→「接入服务未配置：请设置 window.YD.BOSS_API_URL 后重试」；绝对 URL（已配但服务不可达）→「接入服务返回了 HTML 页面而非数据…」。
- 刻意**只拦 `res.ok`**：404 的 HTML 错误页仍交业务层按状态码处理，不改变既有语义。
- 新增 `client.test.ts`（9 例）：content-type 判定（含大小写与 204 空响应不误伤）、文案分支、200+HTML 抛可读错误 / 200+JSON 正常放行 / 404+HTML 不拦截。
- **顺带修掉自己引入的死链**：仪表盘 toolbar 的「返回需求列表」与空态的「去需求列表」都指向 `/requirements`，但需求列表页尚未迁移（源 `src/pages/requirement/` 共 **22186 行**，其中 `RequirementList/index.tsx` 1270 行），点进去是 404。已移除这两处链接，待需求列表页迁移后再加回。
- 测试基线 **451/452**（唯一失败仍为上游继承的 `route-repo` 红测试）；typecheck / build 通过。

### 5.3.14 第二十轮：需求数据服务的配置入口与提示语（2026-10-17）

- **用户质疑**：「接入服务未配置：请设置 window.YD.BOSS_API_URL 后重试」——为什么要这个？
- **架构事实（查证）**：需求列表/项目接入/仪表盘的数据**不在 opencode SaaS 里**，而在外部业务域（boss harness，`/boss/api/v3/harness`）；SaaS 只管会话/沙箱/文件/模型。源项目 `window.YD` **从不赋值**（`src/env.d.ts` 只有类型声明，`index.html` 不注入），由宿主部署平台注入——所以源项目永远配好。
- **该质疑成立的两点**：① 文案是开发者黑话，部署者看不懂；② 只认 `window.YD` 注入，而 hn-app 是独立应用、无宿主注入 → 这些功能必然失败，且与项目已有约定（`utils/opencode-saas-base.ts` 的 `window.YD` → `VITE_` env → 默认值）不一致。
- 修正 `requirementApiBaseUrl` / `bossApiBaseUrl`：来源优先级改为 **`window.YD.BOSS_API_URL` → `VITE_BOSS_API_URL` → 未配置**，尾部斜杠归一（避免拼出 `//boss/...`）。独立部署走 env，宿主注入场景保持 1:1 兼容。
- 文案改为面向部署者：「需求数据服务未配置：请设置 VITE_BOSS_API_URL（或由宿主注入 window.YD.BOSS_API_URL）后重启」/「需求数据服务无响应：…」。项目接入看板同类文案同步。
- 新增 4 例单测锁优先级（注入优先于 env / 无注入读 env / 皆无为空 / 尾斜杠归一），`client.test.ts` 累计 13 例。
- **端到端验证配置入口真能用**：临时 `VITE_BOSS_API_URL=http://boss.test npx vite --port 3011`，Playwright 观测到请求确实发往 `http://boss.test/boss/api/v3/harness/v2/requirements/all`，页面正常渲染（总数 2），且 60s 轮询触发第 2 次请求。
- 测试基线 **455/456**；typecheck / build 通过。

### 5.3.13 第二十一轮：接入 hn-base-server（认证 + free-chat 数据链路）（2026-10-19）

- **认证**：`lib/auth.tsx` 纯 fetch 实现（signIn/signUp/signOut/fetchSession + `AuthProvider`/`useAuth`）；登录页 `/login`；`AuthGate` 守卫包布局路由；侧栏 `UserMenu`（头像+登出）。开关式：配置 `VITE_HN_BASE_URL` 启用，未配置保持直连现状。
- **数据链路切换（free-chat）**：`lib/session-source.ts` 抽象「直连 SaaS / 经 base-server」两种实现；`lib/base-sse.ts` 用 fetch 流解析 SSE（EventSource 带不了 Authorization），断线 3s 重连；`DataProvider` 加可选 `bridge`（事件订阅 + 消息加载），base 模式下单会话订阅。
- **e2e 实测全链路**（Playwright）：注册 → 新建会话（`POST /api/sessions`）→ 发消息（`POST .../message`）→ **agent 真实执行并回复**（SSE 事件驱动时间线）；请求序列 get-session → sessions → POST sessions → messages + event → POST message 全部经网关，归属校验生效（他人 404 已在 base-server e2e 覆盖）。
- **排掉两个深坑**：① `better-auth/react` 在页面导致 renderer 主线程打满（白屏、evaluate 挂起）→ 改纯 fetch 调标准 REST 端点并移除该依赖；② AuthGate 包整个 Routes 时在 /login 渲染 `<Navigate to="/login">` 同路径死循环 → 守卫只包布局路由。
- base 模式下 slash 会话命令暂不可用（client.command 抛明确错误），普通消息/中止不受影响。
- 回归 455/456（唯一失败仍为上游继承的 route-repo 红测试）；typecheck/build 通过。

### 5.3.14 第二十二轮：需求对话/项目接入/仪表盘切网关 + 文件预览 + 存量迁移（2026-10-19）

- **需求对话**：`sessionSource()` + `useSessionBridge`（从 free-chat 抽出）；修两个真 bug：① 无会话时创建后仍用旧空 `sid` 发送（消息发不出）→ 改用 `targetSid`；② `loadMessages` 空结果覆盖刚插入的乐观消息（消息闪一下消失）→ 空结果且本地有消息时保留。
- **阶段 agent 回退**：`specer` 等阶段 agent 由 harness 注入，本地 SaaS 不存在 → 卡在「思考中」。新增 `use-available-agents` + `pickAvailableAgent`，不存在时回退 `build`（实测回复正常）。
- **项目接入**：入口页网关模式下创建「需求 + 会话」；会话页接 bridge；无 intake confirm-job 概念时隐藏右侧状态看板。
- **仪表盘**：数据源切 `/api/requirements`（`fromGateway` 字段映射）；base-server 列表/详情 join 用户表返回 `ownerName`，人员排行可用。
- **文件预览**：`readSandboxFile` 增加网关分支（`/api/sessions/:id/fs/content` + Bearer，二进制/JSON 双处理），失败回退直连链路。
- **存量迁移**：`migrate-legacy.mjs` 支持 `--user <userId>`（个人资源，无需组织）；实测 100 条 → 演示账号登录后「自由对话」列表显示历史会话（50 条上限）。
- 回归 455/456（唯一失败仍为上游继承的 route-repo 红测试）；typecheck 通过。

### 5.3.15 第二十三轮：Git 服务连接页（2026-10-19）

- 新增 `/git-providers` 页面 + 侧栏入口（辅助工具组，`GitBranch` 图标）。
- 设计参考：Linear Integrations（卡片列表 + 状态徽章 + 行内操作）、Vercel/Netlify（重新校验）、GitHub Settings → Applications（授权范围与凭据脱敏）。
- 列表行：类型图标（GitLab 橙 / GitHub 黑）、显示名、状态徽章（已连接 / 凭据失效）、`host · 归属 · 脱敏 token · 创建日期`、校验与删除。
- 添加对话框：选类型（GitLab / GitHub 卡片）→ 显示名 / 实例地址（支持自建）/ 访问令牌（加密存储）→ 授权范围（只读 / 读写，附对应 scope 文案）→ 「连接并校验」（后端先 verify 再入库，失败内联报错）。
- 删除走二次确认对话框；空态引导添加；未启用网关模式时给出明确提示。
- e2e（mock GitLab）：空态 → 添加（校验通过）→ 列表显示脱敏凭据 → 重新校验 → 删除确认 → 回到空态，无页面错误。
- 测试辅助：`test/mock-gitlab.mjs`（本地 mock，可复用手动验收）。

### 5.3.16 第二十四轮：创建应用（复用网关应用概念 + Git Provider 建仓 + 脚手架）（2026-10-19）

- **为什么不直接调网关**：`POST /gw-api/apps/project/:appId` 强耦合 GitLab API + `execSync("create-xybot-app ...")`（内部 CLI），且注册与建仓绑定、无独立注册接口；本地无网关/GitLab/CLI。按确认的方案 B 实现。
- **复用而非重建**：应用字段对齐网关 `apps` 表（`appId/domain/baseRoute/config/enabled`）；建仓与提交**复用**已有 `GitProvider`（`createRepo`/`commitFiles`）；脚手架由 `lib/scaffold/vite-react.ts` 生成。
- 后端：`app` 表 + `GET/POST /api/apps`；建仓（GitLab 空仓库 create / GitHub upsert）→ 提交 14 个脚手架文件 → 写归属元组；重复 appId 409。
- 脚手架：Vite 7 + React 19 + TS + Tailwind v4 + shadcn/ui（`components.json`、`cn()`、Button 示例），`bun install && bun run dev` 可启动。
- **组织改为选择**：新增 `GET /api/orgs`（我所属组织）与 `GET /api/git-providers/:id/owners`（GitHub org / GitLab group）；向导第 1 步「归属组织」、第 2 步「仓库归属」均为下拉，不再手输。GitHub OAuth scope 增加 `read:org`。
- 去重：`Field`/`ProviderLogo`/提示条/空态抽到 `components/settings/settings-ui.tsx`，Git 服务页与应用页共用。
- 修输入问题：`appId` 输入时不再 trim 尾部短横线（之前输入 `order-` 会被立即改成 `order`）。
- e2e（mock GitLab + mock groups）：组织列表、owners 列表、创建应用（orgId + owner 落库、14 文件提交）、向导两步下拉均验证通过。

### 5.3.17 第二十五轮：应用详情页 + 组织来源修正（2026-10-19）

- 新增 `/apps/:appId` 详情页：概览（appId/域名/类型/技术栈/默认分支/创建时间）、Git 仓库（地址 + 分支列表，来自 provider 授权）、危险操作（删除应用，仅移除记录与归属，不删仓库）。
- 列表项整行可点击进入详情；新增 `DELETE /api/apps/:appId`（check delete + 级联删元组 + 审计）。
- **修正组织来源**：之前把「归属组织」做成了平台 better-auth organization，与 Git 组织混淆。现移除平台组织字段，组织统一来自 Git provider 授权（GitHub `/user/orgs`、GitLab `/groups?min_access_level=30`），标签明确为「组织（仓库归属）」并注明来源。
- 修复 `appId` 输入时尾部短横线被 trim（输入 `order-` 变 `order`）：输入清洗不再 trim，提交时再 finalize。

### 5.3.18 第二十六轮：应用工作台（独立布局 + 独立侧栏菜单）（2026-10-19）

- 参考控制台布局：点击应用 → 新标签打开 `/#/apps/:appId`，**不复用 L1 图标导航**，使用应用自己的侧栏菜单。
- 路由：`/apps/:appId` 从 `AppLayout` 移出，改为独立全屏路由（仍由 `AuthGate` 保护）。
- 侧栏：应用名 + 状态徽章 → 「新对话」→ 管理分组（应用管理 / Git 服务 / 应用设置）→ 会话历史 → 底部用户区；`SidebarLink` 为后续扩展项（Harness 管理等）预留。
- 右侧 Tabs：工作台（一句话需求输入 + 模型/分支/发送）与设置（概览 / Git 仓库 / 删除）；提交需求后创建「需求 + 会话」并跳转需求对话。
- 数据：`requirement.app_id` + `GET /api/apps/:appId/sessions`（按应用过滤会话历史）。
- 实测：新标签打开 → 独立侧栏渲染（L1 图标栏数量 0）→ 会话历史显示 → 「应用设置」切换 Tab → 提交需求跳转会话，无页面错误。

### 5.3.19 第二十七轮：工作台改为「项目 → 需求列表 → 会话」（2026-10-19）

- 左侧由「会话历史」改为**需求列表**（项目维度）：每条显示需求标题、状态（草稿/待处理/进行中/待发布/已完成/已归档）、类型（常规/Bugfix）、更新时间；无关联会话的需求标注「无会话」且不可点击。
- 新增 `GET /api/apps/:appId/requirements`：按 `requirement.app_id` 取出需求并左连 `requirement_session`，每个需求保留主会话（优先 `role=primary`）。
- 点击需求在**工作台内嵌会话**（URL `?session=<id>`），不再跳转需求对话老页面；会话视图复用 `SessionTimeline` + `Composer` + `sessionSource`，支持发送/中止。
- 提交「一句话需求」后：创建需求 + 会话 → 刷新需求列表 → 自动打开该会话（无需跳页）。
- 实测：需求列表两项（含 Bugfix/无会话标记）→ 点击有会话需求打开内嵌会话 → 无会话需求禁用 → 提交新需求后列表新增并打开会话，无页面错误。

### 5.3.20 第二十八轮：工作台分支选择与新建分支（2026-10-19）

- 输入框底部的静态分支标签改为**分支选择器**（Popover）：列出仓库已有分支（含「默认」标记），底部支持「新建分支（基于当前分支）」内联输入。
- 后端：`GitProviderClient.createBranch`（GitLab `POST /repository/branches`；GitHub 取 `git/ref/heads/{from}` 的 sha 后 `POST /git/refs`）+ `POST /api/git-providers/:id/branches`。
- 需求创建支持 `workBranch`（落库到 `requirement.work_branch`），工作台提交时带上当前选中分支。
- 实测（mock GitLab）：下拉展示 main/develop → 选中 develop → 新建 `feature/data-export` 成功并选中 → 提交需求后 `workBranch=feature/data-export` 落库。

### 5.3.21 第二十九轮：工作台底部用户区布局修正（2026-10-19）

- 问题：240px 侧栏里沿用了 64px 图标栏的「头像在上、登出在下」垂直布局，底部大片留白且分隔线位置突兀。
- 修正：`UserMenu` 增加 `layout`（`vertical` 供 L1 图标栏 / `horizontal` 供宽侧栏）；工作台使用水平布局：头像 + 邮箱（截断）+ 登出同一行，高度约 40px，分隔线紧贴用户区顶部。
- 复用同一组件，未新增重复实现。

### 5.3.22 第三十轮：工作台侧栏可收起（2026-10-19）

- 侧栏（240px）支持收起/展开：侧栏 header 右侧 `PanelLeftClose`；收起后主区 header 左侧出现 `PanelLeft` 展开按钮。
- 快捷键 `⌘B / Ctrl+B`（输入框/文本域内不拦截），状态持久化到 `localStorage.hn_app_panel_collapsed`，刷新保持。
- 宽度过渡 200ms，收起时 `w-0 border-r-0 + aria-hidden`，主区自适应占满。
- 实测：240 → 0 → 240；⌘B 切换；刷新后保持收起。

### 5.3.23 第三十一轮：工作台输入区视觉精修 + 切换按钮位置对齐（2026-10-19）

- 输入区重做（对齐 ChatGPT/Claude 质感）：`rounded-2xl` 卡片 + 聚焦态边框/阴影、textarea 随内容自动高度（上限 200px）、占位符降低对比度。
- 「需求目标 / 功能描述 / 验收标准」由灰底标签改为 **ghost 按钮**，点击在光标处插入 `## 标题` 模板（真实功能）。
- 模型选择、分支选择统一为 `h-7 rounded-md bg-muted/60 border-0` 的轻量控件；发送按钮改为 28px 方形图标按钮，有内容时深色、无内容时灰色。
- 切换按钮位置按自由对话页模式调整：**常驻主区 header 左侧**（`PanelLeft`，aria-label 随状态变化），移除侧栏 header 的收起按钮；⌘B 与持久化保留。
- 实测：展开 240px ↔ 收起 0px 切换；模板插入 `## 需求目标\n`；发送按钮随内容启用；无页面错误。

### 5.3.24 第三十二轮：输入区整体精致化（2026-10-19）

- 结构：标题/副标题/输入卡片**整体垂直居中**（此前标题在屏幕中央、输入框贴底，视觉断裂）；卡片宽度收窄到 `max-w-2xl`。
- 卡片：`rounded-2xl` + `overflow-hidden`；textarea 与底部工具条之间加 `border-t` 分隔，层次清晰。
- 控件：模型/分支由「灰底块」改为**描边控件**（`border bg-background` + hover），避免看起来像禁用态；发送按钮 28px 方形，有内容时黑底、无内容时描边。
- 空态：增加 `新需求` eyebrow 徽章（Sparkles），标题/副标题层次更完整。
- 聚焦反馈：`ring-2 ring-foreground/[0.04]` + 明确边框 + 柔和阴影；textarea 随内容增高（上限 200px）。
- 标签按钮支持点击插入 `## 需求目标` 等模板；提示文案居中、降噪。

### 5.3.25 第三十三轮：全局需求列表 + 工作台最近需求（2026-10-19）

- 侧栏导航「应用」改为**需求**（`/requirements`）：全局需求列表（跨应用），显示标题、状态、所属应用、更新时间；无主会话的需求标注「无会话」并禁用点击。
- 搜索：标题/ID 模糊匹配（防抖 280ms）；后端 `GET /api/requirements` 支持 `q`、`appId`、`limit`，并 leftJoin 应用名与主会话（每需求保留 primary 会话）。
- 创建需求：对话框（标题/描述/可选应用）→ 创建需求 + 会话 → 有应用跳 `/apps/:appId?session=`（工作台内嵌会话），无应用跳 `/requirement-chat/-/:sessionId`。
- 点击需求：按归属跳转（有应用 → 工作台，无应用 → 需求对话）。
- 工作台左侧需求列表改为**最近 10 个**（按 timeUpdated 倒序），其余滚动查看。
- 状态映射抽到 `lib/requirement-status.ts`，工作台与需求列表共用。
- 实测：13 条列表、搜索「需求-01」命中 1 条、limit=10、创建需求跳转工作台会话、工作台显示 10 条。

### 5.3.26 第三十四轮：需求创建编排（建分支 + clone 到沙箱）（2026-10-19）

- 新增 `POST /api/requirements/prepare`：一次完成「需求落库 → 创建会话 → 远端建分支 → 沙箱 clone/checkout」，返回 `{ requirementId, sessionId, branch, prepared, prepareError }`。
- **双协议适配**（`lib/saas.ts`）：
  - 创建会话：V2 `POST /api/session`（`{data:{id}}`）优先，legacy `POST /session`（`{id}`）回退
  - 执行命令：V2 `POST /api/session/:id/shell` + `GET /api/experimental/session/:id/log`（shell.ended 的 `exit/output`）；legacy `POST /session/:id/shell`（输出在返回消息的 tool part）
  - **legacy 的 tool status 不可靠**（命令失败仍标 completed）→ 用成功标记 `PREPARE_OK` 判断；V2 用 exit code
- clone 命令：临时 `.netrc`（chmod 600，trap 清理）→ `git init/fetch` → `git checkout -B <workBranch> origin/<workBranch>` → 输出 `PREPARE_OK`。
- 前端：工作台提交与「创建需求」对话框统一调用 prepare；失败时 toast 回传真实 git 错误。
- 权限：prepare 校验 `git_provider#use`。
- 实测：mock 仓库 clone 失败 → `prepared:false` + 真实 `fatal: unable to access ...`；真实 GitHub 仓库 → fetch/建分支/checkout 成功，`/workspace` 出现 README/components.json/package.json/src。

### 5.3.27 第三十五轮：真实场景验证（真 GitHub 仓库 + 真 SaaS + 真模型）（2026-10-19）

- **发现并修复一个真 bug**：V2 `POST /api/session` 的 directory 只认 **body 的 `location: { directory }`**，query `?directory=` 会被忽略并回落到镜像默认目录 `/app/packages/opencode`。这导致 session.directory 错误 → shell / file 工具 / agent 编辑与预期工作区不一致（曾表现为 edit 报告成功但 shell 看不到改动）。
- 修复 `saasCreateSession`：body 同时传 `location.directory`（query 保留兼容 legacy）。
- 真实链路验证（用户 `shangwfa@gmail.com` 的真实 GitHub OAuth 连接 + `shangwfa/rumu-demo-001`）：
  - `GET /branches` 返回真实分支 main ✓
  - `prepare` → `prepared:true`，远端真实创建 `feature/e2e-*` 分支 ✓
  - 沙箱 `/workspace` 出现 clone 内容（README/components.json/package.json/src/tsconfig）✓
  - agent 真实执行（read/edit/bash 工具调用）并回复「完成」✓
  - `session.directory` 修复后为 `/workspace` ✓
- **本地环境限制**：`OPENCODE_SANDBOX_IDLE_KILL_SEC=30`，沙箱空闲 30s 销毁；跨较长间隔的操作会丢状态（连续请求内验证文件持久正常）。生产需确认 TTL / keep-alive 配置。
- e2e 脚本修复：Origin 改为 `E2E_ORIGIN`（默认 3002）；`git-flow` mock 端口隔离（3296）；`p3-flow` 断言允许沙箱就绪后的 200。

### 5.3.28 第三十六轮：编排操作对 chat 不可见 + 恢复应用入口（2026-10-19）

- **问题**：需求创建编排（prepare 的 clone / 切分支）在 chat 里显示成 Shell 工具卡；L1 全局导航缺少「应用」入口，无法从首页进入应用列表/创建应用。
- **编排不可见（数据层统一过滤）**：
  - base-server 的 prepare 给编排 shell 固定 messageID 前缀 `msg_prepare_*`（V2 用 `id`，legacy 用 `messageID`）。
  - `src/lib/system-messages.ts`：识别前缀消息 + 由它触发的 assistant 回复；并对历史会话兜底识别 legacy 固定文案 `The following tool was executed by the user`。
  - `src/context/data.tsx`：`message.updated` / `loadMessages` / `message.part.updated` 三处统一过滤（先隐藏、后到达的消息也不会漏），所有页面共享。
  - 工作台发送时注入 `runtimeContextText`（synthetic，不显示）：告知 agent 工作区已就绪，不要重复 `git clone`。
- **恢复 L1 入口**：`components/layout.tsx` 第二组新增「应用」（Boxes）→ `/apps`；应用列表与「创建应用」向导（新建仓库 / 使用已有仓库）均正常。
- **验证**：
  - 浏览器实测：首页 → 侧栏「应用」→ `/apps` → 创建应用弹窗三步骤正常；工作台新需求编排完成后 chat 无 Shell 卡片、无页面错误。
  - 历史会话（旧 legacy shell 消息）也不再显示。
  - 单测：hn-app 465 个（新增 9 个过滤用例），仅约定不修的 `route-repo` 失败；base-server 65 个全通过（新增 saas 协议用例 4 个）。

### 5.3.29 第三十七轮：需求收敛到应用内（2026-10-19）

- **产品口径**：需求跟着应用走——需求的入口在应用工作台（应用 → 需求列表 → 会话），不再提供全局需求入口。
- **L1 侧栏**：移除「需求」（`/requirements`）项；保留「应用」入口。
- **首页**：移除「需求对话」卡片，替换为「应用」（每个应用拥有自己的需求列表）；副标题改为「应用 · 自由对话 · 项目接入」。
- **路由保留**：`/requirements` 与 `/requirement-chat/*` 仍可直接访问（项目接入与旧链接会用到），只是不再有全局导航入口。
- 验证：浏览器实测侧栏无「需求」、首页仅「应用 / 自由对话 / 项目接入」，typecheck 通过；单测 465 个，仅约定不修的 `route-repo` 失败。

## 六、继续迁移建议顺序

1. ~~会话消息流~~ → **已接通**（REST + SSE + optimistic；剩余：时间线特殊 tool 视图、agent 徽章色、重试 UI）
2. ~~fetchArtifact 适配~~ → **已接通**（GET /file/content）
3. **suggest-step 接口**：`fetchSuggestStep` 对接 harness
4. **composer 高级交互**：slash/at 浮层 UI、文件选择器、图片粘贴附件 UI（逻辑已迁）
5. **workspace 文件管理** + **CDP 面板** + **preview dock**（feature 结构与源一致，逐文件搬）
6. **openui 消息渲染**（React runtime 已迁，消息 UI 待接）
7. **requirements-v2 / project-intake / 飞书 collab** 界面
8. `src/ui/**` 其余组件按需 shadcn 化，不整包翻译
