# V2 Session Tools（会话级自定义工具）

Session Tool API 与执行链路的当前验收以 V2 API E2E 为准。V1 `/session/:id/tools/create`、旧 `message/part` 契约和旧 inline shell 脚本已从当前用例移除。

## 执行

需有可用的 V2 SaaS API、PostgreSQL、Sandbox 和模型。使用隔离测试数据库，并设置相应环境变量：

```bash
BASE=http://127.0.0.1:14296 \
PG_URL=postgresql://local@127.0.0.1:5432/opencode-v2-test \
OPENCODE_PASSWORD="$OPENCODE_PASSWORD" \
bun docs/test-cases/scripts/session-tools-full-v2-e2e.mjs
```

`ONLY=T32.29` 可单独运行 Sandbox `.opencode` > Session API > 全局内置工具的优先级用例。脚本经 `/api/session/:sessionID/tools` 执行 upsert/list/delete，经 `/api/session/:sessionID/prompt_stream` 触发真实模型工具调用；验证 `session_message` tool parts、`session_tools` PG 状态、Sandbox 文件副作用，并清理测试 Session。脚本应使用一次性隔离 DB，避免测试数据影响其他会话。

全量运行含 T32.27 模型工具目录断言，必须启用 Model Request Audit：服务端设置 `OPENCODE_MODEL_REQUEST_LOG=/audit` 并将 `/audit` 挂载到宿主机目录；执行脚本时 `MODEL_REQUEST_LOG_FILE=<宿主机目录>/model-requests.jsonl`。未启用审计时 T32.27 无法判断无效导出是否进入 provider 工具目录，该用例应判为环境未满足，不能记为通过。

## 用例与通过条件

| 编号 | V2 场景 | 关键通过断言 |
|---|---|---|
| T32.1–9 | CRUD、upsert、排序、隔离、级联、schema 校验 | API 响应与 `session_tools` PG 行一致；不存在 Session 返回 404，非法请求返回 400 |
| T32.10–14 | 模型可见性、参数 schema、真实执行与完整工作流 | 对应 tool part 实际出现且 completed，结果符合输入；API 返回 schema 源码正确 |
| T32.15 | 非法工具名称 | V2 非法名称返回 400 |
| T32.16–24 | 内置工具不受干扰、时间戳、幂等、异常恢复、多工具、PG 一致性及同名覆盖回退 | 以真实 tool part 状态/结果与 PG 行断言，不只看 assistant 文本 |
| T32.27–28 | 非 ToolDefinition 导出处理、code 热更新 | 无效导出不被调用；upsert 后下一次真实调用命中新版本 |
| T32.29 | Sandbox `.opencode` > Session > 全局内置优先级 | 三层标记按顺序胜出，删除高优先级定义后回退，PG 行与 Sandbox 文件清理正确 |
| T32.25–26 | 历史用例 | 已移除，不纳入本版本套件；编号保留以便追溯历史记录 |

## 最近验证记录

- 2026-09-28：文档记载 T32.1–24、T32.27–28 的 V2 全量验证通过。
- 2026-10-01：T32.29 隔离 PG/API/Sandbox E2E 通过 1/1；Sandbox 标记胜出、删除后 Session 标记胜出、删除 Session 定义后内置 shell 标记胜出；测试后目标 PG 工具记录为 0、Session 删除，临时 API 与本轮 Sandbox 容器已清理。
- 2026-10-01：当前工作区源码叠加镜像全量 API/PG/Sandbox E2E 通过，27 passed、0 failed；T32.27 使用 Model Request Audit 验证 provider 工具目录。T32.25/26 因历史移除跳过。

历史 V1 执行记录不代表当前分支的最新验证。若代码或 API 契约有变化，应运行上述脚本并更新这张结果表。

## 单测位置

V2 Session Tool 相关单测位于 `packages/core/test/session-tools.test.ts`、`packages/core/test/session-tool-host.test.ts`、`packages/core/test/session-tool-gate.test.ts` 与 `packages/core/test/session-tool-progress.test.ts`。完整 API/PG/Sandbox E2E 不可由这些单测替代。
