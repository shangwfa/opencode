# SaaS 测试用例索引

> 所有测试用例已从原 `saas-test-cases.md` 拆分到本目录下。原文件保留作历史参考。
>
> 公共配置（测试环境、模型、验收分层）见 [`00-preamble.md`](./00-preamble.md)。
> 全量验收状态表见 [`99-acceptance-status.md`](./99-acceptance-status.md)。

## 文件列表

| 文件 | 章节 | 用例范围 | 内容概述 |
|------|------|---------|---------|
| [`01-health-and-session.md`](./01-health-and-session.md) | 一、二 | T1.x T2.x | 健康检查、全局配置、Session CRUD |
| [`02-auth-credentials.md`](./02-auth-credentials.md) | 三 | T3.x | Provider 凭据设置/删除/持久化 |
| [`03-ai-conversation.md`](./03-ai-conversation.md) | 四 | T4.x | 文本对话、多轮上下文、工具调用（写/读/bash）、异步消息、中断 |
| [`04-sandbox-pvc.md`](./04-sandbox-pvc.md) | 五 | T5.x | 沙箱创建/销毁、PVC 持久化、多文件/目录 |
| [`05-concurrency-isolation.md`](./05-concurrency-isolation.md) | 六 | T6.x | 并发 session 创建、跨 session 文件隔离、并发消息 |
| [`06-error-handling.md`](./06-error-handling.md) | 七 | T7.x | 未配置 provider、不存在的 session、无效 JSON、缺失字段、超长消息 |
| [`07-provider-sse.md`](./07-provider-sse.md) | 八、九 | T8.x T9.x | Provider 列表、模型切换、SSE 事件流订阅 |
| [`08-e2e.md`](./08-e2e.md) | 十 | T10.x | 完整开发流程端到端 |
| [`09-sandbox-proxy.md`](./09-sandbox-proxy.md) | 十一 | T11.x | Vite/Next.js dev server 代理、HTML/JS/CSS 注入与路径重写、HMR、keepAlive |
| [`10-sandbox-lifecycle.md`](./10-sandbox-lifecycle.md) | 十二 | T12.x | 沙箱按需创建/复用/销毁、PVC 恢复、idle 超时、keepAlive、进程隔离 |
| [`11-saas-stability.md`](./11-saas-stability.md) | 十三 | T13.x | kill-sandbox、dispose 并发、HMR、路径重写、PG FK、rate limit、安全、幂等性、观测性 |
| [`12-compatibility.md`](./12-compatibility.md) | 十四 | T14.x | Session 列表过滤、status、fork、分页、share、diff/revert、file/find/VCS API |
| [`13-session-skills.md`](./13-session-skills.md) | 十五 | T15.x | Session skill CRUD、bundle、resources、按需加载、upsert、同名覆盖、permission、边界、多skills主动/被动触发 |
| [`14-session-agents.md`](./14-session-agents.md) | 十六 | T16.x | 会话级动态 Agent 创建/列出/删除、primary/subagent 模式、权限、隔离、级联 |
| [`15-sandbox-endpoint.md`](./15-sandbox-endpoint.md) | 十七 | T17.x | Sandbox 直连 IP 访问、endpoint API、proxy vs 直连对比 |
| [`16-tool-calls.md`](./16-tool-calls.md) | 十八 | T18.x | 7 种工具调用批量验证、消息流结构 |
| [`17-exec-api.md`](./17-exec-api.md) | 十九 | T19.x | exec 命令执行 API、keepAlive、超时、环境信息 |
| [`18-sandbox-tool-test.md`](./18-sandbox-tool-test.md) | — | — | 沙箱工具测试：apply_patch/ls 沙箱分支、路径转换、并发压力、错误信息泄露检查 |
| [`19-saas-tool-sandbox-verify.md`](./19-saas-tool-sandbox-verify.md) | 二十 | T19.x | 8 工具沙箱执行三层验证（代码审查+运行时+PG），可执行脚本 `scripts/test-saas-tools.sh` |
| [`20-path-leak-test.md`](./20-path-leak-test.md) | — | PL-x | 路径泄露防护：system prompt / 工具 I/O / <env> 块中宿主机路径映射为 /workspace |
| [`21-workspace-routing.md`](./21-workspace-routing.md) | — | WR-x | Workspace Routing 路径解析：API 请求 directory fallback 到 session.directory |
| [`22-session-mcp.md`](./22-session-mcp.md) | 二十二 | T22.x | 会话级动态 MCP：CRUD、隔离、级联、校验 |
| [`23-package-cache.md`](./23-package-cache.md) | 二十三 | T23.x | 共享 Package Cache：标准 exec 使用流程、跨 session 缓存共享、npm/pnpm/yarn/bun、加速/并发、mountPath 校验 |
| [`24-preload-cache.md`](./24-preload-cache-switch-env.md) | 二十四 | T24.x | 环境切换与预装依赖缓存：mise 多版本 Node/pnpm 切换、shims 自动检测、npm cache/node_modules 预装、跨版本缓存共享、隔离性 |
| [`25-session-user-fields.md`](./25-session-user-fields.md) | 二十五 | T25.x | Session 用户标识字段：userName/userId 传递、持久化、向后兼容、多轮独立标识 |
| [`26-session-agent-permissions.md`](./26-session-agent-permissions.md) | 二十六 | T26.x | Session Agent 权限：字符串简写、对象语法白名单、bash 粒度命令、last matching rule wins、worktree 影响权限 pattern（directory 基准修复）、`**/`/`*` 前缀匹配、`...` 字面点限制 |
| [`sandbox-shared-test.mjs`](./sandbox-shared-test.mjs) | 十六 | T16.29 | 主子 agent 沙箱共享验证：主→子写读、子→主写读、exec 独立验证 |
| [`vcs-diff-sandbox-test.mjs`](./vcs-diff-sandbox-test.mjs) | 十六 | T16.30 | VCS Diff 沙箱重建验证：销毁后自动重建 PVC 恢复，两次 diff 一致 |

## 快速定位

```
T1.x  → 01-health-and-session.md
T2.x  → 01-health-and-session.md
T3.x  → 02-auth-credentials.md
T4.x  → 03-ai-conversation.md
T5.x  → 04-sandbox-pvc.md
T6.x  → 05-concurrency-isolation.md
T7.x  → 06-error-handling.md
T8.x  → 07-provider-sse.md
T9.x  → 07-provider-sse.md
T10.x → 08-e2e.md
T11.x → 09-sandbox-proxy.md
T12.x → 10-sandbox-lifecycle.md
T13.x → 11-saas-stability.md
T14.x → 12-compatibility.md
T15.x → 13-session-skills.md
T16.x → 14-session-agents.md（基础 CRUD/隔离）+ 26-session-agent-permissions.md（权限 T26.x）
T17.x → 15-sandbox-endpoint.md
T18.x → 16-tool-calls.md
T19.x → 17-exec-api.md
T22.x → 22-session-mcp.md
T23.x → 23-package-cache.md
T24.x → 24-preload-cache.md
T25.x → 25-session-user-fields.md
T26.x → 26-session-agent-permissions.md

沙箱工具（apply_patch/ls/错误泄露）→ 18-sandbox-tool-test.md
路径泄露防护（PL-x）→ 20-path-leak-test.md
```
