# GraphRAG 评测环境中断调查（2026-10-14）

## 结论

根因链：真实知识数据与 E2E 测试共用 `55432/knowledge` 数据库的 `knowledge` schema；测试继承业务 `.env` 的 schema，清理钩子删除整个 schema；知识服务后台 Wiki 恢复轮询随后访问不存在的表，未捕获 Promise rejection，Bun 进程退出。

这是测试隔离与清理范围问题，不是图检索失败，也不是凭据变化或已观察到的 PG 容器重建。现已修复本次涉及的两套 E2E 隔离与清理风险、Wiki 恢复轮询未捕获异常；数据尚未恢复，严格 V01–V12 仍为 BLOCKED。

## 证据时间线（UTC，北京时间需加 8 小时）

| 时间 | 证据 |
|---|---|
| 07:57:53.786 | 当前 `packages/knowledge/.env` 最后修改时间；指向 `127.0.0.1:55432/knowledge`，`KNOWLEDGE_DATABASE_SCHEMA=knowledge` |
| 08:17:45.396 | 临时目录 `harness-graph-build-or.log` 最后修改时间，包含全量构建汇总；此前图库已完成构建 |
| 08:38:00.122 | 本地 OpenCode 会话记录：在 `packages/knowledge` 目录执行 `KNOWLEDGE_DATABASE_URL=…/knowledge bun test test/database-e2e.test.ts`，未覆盖 schema；结果 7 pass、1 fail |
| 08:38:22.731 | 同一会话再次执行该测试，仍未覆盖 schema；结果 8 tests、0 fail。两次记录的会话 ID 为 `ses_ec7aebf01ffekCM1zHjucRjU4q` |
| 08:38:33.977 | PG 容器日志：`UPDATE knowledge.wiki_compile_tasks ...` 报 `relation "knowledge.wiki_compile_tasks" does not exist` |
| 08:38:33.981 | `knowledge-server.log` 最后修改时间；记录同一缺表异常，SQLSTATE `42P01`，结尾为 Bun 版本信息；此后 18787 连接失败 |
| 后续只读检查 | `pg_namespace` 中 `knowledge` schema 不存在，不仅是某一张图表为空；源文档、向量表及目标图表在当前连接中都已不可用 |

会话记录来源：只读查询 `/Users/ruomu/.local/share/opencode/opencode.db` 的 `session_message`，提取上述时间窗口的 shell input 和已完成输出；未修改该数据库。数据库 URL 的用户名、密码未写入本报告。

## 缺陷位置

1. `test/database-e2e.test.ts:50–58`：beforeAll 使用 `process.env.KNOWLEDGE_DATABASE_SCHEMA || "knowledge_ds_e2e"`，因此业务 `.env` 中的 `knowledge` 优先；afterAll 用同一环境变量执行 `DROP SCHEMA IF EXISTS ... CASCADE`，没有检查是否为本套件创建的测试 schema。
2. `test/e2e.test.ts:70–79` 存在同型风险。本次日志中已找到明确运行记录的是 `database-e2e.test.ts`，不能把所有风险测试都当作本次实际执行者。
3. `src/llm-wiki/services/wiki-compiler.service.ts:203–206`：恢复器立即调用和 15 秒定时调用均为 `void this.recoverAvailableTasks()`，没有 rejection handler；`recoverAvailableTasks():215–224` 直接查询数据库。`src/app.ts:56` 在启动时开启该恢复器。异常不只影响 Wiki 域，会使整个独立知识服务退出。

`database-e2e.test.ts` 当前工作区差异仅将查询词“订单创建”改为“订单服务”；隔离与清理代码没有出现在该差异中。没有为了复现再次执行任何删库测试。

## 排除项与证明边界

- PG 容器 `knowledge-pg` 创建于 10 月 12 日，最近启动为 10 月 13 日 01:24 UTC，restartCount=0，仍挂载原匿名数据卷；不支持“本次 PG 重建导致数据消失”的解释。
- 旧服务记录的数据库连接与当前 `.env` 的主机、端口、数据库、schema 相同；`.env` 修改时间早于测试和退出时间。
- PG 当前 `log_statement=none`、`log_min_duration_statement=-1`，没有记录每条成功 DDL，因此未拿到服务器端成功 `DROP SCHEMA knowledge` 审计日志。根因判断来自实际测试调用、执行目录、既有 `.env`、无条件清理源码，以及紧随其后的缺表异常和 schema 不存在的组合证据，不能声称已有逐条 DDL 审计。
- `archive_mode=off`、`archive_command=(disabled)`；未确认外部备份或存储快照，不能承诺直接从现有 PG 恢复。本次未扫描所有数据库或所有备份路径。
- 旧 V 系列日志另有模型上游 429，但它不解释 PG schema 消失，也不把旧轮次转换成本轮严格评测结果。

## 建议处置（尚未执行）

1. 优先修复测试安全边界：独立测试库或每套件唯一 schema；只清理本套件创建的对象，拒绝删除业务 schema；避免以可变全局环境变量作为清理依据。
2. 为 Wiki 恢复轮询增加明确异常处理及可观测性；数据库缺表仍需报警，不能静默报告健康。
3. 查找已有备份/快照并确认可恢复范围。若只能重新同步原文和构图，需用户确认，并标记新语料及图库版本，不能当作旧图库复测。
4. 在测试隔离修复和数据恢复确认前，不运行当前目录的普通全量 `bun test test/`，因为 Bun 会自动加载业务 `.env`。

