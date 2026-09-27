# upstream/v2 与当前分支功能对比分析

- 分析日期：2026-09-26
- 基线：`upstream/v2`（HEAD = `a5b3802ca3`）
- 当前：`feat/opencode-saas-2.0`，merge-base 恰为 upstream/v2 HEAD
- 关系：**领先 37 提交、落后 0 提交**（`git rev-list --count`），即当前分支 = upstream/v2 全量 + 本地增量，无需 rebase
- 增量规模：packages 内 189 文件、约 +29.7k / -1.2k 行（另有 docs 测试用例 697 文件）

## 一、已实现功能清单（37 提交归纳）

| 功能域 | 内容 | 代表提交 |
|---|---|---|
| PG 存储桥接 | 基于 upstream SqlClient 扩展点的 PG 驱动 + SQL 方言运行时翻译 + 兼容对象（sqlite_master/pragma/json_extract 视图） | f22e425a55, ef76d93665 |
| Sandbox 子系统 | opensandbox 桥接（provider 1151 行）、会话↔沙箱映射、子会话复用根沙箱、卷模式 none/pvc/host、预览代理、vcs-diff、空闲回收、心跳 | 28c2df0bf2, 87a3a6f22f, cf13f73226, 514d9311f9, 8cadc671e0, 8bdaf17f6f |
| 沙箱化工具 | read/write/edit/patch/glob/grep/shell 全部 sandbox-backed；bash 缺失 ripgrep 即 fail-loud | 3f9eedf806, 4d4e00c082 |
| Managed attachments | 工具输出旁路落盘沙箱、model-request 按需物化 base64、GET 路由带 Range/ETag/nosniff | fece064f9c, 943168d03b |
| CCR 上下文压缩检索 | 标准 upstream plugin（`ctx.session.hook("context"/"compaction")` + `ctx.tool.transform` 注册 ccr_retrieve 工具），KV 持久 + TTL | 9c597fd106 |
| 压缩历史持久化 | compaction 写 tool_history_*.md、checkpoint 带 historyPath、历史可检索 | 9aa68014be |
| 会话命令 | 会话级 command CRUD + hints + sandbox 扫描（`.opencode/command/*.md` 含 `` !`cmd` `` 插值），复用 V2 `Command.Service` | 2c3494bb52 |
| 会话 AGENTS.md | 会话级指令覆盖，走 `Instructions.make` + combine 首位注入，不随 fork 继承 | 4257bdebe0 |
| Watchdog | 超预算工具自动 `interrupt({reason:"watchdog"})`，纯复用 V2 interrupt 结算设计 | 8bdaf17f6f |
| 会话增强 | prompt 用户身份字段、PVC 模式、sandbox resource 限额、session-stream SSE、404 语义修复、structured-output | 615b3bfa3d, ee2f5ce928, 859c3506da |
| API/部署 | protocol 4 新组、openapi/client 再生、Dockerfile（glibc 基础镜像避 PG 桥段错误）、containers 沙箱镜像、web assets 缺失保 API | 8684401b21, 5590eac494, b0a65b1cdc |
| WIP（未提交） | session-agents：三层（global/session/sandbox）agent 定义合并，替换权限/上下文/subagent 的 agent 解析 | 工作区 |

## 二、总体判定

### 核心逻辑是否被破坏：**未破坏**

判据（均有一手 diff 证据）：

1. **无落后提交**：upstream/v2 全部提交被当前分支包含，不存在分叉后各自演进的漂移。
2. **能力均为运行时门控而非删除**：sandbox 以 `sandbox.enabled` 短路回本地路径，服务层常驻 stub（provider.ts:42 注释）；PG 仅在 `OPENCODE_DATABASE_URL` 存在时整体替换 layer（database.ts:71-75），CLI 默认 sqlite 路径逐行未变。
3. **28 个被改的 upstream 会话文件中仅 1 类"语义替换"**：历史解码损坏行从 orDie fail-fast 改为跳过+warn（history.ts:70-75、store.ts:175-207、projector.ts decodeRow），happy-path 结果不变。
4. **签名变更全部有同步**（SessionCommand.execute 新增必选参数的唯一调用方已改；kv 测试 mock 已补），core/server typecheck 通过。
5. **默认路径等价性抽查通过**：toolChoice 表达式等价（runner/llm.ts:229-254）、command builtin 回退等价（command.ts:37）、shell 本地 timeout 默认仍 0、model-request 无 managed URI 原样透传。
6. **测试实证**：session-runner 214 pass、permission 105 pass、subagent 12 pass、agents 单测/PG 测通过。

### 是否符合 V2 最佳实践：**大体符合，两处系统性偏差**

