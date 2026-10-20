# Harness 管理功能验收（2026-10-20）

## 结论

**已通过**。正常配置管理、会话下发、Skills 资源执行、Commands 执行以及 Code Mode/MCP 实际调用均通过；五个服务端保存校验缺口已修复并通过回归。此前 Code Mode 失败的原因是 `mise-preload-v1` 镜像缺少 `/opt/opencode-codemode-runner.mjs`，不是 Code Mode 代码回归。已基于原镜像追加 Runner、推送新标签并切换测试服务，真实会话验证通过。

## 环境与隔离

- 前端 3002 → 基础服务 3201 → Docker SaaS 14097；不使用旧服务 14096。
- 基础服务 PG：opencode-v2-up / hn_base_dev；SaaS PG：opencode_shell_test。
- 创建临时 app、授权元组、requirement、session；沿用已授权仓库，checkout 已存在的默认分支，不创建新的远端分支、不写仓库文件。
- 测试模型显式使用 Yd-GLM / glm-5.3，不修改用户已有会话模型。
- 模型轮次订阅 `GET /api/session/:id/event`，工具、文本和终态通过短窗口实时输出。

## 已验证

| 范围 | 结果与依据 |
| --- | --- |
| 类型检查 | hn-app、hn-base-server 均通过 |
| 基础服务单测 | 76 通过、0 失败；新增 3 项覆盖保存边界 |
| 前端单测 | 507 通过、1 失败；唯一失败为既有 route-repo，不在本轮处理 |
| 未登录/越权 | GET/PUT 分别返回 401、404；不存在应用不泄露信息 |
| 配置 CRUD | 四类配置通过 API 创建、修改、删除、完整回读 |
| 存储 | 应用配置加密；其他 config 字段保留；审计不含测试认证值 |
| 浏览器 | 四类空表单提示必填；Agent 示例创建/删除、Commands 新增/修改/搜索/删除、MCP 认证值遮罩与回读、Skills ZIP 导入/保存/回读/删除通过 |
| 新建需求 | 真实仓库准备成功，四类定义和默认 Agent 正确下发 |
| 生效范围 | 清空应用模板后，已建会话仍保留原定义 |
| 下发失败门禁 | 非法 Skill 资源被 SaaS 拒绝时，prepare 返回 prepared=false 和 Harness 下发错误，未产生 assistant 消息 |
| Skills 执行 | SSE 显示技能加载、资源读取、测试脚本执行成功；shell 工具返回 HARNESS_SCRIPT_OK 和 exit 0 |
| Commands + Agent | 两轮独立验收均返回 HARNESS_COMMAND_OK HARNESS_AGENT_OK，SSE execution.succeeded |
| SaaS PG 后检 | session_agents / session_skills / session_commands 各 1 行，session_mcps 2 行（应用模板 + 验收探针）；技能 2 个资源；选定 Agent 正确；idle_outcome=succeeded；assistant 保存两个预期标识 |
| Code Mode/MCP | SSE 观察到 `execute` 工具调用成功并返回 `HARNESS_MCP_OK`；同轮技能、资源、脚本均成功；Commands 轮次随后成功 |

## 已修复的保存校验缺陷

以下配置曾直接调用基础服务 PUT `/api/apps/:appId/harness` 返回 200 并保存。现已在 `packages/hn-base-server/src/lib/harness.ts` 的保存边界补齐校验，统一返回 400，且不覆盖已保存配置。

1. Skill 资源路径包含 `../`。
2. Skill 资源使用保留路径 `SKILL.md`。
3. 单个 Skill 资源超过 256 KiB。
4. Commands 模板超过 256 KiB。
5. Agent 定义的 id 为空字符串。

另补充拒绝空白标识、资源文件与目录冲突、资源重复路径、资源数量与总量超限。回归入口：`packages/hn-base-server/scripts/harness-validation-verify.ts`。

2026-10-20 复测结果：7 项非法输入全部返回 400，保存前配置保持不变。临时应用与授权元组已清理。

## 镜像修复与复测

