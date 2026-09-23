# load-dot-opencode 技术实现方案

## 1. 背景

项目当前已经支持通过接口向 Session 注入 Agent、Skill、MCP、Tool、Command、Plugin 等资源，并将这些资源保存到 PostgreSQL 的 `session_*` 表中。

本方案增加项目文件配置加载能力：扫描代码仓库下的 `.opencode` 目录，将文件配置转换为已有的 Session 资源记录，继续复用现有运行时逻辑。

本方案不新增复杂的资源 Resolver，也不替换当前 Config、Agent、Skill、MCP 等加载机制。

## 2. 目标

支持官方配置约定下的以下目录和文件：

```text
.opencode/
├── AGENTS.md
├── agents/
├── skills/
├── tool/
├── commands/
├── plugins/
└── opencode.json(c)
```

其中 MCP 只配置在官方的 `opencode.json` / `opencode.jsonc` 的 `mcp` 字段中，不创建 `.opencode/mcps/` 目录。

最终优先级为：

```text
项目 .opencode 配置
    >
当前 Session 的 PostgreSQL 配置
    >
全局配置
```

其中，当前 Session 的 PostgreSQL 数据是接口注入配置的权威来源。

## 3. 非目标

- 不修改现有 `Agent.sessionList`、`Agent.sessionGet`。
- 不修改现有 `Skill.get`、`Skill.available`。
- 不修改现有 `Command.sessionList`、`Command.sessionGet`。
- 不修改现有 `MCP.toolsForSession`。
- 不直接操作 PostgreSQL 或 SQLite。
- 不在扫描阶段连接 MCP。
- 不在扫描阶段执行 Plugin 或 Tool 代码。
- 不替换现有的全局 `.opencode` 配置发现机制。
- 不新增独立的资源候选模型和跨服务 Resolver。

## 4. 核心设计

新增模块：

```text
packages/opencode/src/config/load-dot-opencode.ts
```

模块只负责以下工作：

1. 定位当前项目的 `.opencode` 目录。
2. 扫描目录下的资源文件。
3. 解析并校验文件内容。
4. 调用已有的 Session 资源 Service 写入 PostgreSQL。
5. 返回加载成功和失败的诊断结果。

整体流程：

```text
Session 创建或恢复
        ↓
定位当前 worktree
        ↓
扫描 .opencode
        ↓
解析各类资源
        ↓
调用 SessionXxx.upsert 写入 PG
        ↓
现有运行时读取 Session 配置
```

现有运行时已经具备 Session 配置覆盖全局配置的能力。因此，将 `.opencode` 配置写入当前 Session 的 PG 记录后，不需要重新实现各资源的运行时合并逻辑。

## 5. Service 复用关系

`load-dot-opencode` 不直接依赖数据库实现，而是调用已有 Service：

| 文件来源 | 已有 Service | 写入方法 |
| --- | --- | --- |
| `.opencode/AGENTS.md` | `SessionAgentsMd` | 创建或替换内容 |
| `.opencode/agents/**/*.md` | `SessionAgent` | `upsert` |
| `.opencode/skills/**/SKILL.md` | `SessionSkill` | `upsert` |
| `.opencode/opencode.json(c)` 的 `mcp` 字段 | `SessionMcp` | `upsert` |
| `.opencode/tool/*.{ts,js}` | `SessionTool` | `upsert` |
| `.opencode/commands/**/*.md` | `SessionCommand` | `upsert` |
| `.opencode/plugins/*.{ts,js}` | `SessionPlugin` | `upsert` |

生产环境通过现有 Layer 提供 PostgreSQL 实现：

```text
SessionAgent.pgLayer
SessionSkill.pgLayer
SessionMcp.pgLayer
SessionTool.pgLayer
SessionCommand.pgLayer
SessionPlugin.pgLayer
```

加载器不直接导入 `Database`，也不直接执行 SQL。

## 6. 文件格式

### 6.1 AGENTS.md

路径：

```text
.opencode/AGENTS.md
```

文件为纯 Markdown，内容写入当前 Session 的 AGENTS 指令存储。

加载器不执行其中的命令、脚本或 URL，只将其作为模型上下文内容保存。

### 6.2 Agent

扫描：

```text
.opencode/agents/**/*.md
```

复用当前实现：

```text
packages/opencode/src/config/agent.ts
packages/opencode/src/config/markdown.ts
packages/opencode/src/config/entry-name.ts
```

使用 YAML frontmatter 和 Markdown 正文：

```md
---
description: Review code changes
mode: subagent
model: anthropic/claude-sonnet-4
---

Review the code carefully.
```

