# Knowledge MCP Server

提供文档知识库检索及文档平台管理工具，基于 `@modelcontextprotocol/sdk`。
文档 CRUD 复用 `doc-platform` 的 `OpenDocumentService`，MCP 层只做参数校验、响应适配和删除确认。

## 工具

| 名称 | 描述 |
| --- | --- |
| `search_yddoc_documents` | 搜索 YYDoc 知识库并返回文档片段、来源元数据和媒体 URL；可按调用请求动态指定知识库与返回字段 |
| `list_documents` | 查询知识库文档目录树 |
| `get_document` | 获取文档 published/draft/effective 版本 |
| `get_block` | 按 blockId 获取一级内容块 |
| `create_document` | 创建草稿或发布文档 |
| `update_document` | 更新元数据或正文 |
| `update_block` | 更新一级内容块 |
| `set_document_enabled` | 启用或禁用文档 |
| `delete_document` | 删除文档；必须显式确认 `confirmDocUniqueId` |
| `create_resource_upload` | 创建图片、视频、附件或画板上传会话 |

文档工具使用 `kb`（知识库 slug 或 ID）作为作用域。当前阶段不校验用户身份；知识库 Open API 的权限策略由 `OpenDocumentService` 统一执行。

入参：`query`（必填）、`topK`、`knowledgeBaseIds`、`knowledgeBaseNames`、`outputOptions`
（`includeRetrievalDebug` / `includeMetadata` / `metadataFields` / `includeMedia` / `includeText`）。
默认知识库可用环境变量覆盖（见 `src/config/env.ts`）：
`MCP_KB_DOCUMENT_SEARCH_DEFAULT_KB_IDS` / `MCP_KB_DOCUMENT_SEARCH_DEFAULT_KB_NAMES`（CSV，单次调用传参优先）。

## 接入方式

### stdio（命令行）

```jsonc
// MCP 客户端配置（如 Claude Desktop / opencode mcp 配置）
{
  "mcpServers": {
    "kb-document-search": {
      "command": "bun",
      "args": ["/path/to/packages/knowledge/src/mcp/server.ts"],
      "env": {
        "KNOWLEDGE_DATABASE_URL": "postgresql://user:pass@host:5432/db"
      }
    }
  }
}
```

stdio 模式下 stdout 仅承载 JSON-RPC，进程内 console 输出统一重定向到 stderr。

### HTTP（Streamable HTTP，stateless）

随知识库服务挂载（`src/app.ts` 已内置），路径 `/mcp/kb-document-search`：

```bash
# initialize
curl -X POST http://localhost:3000/mcp/kb-document-search \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"demo","version":"1.0.0"}}}'
```

- stateless 模式：每个 POST 独立处理，无 `mcp-session-id`，适配多副本部署；
- 响应为普通 JSON（`enableJsonResponse`），GET/DELETE 返回 405（Allow: POST）。

## 环境变量

见 `src/config/env.ts` 顶部注释。服务依赖 PG（`KNOWLEDGE_DATABASE_URL`，回退
`DATABASE_URL` / `OPENCODE_DATABASE_URL`）；调试日志开关 `DOCUMENT_SEARCH_DEBUG=true`。

## 测试

```bash
bun test --isolate src/mcp   # InMemoryTransport 直连 + hono handler 直调，不依赖真实 PG
```
