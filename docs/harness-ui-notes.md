# Harness 配置交互

## 参考依据

2026-10-20 核对以下官方文档，参考配置流程，不视为对这些产品当前界面的截图复刻：

- [Claude Code Subagents](https://code.claude.com/docs/en/sub-agents)：角色职责、主提示词、角色边界；用于 Agent 的职责与提示词分层。
- [Claude Code Skills](https://code.claude.com/docs/en/skills)：描述使用场景，正文保存执行步骤；用于 Skills 的“何时使用”与正文分离。
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)：区分远程 HTTP 与本地 stdio；用于显式选择连接方式。
- [Cursor MCP](https://cursor.com/docs/context/mcp)：启动程序、参数、环境变量及认证头；用于结构化连接表单。

## 本产品取舍

- 只显示 Agent、MCP、Skills、Commands 四类，已有其他配置不删除。
- 常用字段使用表单，高级原生字段折叠；编辑时保留既有高级字段。
- MCP 启动参数每行一项，不解析 shell；认证值遮罩输入，加密存储沿用现有接口。
- Commands 使用命令名称、描述、提示词和可选 Agent，不要求用户先学习 JSON。
- Agent、Skills、Commands 空状态提供可编辑示例，不自动保存或执行。
- 有配置时提供名称和描述搜索；关闭脏表单需确认放弃，刷新触发浏览器离开提醒。
- 应用模板保存不等于连接成功，不伪造 MCP 在线状态；仅新需求生效。
- 不增加市场、OAuth、真实连接测试或旧协议兼容；这些能力需要独立后端契约。