Markdown 正文写入 `prompt`，文件名或相对路径转换为 Agent 名称。

内部 Agent `compaction`、`title`、`summary` 不允许被覆盖。

### 6.3 Skill

扫描：

```text
.opencode/skills/**/SKILL.md
```

复用当前 Skill 的发现和资源读取规则：

```text
packages/opencode/src/skill/index.ts
```

写入字段：

```text
name
description
content
resources
```

继续使用现有资源限制：

- 忽略 `.git`、`node_modules` 等目录。
- 限制单个资源文件大小。
- 限制 Skill 总资源大小。
- 限制资源数量。
- 禁止资源路径逃逸 Skill 根目录。

### 6.4 MCP

MCP 使用官方的 `opencode.json` / `opencode.jsonc` 配置格式，不新增 `.opencode/mcps/` 目录。

加载器读取：

```text
.opencode/opencode.json
.opencode/opencode.jsonc
```

然后读取配置文件中的 `mcp` 字段。MCP 是以名称为 key 的对象：

```json
{
  "mcp": {
    "github": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "headers": {}
    }
  }
}
```

远程 MCP 的单项配置为：

```json
{
  "type": "remote",
  "url": "https://example.com/mcp",
  "headers": {}
}
```

本地 MCP 的单项配置为：

```json
{
  "type": "local",
  "command": ["bun", "run", "mcp.ts"],
  "environment": {}
}
```

配置名称来自 `mcp` 对象的 key，转换为：

```ts
SessionMcp.upsert(sessionID, {
  name,
  type: value.type,
  command: value.command,
  url: value.url,
  environment: value.environment,
  headers: value.headers,
  enabled: value.enabled,
})
```

配置结构复用现有 `ConfigMCPV1.Info` 和 `SessionMcp.Input`。

当前 `Config.loadInstanceState` 已经会读取 `.opencode/opencode.json(c)` 作为普通项目配置。`load-dot-opencode` 需要单独读取当前 worktree 的这两个文件，并只提取 `mcp` 字段写入当前 Session，不能把全局配置目录或其它项目目录的 MCP 写入当前 Session。

扫描阶段只进行解析和持久化，不连接服务器。MCP 连接继续由现有 `MCP.toolsForSession` 负责。

### 6.5 Tool

扫描：

```text
.opencode/tool/*.ts
```

遵循官方 Tool 文件格式，文件内容直接作为 `SessionTool.code` 保存，不增加自定义 frontmatter 或字段协议。Tool 模块可以使用官方 `@opencode-ai/plugin` 的 `tool()` 定义：

```text
name
description
code
```

文件名作为默认 Tool 名称。加载阶段不执行 Tool 代码，仍由现有 Tool 运行时（`SessionTool` 的 `importToolCode`）负责动态加载。

### 6.6 Command

扫描：

```text
.opencode/commands/**/*.md
```

复用：

```text
packages/opencode/src/config/command.ts
```

Markdown 正文作为 `template`，frontmatter 映射到已有 Command 字段：

```text
description
agent
model
subtask
hints
```

### 6.7 Plugin

扫描：

```text
.opencode/plugins/*.{ts,js}
```

文件路径或文件内容按照现有 `SessionPlugin` 输入格式写入 PG。

加载阶段不执行 Plugin。实际动态加载继续由：

```text
packages/opencode/src/plugin/session-plugin-runtime.ts
```

负责。

## 7. 路径定位

只扫描当前项目 worktree 下的 `.opencode`：

```text
<worktree>/.opencode
```

不复用 `ConfigPaths.directories()` 作为扫描入口，因为该函数还会返回全局配置目录、用户目录和 `OPENCODE_CONFIG_DIR`。这些目录不能被错误写入当前 Session 的 PG 配置。

必须校验：

- `.opencode` 位于当前 worktree 内。
- 文件路径不能通过 `..` 越出 worktree。
- Symbolic link 解析后不能越出 worktree。
- 只读取普通文件。
- `.opencode` 不存在时返回空结果，不报错。

## 8. 优先级和加载时机

同名资源使用已有 Session 表的唯一约束：

```text
(session_id, name)
```

加载逻辑使用 `upsert`：

```text
.opencode 文件解析成功
        ↓
写入当前 Session PG
        ↓
Session 运行时优先读取 PG 记录
        ↓
全局配置作为 fallback
```

推荐在以下时机调用：

1. Session 创建完成后。
2. Session 恢复时。
3. Session fork 后。
4. Session 执行 prompt 前。

