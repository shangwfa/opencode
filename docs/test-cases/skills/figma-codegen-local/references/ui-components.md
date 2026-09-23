# AST `type` → `@xybot/ui` 映射表

本文档定义 **`processed.ast` 节点 `type`** 与 **`@xybot/ui` 导出** 的对应关系；表体（组件名、引入路径、用法摘要）见下文各分组。**具体 props、默认值、与 antd 的差异一律以 CLI 输出为准，禁止臆测。**

## 生码前（在已安装 `@xybot/ui` 的目标项目根）

| 步骤 | 命令 | 用途 |
| --- | --- | --- |
| 核对名称 | `xybotui list --json` | 与表内「组件名」、包内实际导出对齐 |
| 查 API | `xybotui info <组件名> --json` | props、类型、文档摘要 |
| 查写法 | `xybotui demo <组件名> --json` | 示例源码；单文件时可加 `--file demo1`（或带 `.tsx` 后缀） |

更完整的 CLI 说明与 Agent 操作建议见 **`.cursor/skills/xybotui-llm-context/SKILL.md`**。

## 规则摘要

1. **匹配条件**：仅当节点 **`type` 字符串与下表「组件名」完全一致**时，按该行的「引入」从 `@xybot/ui` 生码。
2. **表与 figmaui 的权威来源**：名称以 **`@xybot/figmaui` 的 `components.json`** 为准；库侧新增导出后，应在本表补一行（或调整 figmaui 映射），并用 **`xybotui list --json`** 二次核对。
3. **无法跑 CLI**：未安装包或环境受限时，可暂按表内「用法摘要」写最小占位，**上线前**仍须对照包内类型或官方文档补全。
4. **`componentDesc`（变体提示）**：当 AST 节点上存在 **`componentDesc`** 时，表示 figmaui 已从 Figma **`components[componentId].name`** 取出的**变体描述**（常见为 `类型=…, 规格=…, 状态=…` 等 `键=值` 逗号分隔），对应稿里该组件实例的变体组合。**生码流程**：先读 `componentDesc` 理解语义 → 再查 **`xybotui info <组件名> --json`** 找到真实 **props 名与枚举** → 将「键=值」逐项映射到 props（例如「类型=面性基础」→ `type`/`variant` 等，**以 `info` 类型为准**）。**禁止**把整段 `componentDesc` 当作合法属性名或未校验的枚举字面量；若稿里还有冗长的 **`componentProperties`**，可**优先以 `type` + `componentDesc` + `xybotui info` 为准**。
5. **`componentDesc` 与「规格 / 尺寸」中文 → 常见码值**（`@xybot/ui` 若使用 `size` 或类似枚举，**仍以 `xybotui info` 的合法取值为准**；下表为 **Figma 中文习惯与 T 恤尺寸的启发式对应**，用于从描述里猜 props，猜错时以包内类型为准）：

| 稿面常见字样（`componentDesc` / 变体名片段） | 常见码值（示意） |
| --- | --- |
| 特小 | `xs` |
| 小 | `sm` |
| 大 | `lg` |
| 特大 | `xl` |
| 特特大 | `xxl` |

- 若出现 **「中等」「默认」「常规」** 等，多为 **`md`** 或组件 **default**，须用 **`xybotui info`** 确认是 `size="md"` 还是省略 `size`。
- 若描述为 **「规格=特大36」** 这类 **「语义 + 数字」**，数字多为 Figma 帧高提示；**码值优先取语义档（特大 → `xl`）**，数字是否写入样式以组件 API 为准。

## 与 `processed.requiredMark`

MCP 返回的 **`processed.requiredMark`** 由 figmaui 按 AST 汇总（如是否需 **`@xybot/ui`**）。下表中 **无 `UI` 前缀** 的 `type`（例如 `AvatarGroup`）若出现在 AST 中，仍**按本表**做映射与引入；若 `requiredMark` 未单独提示而稿中确有此类节点，生码前请**人工确认**目标项目已安装 **`@xybot/ui`** 且版本与 CLI/`package.json` 一致。

下方可按设计系统分组追加表格列：**组件名**、**引入**、**用法摘要**。
