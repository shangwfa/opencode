# Agent 版 RAG 管道（Session Agent 承担检索问答）

> 定位：RAG 编排（分词 → 检索 → 证据筛选 → 生成）由 **opencode saas 会话内注册的 rag agent** 承担；
> 知识服务只提供基础检索能力。依据 `docs/test-cases/agents/session-agents.md` 的 V2 Session Agents 契约。

## 契约速查（V2）

| 操作 | 路由 | 说明 |
|---|---|---|
| 创建会话 | `POST /api/session` | `{ location, model }` → `{ data: Session }` |
| 创建 rag agent | `POST /api/session/:sid/agents` | body `{ id: "rag", config: { system, description, mode: "primary" } }`（Session Agent 覆盖，`ConfigAgent.Info`） |
| 选择 agent | `POST /api/session/:sid/agent` | body `{ agent: "rag" }` → 204 |
| 提问 | `POST /api/session/:sid/prompt_stream` | SSE，`session.execution.succeeded` 为终态 |
| 收回答 | `GET /api/session/:sid/message?order=asc` | 最后一条 assistant 的 `content[].text` |

注意：`config` 字段以 `ConfigAgent.Info` 为准（system/description/mode/model/permissions 等）；无 V1 的 `prompt`/`temperature`；`steps` 是正整数。

## rag agent 工作流（system prompt 要点）

1. **查询理解**：剥离疑问词，拆 1~3 个核心查询（含同义表述）
2. **检索**：沙箱内 node fetch 调知识服务 `POST /knowledge-base/{kb}/search`（**沙箱内地址 `http://host.docker.internal:18787/api`**，`192.168.215.2` 不可达、沙箱无 curl 用 node fetch）
3. **证据筛选**：只保留真正回答问题的 chunk，不足换词补查
4. **生成**：结论优先、引用《文档名》；证据不足说"资料中未找到"，不编造；末尾列引用

## 实测（2026-10-13，问题"harness 平台的知识库是什么？"）

- 创建 rag agent 200 + 选择 204；执行 35s succeeded；2 次 shell 检索（分词→多查询检索发生）
- 回答：结论优先、逐点引用《能力总览》《数据集能力概览》《使用指南》、末尾列引用——**证据筛选生效**（泛化文档被丢弃）
- agent 自选证据与人工预设目标文档不同（《能力总览》vs《总览》）但答案准确——符合 L3"能回答"判定视角
- 测试台页面 `docs/ui-demos/rag.html` 的 **Agent 自主**模式已集成：创建会话时自动注册并选择 rag agent，时间线展示思考/工具调用

## 与页面 RAG 模式的分工

| | RAG 检索回答（页面编排） | Agent 自主（rag agent 编排） |
|---|---|---|
| 查询理解/分词 | 页面调知识服务（含 `enableQuerySplit`） | Agent LLM 拆解改写 |
| 检索 | 页面直调 search API | Agent 经 shell/node fetch 多轮调用 |
| 证据 | 全部展示（检索证据卡） | Agent 筛选后引用 |
| 特性 | 确定性、可回归、证据全可见 | 智能筛选、可补查、答案导向 |
