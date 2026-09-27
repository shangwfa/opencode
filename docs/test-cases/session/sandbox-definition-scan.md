# 会话沙箱定义扫描（V2）

> 覆盖 Session Agent 和 Session Command 从 Session 所属 OpenSandbox 的
> `/workspace/.opencode/{agent,agents,command,commands}` 扫描、合并、失效及隔离。
> 这是沙箱文件系统的派生视图测试；扫描到的定义**不应**写入 PostgreSQL。

## 1. 环境、前提与判定边界

- 服务、PostgreSQL、OpenSandbox 均通过 Docker 启动；使用 `docs/test-cases/test-env.sh` 的 `BASE`、`PG_URL`、`MODEL` 和 Basic Auth 配置。
- 每个用例创建独立 root Session，目录为 `/workspace`；结束后删除 root Session。
- 文件夹/文件 fixture 必须通过该 Session 的 `prompt_stream` 驱动 shell/write 工具写入。SSE 必须确认工具 `completed`，再执行读 API；不能以宿主机 `docker exec` 或直接改 PG 代替产品链路。
- Agent API：`GET/POST/DELETE /api/session/:id/agents`，`POST /api/session/:id/agents/refresh`。
- Command API：`GET/POST/DELETE /api/session/:id/commands`，`POST /api/session/:id/commands/refresh`。
- 当前实现尚无 SandboxWatcher 事件订阅；“实时生效”在本用例中指**下一次 list/refresh 请求必须读取新 fingerprint**，不是要求未发请求时主动推送 SSE。若以后实现 SandboxWatcher，另补事件时延和断线重连用例。

### 通用断言

每个成功扫描场景都必须同时检查：

1. HTTP：list/refresh 返回 200，定义的 `source="sandbox"`、ID、`sourcePath`、内容符合 fixture；
2. 过程：写 fixture 的工具事件完成，refresh/list 没有 `Sandbox Agent/command scan failed` 日志或 5xx；
3. PG：`session_agents` 和 `session_commands` 只包含 API 显式创建的行，扫描出的 sandbox 定义不产生行；
4. 隔离：其他 root Session 的 list 不得出现该 fixture 定义。

建议公共 fixture 名均带 nonce，例如 `scan-${NONCE}/reviewer.md`，避免共享环境遗留文件。

---

## 2. Agent 扫描用例

| ID | 场景与准备 | 操作 | HTTP / PG / 过程期望 |
|---|---|---|---|
| SAS-AG-01 | 在 `.opencode/agents/scan-N/reviewer.md` 写 frontmatter `description`、`mode: subagent` 和正文 system | refresh，随后 GET agents | 返回 `id=scan-N/reviewer`、`source=sandbox`、`sourcePath=scan-N/reviewer.md`；正文成为 system；PG 不新增 `session_agents` |
| SAS-AG-02 | 分别在 singular `agent/` 和 plural `agents/` 下放合法文件 | refresh | 两个定义均被发现；验证两个根目录都受支持 |
| SAS-AG-03 | 将 AG-01 文件的 description/system 改为唯一新标记 | **不先 refresh，直接 GET**；再 refresh | 两次读取均不得返回旧内容；refresh 的结果与 GET 一致，证明缓存只跳过未变内容解析，不缓存目录快照 |
| SAS-AG-04 | 新增另一个合法文件 | GET agents | 新 ID 在下一次读取出现；旧 ID 保留 |
| SAS-AG-05 | 删除 AG-01 文件 | GET agents，再 refresh | 被删除 ID 均不出现；无残留 sandbox 定义；PG 无对应行 |
| SAS-AG-06 | 写无 frontmatter/非法 mode/非法配置的 markdown | refresh | 200；该文件被跳过，其他合法定义仍返回；日志只含脱敏路径/计数，不得记录文件正文 |
| SAS-AG-07 | 创建 `../outside.md`、空名称、非 `.md`、位于 `.opencode/other` 的文件 | refresh | 全部不可见，不能越出 discovery prefix；服务不读取 `/workspace` 外路径 |
| SAS-AG-08 | 创建超过 `MAX_SCAN_FILES` 的合法 markdown，首尾名称可辨识 | refresh | 最多扫描上限个；响应/日志含截断可观测信号；服务不超时、不中断；记录排序和保留集合作为当前契约 |
| SAS-AG-09 | 模拟 sandbox 不可达/scan timeout（测试环境关闭该 Session sandbox 或使用 SDK fault 注入） | GET agents；refresh | GET 可降级为全局 + Session 定义且不 5xx；显式 refresh 返回可识别失败；PG 与既有行不受影响 |
| SAS-AG-10 | API 创建同 ID 的 Session Agent，再放同 ID sandbox 文件，字段分别设置不同标记 | refresh | sandbox 优先级覆盖同字段，未设置的字段保留 Session 值；删除 sandbox 文件后恢复 Session 值 |
| SAS-AG-11 | sandbox 文件 `disabled: true` 覆盖全局/Session Agent | refresh，删除该文件后再 refresh | 生效列表中该 ID 消失；删除后恢复。该项须同时由产品确认 sandbox 文件是否被允许影响 permissions，未确认前不得用它验证权限放大 |