符合的：Effect v4 + Context.Service + Layer + makeLocationNode/makeGlobalNode DI 图全程沿用（grep 证实改动文件零 async/Promise 混入）；DB schema 复用 drizzle sqliteTable；新功能全部按"schema 契约 + LocationNode + instance 注册 + 迁移链"规范落地；command/Instructions/interrupt/plugin API/tool snapshot 通道均走正门复用。

两处系统性偏差（功能正确但非 V2 理想形态）：

- **偏差 A：工具层硬编码分支而非插件扩展点。** 每个内建工具 execute 顶部 `if (sandboxProvider.enabled) return SandboxTools.xxx`（read.ts:60、edit/write/glob/grep/shell 同；patch.ts 五处逐点判断，最重）。V2 的 `ToolEditor.update(id,…)`（packages/plugin/src/effect/tool.ts:8-19）本可让独立 sandbox 插件替换 execute 而不动内建插件。代价：sandbox/tools.ts 与本地 read/glob/grep 逻辑双份维护（分页、rg 管线解析各两份），upstream 更新内建工具时需双处同步，rebase 冲突面大。
- **偏差 B：PG 方言适配是运行时 SQL 字符串翻译，而非 dialect 抽象。** pg.ts:87-120 对每条 SQL 扫描/正则重写（?→$n、反引号→双引号、类型名替换、ON CONFLICT 改写），另加 COMPAT_DDL 兼容视图（:129-177）。注入点在 upstream 认可的 SqlClient provider 边界内、sqlite.ts 零改动、实测通过，但本质是桥接 hack，非 V2 式 dialect 分层，长期演进脆弱（见风险 D1-D3）。

## 三、需要关注的问题（按优先级）

### P0 — 建议尽快处理

1. **未提交的 SessionAgents 改动是全分支侵入性最强的一处**：直接替换了 `context.ts:133` 主循环与 `permission.ts:162` 的 agent 解析点。且 `list()` 每次触发沙箱 find+批量读文件（无缓存），permission/context 用 `Effect.orDie`——沙箱瞬时故障会把权限检查升级为 defect、整轮中断，执行路径无兜底、无回归测试。建议：降级容错（扫描失败退化为缓存/全局定义）+ orDie 改类型化错误 + 缓存。
2. **沙箱 shell 输出无截断**：本地路径有 maxBytes/maxLines 截断落盘（shell.ts:240-243），沙箱分支返回全量且 `truncated:false`（plugin/shell.ts diff），ToolOutput.truncate 因此跳过（tool-output.ts:66）。`cat` 大文件直接灌爆模型上下文。
3. **compaction 默认路径新增副作用**（compaction.ts:417-458）：纯本地 CLI 模式每次压缩也写 tool_history 文件，且 to-llm-message.ts:10-14 给 checkpoint 注入"去 Grep/Read 该文件"的新指令文本——改变模型可见 prompt 与磁盘占用。建议 writeHistory 加开关或纯 CLI 下关闭。

### P1 — 中期改进

4. 偏差 A 的收敛：`if(enabled)` 分支改为 `editor.update` 式注册时替换，消除双份实现。
5. PG 风险：`pg-schema.sql` 不可独立 psql 回放（dump 脚本 translateType 缺 `DEFAULT false→0`，裸文件报错，pg-schema.sql:94）；translate 的类型正则不识别字符串字面量（pg.ts:104-110）；`json_extract` 垫片 RETURNS text 与 `session/diff.ts:92` 声明 sql<number> 类型漂移；`max:1` 单连接零并发。
6. 历史解码静默降级可能掩盖 seq 断层（分页/重放基于 seq）：warn 建议升级为可观测指标。
7. create 自动 keepalive 的 fire-and-forget（session.ts:329-346）绕过 Scope，默认开启；测试/优雅退出场景有 fiber 泄漏面。
8. 每命令执行多一次全量 list（含 Plugin.awaitActivation + DB 查询，command.ts:27）；inbox 每条 prompt admission 事务内多一条 SessionTable SELECT（注释自认 PG 下 re-check 依赖 fallthrough，正确但脆弱）。
9. Watchdog 只覆盖本进程活跃执行（watchdog.ts:99），多副本部署下其他实例的 stuck 会话无人处理。
10. sandbox 存储的 attachment 随沙箱销毁丢失（attachment.ts:13 存沙箱 fs），历史图片/PDF 降级 `[Attachment omitted]`，无 PG/对象存储兜底。

### P2 — 低优先

