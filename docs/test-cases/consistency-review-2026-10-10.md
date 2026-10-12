# docs/test-cases 用例 × 当前实现 一致性核对报告（2026-10-10）

范围：docs/test-cases 下 141 个用例文档（排除 skills/ 下 skill 资源本体），逐篇对照 packages/core、packages/server、packages/protocol、packages/schema、packages/containers 等实现。所有结论均附证据（文档引文 + 文件:行号），无法定位证据的记"无法确认"。

总览：**一致 ≈ 90 篇 · 不一致 ≈ 21 篇 · 无法确认 ≈ 8 篇**。不一致绝大多数是"文档回写滞后"（V1 契约残留、2026-10 变更未同步）；真正"实现缺失"的只有 3 处（anti-doom-loop、session-goal、workspace-search/load-dot-opencode）。

---

## 一、实现缺失类（用例描述的功能当前根本没有，需决策迁移或标注 V1-only）

1. **session/anti-doom-loop.md【高】** — `packages/opencode/src/session/anti-loop.ts`、`AntiLoop.LoopAbortedError`、指纹滑动窗口（repeat=3/fail=3/window=10）全仓 grep 0 命中（连 V1 `DOOM_LOOP_THRESHOLD` 也无残留，仅 `core/src/v1/config/permission.ts:31` 残留 `doom_loop` 权限键）。T42.x 全组不可测。SaaS 无人值守场景缺重复调用/盲重试熔断。
2. **commands/session-goal.md【高】** — `/goal` 命令、`session_goal` 表、`MAX_GOAL_REACT=12`、judge 模型在 packages/ 零命中，仅有 `docs/session-goal-design.md` 设计稿；且 API 形态（`POST /session/:id/message`、`{command,arguments}`）是 V1。
3. **opencode/sandbox/workspace-search.md + load-dot-opencode.md【高】** — `POST /find/session/:sessionID` 全文搜索、`POST /session/:id/dot-opencode/load`/`LoadDotOpencode.Service` 均不存在（grep 0 命中）。且与 session-agents.md T16.70「沙箱 `.opencode/opencode.json` 不进服务端发现」的已复现缺口直接冲突。
4. **context/rsi-agent/app-memory-rsi.md【低】** — `app_memory` 表、`memory://` skill、`OPENCODE_APP_MEMORY_*` 零命中（设计稿）。related-work-memory-2026.md 为文献综述，无产品断言（无法确认）。

## 二、V1 契约残留类（正文接口/表名为 V1，V2 下按原文执行必失败；多数已自注或有 V2 脚本兜底）

- **session/communication/ 三篇【高】**：`prompt_async`、`POST /session/:id/message`、`/exec`、`files/download`、`/children`、`/summarize`、`/session/status` 等 V2 全无（V2 等价：`/api/session/:id/prompt` 200 接纳、`/shell`、`/fs/read/*`、`session.list?parentID=`、`/compact`、`/api/session/active`）。整组 T21-T23 不可执行。
- **models/auth-credentials.md【高】**：`/provider`、`PUT/DELETE /auth/:provider`、PG `auth(user_id)`、`x-user-id` 凭据隔离均不存在；V2 是 `credential` 表 + `/api/credential/:credentialID`，无按用户隔离凭证。
- **models/provider-connect-interactions.md【中】**：`dialog-connect-provider.tsx` 等前端组件与 `GET /provider/auth`、`oauth/authorize|callback`、`POST /global/dispose` 不存在；V2 为 `integration.oauth.*`（protocol/groups/integration.ts:83-149）。文档自述基于 feat/opencode-1.18.31。
- **agents/session-logs.md【中】**：V1 `exec_log` 表与 `agents/create`、`/abort`、`/share` 路由已随 V1 移除（姊妹篇 session-exec-log.md 已声明）；V2 为 `log` 表 + `GET /api/session/:id/logs`。
- **opencode/apis/codegraph.md + sandbox/codegraph.md【中】**：V1 路由（`/exec`、`/mcps/create`、`/agents-md/create`、`prompt_async`），可迁移到 V2 等价接口。
- **opencode/sandbox/context-mode.md【高】**：断言 plugin 返回/PG 有 `enabled` 字段（schema/session-plugin.ts:60-74 无、session/sql.ts:187-204 无 `enabled` 列）；hook 名 `experimental.session.compacting`/`experimental.chat.system.transform` 不在白名单（containers/sandbox/opt/sandbox-plugin-agent.ts:42-52）；工具名 `bash`、`read.filePath`（实为 `shell`、`read.path`）；镜像安装声明引用不存在的 `packages/opencode/docker/Dockerfile`。
- **session/e2e.md、session/path-leak-test.md、session/session-appid.md、browser/base.md【中/低】**：正文 V1 写法（均已自注不可执行或有 V2 脚本：`session-e2e-stream-v2.mjs`、`session-appid-v2.mjs`）；path-leak 引用的 3 个单测文件不存在（等价物 `packages/core/test/sandbox-path.test.ts`）；session-appid SQL 查 V1 `session` 表（V2 为 `session_v2`）。

## 三、语义过期类（实现已演进，文档断言未同步，会导致验收误判）