## 3. Command 扫描用例

| ID | 场景与准备 | 操作 | 期望 |
|---|---|---|---|
| SAS-CM-01 | 在 `.opencode/commands/scan-N/hello.md` 写 description 和 template | refresh/list commands | 返回 `name=scan-N/hello`、`source=sandbox`、`sourcePath` 正确；PG 不新增 `session_commands` |
| SAS-CM-02 | 覆盖 `command/` 和 `commands/` 两个目录 | refresh | 两者均可发现；重复 name 的优先级必须有确定契约，若未定义则测试应失败并要求产品决定 |
| SAS-CM-03 | 改 template/新增/删除文件 | 每一步直接 list，再 refresh | 每次返回最新定义；删除后不残留；不能因 fingerprint cache 返回旧 template |
| SAS-CM-04 | 非法 name、无效 frontmatter、超长/含敏感正文模板 | refresh | 非法文件跳过且不影响合法项；错误和日志不得泄露 template/参数正文 |
| SAS-CM-05 | Session API 创建与 sandbox 同名 command | list，执行 command | 明确并断言既定优先级；执行事件使用获胜定义。若 sandbox command 包含 ``!`cmd` `` 插值，必须记录 shell 权限事件和完整执行结果 |
| SAS-CM-06 | sandbox scan timeout/非零退出 | list；refresh | **当前 Command list 与 refresh 都会失败**（扫描错误向上冒泡）；HTTP 错误映射应为稳定、可识别的非 2xx，不能伪装为空列表成功。若产品要求与 Agent list 一样 best-effort，先改实现并另行更新此预期 |

---

## 4. 根会话与跨会话场景

### SAS-SH-01：子会话复用 root sandbox

1. root Session 写入 `.opencode/agents/scan-N/shared.md` 和 command fixture；
2. 通过 subagent 工具创建 child Session；
3. 对 child 调用 agent/command list 与 refresh；
4. 断言 child 能读取 root `/workspace` 的 fixture，sandbox 表仅 root Session 对应一条记录；
5. 修改 root fixture 后，root 与 child 的下一次读取都应得到相同新版本。

> 缓存实现必须按 root sandbox identity 去重，同时不能跳过每次变更检测；不能仅按 child session ID 缓存独立快照。

### SAS-SH-02：不同 root Session 隔离

创建 A/B 两个 root Session，仅 A 写 `scan-N/reviewer.md`：A 可见，B 不可见；删除 A 后 B 的结果仍不变。PG 查询应确认两边没有因扫描写入的定义行。

### SAS-SH-03：sandbox 重建

在已扫描 fixture 后销毁/重建 root sandbox（使用受控测试管理接口或 fault injection），再调用 list/refresh：旧内存缓存不得把已不存在的文件返回为存在；新 sandbox 的 fixture 必须按其实际文件系统为准。

## 5. 自动化门禁

| 层级 | 最低门禁 |
|---|---|
| Core | `packages/core/test/session/scan.test.ts` 覆盖 path 解析、上限、fingerprint 新增/修改/删除、cache eviction；Agent/Command 测试覆盖合并、降级与显式 refresh |
| HTTP + PG | 使用真实 Docker 服务运行 AG-01/03/05/09/10、CM-01/03/06、SH-02；脚本用 `psql` 验证扫描不落库及 API 覆盖行的隔离 |
| Runtime E2E | 用真实模型完成 fixture 写入、refresh/list、subagent root-share（SH-01）；检查 SSE 工具完成、session execution succeeded、持久化消息与 sandbox 文件内容 |

