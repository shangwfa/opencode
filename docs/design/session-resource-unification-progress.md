# Session 资源统一实施记录

日期：2026-10-01。状态：实施中；不得将阶段通过等同于六类全量交付。

## 实施顺序

1. 主/内部子会话六类资源 owner 统一；Skills 优先级纠正；真实 PG 与 Docker API 验证。
2. 共享项目 discovery、诊断、inspection 和强制 refresh。
3. 步骤解析快照、错误隔离、PG 一致视图。
4. MCP 服务级覆盖、连接版本及 Sandbox AGENTS.md 指令跟踪。
5. 用户投影、并发/关闭恢复及完整验收矩阵。

## 待补齐事项

| 编号  | 事项                    | 处理要求                                                                                                                                                                        | 状态     |
| ----- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| RU-01 | resource owner 持久关系 | 已使用 parent_id 识别内部子会话、fork_session_id 识别独立 fork；新增 shared resolver 检查循环、断链、深度及 project/app/directory/workspace 边界。多实例关闭竞态仍由 RU-09 跟进 | 首批完成 |
| RU-02 | 共享配置权限            | 明确内部子会话修改共享资源的授权，分支权限不因资源共享自动扩大                                                                                                                  | 待补齐   |
| RU-03 | 跨资源 revision/发布    | 单项变更、批量原子发布及 PG snapshot 合同；禁止以时间戳伪装全局版本                                                                                                             | 待补齐   |
| RU-04 | MCP 多实例控制          | 原子端口/启动协议、fencing、owner marker、崩溃恢复；复用执行 gate                                                                                                               | 待补齐   |
| RU-05 | Tool 项目依赖           | 相对 import、named exports、项目依赖及物化目录支持范围                                                                                                                          | 待补齐   |
| RU-06 | 调用链覆盖              | 六类定义 CRUD/read 已统一 owner；执行仍使用 child 身份，Skill bundle 目录使用主 owner，AGENTS.md load 读取主 owner。下一阶段统一 discovery/snapshot/diagnostics                 | 首批完成 |
| RU-07 | 容量/性能               | 扫描预算、超时、缓存上限、连接租约及旧版本回收期限                                                                                                                              | 待补齐   |
| RU-08 | 用户不可见投影          | 内部子会话列表/详情/订阅授权及主会话结果归集；显式用户 fork 单独处理                                                                                                            | 待补齐   |
| RU-09 | 主会话关闭时序          | 先取消收束全部内部分支，再释放共享 Sandbox；关闭期间阻止创建新分支                                                                                                              | 待补齐   |
| RU-10 | 历史 child 定义         | 隔离测试库六表的内部 child 私有行已检查，均为 0；共享/部署库仍需部署前检查。不自动提升并覆盖主配置                                                                              | 待补齐   |

## 验证记录

### 本轮已实施

- 新增 `packages/core/src/session/resource-owner.ts`：一个 resolver 为六类服务定位资源 owner；没有复制 child 资源记录，也没有引入新的定义表。
- Agent/Skill/MCP/AGENTS.md/Tool/Command 的服务级 CRUD 与定义读取统一到主 owner；MCP/Tool 实际执行仍关联执行分支，删除分支仍走原 runtime release。
- `SessionSkills.mergeSkills` 改为 global → Session → Sandbox；Session Skill 的资源物化目录使用主 owner。
- 保留显式历史 fork 的独立资源域和 Session AGENTS.md 空读兼容行为。

### 测试

| 验证                        | 结果                            | 依据                                                                                                                                                                                                                                   |
| --------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core typecheck              | 通过                            | `bun run typecheck`，包括 tests tsconfig                                                                                                                                                                                               |
| 定向单测                    | 55 pass / 0 fail                | resource-owner、session-skills、session-tools、session/agents、session/commands、session/agents-md、session-mcps 七文件                                                                                                                |
| Tool registry/Host/扫描回归 | 56 pass / 0 fail                | tool-registry、session-tool-host、session/tool-scan 三文件                                                                                                                                                                             |
| 真实 PG 测试                | 7 pass / 0 fail，114 assertions | `OPENCODE_DATABASE_URL=postgresql://local@127.0.0.1:5432/opencode-v2-test bun run script/test.ts test/session/resources-pg.test.ts test/session/agents-pg.test.ts test/session/commands-pg.test.ts test/session/agents-md-pg.test.ts`  |
| Docker API owner E2E        | 29 assertions pass / 0 fail     | `docs/test-cases/scripts/session-resources-owner-v2-e2e.mjs`；通过 command API 创建真实子任务，验证六类定义、主/子双向更新、无 child 私有行、Tool 执行/Sandbox 文件、Skill 优先级与 bundle、AGENTS.md 请求审计、Code Mode 可见性及清理 |
| T32.29 API 回归             | 1 pass / 0 fail                 | `ONLY=T32.29` 运行 session-tools-full-v2-e2e.mjs，验证 Tool 三层覆盖与回退                                                                                                                                                             |

API 环境：临时 Docker `opencode-resource-owner-test`（14296）、既有 `opencode-saas-sandbox-test:session-tools-runtime` 镜像挂载当前 `packages` 源码、本地 OpenSandbox `8080`、隔离 PG `opencode-v2-test`、真实 `Yd-DeepSeek/deepseek-v4-flash`。Code Mode 使用服务默认配置，审计确认 `execute` 与共享 native tool 同时可见。本轮不是标准镜像重新构建验收。

第一次 owner E2E 因命令中的审计文件名误写为 requests.jsonl 失败；真实文件为 model-requests.jsonl。修正路径后复跑，并扩充 Skill 优先级及资源物化断言，最终 29/29 通过。

本轮最后一个 owner 用例 root/child 为 `ses_f0b060417ffeAW8TPWvU9xGsIu` / `ses_f0b05fa6affeWsJ3ks9uurLAnt`。脚本验证 session_v2 和六资源表目标行均为 0；随后查询测试 title 也无残留。当前 Docker 列表无本轮 Sandbox 容器残留；临时 API 容器测试结束后清理。

### 下一阶段

继续实现统一项目发现/inspection、错误诊断与步骤快照；MCP Sandbox 配置发现/服务级遮蔽、项目 AGENTS.md 跟踪和用户不可见投影尚未实施。本轮通过不能代表这些能力完成。