1. **release（keep-alive enabled=false）语义变更未回写【中】** — 3 处断言过期：
   - `sandbox/exec-api.md` T19.3「enabled=false …并立即销毁 sandbox」；
   - `sandbox/sandbox-lifecycle.md` 契约表「release…先清 keep-alive，再销毁」；
   - `sandbox/sandbox-create-background.md` T-SBG.3「release 后 sandbox ID 为空、PG destroyed」。
   实现：`core/src/sandbox/provider.ts:1460-1463` 仅 `dbSetKeepAlive(sessionID,false)`，不销毁，running 时 sandboxId 仍非空（:1466-1469）。变更来源：store/sandbox-lifecycle-v1-alignment-2026-10-04.md 第 4 项。实际语义=「取消保活，等 idle 回收」。
2. **store/snapshot.md T-SNAP.11「恢复失败→镜像冷启动」【中】** — 与同文档顶部「恢复失败保留恢复点、阻止冷启动」自相矛盾；实现是阻止冷启动（snapshot-safety 策略 + provider 拒绝降级），T-SNAP.11/T25.16 期望已不成立。另 T25.9/T25.19 的 `sandbox.snapshotId` 派生参数 V2 不存在（schema/session-sandbox-resource.ts 仅 cpu/memory/image/persistMode）。
3. **session/back-end-java.md「沙箱不支持 background 硬失败」【中】** — 现为 nohup+detached 正常执行（core/src/tool/plugin/shell.ts:213-232，2026-10-08 修复），与 background/README.md 矛盾，「必须 setsid nohup」指引失效。
4. **tools/tool-calls.md「read 无专属超时」【中】** — 已有 files API 预算+超时重试（sandbox/config.ts:131-132、provider.ts:352,359），与 read-fast-timeout.md「已实现已验证」矛盾，实现支持后者。
5. **sandbox/files-api.md「当前无持久卷，销毁后文件不保留」【低】** — 默认 volumeType=pvc（sandbox/config.ts:92-93,138；volumes.ts:25-33），kill 重建后文件保留（store/pvc/sandbox-pvc.md T5.3）。
6. **sandbox/sandbox-lifecycle.md「PVC/snapshot 当前 Provider 未实现」【低】** — PVC 为默认后端、snapshot 已完整实现；同文「回收 running/killed 过期行」漏 `snapshotting`（provider.ts:2075-2081）、「扫描周期固定 300s」实为 snapshot 启用时 max(5,min(60,refresh/2))s（provider.ts:2170-2176）。
7. **低危数字/路径漂移**：skill 专项静态资源计数（skill-creator 17 vs 16、humanize-ppt 36 vs 37）；skill 工具 input 期望 `{name}` 实为 `{id}`（tool/plugin/skill.ts:15-17）；session-skills.md §4 物化路径旧写法（§8/§10 已更正）；nextjs-snapshot-performance「轮询 5s」为优化前口径；proxy-demo/README.md V1 路径口径。

## 四、一致（核对通过的要点，摘录）

- **sandbox 域**（41 篇中 33 篇全一致）：exec/files/proxy/endpoint 契约、OOM 采样、watchdog、shell-perf、codemode-runner 就绪三段式、2026-10-04 四轮生命周期修复链（alignment/round2/round3/round4、tool-gate Closure 令牌、commandSessionKey 单飞、create-lease 补偿）、snapshot 安全/轮询/扫描优化、PVC/session-pvc-mode（T38 全组）全部与实现吻合。
- **session 域**（29 篇中 22 篇全一致）：SSE 事件全集、HITL 表单（409/400、frm_ 前缀）、inbox、llm-stall/lock-timeout 恢复、compatibility、权限（findLast+默认 ask、preset）、summaryFrom、user 字段（x-user-id 优先）、structured-output、watchdog-coverage 等逐条核实。
- **tools/code-mode/skills 域**：write existed 语义、grep 截断 metadata、read 超时不销毁、session_tools 优先级、code-mode 缺口声明（S4/S6 RISK、无 PG ledger）与实现吻合；session-skills 物化/限额/优先级/streaming-output-spec 事件集一致。
- **agents/mcps/plugins 等**：builtin-agents 权限矩阵、agent-runtime fail-fast、session-agent-permissions preset、session-exec-log `log` 表、session-mcp supergateway、local-mcp-endpoint 开关矩阵、broken-plugin 隔离、session-plugins hook 白名单、session-ccr、compaction-history、destroy-row-consistency、attachments、metrics-and-trace、websearch 均一致。

## 五、无法确认（8 篇）

persistence-code-agent-execution.md（自标 NOT_RUN 的验收门槛，CA-PERSIST-01~28 未跑）；store/snapshot.md 中标「⏳ 实现已含未验」条目；sandbox-oom-scan.md V1 exec_log 段；各性能报告的耗时数据（31/32/33/35/36/38）；browser/agent-browser-* 与 plugin-credential-shop（外部 CLI 行为，仅确认沙箱预装 agent-browser+chromium，containers/sandbox/Dockerfile:56-62）；browser/derive-client-ydc.md、dogfood-yingdao.md（纯浏览器实测记录）。

## 六、建议处理优先级

1. **实现决策**：anti-doom-loop、session-goal、workspace-search/load-dot-opencode —— 决定迁移到 V2 还是标注 V1-only/设计稿（前两者影响无人值守稳定性与目标驱动验收）。
2. **文档改写**：communication 三篇、auth-credentials、provider-connect-interactions、session-logs、codegraph×2、context-mode 按 V2 契约改写或加"仅存档"横幅。
3. **断言回写**：release 语义 3 处、snapshot.md T-SNAP.11、back-end-java background、tool-calls read 超时、files-api/sandbox-lifecycle 持久化声明。
4. **小修**：skill 资源计数、input `{name}`→`{id}`、session-skills.md §4 路径、轮询口径、proxy-demo 路径。
