# Agent 配置发现与合并（V2）

> 对照官方文档 <https://opencode.ai/v2/docs/agents/> 的 Locations / Formats / Merging / Modes 章节。
> 本文档只覆盖**配置来源**侧的契约；Session 级 CRUD 见 [`session-agents.md`](./session-agents.md)，
> 权限规则见 [`session-agent-permissions.md`](./session-agent-permissions.md)，运行时行为见 [`agent-runtime.md`](./agent-runtime.md)。

## 一、运行环境

脚本会**改写测试容器的 `~/.config/opencode/opencode.jsonc` 与 `agents/` 目录**，因此只允许对可丢弃的隔离容器执行，并在 `finally` 中原样还原。

```bash
source docs/test-cases/test-env.sh 3
export CONTAINER=opencode-saas-test   # 指向以当前源码构建的隔离 SaaS 容器
node docs/test-cases/scripts/config-agents-v2.mjs
```

未设置 `CONTAINER` 时脚本输出 `SKIP` 并以 0 退出；`SKIP` 不得记作通过。

配置目录写入经 100ms debounce 后的 watcher 重建 Agent 注册表，脚本用轮询等待生效，不依赖固定 sleep。

## 二、当前实测的配置加载拓扑

SaaS 模式下沙箱 `/workspace` 与服务端进程的文件系统**不是同一份**，因此 Agent 定义有两个彼此独立的来源：

| 来源 | 路径 | `source` 字段 | 本用例编号 |
|---|---|---|---|
| 服务端全局配置 | 容器内 `~/.config/opencode/agents/*.md`、`opencode.jsonc` 的 `agents` 块 | `global` | T61.1–T61.7 |
| 会话沙箱 | `/workspace/.opencode/agents/*.md` | `sandbox` | T61.13 |

沙箱内的 `opencode.jsonc` 与 `agents/`（无 `.opencode` 前缀）**不参与**配置加载，已实测确认，属能力边界而非缺陷。

## 三、用例

### T61.1–T61.2：全局 `agents` 目录与嵌套 Agent ID

`config-agents-v2.mjs` 写入容器内 `~/.config/opencode/agents/global-plain.md` 与 `agents/team/nested-rev.md`。

| 用例 | 验证点 |
|---|---|
| T61.1.1–T61.1.4 | 全局 `agents/<name>.md` 被发现；`source=global`；Markdown body 成为 system prompt；frontmatter 标量（`color`）生效 |
| T61.2.1–T61.2.2 | 嵌套路径生成的 Agent ID 为 `team/nested-rev`，与文档 `.opencode/agents/team/reviewer.md → team/reviewer` 一致 |

### T61.3：Markdown body 覆盖 frontmatter `system`

文档要求「In a Markdown agent, put this text in the document body instead of a `system` frontmatter field」。
写入同时含 `system: FRONTMATTER_SYSTEM` 与 body `BODY_WINS_SYSTEM` 的文件。

**期望**：有效 system 为 `BODY_WINS_SYSTEM`。

### T61.4：分离的 `model` 与 `variant` 前置键

**期望**：合并为单条模型选择 `{providerID, id, variant}`。

### T61.5：Markdown frontmatter 的嵌套对象

**期望**：`request.headers` 与 `request.body` 嵌套映射被正确解码。

### T61.6–T61.7：JSONC `agents` 块与 request 逐键合并

同一个 Agent 同时由 `opencode.jsonc` 的 `agents` 块和 `agents/<name>.md` 定义，两者都设置 `request.headers`。

| 用例 | 验证点 |
|---|---|
| T61.6.1 | JSONC `agents` 块生效 |
| T61.7.1 | request headers **逐键合并**，非整体替换 |
| T61.7.2 | 同一键冲突时，后加载的 Markdown 定义胜出（全局目录中 `Directory` 条目晚于 `opencode.jsonc` 文件条目） |

### T61.8：全局 `permissions` 与 Agent 规则的相对顺序

全局配置 `permissions: [{shell, "*", ask}]`，同时给 `build` 追加 `{shell, "git status", allow}`。

**期望**：两条规则共存，且 `shell "*"` 在 `shell "git status"` 之前——符合文档「Global `permissions` apply before agent-specific rules」。

### T61.9–T61.12：mode 与 steps 校验

| 用例 | 验证点 |
|---|---|
| T61.9.1 | 新建 Agent 省略 `mode` 时默认 `primary` |
| T61.10.1 | `mode: all` 通过校验并保留 |
| T61.11.1 | 非法 `mode` 返回 400 |
| T61.12.1–T61.12.2 | `steps` 为 0 / 负数 / 小数 / 字符串均返回 400（正整数约束） |

### T61.13：三级来源的字段级覆盖

Session Agent 与沙箱 Markdown 定义同一 ID，各自只声明部分字段。

| 用例 | 验证点 |
|---|---|
| T61.13.1 | 沙箱定义在同 ID 冲突时优先于 Session Agent（`source=sandbox`） |
| T61.13.2 | 沙箱声明的 `system` 覆盖 Session 的取值 |
| T61.13.3 | 沙箱**未声明**的 `color` 保留 Session Agent 的取值——逐字段合并而非整体替换 |

## 四、本轮执行记录

**2026-09-29**：`opencode-saas-test`（端口 14096）+ 本地 PostgreSQL `opencode-v2-up`。**26 项全部通过**（含 2 项清理断言）。

| 脚本 | 结果 | 环境 |
|---|---|---|
| `config-agents-v2.mjs` | 26 PASS / 0 FAIL | 本地隔离容器 |

覆盖矩阵：

| 验收面 | 证据 | 状态 |
|---|---|---|
| 全局 `agents` 目录 Markdown、嵌套 Agent ID | T61.1–T61.2 | 覆盖 |
| Markdown body→system、`model`+`variant`、嵌套 frontmatter | T61.3–T61.5 | 覆盖 |
| JSONC `agents` 块、request 逐键合并 | T61.6–T61.7 | 覆盖 |
| 全局 permissions 与 Agent 规则顺序 | T61.8 | 覆盖 |
| mode 默认值、`all`、非法值 | T61.9–T61.11 | 覆盖 |
| steps 正整数校验 | T61.12 | 覆盖 |
| 沙箱 > Session 的字段级覆盖 | T61.13 | 覆盖 |
| 沙箱内 `opencode.jsonc` / `agents/` 目录 | — | 不适用（沙箱 FS 与配置 FS 分离，已实测） |
| 沙箱 `/workspace` 之外的目录发现 | — | 无接口，见 gap 报告 |

脚本：[`../scripts/config-agents-v2.mjs`](../scripts/config-agents-v2.mjs)。
