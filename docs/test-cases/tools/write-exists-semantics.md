# V2 Write：新建与覆盖语义

## 前置条件

SaaS API、PG 和 OpenSandbox 可用。Session 权限需要允许 `shell` 与 `edit`；V2 内置 `write` 工具使用 `edit` 权限 action。不要配置不存在的 `write` permission action。

## 用例与断言

| 用例 | 初始化 | 断言 |
|---|---|---|
| T-WEX.1 覆盖空文件 | 用 V2 `/api/session/:id/shell` 创建 0 字节文件 | 实际 `write` tool part `completed`；`state.metadata.existed=true`；Sandbox 文件含新内容 |
| T-WEX.2 新建文件 | 目标路径不存在 | tool part `completed`；`state.metadata.existed=false`；文件内容正确 |
| T-WEX.3 覆盖非空文件 | 预置非空旧内容 | tool part `completed`；`state.metadata.existed=true`；旧内容替换为新内容 |

检查 tool part 时读取 assistant 消息 `content[]` 中 `type=tool,name=write` 的 part；数据库证据从 `session_message` 查询。V1 `part.metadata.exists` 与模型回复措辞不作为 V2 断言。

## 执行入口

```bash
BASE=http://127.0.0.1:14096 \
PG_URL=postgresql://local@127.0.0.1:5432/opencode-v2-up \
OPENCODE_PASSWORD="$OPENCODE_PASSWORD" \
bun docs/test-cases/scripts/tools-v2-e2e.mjs
```

通用 API/PG 证据和清理约定见 [`tool-calls.md`](./tool-calls.md)。现有脚本覆盖 T-WEX.1：会先用 shell 创建空文件，再调用 write，并同时检查 tool part metadata 与 PG projection。T-WEX.2/T-WEX.3 的新建/非空覆盖场景若需逐项验收，应加入同一 V2 脚本并用固定路径、tool input 和 Sandbox 回读断言；模型文本不能代替这些断言。

## 语义依据

V2 实现在 `packages/core/src/tool/plugin/write.ts` 与 `packages/core/src/sandbox/tools.ts`：通过 Sandbox `fileStat` 是否返回文件信息判定 `existed`，因此 0 字节文件仍视为已存在；只有 not-found 才判不存在，其他 files API 错误应失败而非静默当作新建。2026-09-24 的历史 V2 实测记录为：空文件覆盖 `existed=true`，新建 `false`，覆盖非空文件 `true`；需以当前脚本执行结果作为当前分支通过证据。