为了保证 `.opencode` 始终高于接口注入，最小可靠方案是在每次 Session 开始执行 prompt 前重新加载一次。这样即使接口在上一次执行后更新了同名资源，下一次执行仍会恢复 `.opencode` 的优先级。

## 9. 幂等性

重复执行加载必须得到相同结果：

- 所有资源使用 `upsert`。
- 不重复创建 Session 记录。
- 同一个文件只处理一次。
- AGENTS 内容不能重复追加。
- MCP、Plugin、Tool 不在加载阶段执行。

## 10. 文件删除策略

现有 Session 表没有记录资源来源，因此无法区分以下两种记录：

```text
接口注入的 Session Agent
.opencode 写入的 Session Agent
```

第一版采用简单策略：

- 文件新增或修改：执行 `upsert`。
- 文件删除：暂不自动删除 PG 记录。
- Session 资源仍可通过现有 unload/clear 接口清理。

如果后续要求删除 `.opencode` 文件后自动恢复接口配置，需要给 Session 资源增加来源字段，例如：

```text
source = api | dot-opencode
```

该能力属于后续版本，不纳入第一版实现。

## 11. 错误处理

单个文件解析失败时，不影响其它资源：

```text
解析成功 → upsert
解析失败 → 记录 warning，跳过当前文件
```

数据库写入失败、Session 不存在、权限校验失败和 worktree 路径非法时，整个加载过程失败。

加载结果应返回：

```text
loaded: 成功加载的文件列表
skipped: 被跳过的文件及原因
```

高优先级 `.opencode` 配置解析失败时，不应静默回退为全局同名配置，避免用户误以为 `.opencode` 已经生效。

## 12. Layer 依赖

`LoadDotOpencode.layer` 需要以下依赖：

```text
FSUtil
SessionAgentsMd
SessionAgent
SessionSkill
SessionMcp
SessionTool
SessionCommand
SessionPlugin
```

在 PostgreSQL SaaS 环境中提供对应 `pgLayer`。无 PostgreSQL 时可以提供 noopLayer，但应记录提示，因为此时加载结果不会持久化。

## 13. 测试方案

新增：

```text
packages/opencode/test/config/load-dot-opencode.test.ts
```

测试范围：

- `.opencode` 不存在。
- 空 `.opencode` 目录。
- `AGENTS.md` 加载。
- Agent Markdown 解析和 upsert。
- Skill 及资源文件加载。
- `.opencode/opencode.json(c)` 中 `mcp` 字段解析。
- Tool 文件加载。
- Command Markdown 解析。
- Plugin 文件加载。
- 重复加载结果一致。
- 同名配置正确 upsert。
- 非法 frontmatter 和 JSON 被跳过。
- 路径穿越和 symlink 越界被拒绝。
- 不扫描全局 `.opencode`。
- PG Service 被正确调用。
- MCP、Plugin、Tool 在加载阶段不执行。
- 现有全局配置在没有 Session 记录时仍可使用。

## 14. 实施顺序

### 第一阶段：基础加载器

- 新增 `load-dot-opencode.ts`。
- 实现 worktree 下 `.opencode` 定位。
- 实现 Agent、Skill、Command、Plugin 扫描。
- 调用已有 Session Service。
- 增加基础单元测试。

### 第二阶段：新增资源类型

- 加入 `AGENTS.md`。
- 加入 `.opencode/opencode.json(c)` 中 `mcp` 字段解析。
- 加入 Tool 文件加载。
- 完善统一诊断结果。

### 第三阶段：接入 Session 生命周期

- 接入 Session 创建和恢复。
- 接入 prompt 前加载。
- 验证 `.opencode > Session PG > global`。

### 第四阶段：后续增强

- 文件删除同步。
- 资源来源字段。
- 文件变更监听。
- 加载版本和 fingerprint。
- 更细粒度的 Plugin、Tool 安全控制。

## 15. 验收标准

满足以下条件即可认为第一版完成：

1. 项目 `.opencode` 下的资源可以被加载到当前 Session 的 PostgreSQL 记录。
2. 所有资源均通过已有 `SessionXxx` Service 写入。
3. 现有 Agent、Skill、MCP、Tool、Command、Plugin 运行时无需改变即可读取资源。
4. 同名资源满足 `.opencode > Session PG > 全局配置`。
5. 重复加载不会产生重复记录。
6. 扫描阶段不会连接 MCP 或执行 Plugin/Tool 代码。
7. `.opencode` 不存在或为空时，不影响现有功能。
8. 解析错误、路径越界和数据库错误有明确处理结果。