11. PVC subPath 拼接 `apps/${appId}` 无路径字符校验（volumes.ts:43，`appId="../../x"` 可越前缀，取决于信任边界）。
12. `toSandboxPath` 原语自身不防御（path.ts:17-26），靠调用方先 resolve+containment；shell workdir 越界静默映射为 /workspace 而非报错。
13. `isReady` 只看内存 entries（provider.ts:1126），服务器重启后到重连前 fs/预览路由 502；`isSandboxGone` 靠正则匹配 SDK 文案；`commandLocks`/`sandboxKeys`/ripgrep 缓存 Map 无过期删除。
14. 会话级同名 command 可覆盖 builtin（init/review），有意设计但升级 upstream 时 `command.ts` 的 `definition` 后门必冲突（fork 面扩大）。
15. commit 2c3494bb52 当时 openapi.json 未再生（中间提交不可独立通过 `check:generated`；HEAD 已补齐，146 路由三件套一致）。建议每提交跑生成检查。
16. 仓库 `.opencode/command/*.md` 的 `` !`cmd` `` 插值在用户执行命令时于沙箱内跑任意 shell，无二次确认；sandbox disabled 时 stored command 的 run 会 die（provider.ts:263，边角）。
17. 风格小疵：filesystem.ts:16 模块顶层 `SandboxConfig.load()` 导入期副作用（upstream 无同类）；session.ts:329 业务逻辑直读 env；permission.ts:346 冗余 `Agent.node` dep；ccr.ts 753 行单体无运行时观测 API。

## 四、测试与验证现状

- **单测**：sandbox 8 文件、session 多文件、server API 9+ 文件、schema 契约测均新增；实测 session-runner 214 / permission 105 / subagent 12 / agents 9 / agents-pg 2 全绿。
- **e2e**：docs/test-cases 体系 = md 用例 + `scripts/*.mjs`（HTTP 打接口 + psql 直查 PG，双重校验结果与过程），符合 AGENTS.md 测试要求；但 6 个 `*-v2.mjs` 需 docker + 真实模型，本次未运行。
- **缺口**：session-agents 真实沙箱扫描链路、扫描失败对执行路径的后果、selectTitle 覆盖、mergeAgents 部分字段、delete 非法 ID 400 用例；ccr-bench 非断言测。
- **生成物一致性**：HEAD 的 openapi/client/schema.gen/migration.gen/pg-schema 已对齐（含未提交 WIP）。

## 五、结论

当前分支以 **0 落后 + 37 领先** 的健康形态叠加在 upstream/v2 上。SaaS 化核心诉求（PG、opensandbox、附件、命令/指令/agent 会话化、watchdog）全部落地，实现风格统一沿用 Effect v4 服务化 DI 图，V2 既有抽象（Command、Instructions、interrupt、plugin hook、ToolEditor 输出通道）复用率高，**原有核心逻辑（会话执行链路、事件投影、压缩、权限、sqlite 默认路径）未被破坏**，有测试实证。

主要技术债集中在两点系统性偏差：工具层的 `if(enabled)` 硬编码分支（双份维护/rebase 漂移风险）和 PG 的运行时 SQL 翻译桥（方言兼容的长期脆弱点），外加 P0 三条（SessionAgents 未提交侵入、沙箱 shell 输出无截断、compaction 默认路径副作用）。建议：P0 三项在 session-agents 提交前一并解决；偏差 A/B 立为中期重构项。

## 六、2026-09-27 复核更正

1. **不得把工具层的条件分支直接判为“不符合 V2”。** `packages/core/src/tool/AGENTS.md` 明确内建工具的 leaf 自己负责路径解析、权限与副作用顺序，且注明“Session-scoped registrations”尚无 canonical 设计。因此 Sandbox 分支是维护成本/测试覆盖风险，不是已证实的架构违规；不能未经设计就改用全局 `ToolEditor.update`。
2. **SessionAgents 的“扫描失败导致 `orDie`”结论已过时。** 当前工作区已引入 `session/scan.ts`，其 `scanSandboxMarkdownBestEffort` 明确在读路径降级；该方向符合 prompt/权限热路径的可用性要求。仍需优化的是每次读取至少执行一次 `find`，不是已证实的 `orDie` 故障放大。
3. **但当前未提交的扫描器重构尚不可合并。** 2026-09-27 实测 `bun run typecheck`（packages/core）失败：`session/agents.ts` 引用已移除的 `SCAN_COMMAND`/`parseScanOutput`/`scanIncremental` 等符号，`session/commands.ts` 仍将 `ScannedFile` 传给旧的 `string` 参数；聚焦测试也曾复现对应运行时 `ReferenceError`。先完成统一到 `scanSandboxMarkdown`、更新 wire-format 测试，再重新做功能判断。
4. **PG schema 可独立 psql 回放失败、PG 数值类型漂移等前述 PG 条目，本轮未重新独立复现。** 它们应视为待复验的静态风险，不能当作本轮已证实缺陷。