当前未提供沙箱文件变更事件时，不得用固定 sleep 作为“实时”断言；所有读取断言必须由一次 list 或 refresh 请求触发。

---

## 6. 补充边界与缓存回归用例

| ID | 场景与准备 | 操作 | 期望/意义 |
|---|---|---|---|
| SAS-CACHE-01 | 首次扫描后保持文件 mtime 与 byte size 不变，只改同长度内容（测试 fixture 可在沙箱内显式恢复 mtime） | 普通 list，再强制 refresh | 普通 list 当前基于 `mtime:size` fingerprint，可能复用旧解析值；refresh 必须读出新内容。此测试明确 fingerprint 的失效限制。若产品要求普通 list 也检测任意内容变化，就须调整 fingerprint（例如内容 hash/事件驱动），而不是放宽预期 |
| SAS-CACHE-02 | 首次扫描成功，下一次对已变更文件的 `fileRead` 注入一次失败，随后恢复成功且 fingerprint 不变 | 连续两次普通 list，再 refresh | 普通 list 不应永久缓存“读取失败/无定义”；恢复后应能重试并读到定义。当前 scanner 将读失败映射为 `undefined` 并按 fingerprint 缓存，需确认实现是否满足；不满足时此用例应作为缺陷阻断 |
| SAS-CACHE-03 | 同一 root session 并发触发多次 list/refresh，并在扫描过程中改文件 | 并发请求后再次普通 list | 每个响应都是完整有效定义，不出现部分合并/异常；最终请求看到最新版本。记录扫描次数和 fileRead 次数，验证是否有 single-flight；并发是否允许重复扫描需明确性能契约 |
| SAS-CACHE-04 | 两个服务实例使用同一 PG 和同一个 root sandbox，先后访问同一 Session | 实例 A 扫描；改文件；实例 B、A 依次 list | 两个实例在下一次读取都得到当前 sandbox 内容；不能依赖本地 watcher 或跨实例缓存广播。记录各实例 fingerprint scan，而不要求共享内存缓存 |
| SAS-SCAN-01 | 创建数量远超 `MAX_SCAN_FILES` 的 `.md` 文件，令 find 输出显著大于 200 条 | refresh 并观察 sandbox 命令输出字节数、耗时、超时及服务内存 | 只能断言最多读取 200 个定义；**当前上限并未约束 find 枚举和输出字节数**。评估是否需在沙箱命令端提前截断/流式扫描和字节上限，避免“限制读取数但先生成无限清单” |
| SAS-SCAN-02 | 沙箱 `find` 不存在/不支持 `-printf`、目录不可读、命令被中断 | Agent GET/refresh 与 Command list/refresh 分别执行 | 按各接口契约得到预期 fallback 或非 2xx；错误可观测且不泄露文件正文；命令支持性问题不能误判为空目录 |
| SAS-SCAN-03 | markdown 文件名包含空格、制表符、换行、非 ASCII 字符；另加符号链接指向 discovery 根外文件 | refresh | 空格/Unicode 应按契约正常解析；TAB/换行不得造成错行、串路径或越界读取；符号链接不得让读取越出允许目录。当前扫描协议按换行分条，且 `find -type f` 不跟随链接，但仍需以真实沙箱验证解析和 provider fileRead 边界 |
| SAS-DEF-01 | sandbox Agent 对既有 global/session ID 设置 `permissions`，并通过 prompt 触发受保护的 read/edit/shell；另测新 sandbox-only Agent | list 后实际执行工具 | 验证权限来源、deny/ask/allow 优先级及审计事件；若 sandbox 文件来源不可信，必须证明其不能扩大授权。该项当前有产品策略待定，策略确认前不能判通过 |
| SAS-CM-07 | sandbox command 的 template 引用不存在参数、空参数、含 shell 特殊字符参数；分别测试普通执行和 `!` 插值 | 通过 HTTP/Prompt 执行并检查 SSE 与消息 | 结果符合参数展开契约；shell 插值经过权限检查，失败不泄漏/执行部分命令；记录有效定义来源和实际 template 版本 |
| SAS-CM-08 | `.opencode/command` 与 `.opencode/commands` 同时存在同名定义；再在 sandbox 与 Session API 各放同名定义 | refresh/list 后执行 | 断言唯一、稳定的获胜来源及执行内容；不得因目录遍历顺序或 Map 插入顺序随机改变。若产品尚未规定优先级，此用例阻止发布直到契约明确 |