此前 SSE 多次出现 `Failed to start Code Mode Runner ... exited before readiness`。通过会话 shell 读取沙箱 `/tmp/opencode-codemode-runner.log`，得到 `Error: Cannot find module '/opt/opencode-codemode-runner.mjs'`（MODULE_NOT_FOUND）。对照 `docs/test-cases/code-mode/code-mode.md`，原先通过的验收使用 `opencode-opensandbox:codemode-local`，说明这是镜像版本不匹配，不是 Code Mode 代码回归。

处理结果：

- 用当前源码构建 Runner 产物，并在本机实际启动、探测 9911 就绪通过。
- 基于原 `mise-preload-v1` 追加 Runner，推送新标签 `crpi-hlpnu8kiweghie0r.cn-hangzhou.personal.cr.aliyuncs.com/shangwfa/opencode-sandbox:mise-preload-v1-runner-20261020`。
- 镜像 manifest：`sha256:e8064e05504cf27b9c21cd8fe0f6d9216acea3ec72d7802c27bb2d98ea2f97c9`，25 层（原 24 层 + Runner 层）。
- 切换本地测试服务 `opencode-saas-shell-test` 的 `OPENCODE_SANDBOX_IMAGE`；旧容器保留为 `opencode-saas-shell-test-runner-backup` 以便回滚。
- 新建隔离会话后，`execute` 返回 `HARNESS_MCP_OK`，Skills 资源与脚本、Commands 全部通过；PG 后检通过并清理测试会话/应用/需求。

推送注意：阿里云仓库会拒绝 BuildKit 默认的 OCI 空证明清单，需使用 `--provenance=false --sbom=false`。仓库内 `Dockerfile.runner-fix` 提供可复现的完整构建（含镜像内 Runner 冒烟），本次因本机空间受限采用本地已验证产物叠加的薄镜像方式。

## 执行器校正

- Effect 解码返回 class 实例，PG 语义比较需 JSON 规范化，不以原型不同判产品失败。
- Commands API 需要 `{name,text}`，已补 `text:""` 后重测成功。
- SaaS `session_skills.resources` 为 text 存储，PG 检查使用 `resources::jsonb`，修正后重新创建隔离会话并完成后检。
- MCP 列表仅证明定义已注册，不证明已连接；连接由 `execute` 实际返回 `HARNESS_MCP_OK` 证明。
- 旧镜像的失败轮次已 interrupt 停止并保留证据，未将镜像缺失归因于模型或业务代码。

## 证据与复跑

本机证据目录：

- 首轮：`/private/var/folders/zk/8qd0lv657wn8kvpp__hwjj400000gn/T/opencode/harness-verification`
- 新镜像复测：`/private/var/folders/zk/8qd0lv657wn8kvpp__hwjj400000gn/T/opencode/harness-runner-acceptance`

- `final/result.json`：正常契约与五项缺陷复现。
- `final/command-recheck-result.json`、`final/command-recheck-events.json`：独立 Commands 执行。
- `final/pg-evidence.json`、`final/cleanup.json`：PG 后检和清理。
- `runtime-events.json`、`runner-diagnostic.json`：Skills 工具过程与 Code Mode 故障证据。
- `browser-validation.json`：四类空表单浏览器验证。
- `gating/result.json`：下发失败门禁；其清理首次失败，重试删除会话返回 204，基础服务数据清理完成，见 `gating/cleanup-retry.json`；首次清理失败根因未确认，不算产品新缺陷或最终残留。
- `harness-validation/validation-result.json`：保存校验修复后的 7 项回归结果。
- `harness-runner-acceptance/result.json`：新镜像下 19 项配置/下发契约。
- `harness-runner-acceptance/runtime-result.json`、`runtime-events.json`：Code Mode/MCP、Skills、Commands 实际执行。
- `harness-runner-acceptance/pg-evidence.json`、`cleanup.json`：PG 后检与清理。

脚本以 `HARNESS_VERIFY_AUTH_FILE` 读取临时登录凭据、`HARNESS_VERIFY_OUTPUT` 指定证据目录；运行环境从现有安全 env 文件载入，不将凭据写入仓库。`HARNESS_VERIFY_KEEP=1` 保留本轮隔离会话供运行验收，最终由 `harness-pg-verify.ts` 后检并清理；普通模式自行清理。

未覆盖：远程第三方 MCP 真实外部服务、完整移动端视觉验收与多用户并发编辑。测试服务当前使用修复镜像；旧容器保留用于回滚。
