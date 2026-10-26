# Sandbox 目录职责

共享入口保持稳定，后端实现可以针对各自能力独立处理，不要求特性或内部结构一致。

| 位置 | 职责 |
| --- | --- |
| `provider.ts` | 统一入口，按 PG 中的 provider 绑定分发调用，兼容原有辅助函数导出 |
| `contract.ts` | 后端共用的服务契约及会话根归属 |
| `config.ts`、`sql.ts` | 部署配置和会话沙箱绑定数据 |
| `lifecycle/` | 共享的 PG 创建租约、代次校验与活动水位辅助逻辑 |
| `opensandbox/` | OpenSandbox SDK 实现、命令会话、后台恢复、卷与 OOM 采样 |
| `opensandbox/snapshot/` | OpenSandbox 快照实现、数据表、后台操作、复用、安全检查与耗时采样 |
| `vercel/` | Vercel SDK 实现、命令执行、传输控制与公网端口 token 网关 |
| `aliyun/` | 阿里云 Agent Sandbox 极速版（E2B SDK）、原生流量鉴权、模板和暂停/恢复 |
| `preview/` | SaaS 预览代理的内容重写；Vercel 公网直连不依赖此逻辑 |
| `endpoint.ts`、`path.ts` | 共享的地址和工作区路径处理 |
| `tools.ts`、`workspace.ts`、`vcs-diff.ts` | 工具适配、工作区初始化及差异处理 |

## 依赖边界

- 业务调用方依赖 `provider.ts`；各后端依赖 `contract.ts`，不相互引用实现。
- 仅某后端使用的 SDK、限制与策略放在其目录内。例如 OpenSandbox 的卷和快照，与 Vercel 的端口预算和传输策略分别实现。
- `lifecycle/` 只放通用状态协调，不把后端的生命周期 API 或能力限制强行统一。
- `opensandbox/snapshot/tables.sql.ts` 保留 `.sql.ts` 命名，沿用现有 Drizzle 发现顺序；目录变化不改变表名或要求数据迁移。
- 内部模块直接引用具体文件，不添加统一 barrel 或旧路径转发文件。仓库内调用方、测试及脚本随目录移动更新。

## 阿里云极速版

配置和验收限制见 `docs/test-cases/sandbox/aliyun.md`。该后端不经过 OpenSandbox 控制面：命令、文件和生命周期经阿里云 E2B API，内部 HTTP/WS 服务经阿里云原生端口网关。端口解析结果的可选 `headers` 仅供 SaaS 内部连接使用，不返回给浏览器。
