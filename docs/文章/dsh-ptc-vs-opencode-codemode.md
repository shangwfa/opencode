# DeepSeek Harness "Code Mode (PTC)" 与本项目 Code Mode 对比

> 背景：DeepSeek Harness（DSH）的文档/Agent Notes 中反复出现 **Code Mode**；该项目在 2026-08 的预发布阶段把它**改名并统一为 PTC mode**（programmatic tool calls，程序化工具调用）。本项目（opencode SaaS）本身就以 Code Mode 为核心执行模型（`packages/codemode`、`packages/core/src/codemode`，工具名 `execute`）。两者同源——都源自 Cloudflare 的 [Code Mode](https://blog.cloudflare.com/code-mode/) 范式：模型不逐步发 tool-call，而是**写一段程序**调用工具，只把 print/return 的结果送回上下文。
>
> 资料来源：
> - DSH：`.agents/notes/implemented/feature/2026-06-15-ptc.{md,zh.md}`、`.agents/notes/implemented/architecture/2026-09-11-sandboxed-node-ptc-runtime.zh.md`、`.agents/notes/archived/architecture/2026-08-25-rename-code-mode-to-ptc.zh.md`、`docs/subsystems/claude-code-mods.zh.md`
> - 本项目：`docs/design/codemode-session-sandbox-execution.md`、`packages/codemode/*`、`packages/core/src/codemode/*`

## 一句话结论

同一范式，两种落点：

- **DSH** 把 Code Mode 定义为 **`ToolRuntime` 的一种呈现模式**（`native | ptc | both`），通过配置切换；执行时**每次在全新 Node 子进程里跑**，受调用 Session 的 **OS 沙箱策略**约束，程序内**可以直接用 Node API**。
- **本项目** 把 Code Mode 定义为 **一个工具（`execute`）+ 一个受限 JS 解释器**：语言级隔离（无 import/fs/process/env），工具通过 `tools.xxx()` 调回宿主；SaaS 部署下把解释器搬进 **Session Sandbox**，工具经 **WebSocket 回到 SaaS Tool Gateway**。

## 对比表

| 维度 | 本项目 opencode Code Mode | DeepSeek Harness PTC（原 Code Mode） |
| --- | --- | --- |
| 定位 | 一个工具 `execute` + 运行时；模型写 JavaScript 子集 | `ToolRuntime` 的呈现模式之一（`native`/`ptc`/`both`），注册表拥有模式 |
| 入口 | `execute({ code })` | `run_code({ code, description })`（两个参数都必填） |
| 模型写什么 | JavaScript 程序（可 `return`，或用末表达式） | 所加载运行时语言的 **async 函数体**：默认 TypeScript，另有 Python（`async` + `asyncio.gather`） |
| 工具暴露 | 提示词注入 **catalog 指令**（含签名行、`search()` 分页发现、pinned、inline 预算 ~2000 字符） | 注入 **生成的 SDK `.d.ts`**（`jsonSchemaToTs`，JSDoc 带 schema 描述）；`'both'` 下同时给原生 schema |
| 工具调用方式 | `tools.xxx(args)` / `tools["ns"]["name"](args)`，精确路径 | `await tools.name(args)`（命名异步绑定） |
| 执行基底 | **受限解释器**（自定义 JS 子集，`transpile.node/workerd` + AST 求值），**无 Node API**；有纯函数 stdlib（array/json/math/regexp/string/url/date 等） | **每次全新 Node 子进程**（`dsh-ptc-runtime-node`），按 Session 解析的 **OS 沙箱策略**运行；**策略内可直接用 Node API** |
| 隔离信任点 | 语言级隔离：无 import、无 fs、无 child_process、无 env、无 timers；SaaS 版 Runner 无服务端密钥 | OS 级隔离：文件/子进程策略同 Bash；显式否决用 `node:vm` realm 当安全机制 |
| 工具/宿主通信 | SaaS 主动建 WebSocket：Runner → Tool Gateway；`tool.call`/`tool.result` 帧 | 专用**继承式二进制控制通道**（与 stdout/stderr 分离）；Host 预校验帧、调用身份、绑定允许列表 |
| 网络 | 默认无 `fetch`；显式开启后由 Runner 所在 Sandbox 进程原生 fetch（不回退 SaaS） | 程序在 Node 进程内，直接受 OS/后端策略约束 |
| 资源预算 | `timeoutMs` / `maxSteps` / `maxToolCalls` / `maxOutputBytes`（SaaS **默认不设限额**，部署侧显式开启）；解释器值上限：字符串 2²⁴、数组 1e7、pending promise 1e4、值深度 32 | **经过时间**默认 120s、上限 600s（可信方可 `null` 关闭）；V8 老生代堆、控制帧/排队写入/未完成参数上限；`maxParallelSubCalls` 默认 10 |
| 并行子调用 | 设计目标支持（`maxParallelToolCalls`，**尚未实现**）；`Promise.all` 受并发安全分类约束 | 每 run 一个分发队列，按提交顺序启动；并发安全类最多重叠 `maxParallelSubCalls`，exclusive 类串行 |
| 状态模型 | **每次执行全新实例**，无持久内核（保「请求是日志的纯函数」） | **每次 run 全新实例**，无持久内核（同理由，可重建性） |
| 失败/重放 | 副作用命令绝不自动重放；SaaS 用 `(execution_id, ordinal)` 幂等 | 失败程序不隐式重放（先前效果可能已提交） |
| 命名 | Code Mode（即执行模型名） | 原名 Code Mode → **PTC mode**；标识符 `ptc`，用户文案保留「PTC 模式」；`run_code`/`code` 参数不动 |
| 配置切换 | feature flag `OPENCODE_CODEMODE_EXECUTOR=server|sandbox`；工具级 `options.codemode:false` 排除进 code mode | `tools.mode: 'native'|'ptc'|'both'`，经 `cordis.yml` 翻转，无兼容别名 |

## 关键取舍差异

1. **呈现模式 vs 执行模型。**
   DSH 明确把 PTC 定义为「工具呈现的传输层，而非 plan-mode 那样的模式」，所以它和 `native` schema 是**同一个可见存储的两种投影**（`'both'` 并存）。本项目的 Code Mode 更像「一种执行模型」，由 `execute` 工具承载，并通过在每条工具的 `options.codemode` 上打标来区分哪些工具进 code mode、哪些走原生直连（如 `edit`/`write`/`shell`/`subagent` 是 `codemode:false`）。

2. **隔离哲学不同。**
   DSH 相信 **OS 沙箱 + Node 直连**：程序就是 Node，能力由底层策略（文件/子进程）裁剪。本项目相信 **语言级裁剪**：解释器根本不暴露 fs/process/import，能力只能经 `tools` 显式授予。本项目的 SaaS 版再把解释器放进 Session Sandbox，等于**双重约束**（语言 + 沙箱），代价是自研解释器和 stdlib。

3. **SDK 交付方式不同。**
   DSH 生成 `.d.ts` 提示给模型（类型是建议性的，运行时剥离），并承认 `'both'` 下 SDK 可能与原生 schema 体量相当、成本翻倍。本项目用 catalog 指令 + `search()` 按需发现工具，并做 inline 预算截断（描述 120 字符、总计 ~2000 字符），对前缀缓存更友好。

4. **语言面不同。**
   DSH 支持 TypeScript 与 Python 两种 flavor（后端语言是运行时属性，未来可加容器后端）。本项目限定 JavaScript 子集。

5. **自研 vs 借力。**
   本项目自实现解释器（含值上限、稳定诊断 `StepLimitExceeded` 等），换来完全无环境能力的确定性；DSH 借 Node 进程（含 `stripTypeScriptTypes` 这类 experimental API 风险）与 Codex Code Mode 的执行模型，换来直接能力。

## 对本项目的启示

- **呈现模式化的可能**：DSH 的 `native | ptc | both` 是一个干净的抽象——原生 schema 与 SDK 是同一目录的两种投影。我们目前以 `execute` 工具 + `codemode:false` 白名单来近似，若未来要在「原生工具调用」与「代码调用」间平滑切换，可参考这种**注册表拥有呈现模式**的做法，并注意 `toolOrder` 与协议面完整性的连带影响。
- **SDK 提示成本**：DSH 自陈 `.d.ts` 与原生 schema 同量级，`'both'` 翻倍。我们的 catalog + `search()` 分页 + inline 预算正是对冲手段，可继续强化「按需暴露」。
- **并行子调用的兑现**：DSH 已给出 `maxParallelSubCalls`(默认 10) + 并发安全分类的实际实现；本项目的 `maxParallelToolCalls` 仍是设计目标（未实现），是需要补齐的能力。
- **限额默认值**：DSH 给 PTC 设了默认 120s/上限 600s 的经过时间预算；本项目 SaaS **默认不限额**（`while(true){}` 靠 `maxSteps` 才能抢占）。生产建议显式开启 `timeoutMs` 与 `maxSteps`——这与设计文档 §6 的提醒一致。
- **命名经验**：DSH 预发布阶段一次性把 `code`→`ptc` 全部改名且不加兼容别名，同时刻意**不动** `run_code`/`code` 参数与持久事件词汇（那是需要独立迁移边的结构变更）。这是清晰的「配置标识符 vs 持久词汇」边界处理，值得借鉴。
