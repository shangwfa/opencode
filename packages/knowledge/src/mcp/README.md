# kb-document-search MCP Server

影刀文档知识库检索的 MCP 服务（迁移自源工程 `mastra/mcp/kb-document-search-server.ts`，
基于 `@modelcontextprotocol/sdk`，无 mastra 依赖）。检索逻辑复用
`src/tools/multi-kb-document-search-tool.ts`。

## 工具

| 名称 | 描述 |
| --- | --- |
| `search_yddoc_documents` | 搜索 YYDoc 知识库并返回文档片段、来源元数据和媒体 URL；可按调用请求动态指定知识库与返回字段 |

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
