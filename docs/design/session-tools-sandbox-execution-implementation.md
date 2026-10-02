# Session Tools Sandbox 实施记录

日期：2026-09-30。状态：主链路已接通，完整方案仍在实施及验收中。

## 部署决策更新

按用户反馈，取消本功能的 Sandbox 镜像预置要求。

- `core/script/build-session-tool-host.ts` 在 SaaS 构建阶段生成 Host、worker、共享 Effect/schema runtime 三个自包含 ESM 文件及 SHA-256 manifest。
- `core/src/session/tool-host/assets.ts` 校验服务端构建产物，通过 SandboxProvider 写入临时目录并原子发布到 `/workspace/.opencode/.session-tool-runtime/<artifactHash>/`。
- `core/src/session/tool-sandbox.ts` 经 `sandbox.run` 启动常驻 Host，经 `sandbox.endpoint` 调用。资源物化和启动方式分别沿用 session skills、local MCP 的机制。
- 运行阶段不安装 npm 依赖；Sandbox 重建后重新物化运行文件和捕获的工具源码。
- Core 发布构建和 SaaS Dockerfile 均已接入运行文件编译。开发环境须先执行 `bun packages/core/script/build-session-tool-host.ts`。

## 已实现主链路

1. Session tools CRUD 继续写入 PG；SaaS 不再 import/execute 用户工具源码。
2. Host 监督独立版本 worker；发现与执行共享模块。限制 worker 数量，空闲 LRU 淘汰。
3. 同 logical session 同源码复用模块；跨 logical session 隔离模块状态。
4. Worker 完成原 codec 解码/编码；共享同一 Effect runtime，保留 Effect progress/ack、title 与文本结果转换。
5. 模型请求的 Effect scope 获取/释放 snapshot lease；模型响应及工具 settlement 在同 scope 内消费。
6. 已加入 PG root/logical gate 表与迁移、准入锁、删除关闭、物理销毁关闭和新 Sandbox 身份检查。
7. 执行有 deadline、取消 tombstone、进程组终止、去重身份与有限结果缓存；丢失结果流不重放副作用调用。

## 验证记录

| 验证 | 结果/范围 |
|---|---|
| Core 类型检查 | 通过，含新增 Host/worker 和测试 |
| Server 类型检查 | 通过 |
| 工具 adapter + Host 定向测试 | 20 pass、0 fail |
| 邻接回归 | 74 pass、1 skip、0 fail；覆盖 compaction、owned、shell 及工具相关测试，执行于新增 AbortSignal 用例之前 |
| 专用 PG gate 测试 | 3 pass、0 fail；含真实 PG 多连接准入/关闭顺序 |
| migration `--check` | 无新增 schema 差异 |
| Docker/API/PG E2E | 10 项断言通过；脚本见下 |

接口脚本：`docs/test-cases/scripts/session-tools-sandbox-v2-e2e.mjs`。

实测环境：独立服务容器 `opencode-session-tools-test`，端口 14196；数据库 `opencode-v2-test`；复用原 `opencode-opensandbox:local` 镜像。未替换共享服务 `opencode-saas-test`。

E2E 覆盖工具 CRUD/PG 源码一致、Sandbox cwd/context/文件副作用、服务端数据库环境未透传、SSE progress、模块状态复用、upsert 新版本、kill 后重新物化恢复、PG 新 Sandbox 准入绑定和工具终态。另通过模型请求审计确认 `execute` 与原生 `sandbox_probe` 同时出现在模型工具目录。

首次 API 实测发现 launcher 的后台 Host 继承 flock 描述符，第二次 prepare 因锁不释放而超时；修复为 `flock --close` 后全流程重跑通过。进度验证改为检查 SSE 进度事件和最终 title，不要求终态 metadata 保留被最终结果替换的进度字段。

标准 SaaS 镜像构建完成运行文件编译后，在镜像导出阶段遇到 Docker `no space left on device`。本轮使用既有服务镜像叠加最新 Core 源码及构建产物完成独立容器验证；尚不能宣称标准镜像从头构建已通过。

## 完整验收前仍须闭环

- Provider 的全部跨实例 boot/create/destroy 竞态及 `closing` 崩溃恢复：当前在 `sandbox.boot` 返回后执行 gate 身份检查，不能以已通过的准入行锁测试代替完整物理生命周期验证。
- owner heartbeat 失败对整个模型请求的及时传播、异常网络/宿主重启路径、旧快照在依赖变化后的完整回归及资源压测。
- 对内部 RPC DTO 的完整边界验证和诊断覆盖进行收敛。
- `docs/test-cases/tools` 全量用例、T32 完整矩阵、父子删除/并发的 API/PG 全场景验收。
- 标准 SaaS 镜像完整构建复验。

上述定向通过结果不代表 tools 目录全量通过，也不代表完整方案已交付。
