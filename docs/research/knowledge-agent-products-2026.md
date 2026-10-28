# 同类产品扫描（X / 公开讨论）

> 2026-10-26 · 通过 Brave 检索 X 站点内容 · 仅代表公开贴文所述，未逐一验证产品现状

## 和我们的设计高度重合的四类

### 1. 「代码库知识库 + MCP 给编码 Agent 用」

**Greptile — Knowledge Base MCP**

> "Greptile maintains a detailed knowledge base of how every part of your codebase works, as well as a history of past incidents. Starting today coding agents like Codex, Claude can access the Knowledge Base via Greptile's MCP."

对应我们的「通道四：会话能力」——但它是**自动生成**的代码知识（从仓库和事故记录抽取），不是人写的文档。

差异：他们解决"代码怎么工作"，我们解决"业务/产品知识 + 人维护的文档"。

### 2. 「文档站直接生成 MCP / 检索层」

**Mintlify — MCP generator + Mintlify Index**

> "Everything you need to build an MCP server is available in your docs."
> "Mintlify Index: the first publisher-direct search layer for technical knowledge… benchmark against Context7."

**Outline** 社区版 MCP server（把文档上下文拉进其它 AI 工具）。

对应我们的「通道二：API/MCP，一份 manifest 多协议」。Mintlify 已经把"文档站 → 检索层 → Agent"这条路走通并做了基准测试。

差异：他们是**发布即托管**的 SaaS 文档站，没有多租户私有部署、没有 Release 双产物概念、没有"站点版本 vs 索引版本"的显式管理。

### 3. 「企业知识库成为基础设施，权限感知 + MCP」

**Box — Enterprise Knowledge Bases Become Core Infrastructure**

> "Box natively provides… APIs and MCP server with appropriate admin controls, permission aware and auditable governance, Box Hubs as curated domain specific…"
> "Agents become the reasoning layer. Box becomes the source of truth."

这条和我们的判断几乎一致：**一个真相源 + 多个 Agent 作为推理层 + 权限与审计是一等公民**。

差异：Box 是内容协作平台，文档编辑能力成熟，但没有"文档即知识"的编译期（分块/图谱/Wiki）与召回质量治理。

### 4. 「AI 知识层 + 定期体检」

**Shann³ — AI Knowledge Layer**

> "you clip things during the day, they get processed overnight, you wake up to a richer knowledge base. run `/wiki-lint` every week or two to catch contradictions between pages, stale content, orphan pages nobody links to."

这条最接近我提的「知识健康清单」。他们已经把"矛盾 / 陈旧 / 孤儿页"做成例行检查。

差异：他们的体检对象是 wiki 页面结构；我们想做的是**被引用行为驱动**的体检（哪些块被问到、哪些问题答不上）。

## 其它相关信号

- **Cline + AWS Knowledge Base MCP**：把云厂商的 KB 检索包成 IDE 插件——"知识库给 Agent 当基础能力"已是共识。
- **X 官方 Docs MCP**：平台自己把文档做成 MCP（`docs.x.com/tools/mcp`）。
- **Context7**：给编码 Agent 提供"版本精确的库文档"，说明**版本化文档**是刚需（我们的 Release 正好对应）。
- **Amazon Bedrock KB retrieve 的官方 MCP**：检索即服务，配置项（rerank、query config）外露给调用方。
- **Hermes Agent / Hindsight**：GraphRAG 式长期记忆，从会话抽取实体与关系——和我们"会话反向产出知识"方向一致，但他们是全自动记忆，我们是人审草稿。

## 结论：市场已经证明的部分

1. **知识库 → MCP → Agent** 这条路成立，且多家在 2026 年集中推出。
2. **权限感知 + 可审计**是企业侧的入场券（Box 说得最清楚）。
3. **版本化文档**是编码 Agent 的真实痛点（Context7 的存在即是证据）。
4. **知识体检**（矛盾/陈旧/孤儿）已有人做，但停在"页面结构"层。

## 还没有人做透的四件事（我们的机会）

| 空白 | 我们的设计 |
|---|---|
| **发布 = 站点版本 + 索引版本的双产物**，并允许两者差集与独立重试 | Release 模型 |
| **引用落到块级锚点**，且钉住 Release，回答可复现 | `(docId, blockId, release)` |
| **未命中问题 → 维护待办 → 具体块**（不是泛泛的"内容缺口报表"） | Content Gap 回路 |
| **会话既消费又产出**（Agent 写草稿提案，人审后发布） | 通道四 · 反向产出 |

换句话说：**别人做的是"知识库接上 Agent"，我们想做的是"知识库有了版本和闭环"。**

## 提醒

- X 上的产品宣传往往领先实际能力，Greptile / Mintlify 的 MCP 我没有实测。
- 如果要跟进竞品，建议直接读文档而不是贴文：Mintlify Index 的 benchmark、Box 的权限模型、Greptile 的知识抽取范围。
