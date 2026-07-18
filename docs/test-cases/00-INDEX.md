# SaaS 测试用例索引

> 公共配置（测试环境、模型、验收分层）见 [`00-preamble.md`](./00-preamble.md)。
> 全量验收状态表见 [`99-acceptance-status.md`](./99-acceptance-status.md)。
>
> **2026-07-17 整理**：文件编号与用例 ID 已统一（文件编号 = 用例主编号），可执行脚本移入 [`scripts/`](./scripts/)，排查指南移入 [`guides/`](./guides/)。历史编号对照见文末[编号变更记录](#编号变更记录)。

## 测试用例文档

| 文件 | 用例 ID | 内容概述 |
|------|---------|---------|
| [`01-health-and-session.md`](./01-health-and-session.md) | T1.x T2.x | 健康检查、全局配置、Session CRUD |
| [`02-auth-credentials.md`](./02-auth-credentials.md) | T3.x | Provider 凭据设置/删除/持久化 |
| [`03-ai-conversation.md`](./03-ai-conversation.md) | T4.x | 文本对话、多轮上下文、工具调用（写/读/bash）、异步消息、中断 |
| [`04-sandbox-pvc.md`](./04-sandbox-pvc.md) | T5.x | 沙箱创建/销毁、PVC 持久化、多文件/目录 |
| [`05-concurrency-isolation.md`](./05-concurrency-isolation.md) | T6.x | 并发 session 创建、跨 session 文件隔离、并发消息、20 会话混合并发（T6.11） |
| [`06-error-handling.md`](./06-error-handling.md) | T7.x | 未配置 provider、不存在的 session、无效 JSON、缺失字段、超长消息 |
| [`07-provider-sse.md`](./07-provider-sse.md) | T8.x T9.x | Provider 列表、模型切换、SSE 事件流订阅 |
| [`08-e2e.md`](./08-e2e.md) | T10.x | 完整开发流程端到端 |
| [`09-sandbox-proxy.md`](./09-sandbox-proxy.md) | T11.x | 两部分：T11.1-15 proxy 注入与路径重写（HTML/JS/CSS、HMR、keepAlive）；T11.16-25 dev server 生命周期（exec/async、SSE stream、endpoint 直连） |
| [`10-sandbox-lifecycle.md`](./10-sandbox-lifecycle.md) | T12.x | 沙箱按需创建/复用/销毁、PVC 恢复、idle 超时、keepAlive、进程隔离 |
| [`11-saas-stability.md`](./11-saas-stability.md) | T13.x | kill-sandbox、dispose 并发、HMR、路径重写、PG FK、rate limit、安全、幂等性、观测性 |
| [`12-compatibility.md`](./12-compatibility.md) | T14.x | Session 列表过滤、status、fork、分页、share、diff/revert、file/find/VCS API |
| [`13-session-skills.md`](./13-session-skills.md) | T15.x | Session skill CRUD、bundle、resources、按需加载、upsert、同名覆盖、permission、边界、多 skills 主动/被动触发 |
| [`14-session-agents.md`](./14-session-agents.md) | T16.x | 会话级动态 Agent 创建/列出/删除、primary/subagent 模式、权限、隔离、级联 |
| [`15-sandbox-endpoint.md`](./15-sandbox-endpoint.md) | T17.x | Sandbox 直连 IP 访问、endpoint API、proxy vs 直连对比 |
| [`16-tool-calls.md`](./16-tool-calls.md) | T18.x | 7 种工具调用批量验证、消息流结构 |
| [`17-exec-api.md`](./17-exec-api.md) | T19.x | exec 命令执行 API、keepAlive、超时、环境信息 |
| [`18-sandbox-tool-test.md`](./18-sandbox-tool-test.md) | （无编号） | 沙箱工具测试：apply_patch/ls 沙箱分支、路径转换、边界与并发压力、错误信息泄露检查 |
| [`43-shell-perf-sse.md`](./43-shell-perf-sse.md) | ST.Ex ST.Sx | Shell 执行性能优化（并发 createSession、getOrCreate 超时、sbCache TTL）与 SSE 早退优化（延迟、exitCode 推断、输出完整性）。从 18 拆分而来 |
| [`19-path-leak-test.md`](./19-path-leak-test.md) | PL-x WF-x | 路径泄露防护：system prompt / 工具 I/O / `<env>` 块中宿主机路径映射为 /workspace |
| [`20-saas-tool-sandbox-verify.md`](./20-saas-tool-sandbox-verify.md) | T20.x | 8 工具沙箱执行三层验证（代码审查+运行时+PG） |
| [`21-workspace-routing.md`](./21-workspace-routing.md) | WR-x | Workspace Routing 路径解析：API 请求 directory fallback 到 session.directory |
| [`22-session-mcp.md`](./22-session-mcp.md) | T22.x | 会话级动态 MCP：CRUD、隔离、级联、校验 |
| [`23-package-cache.md`](./23-package-cache.md) | T23.x | 共享 Package Cache：标准 exec 使用流程、跨 session 缓存共享、npm/pnpm/yarn/bun、加速/并发、mountPath 校验 |
| [`24-preload-cache-switch-env.md`](./24-preload-cache-switch-env.md) | T24.x | 环境切换与预装依赖缓存：mise 多版本 Node/pnpm 切换、shims 自动检测、npm cache/node_modules 预装、跨版本缓存共享、隔离性 |
| [`25-session-user-fields.md`](./25-session-user-fields.md) | T25.x | Session 用户标识字段：userName/userId 传递、持久化、向后兼容、多轮独立标识 |
| [`26-session-agent-permissions.md`](./26-session-agent-permissions.md) | T26.x | Session Agent 权限：字符串简写、对象语法白名单、bash 粒度命令、last matching rule wins、worktree 影响权限 pattern、`**/`/`*` 前缀匹配、`...` 字面点限制 |
| [`27-session-lsp.md`](./27-session-lsp.md) | T27.x | Session LSP：容器内 daemon、TS 诊断、hover、definition、references、implementation、documentSymbol、workspaceSymbol、apply_patch/lsp sandbox 分支、健康检查、自动恢复 |
| [`28-sandbox-perf-watchdog.md`](./28-sandbox-perf-watchdog.md) | T28.x | 沙箱性能优化与 Watchdog 兜底：对象缓存（30s TTL）、getOrCreate 90s 超时、`SessionTools.markTimedOut` lifecycle 超时标记、CAS 幂等、配置注入、各阶段耗时日志 |
| [`29-session-sandbox-resource.md`](./29-session-sandbox-resource.md) | T29.x | 会话级沙箱资源配置：创建会话时设置 sandbox {cpu,memory}、PG 持久化、格式校验、SDK cgroup 验证、子会话/fork 继承、默认 {cpu:1,memory:2Gi} |
| [`30-sandbox-idle-reap.md`](./30-sandbox-idle-reap.md) | T30.x | 空闲沙箱定期回收：30 分钟无活跃即销毁（含 keep_alive=true）、CAS 保护、可配置阈值、扫描日志 |
| [`31-code-review-commands.md`](./31-code-review-commands.md) | T31.x | Code Review 命令：`/review`（自由文本）与 `/codex-review`（Codex 结构化 JSON + 优先级 + 合并裁决）对比测试 |
| [`32-session-tools.md`](./32-session-tools.md) | T32.x | Session 自定义工具：CRUD、动态加载（importToolCode）、隔离、级联、registry 合并 |
| [`33-session-commands.md`](./33-session-commands.md) | T33.x | Session 自定义命令：CRUD、overlay 合并（session 覆盖 instance）、隔离、级联、模板占位符、hints 自动推导 |
| [`34-session-goal.md`](./34-session-goal.md) | T34.x | Session Goal 停止条件：`/goal` 命令路由、状态机、judge 模型评估、runLoop 集成、fail-open、多 session 隔离、PG 持久化 |
| [`35-session-plugins.md`](./35-session-plugins.md) | T35.x | Session Plugins：PG CRUD、9 个已接入 Runtime Hook、缓存/生命周期/并发、错误隔离、API 脱敏、输入边界、动态代码安全、npm 包安装与真实功能验证 |
| [`36-session-agents-md.md`](./36-session-agents-md.md) | T36.x | Session AGENTS.md：会话级 AGENTS.md 约束注入、工具调用、真实 Vite React 场景验证 |
| [`37-load-dot-opencode.md`](./37-load-dot-opencode.md) | T37.x | 用户通过公开接口触发项目 `.opencode` 配置加载：资源扫描、PG 持久化、优先级、隔离、幂等、错误诊断和权限 |
| [`38-session-pvc-mode.md`](./38-session-pvc-mode.md) | T38.x | Session PVC 模式：session/app 模式创建、appId 校验、PVC 共享/隔离、自动 worktree（detach+幂等+降级）、PG 持久化、子会话继承 |
| [`39-concurrency-p0-fixes.md`](./39-concurrency-p0-fixes.md) | T39.x | 并发安全 P0 修复回归：级联删除、孤儿 sandbox、删除与进行中 LLM 竞态 |
| [`40-antd-mcp-e2e.md`](./40-antd-mcp-e2e.md) | T40.x | Ant Design MCP 端到端：CRUD、AI 感知/调用 MCP 工具、生成 Dashboard 代码 |
| [`41-mastra-mcp-e2e.md`](./41-mastra-mcp-e2e.md) | T41.x | Mastra MCP 端到端：CRUD、AI 查询 Mastra 文档、生成 Agent 代码 |
| [`42-compose-agent.md`](./42-compose-agent.md) | T42.x | Compose Agent 编排：plan→execute→review 编排执行、子 agent 并行分发、隔离、重启持久化 |

## 指南（非用例）

| 文件 | 内容 |
|------|------|
| [`guides/session-diagnostic-guide.md`](./guides/session-diagnostic-guide.md) | 会话问题诊断指南（卡顿/超时排查，配合 T28 Watchdog） |
| [`guides/sandbox-frontend-debug-guide.md`](./guides/sandbox-frontend-debug-guide.md) | 沙箱前端项目启动失败排查指南 |
| [`guides/exec-api-reference.md`](./guides/exec-api-reference.md) | exec / keep-alive API 参考（请求/响应字段、错误码；从 17-exec-api.md 迁出） |

## 公共脚本（根目录）

| 文件 | 说明 |
|------|------|
| [`test-env.sh`](./test-env.sh) | 环境组合切换：`source test-env.sh 3`（组合 1/2/3 → $BASE/$PG_URL/$MODEL/$NO_PROXY） |
| [`test-lib.sh`](./test-lib.sh) | 测试函数库：pass/fail/summary/jexec/new_sid/pgval |

## 可执行脚本（scripts/）

| 脚本 | 对应用例 | 说明 |
|------|---------|------|
| [`scripts/run-regression.py`](./scripts/run-regression.py) | 全局 | 全量回归套件（batch 1-15）：`python3 scripts/run-regression.py [batch]` |
| [`scripts/lsp-daemon-unit-test.mjs`](./scripts/lsp-daemon-unit-test.mjs) | T27.1-7.6 | LSP daemon 单元测试：宿主机直跑 daemon bundle，自动验证全部 13 个端点。实测 14/14 |
| [`scripts/lsp-sandbox-e2e-test.mjs`](./scripts/lsp-sandbox-e2e-test.mjs) | T27.8+ | LSP sandbox 端到端：OpenSandbox SDK 直连建真实 sandbox 容器，容器内启 daemon。实测 6/6 |
| [`scripts/lsp-smoke-test.mjs`](./scripts/lsp-smoke-test.mjs) | T27.x | LSP 冒烟：status/touch/diagnostics |
| [`scripts/lsp-tool-visibility-test.mjs`](./scripts/lsp-tool-visibility-test.mjs) | T27.x | LSP 工具可见性（EXPECT_LSP_DISABLED） |
| [`scripts/lsp-code-agent-e2e-test.mjs`](./scripts/lsp-code-agent-e2e-test.mjs) | T27.x | LSP code-agent 真实开发全流程 e2e |
| [`scripts/path-leak-e2e-test.mjs`](./scripts/path-leak-e2e-test.mjs) | PL-x | 路径泄露 e2e |
| [`scripts/path-leak-real-workflow-test.mjs`](./scripts/path-leak-real-workflow-test.mjs) | WF-x | 路径泄露真实开发流程 e2e |
| [`scripts/sse-dump.mjs`](./scripts/sse-dump.mjs) | T9.x | SSE 事件采集器：07 文档全部 SSE 用例的标准三段式脚手架（后台订阅 + 动作 + 日志断言） |
| [`scripts/sandbox-shared-test.mjs`](./scripts/sandbox-shared-test.mjs) | T16.29 | 主子 agent 沙箱共享验证：主→子写读、子→主写读、exec 独立验证 |
| [`scripts/vcs-diff-sandbox-test.mjs`](./scripts/vcs-diff-sandbox-test.mjs) | T16.30 | VCS Diff 沙箱重建验证：销毁后自动重建 PVC 恢复，两次 diff 一致 |

### 归档脚本（scripts/archive/）

以下脚本为一次性回归/调试用途，未被当前用例文档引用，保留作历史参考（其中用例编号可能为旧编号）：

| 脚本 | 原用途 |
|------|--------|
| `scripts/archive/lsp-app-mode-test.mjs` | app 模式 LSP e2e（旧 T27.23-27，现 T38 相关场景） |
| `scripts/archive/lsp-full-e2e-test.mjs` | LSP 综合 e2e（被 scripts/ 下拆分后的脚本替代） |
| `scripts/archive/lsp-full-endpoint-test.mjs` | LSP daemon 端点 HTTP 验证 |
| `scripts/archive/multi-agent-workflow-test.mjs` | 多 Agent 协作工作流（主题见 42-compose-agent.md） |
| `scripts/archive/permission-e2e-test.mjs` 等 4 个 | T26 权限 e2e 系列（permission-e2e-test/-test2/-edit-write/-prefix） |
| `scripts/archive/reproduce-136b900-test.mjs` | 复现 ses_136b900 specer 权限（对象语法） |
| `scripts/archive/run-03-ai-conversation.mjs` | 03 文档 T4.1-T4.7 回归（SSE 自动回复） |
| `scripts/archive/run-t26-batch1/batch2/regression/final.mjs` | T26 权限分批回归 |
| `scripts/archive/run-t27-pvc-mode.mjs` | PVC 模式回归（旧 T27.1-6，现 T38.1-6） |
| `scripts/archive/run-workflow.mjs` / `run-workflow-v2.mjs` | 多 Agent 协作 e2e |
| `scripts/archive/test-autoreply.mjs` | 权限测试通用自动回复 helper |

## 快速定位

```
T1.x  → 01-health-and-session.md        T22.x → 22-session-mcp.md
T2.x  → 01-health-and-session.md        T23.x → 23-package-cache.md
T3.x  → 02-auth-credentials.md          T24.x → 24-preload-cache-switch-env.md
T4.x  → 03-ai-conversation.md           T25.x → 25-session-user-fields.md
T5.x  → 04-sandbox-pvc.md               T26.x → 26-session-agent-permissions.md
T6.x  → 05-concurrency-isolation.md     T27.x → 27-session-lsp.md
T7.x  → 06-error-handling.md            T28.x → 28-sandbox-perf-watchdog.md
T8.x  → 07-provider-sse.md              T29.x → 29-session-sandbox-resource.md
T9.x  → 07-provider-sse.md              T30.x → 30-sandbox-idle-reap.md
T10.x → 08-e2e.md                       T31.x → 31-code-review-commands.md
T11.x → 09-sandbox-proxy.md             T32.x → 32-session-tools.md
T12.x → 10-sandbox-lifecycle.md         T33.x → 33-session-commands.md
T13.x → 11-saas-stability.md            T34.x → 34-session-goal.md
T14.x → 12-compatibility.md             T35.x → 35-session-plugins.md
T15.x → 13-session-skills.md            T36.x → 36-session-agents-md.md
T16.x → 14-session-agents.md            T37.x → 37-load-dot-opencode.md
T17.x → 15-sandbox-endpoint.md          T38.x → 38-session-pvc-mode.md
T18.x → 16-tool-calls.md                T39.x → 39-concurrency-p0-fixes.md
T19.x → 17-exec-api.md                  T40.x → 40-antd-mcp-e2e.md
T20.x → 20-saas-tool-sandbox-verify.md  T41.x → 41-mastra-mcp-e2e.md
                                        T42.x → 42-compose-agent.md
PL-x / WF-x → 19-path-leak-test.md      WR-x → 21-workspace-routing.md
ST.Ex / ST.Sx → 43-shell-perf-sse.md
```

## 编号变更记录

2026-07-17 整理时解决的编号冲突（同号多文档、用例 ID 撞号）：

| 原文件 | 原 ID | 新文件 | 新 ID |
|--------|-------|--------|-------|
| 19-saas-tool-sandbox-verify.md | T19.x（与 17-exec-api 撞号） | 20-saas-tool-sandbox-verify.md | T20.x |
| 20-path-leak-test.md | PL-x / WF-x | 19-path-leak-test.md | 不变 |
| 20-session-diagnostic-guide.md | — | guides/session-diagnostic-guide.md | — |
| sandbox-frontend-debug-guide.md | — | guides/sandbox-frontend-debug-guide.md | — |
| 23-antd-mcp-e2e.md | T23.x（与 23-package-cache 撞号） | 40-antd-mcp-e2e.md | T40.x |
| 23b-mastra-mcp-e2e.md | T23a.x | 41-mastra-mcp-e2e.md | T41.x |
| 26-compose-agent.md | T26.1-5（与 T26 权限前缀混用） | 42-compose-agent.md | T42.x |
| 27-session-pvc-mode.md | T27.x（与 27-session-lsp 撞号 16 个） | 38-session-pvc-mode.md | T38.x |
| 29-concurrency-p0-fixes.md | T29.x.y（与 T29 资源前缀混用） | 39-concurrency-p0-fixes.md | T39.x.y |
| 30-session-tools.md | T30.x（与 30-sandbox-idle-reap 撞号） | 32-session-tools.md | T32.x |
| 31-session-commands.md | T31.x（与 31-code-review-commands 撞号） | 33-session-commands.md | T33.x |
| 32-session-goal.md | T32.x（为 T32=tools 让位） | 34-session-goal.md | T34.x |
| 33-session-plugins.md | T35.x | 35-session-plugins.md | 不变 |
| 34-session-agents-md.md | T36.x | 36-session-agents-md.md | 不变 |
| 35-load-dot-opencode.md | T37.x | 37-load-dot-opencode.md | 不变 |
| 05-concurrency-isolation.md 内 T7.1（与 06-error-handling T7.1 撞号） | T7.1 | 同文件 | T6.11 |
| 18-sandbox-tool-test.md 内 T18.Ex/T18.Sx（与 16-tool-calls T18 前缀混用） | T18.Ex/T18.Sx | 43-shell-perf-sse.md（拆分） | ST.Ex/ST.Sx |