初始调查只新增文档，没有修改服务代码、连接配置、PG 数据或运行中的容器。用户授权继续后，修复和隔离验证记录如下。

## 授权后的修复与验证

### 修改范围

- `test/helpers/owned-schema.ts`：使用 UUID 生成唯一且合法的测试 schema；先校验实际数据库模块的 schema，再以不带 `IF NOT EXISTS` 的 `CREATE SCHEMA` 取得所有权。只有创建成功才允许清理，清理使用捕获的常量，不读取可变环境变量。已有 schema 或模块缓存冲突时拒绝执行；清理失败明确报错。
- `test/e2e.test.ts`、`test/database-e2e.test.ts`：不再继承业务 schema；初始化前取得 schema 所有权；清理前停止该测试启动的 Wiki 轮询，最后释放连接池。保留原有测试流程及已存在的查询词调整。
- `src/llm-wiki/services/wiki-compiler.service.ts`：启动及定时恢复调用都捕获 rejected Promise 并以 `console.error` 记录原异常。单次扫描失败不会停止后续扫描；直接调用 `recoverAvailableTasks()` 仍会向调用者抛错，不改变它的错误契约。
- 未修改 Graph 摄入、检索和评分逻辑，未修改 npm 包；没有自动启动原 18787 服务或初始化业务 `knowledge` schema。

### 回归证据

| 验证 | 结果 | 证明范围 |
|---|---|---|
| 修复前恢复器回归 | 新增生命周期测试 FAIL，并出现未捕获缺表异常 | 新测试可捕获原事故触发点；日志 `wiki-recovery-before.log` |
| 单测 | 42 PASS / 0 FAIL，105 assertions | schema 命名、模块冲突拒绝、创建失败不清理、定向清理、清理失败重试；恢复首次/定时失败后续可继续、启动幂等和停止 |
| 真实 PG 两套 E2E | 20 PASS / 0 FAIL | 原有 Hono request 接口流程；本轮使用 UUID schema，不访问业务数据 |
| PG 清理防护探针 | 哨兵数据保持不变，业务 `knowledge` schema 状态前后一致，两套测试无残留 schema | 将新建哨兵 schema 模拟为继承的业务配置后执行两套 E2E；仅清理探针自己创建的 schema |
| Docker HTTP + PG 故障注入 | 1 PASS / 0 FAIL，约 18 秒 | 新建隔离服务，删除本套件创建的 Wiki 任务表，等待超过一次 15 秒轮询；日志有 `task recovery failed` 和 `42P01`，容器继续运行，`/health` 与 `/api/knowledge-base` 返回 200，知识库表计数不变 |
| `bun run typecheck` | exit 0 | 包类型检查通过 |

日志均在批准的临时目录 `/private/var/folders/zk/8qd0lv657wn8kvpp__hwjj400000gn/T/opencode/`：`wiki-recovery-before.log`、`knowledge-safety-units.log`、`knowledge-safety-pg-e2e.log`、`knowledge-recovery-http-e2e.log`、`knowledge-safety-typecheck.log`。Docker 回归持久用例为 `test/wiki-recovery-http.e2e.test.ts`，需显式 `KNOWLEDGE_RECOVERY_HTTP_E2E=1`，并提供 Linux canvas 的只读 preload 目录及运行时卷。测试创建的 Docker 容器与 schema 已清理。

注意：`/health` 仍是原有存活检查，不代表所有数据库域就绪。本轮证明错误已记录且进程、其他业务域仍可用，不声称缺表域已健康，也没有静默吞掉错误。

### 备份只读调查

- 在知识包目录、批准的临时目录、`~/backups`、`~/backup`、`~/Documents/backups` 搜索备份扩展名；未找到 `.dump`、`.backup`、`.bak`、`.sql`、压缩 SQL 或 tar 候选文件。跳过依赖及 Git 目录，限制遍历深度，不代表扫描了全部磁盘。
- 找到 3 个未被容器引用的匿名 PG16 数据卷；只通过 `--network none --read-only` 临时容器及只读挂载检查，没有启动这些卷中的 PostgreSQL，也没有修改原卷。
- 创建时间分别为 2026-10-12 16:42（`a725…`）、2026-09-25 18:16（`d62b…`）、2026-10-12 10:01（`de95…`），均早于本次 10 月 14 日构图。
- 扫描这些卷 `base` 目录的数据文件字节，未命中源 KB、目标 Graph KB 或所检查的两条源文档 ID。此检查不是 SQL 全库验证，压缩/编码内容可能不暴露字面标识，不能据此宣布卷中绝无可恢复数据。

**目前没有确认可直接恢复原 36 篇语料和目标图库的备份。** 未执行恢复、重新同步或构图；若进一步检查原卷，须复制到独立工作副本后验证，禁止直接以可写方式启动原卷。若选择重新同步和构图，应另行确认授权并记录新版本。
