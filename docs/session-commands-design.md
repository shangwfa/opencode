# V2 会话命令技术方案

## 目标

为 SaaS 会话提供统一的 slash command 能力。每个会话绑定代码仓库和 opensandbox 沙箱，沙箱工作目录固定为 `/workspace`。命令定义有两类来源：会话 API 定义持久化在 PG；仓库命令由沙箱扫描并读取，不写入数据库。合并优先级为：

```text
sandbox > session API (PG) > builtin
```

扫描、命令模板中的 shell 插值和仓库文件操作都必须通过该会话绑定的 opensandbox 完成；不得从宿主机文件系统访问仓库。子会话沿用父会话的沙箱绑定，不引入 worktree 语义。

## 组件职责

- **PG store**：只保存 API 创建/更新的会话命令，所有 CRUD 均以 `session_id` 隔离。
- **Sandbox scanner**：调用 `SandboxProvider` 扫描并读取 `/workspace/.opencode/command(s)/**/*.md`，解析 frontmatter 与正文，结果只作为运行时覆盖层。
- **Resolver**：按 session 获取内置、PG 和沙箱定义，并以固定优先级合并。命令列表和执行必须使用相同的解析规则。
- **V2 Command Service**：保留统一的命令注册、执行、错误转换职责；会话命令通过 session-aware resolver 获取定义。
- **HTTP API**：提供会话命令 list/create/update/delete/refresh，并保留现有 `session.command` 执行入口。

## 定义契约

复用当前配置命令的字段语义：`name`、`description`、`template`、`agent`、`model`、`subagent`。沙箱 Markdown frontmatter 对应元数据，正文是模板。嵌套目录映射到命令名，例如 `commands/docs/write.md` 映射为 `docs/write`。解析后统一为运行时定义，并附带 `source`（`sandbox`、`session`、`builtin`）及可选相对 `sourcePath` 供诊断/UI 使用。

## PG 存储

会话 API 定义表包含 `id`、`session_id`、`name`、`description`、`template`、`agent`、`model`、`subagent`、创建/更新时间；唯一约束 `(session_id, name)`，会话删除级联删除。表仅存 API 来源定义，无需 source 列。读写删除都必须带 `session_id`。

## 沙箱扫描

通过当前会话 `SandboxProvider` 的沙箱文件 API 扫描 `/workspace/.opencode/command/**/*.md` 和 `/workspace/.opencode/commands/**/*.md`，读取文件内容并解析。扫描路径必须限定在 `/workspace`，拒绝路径穿越及非法命令名。单个文件错误记录诊断且不影响其它有效定义。扫描失败不得伪装成成功的空结果。

第一阶段不缓存扫描结果，避免跨服务实例的缓存一致性问题；命令列表及执行解析按需读取沙箱。若以后增加缓存，必须以 session 为键，有明确 TTL/失效机制，且扫描失败不能清除成功缓存。

## 合并和执行

统一 resolver 提供按会话 list/get：先放入 builtin，再以 PG 会话定义覆盖，最后以沙箱定义覆盖。列表与执行复用此逻辑。执行按当前 `sessionID` 解析最新定义，支持 V2 模板参数、agent/model/subagent 与 prompt contract；shell 插值必须通过同一会话 SandboxProvider 在 `/workspace` 执行。错误沿用 V2 的 Command NotFound/Execution 错误契约。

## API

- `GET /api/session/:sessionID/commands`：返回合并后的有效定义（来源可用于呈现）。
- `POST /api/session/:sessionID/commands`：创建或更新 PG 定义。
- `DELETE /api/session/:sessionID/commands/:name`：删除 PG 定义；若沙箱有同名定义，仍会生效。
- `DELETE /api/session/:sessionID/commands`：清空 PG 中该会话的所有 API 定义，不影响 builtin 和沙箱定义。
- `POST /api/session/:sessionID/commands/refresh`：显式触发沙箱重新扫描并返回新视图（无缓存实现下可作为统一验证/刷新入口）。
- 保留 `POST /api/session/:sessionID/command` 执行接口。

所有路由必须通过 session location/ownership 校验。列表和执行需区分沙箱故障、PG 故障和命令不存在，不能将依赖故障折叠成 NotFound。

## 安全与可观测性

命令名校验拒绝空值、路径穿越和非法分隔符；沙箱读取范围限制在约定目录，执行 cwd 固定 `/workspace`。结构化日志记录 sessionID、命令名、来源、扫描数量及耗时，不记录模板正文、用户参数或文件内容。

## 测试验收

- 单测：优先级、同名回退、路径映射/frontmatter/无效文件、模板参数、Resolver list/get 一致性、PG session 隔离和 CRUD。
- API 集成测试：真实 HTTP 创建 PG 命令、在测试 sandbox 写入同名文件、验证列表及执行命中 sandbox 版本；删除文件后回退 PG，删除 PG 后回退 builtin；验证 shell 在对应会话 sandbox `/workspace` 执行；验证两个会话隔离及子会话复用 sandbox。
- 故障覆盖：sandbox 扫描失败、PG 失败不能误报命令不存在或空列表；单个无效文件不影响其它命令。