## 7. 目录生命周期、扫描竞态与缓存恢复

| ID | 场景与准备 | 操作 | 期望/意义 |
|---|---|---|---|
| SAS-LIFE-01 | 创建 Session 时 `.opencode` 和四个定义目录均不存在 | Agent/Command list 一次后，通过工具创建整级目录和定义文件，再次 list | 首次空扫描不得永久记为“目录不存在”；下一次扫描发现新文件。覆盖动态建目录而非只覆盖已有目录内写文件 |
| SAS-LIFE-02 | 对同一文件在目录间移动（rename），或从 singular 目录移动到 plural 目录 | list/refresh | 旧 sourcePath 消失，新 sourcePath 出现；不得同时保留重复定义或丢失有效定义 |
| SAS-LIFE-03 | 用相同 name 在同一目录放大小写不同扩展名 `.md`/`.MD`，另测 Unicode 与深层子目录 | refresh | 精确确认大小写扩展名策略、ID/sourcePath 规范化及递归深度；不允许隐式大小写碰撞改变定义 |
| SAS-CACHE-05 | 同一 root sandbox 两个扫描并发开始：扫描 A 拿到旧 fingerprint 后延迟 fileRead；改文件并启动扫描 B，令 B 先完成、A 后完成 | 再 list | 最终缓存不能被迟完成的旧扫描回滚；最终 list 必须反映 sandbox 当前版本。用可控 Deferred/fake provider 确定完成顺序 |
| SAS-CACHE-06 | 构造超过 cache session limit 的不同 session 扫描，再回到最早 session | 重新 list 最早 session | 淘汰只能导致重新读/解析，不能返回其他 session 定义或错误复用；核对 cache 上限与淘汰行为 |
| SAS-CACHE-07 | 首次扫描后只执行显式 refresh，文件内容/fingerprint 不变 | 统计 sandbox `fileRead` 次数并比较结果 | `force` refresh 必须重新读取所有当前文件，不能命中解析缓存；响应仍与内容一致 |
| SAS-CACHE-08 | 扫描中途新增/删除/改名文件，使 `find` 清单与后续 `fileRead` 之间发生竞态 | list/refresh 后立即再 list | 不得把瞬时 file-not-found 固化成同 fingerprint 的永久“无定义”；最终稳定状态须恢复正确。覆盖 list snapshot 非原子性 |
| SAS-API-01 | 对不存在/已删除 Session 调用 Agent 与 Command list/refresh；另测无效 ID 和重复请求 | 调用各 HTTP 路由 | 按接口契约返回 404/400/成功；不插入 PG 残留行；重复 refresh 幂等。只对不存在 Session 的请求断言不产生孤儿 sandbox；有效 Session 首次扫描是否懒创建 sandbox 以 provider 契约为准 |
| SAS-API-02 | 扫描定义与显式 Session 覆盖混合；删除覆盖但保留 sandbox 文件，再 clear session overrides | 调用 DELETE 后 list | 删除/clear 只影响 PG 覆盖，sandbox 定义仍存在；删除 Session 后扫描缓存不应泄漏到其他 Session |

> `mtime:size` 相同内容变更已在 SAS-CACHE-01 覆盖；SAS-CACHE-05/08 额外验证异步完成顺序和扫描期间文件系统变化，二者不能由普通“改文件后再读”替代。

### 当前实现相关的注意事项

- `MAX_SCAN_FILES=200` 在 `parseScanOutput` 收到完整命令输出后才应用；因此 SAS-AG-08 仅覆盖定义读取数，不等于扫描输出或资源有界。
- fingerprint 是 `mtime:size`，不保证检测“内容改变但 mtime/size 不变”；`refresh` 的 force scan 是恢复途径。
- `readDefinition` 将 `fileRead` 错误转成 `undefined`，增量扫描可能把失败结果缓存到相同 fingerprint；SAS-CACHE-02 是必要回归门禁。
- Agent list 对 SandboxScanFailure best-effort；Command list 目前直接传播 scan failure。二者当前行为不对称，文档不得把 Command fallback 写成已实现行为。
- 子会话和跨实例用例验证可见性/正确性；当前缓存按 sessionID 维护且进程本地，不应把“跨子会话共享缓存”作为当前实现的通过条件。要验证的是每次扫描都解析到 root sandbox 且读到其当前内容；共享缓存属于后续优化及独立性能契约。

