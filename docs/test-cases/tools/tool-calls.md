# V2 工具调用 E2E

本文记录当前 V2 工具调用验收。测试必须使用 V2 HTTP API，并同时核对 tool part 与必要的 PG/Sandbox 状态；模型最终回复不能单独作为通过证据。

## 环境与运行

先按 [`../local-test-env.md`](../../local-test-env.md) 启动 SaaS、PostgreSQL 和 OpenSandbox。然后运行：

```bash
BASE=http://127.0.0.1:14096 \
PG_URL=postgresql://local@127.0.0.1:5432/opencode-v2-up \
OPENCODE_PASSWORD="$OPENCODE_PASSWORD" \
bun docs/test-cases/scripts/tools-v2-e2e.mjs
```

脚本以 `POST /api/session` 创建测试会话，通过 `prompt_stream` 触发模型，通过 `/api/session/:id/message` 读取 assistant 的 `content[]` tool parts，并直接查询 `session_message`、`session_tools`、`sandbox`。脚本退出时删除创建的会话；运行前确保测试数据库和 Sandbox 环境可丢弃。

## 当前自动化覆盖

| 场景 | 通过条件 | 自动化证据 |
|---|---|---|
| Session Tool CRUD | API 创建/upsert/list/delete/clear、非法名称拒绝；API 与 PG 一致 | `tools-v2-e2e.mjs`；完整覆盖另见 [`session-tools-full-v2-e2e.mjs`](../scripts/session-tools-full-v2-e2e.mjs) |
| 冷会话 lazy Sandbox | 首次 glob 实际调用完成，且 PG 中该资源 owner 有 running Sandbox | `tools-v2-e2e.mjs` T-LZY.1 |
| read/write 闭环 | 空文件覆盖、新建、覆盖已有文件分别断言 `existed`；read 完成且输出包含夹具内容 | `tools-v2-e2e.mjs` T-WEX.1–3/T-RDX.2 |
| grep/glob 与截断 | grep 命中唯一 sentinel；超过 limit 时 `matches=100` 且 `truncated=true` | `tools-v2-e2e.mjs` T18.2/T-GTR.1 |
| 缺失 shell 命令 | 必须实际调用 `shell`，状态完成并快速返回命令失败信息 | `tools-v2-e2e.mjs` T18.9 |
| Session Tool 自定义执行 | 注册的工具被实际调用，状态完成且输出匹配 | `tools-v2-e2e.mjs`；完整 CRUD/优先级见完整脚本 |
| kill Sandbox 后恢复 | API 销毁后 PG 可见 destroyed；再次调工具完成，Sandbox 恢复 | `tools-v2-e2e.mjs` T18.10a |
| 活跃 touch | shell 后 `sandbox.time_updated` 严格增加 | `tools-v2-e2e.mjs` T-LZY.2 |

## 不纳入自动化通过门槛的场景

- **模型策略观察**：模型是否调用 `webfetch`/`skill`、选择 `edit` 还是其他编辑工具、是否并行提交冲突文件操作，都受模型与提示影响。应作为人工观察记录，不以单次未触发判定系统回归。
- **read files API 真挂死**：V2 `SandboxProvider.fileStat/fileRead/fileReadBytes` 当前直接等待 Sandbox files API promise，代码路径没有 read 专属 bounded timeout。kill-sandbox 后快速重建并不等价于 files API 超时注入。因此不再把旧 V1 的“15s×2 后 destroy”脚本当作 V2 测试或已实现能力。需要该能力时，应先实现并提供可控故障注入，再补 API E2E。
- **read 参数错误/二进制/UTF-8 分类**：使用确定性单测，不让模型决定是否传非法参数；见 `packages/core/test/tool-read.test.ts`、`packages/core/test/tool-read-filesystem.test.ts`。
- **watchdog**：这是 Session execution 生命周期测试，不属于 read timeout；watchdog 的中断语义和测试位置见 `packages/core/src/session/watchdog.ts` 及相邻 session watchdog 测试。
- **subagent 共享 Sandbox、子项目路径映射和 shell 并发**：分别归属 Session/Sandbox 行为测试。若需要 API E2E，应单独使用专用夹具和 PG/Sandbox 断言；不通过自然语言“请同时执行”推断系统并发语义。

## 已移除的旧判据

不再使用 V1 `/session`、同步 `/message`、`/exec`、PG `part` 表和 `bash` tool 名称作为 V2 操作步骤；V2 内置命令工具名是 `shell`，tool parts 存于 `session_message.data.content[]`。也不把“最近几条消息中出现任意 tool”或 AI 的总结文本当成用例通过标准。
