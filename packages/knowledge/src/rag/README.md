# Base Knowledge API

本模块与现有 `/knowledge-base/**`、`documents` 和 `kb_*` 向量表隔离。它只读取现有知识库的
embedding 模型配置，不会修改现有知识库或让 Agent 自动检索这里的数据。

api：
测试：https://test-yddoc.yingdao.com
生产：https://yddoc.yingdao.com

## 文档写入

TipTap 编辑器文档应直接提交 JSON 对象：

```http
POST /api/base-knowledge/:knowledgeBaseId/documents
Content-Type: application/json
```

其中 `:knowledgeBaseId` 是必填的路径参数。例如知识库 ID 为 `kb-001` 时，实际请求地址为：

```http
POST /api/base-knowledge/kb-001/documents
```

```json
{
  "documentId": "doc-001",
  "type": "tiptap",
  "content": {
    "type": "doc",
    "content": [
      {
        "type": "paragraph",
        "content": [{ "type": "text", "text": "文档内容" }]
      }
    ]
  }
}
```

服务会保留原始 TipTap JSON，并将其转换成 Markdown 后分块、生成 embedding。接口同步等待向量化；
同一知识库内重复创建相同 `documentId` 返回 `409`。

`knowledgeBaseId` 不要求预先存在于旧的 `knowledge_bases` 表。首次写入时会自动创建独立的
`base_knowledge_spaces` 记录和 `bk_<hash>` 向量表；如果旧知识库存在则复用其 embedding 模型，
否则使用默认的 `openai/text-embedding-3-small`。不会向旧 `knowledge_bases` 写入数据。

更新接口：

```http
PUT /api/base-knowledge/:knowledgeBaseId/documents/:documentId
```

`type` 可省略，此时沿用已存类型。相同内容的 PUT 直接返回当前版本，不重复向量化。

## 删除

```http
DELETE /api/base-knowledge/:knowledgeBaseId/documents/:documentId
DELETE /api/base-knowledge/:knowledgeBaseId
```

第一个接口删除指定文档及其向量；如果它是该知识库的最后一篇文档，还会自动删除对应的
`base_knowledge_spaces` 记录和空的 `bk_<hash>` 向量表。如果仍有其他文档，则保留空间和向量表。

第二个接口只删除 Base Knowledge 命名空间、文档和 `bk_<hash>` 检索表，不会删除现有
`knowledge_bases`、`documents` 或 `kb_*` 表。

## 检索

```http
POST /api/base-knowledge/:knowledgeBaseId/search
```

```json
{
  "query": "如何创建流程",
  "mode": "hybrid",
  "topK": 10,
  "timeoutMs": 5000,
  "failOnPartialTimeout": false,
  "excludeDocumentIds": ["doc-archived"]
}
```

- `mode` 支持 `hybrid`、`keyword`、`vector`，默认 `hybrid`。
- 混合检索使用 RRF 融合关键词和向量结果。
- 一路超时、另一路有结果时默认降级返回；另一路为空或严格模式开启时返回 `504`。
- `excludeDocumentIds` 会在关键词、向量查询和融合结果三个位置过滤。