---

## 8. 本轮执行结果（2026-09-27）

环境：当前源码构建的隔离 Docker SaaS（端口 `14097`）+ 本地 `opencode-v2-up` PG + OpenSandbox + `Yd-DeepSeek/deepseek-v4-flash`。
fixture 全部经 `prompt_stream` 驱动 shell 工具写入；Agent/Command 的 sandbox fixture 用独立 nonce 命名。

- Core：`packages/core/test/session/` **37 pass / 0 fail**（含 5 个 PG 用例，`OPENCODE_DATABASE_URL` 指向本地库）。
- HTTP+PG：`docs/test-cases/scripts/sandbox-definition-scan-v2.mjs` **16 项断言通过**。
- HTTP+PG（command/subagent）：`docs/test-cases/scripts/sandbox-definition-scan-command-v2.mjs` **6 项断言通过**。
- HTTP+PG（故障路径）：`docs/test-cases/scripts/sandbox-definition-scan-fault-v2.mjs` **5 项断言通过**（沙箱 endpoint 不可达的实例）。
- HTTP+PG（边界/故障注入）：`docs/test-cases/scripts/sandbox-definition-scan-edge-v2.mjs` **7 项断言通过**；覆盖 Unicode/深层目录/符号链接、非零 `find`、10 秒超时与超时后恢复。
- 三个脚本结束时 `session_v2`/`session_agents`/`session_commands` 均零残留。

| 用例 | 结果 | 依据 |
|---|---|---|
| SAS-AG-01/02 | 通过（HTTP+PG） | id/source/sourcePath/正文 system 正确；singular+plural 均发现；PG 无新增行 |
| SAS-AG-03 | 通过（HTTP+PG） | 改内容后普通 GET 即读到新值，与 refresh 一致，未返回旧缓存 |
| SAS-AG-04 | 通过（HTTP+PG） | 新增文件下一次 list 出现，旧 ID 保留 |
| SAS-AG-05 | 通过（HTTP+PG） | 删除后 refresh 不再返回，PG 无对应行 |
| SAS-AG-06 | 通过（HTTP+PG） | 非法文件被跳过，合法定义不丢 |
| SAS-AG-07 | 通过（HTTP+PG） | 越出发现根、非 `.md`、非发现目录的文件均不可见 |
| SAS-AG-08 | 通过（Core） | `MAX_SCAN_FILES` 上限与截断信号；未做 HTTP 级 >200 真文件 |
| SAS-AG-09 | 通过（HTTP fault） | 沙箱不可达时 Agent GET 返回 200 且保留 Session 定义；显式 refresh 返回 500 |
| SAS-AG-10 | 通过（HTTP+PG） | sandbox system 覆盖 session；未设置字段保留 session；删除 sandbox 文件后恢复 |
| SAS-AG-11 | 部分（策略待定） | sandbox `disabled`/`permissions` 合并机制已由 Core 用例锁定；是否允许 sandbox 影响 permissions 属产品策略 |
| SAS-CM-01 | 通过（HTTP+PG） | name/source/sourcePath/template 正确；PG 无新增行 |
| SAS-CM-02 | 通过（HTTP） | 同名折叠为单一定义，跨 read/refresh 稳定 |
| SAS-CM-03 | 通过（HTTP+PG） | 改 template 与删除后下一次读取即反映 |
| SAS-CM-04 | 部分 | Core 覆盖非法 frontmatter 跳过；日志脱敏未逐条核对 |
| SAS-CM-05 | 通过（HTTP） | sandbox 命令覆盖同名 Session 命令；执行使用获胜模板 |
| SAS-CM-06 | 通过（HTTP fault） | 沙箱不可达时 command list 与 refresh 均返回 500，且不泄露 template |
| SAS-CM-07 | 通过（Core） | `$n`/`$ARGUMENTS` 缺失与空参数、shell 特殊字符、`!` 插值均由既有 Core 用例覆盖 |
| SAS-CM-08 | 通过（HTTP） | 同名优先级唯一稳定；执行内容与获胜定义一致 |
| SAS-SH-01 | 通过（HTTP runtime） | subagent 子会话读到 root sandbox fixture，child 无 PG 行 |
| SAS-SH-02 | 通过（HTTP+PG） | 另一 root Session 看不到该 fixture；PG 无扫描写入行 |
| SAS-SH-03 | 通过（HTTP） | `kill-sandbox` 重建后扫描结果与文件系统一致 |
| SAS-CACHE-01 | 通过（HTTP+PG） | 同 `mtime:size`、只改等长内容时，force refresh 读出 new |
| SAS-CACHE-02 | 通过（Core） | 读失败不再按 fingerprint 固化；保留上次已知值，下次扫描重试 |
| SAS-CACHE-03 | 通过（Core） | 并发扫描各自返回完整定义，读取次数有界（无 single-flight 契约） |
| SAS-CACHE-04 | 通过（Core） | 两个独立缓存各自解析出当前内容，无跨实例共享状态 |
| SAS-CACHE-05 | 通过（Core） | 晚完成的旧扫描被拒绝写入，不回滚新结果（本轮修复的缺陷） |
| SAS-CACHE-06 | 通过（Core） | 缓存上限淘汰与会话隔离 |
| SAS-CACHE-07 | 通过（HTTP+PG + Core） | force refresh 全量重读 |
| SAS-CACHE-08 | 部分 | Core 覆盖 `null`/读失败 → 不固化、可重试 |
| SAS-SCAN-01 | 部分 | Core 断言最多读 200；find 输出字节仍未被约束（见 §7） |
| SAS-SCAN-02 | 通过（HTTP sandbox stub） | 定向 `find` stub 的非零退出：Agent GET 200 降级、refresh 500；挂起：约 10 秒超时；移除 stub 后扫描恢复 |
| SAS-SCAN-03 | 通过（HTTP sandbox） | Unicode、深层目录、TAB/换行、外部符号链接均已实跑；空格名按 `validName` 契约跳过且不影响相邻定义 |
| SAS-DEF-01 | 部分（策略待定） | sandbox 贡献 permissions 的机制已由 Core 用例锁定；授权扩大是否允许属产品策略 |
| SAS-LIFE-01 | 通过（HTTP+PG） | 首次空扫描后新建目录与文件被下一次扫描发现 |
| SAS-LIFE-02 | 通过（HTTP+PG） | singular ↔ plural 移动后旧 sourcePath 消失、新 sourcePath 出现 |
| SAS-LIFE-03 | 通过（HTTP sandbox） | `.MD` 不匹配；Unicode 文件及深层目录按预期发现 |
| SAS-API-01 | 通过（HTTP+PG） | 不存在 Session 的 agent/command list 与 refresh 均 404 |
| SAS-API-02 | 部分 | AG-10 覆盖「删 sandbox 恢复 session」；clear overrides 由 Core/Server 用例覆盖 |

**统计**：本轮新增 edge 脚本 7 项均通过；SAS-SCAN-02、SAS-SCAN-03、SAS-LIFE-03 的沙箱侧变体已完成。其余“部分”项仅限策略待定或未实现的专门故障类型。

**本轮修复的实现缺陷**

1. `readDefinition` 曾把 `fileRead` 错误/`null` 转成 `undefined` 并按 fingerprint 缓存，导致瞬时读失败被永久固化为“无定义”（SAS-CACHE-02）。现改为返回可缓存性标记：瞬时失败不写缓存、保留上次已知定义、下次扫描重试。
2. `SandboxDefinitionCache.write` 为 last-writer-wins，晚完成的旧扫描会覆盖新扫描结果（SAS-CACHE-05）。现按扫描开始时间拒绝更旧列表的写入。
3. 命令流 SDK 的 reject 曾作为 Effect defect 绕过 Agent GET 的降级处理；超时后的持久命令上下文也可能返回 `context not found`。现将其类型化为命令会话故障：CAS 清除内存/PG/锁中的旧会话，普通命令不重放；扫描作为显式 `safe-read` 只重试一次新命令会话，仍失败才重建 Sandbox 并重试一次。

**本轮 fixture / 脚本修正（非产品缺陷）**

- Agent 的 system 来自 markdown **正文**，frontmatter `system` 会被正文覆盖；sandbox 的 `description` 会覆盖 Session 值。初始 fixture 写反导致 SAS-AG-10 误判。
- user 消息的提示词在 `text` 字段，不在 `content` 数组里。

**仍未覆盖（及原因）**

- **SAS-AG-11 / SAS-DEF-01**：机制已验证，**是否允许 sandbox 文件影响 permissions 属产品策略**，策略确认前不判通过。
