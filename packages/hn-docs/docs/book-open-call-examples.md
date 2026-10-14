# book-v3 文档 Open API 与 MCP 调用示例

本文中的域名、Token、文档 ID、任务 ID 和 OSS 地址均为示例值。请勿把真实 Token 或预签名上传地址提交到代码仓库。

## 1. 公共变量

国内环境默认包含 `/yddoc`；国际环境没有该前缀。

```bash
export BOOK_BASE_URL="https://book.example.com"
export BOOK_V3_TOKEN="替换为当前用户的 Boss Token"
export BOOK_REST_URL="${BOOK_BASE_URL}/yddoc/api/open/v1"
export BOOK_MCP_URL="${BOOK_BASE_URL}/yddoc/api/mcp"

export BRAND_CODE="demo_brand"
export LANGUAGE_CODE="zh-CN"
```

所有业务请求只接受以下鉴权头：

```http
Authorization: Bearer <Boss Token>
```

Token 不支持通过 Query、Cookie 或请求体传递。

## 2. 健康检查与 OpenAPI 文档

健康检查不需要 Token：

```bash
curl --fail-with-body \
  "${BOOK_BASE_URL}/yddoc/api/mcp/health"
```

获取 OpenAPI 3.1 JSON：

```bash
curl --fail-with-body \
  "${BOOK_BASE_URL}/yddoc/api/openapi.json"
```

## 3. REST Open API

### 3.1 查询文档目录树

```bash
curl --fail-with-body --get \
  -H "Authorization: Bearer ${BOOK_V3_TOKEN}" \
  --data-urlencode "brandCode=${BRAND_CODE}" \
  --data-urlencode "languageCode=${LANGUAGE_CODE}" \
  "${BOOK_REST_URL}/document-tree"
```

### 3.2 查询文档详情

`version` 可选值：

- `effective`：默认值；有草稿时返回草稿，否则返回已发布版本。
- `published`：只返回已发布版本。
- `draft`：只返回草稿；没有草稿时返回 `404`。

```bash
export DOC_UNIQUE_ID="doc_demo_001"

curl --fail-with-body --get \
  -H "Authorization: Bearer ${BOOK_V3_TOKEN}" \
  --data-urlencode "brandCode=${BRAND_CODE}" \
  --data-urlencode "languageCode=${LANGUAGE_CODE}" \
  --data-urlencode "version=effective" \
  "${BOOK_REST_URL}/documents/${DOC_UNIQUE_ID}"
```

成功响应示例：

```json
{
  "code": 200,
  "message": "success",
  "requestId": "req-query-001",
  "data": {
    "brandCode": "demo_brand",
    "languageCode": "zh-CN",
    "menuId": "10001",
    "docUniqueId": "doc_demo_001",
    "name": "接入说明",
    "enabled": true,
    "version": "published",
    "hasDraft": false,
    "contentKey": "book/doc/doc_demo_001.json",
    "content": {
      "type": "doc",
      "content": []
    }
  }
}
```

### 3.3 创建草稿文档

草稿创建成功后默认处于禁用状态，不创建知识库同步任务。

```bash
curl --fail-with-body \
  -X POST \
  -H "Authorization: Bearer ${BOOK_V3_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "X-Request-ID: demo-draft-001" \
  "${BOOK_REST_URL}/documents" \
  -d '{
    "brandCode": "demo_brand",
    "languageCode": "zh-CN",
    "name": "MCP 接入草稿",
    "parentId": 0,
    "previousId": 0,
    "publishMode": "draft",
    "content": {
      "type": "doc",
      "content": [
        {
          "type": "paragraph",
          "content": [
            { "type": "text", "text": "这是一篇草稿文档。" }
          ]
        }
      ]
    }
  }'
```

### 3.4 创建并发布文档

对外只有一次创建调用。服务端会按“创建菜单 → 禁用 → 保存正文 → 创建知识库同步任务 → 启用”执行；所有步骤完成后才返回成功。

```bash
curl --fail-with-body \
  -X POST \
  -H "Authorization: Bearer ${BOOK_V3_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "X-Request-ID: demo-publish-001" \
  "${BOOK_REST_URL}/documents" \
  -d '{
    "brandCode": "demo_brand",
    "languageCode": "zh-CN",
    "name": "MCP 接入说明",
    "parentId": 0,
    "previousId": 0,
    "publishMode": "publish",
    "content": {
      "type": "doc",
      "content": [
        {
          "type": "heading",
          "attrs": { "level": 1 },
          "content": [
            { "type": "text", "text": "MCP 接入说明" }
          ]
        },
        {
          "type": "paragraph",
          "content": [
            { "type": "text", "text": "正文使用 TipTap JSON。" }
          ]
        }
      ]
    }
  }'
```

成功响应示例：

```json
{
  "code": 200,
  "message": "success",
  "requestId": "demo-publish-001",
  "data": {
    "status": "success",
    "requestId": "demo-publish-001",
    "menuId": "10001",
    "docUniqueId": "doc_demo_001",
    "publishStatus": "published",
    "enabled": true,
    "contentKey": "book/doc/doc_demo_001.json",
    "knowledgeSync": {
      "status": "queued",
      "taskId": "task_demo_001"
    }
  }
}
```

`knowledgeSync.status=queued` 且已返回 `taskId` 即表示本次发布流程完成，不等待后台知识库任务真正执行结束。

### 3.5 更新文档

更新正文时，`content` 与 `publishMode` 必须同时传递。`expectedContentKey` 可用于乐观并发控制；服务端发现当前正文 Key 已变化时返回 `409 CONFLICT`。

```bash
curl --fail-with-body \
  -X PATCH \
  -H "Authorization: Bearer ${BOOK_V3_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "X-Request-ID: demo-update-001" \
  "${BOOK_REST_URL}/documents/${DOC_UNIQUE_ID}" \
  -d '{
    "brandCode": "demo_brand",
    "languageCode": "zh-CN",
    "name": "MCP 接入说明（更新版）",
    "publishMode": "publish",
    "expectedContentKey": "book/doc/doc_demo_001.json",
    "content": {
      "type": "doc",
      "content": [
        {
          "type": "paragraph",
          "content": [
            { "type": "text", "text": "这是更新后的正文。" }
          ]
        }
      ]
    }
  }'
```

只修改名称时，不需要传 `content` 和 `publishMode`：

```bash
curl --fail-with-body \
  -X PATCH \
  -H "Authorization: Bearer ${BOOK_V3_TOKEN}" \
  -H "Content-Type: application/json" \
  "${BOOK_REST_URL}/documents/${DOC_UNIQUE_ID}" \
  -d '{
    "brandCode": "demo_brand",
    "languageCode": "zh-CN",
    "name": "新的文档名称"
  }'
```

### 3.6 查询一级 block

先通过查询文档详情取得 `content[].attrs.blockId`，再查询单个 block：

```bash
export BLOCK_ID="blk_550e8400-e29b-41d4-a716-446655440000"

curl --fail-with-body --get \
  -H "Authorization: Bearer ${BOOK_V3_TOKEN}" \
  --data-urlencode "brandCode=${BRAND_CODE}" \
  --data-urlencode "languageCode=${LANGUAGE_CODE}" \
  --data-urlencode "version=published" \
  "${BOOK_REST_URL}/documents/${DOC_UNIQUE_ID}/blocks/${BLOCK_ID}"
```

### 3.7 更新一级 block

只允许替换同类型节点。路径中的 `blockId` 会覆盖请求 block 自带的 `attrs.blockId`。

```bash
curl --fail-with-body \
  -X PATCH \
  -H "Authorization: Bearer ${BOOK_V3_TOKEN}" \
  -H "Content-Type: application/json" \
  "${BOOK_REST_URL}/documents/${DOC_UNIQUE_ID}/blocks/${BLOCK_ID}" \
  -d '{
    "brandCode": "demo_brand",
    "languageCode": "zh-CN",
    "publishMode": "publish",
    "block": {
      "type": "paragraph",
      "content": [
        { "type": "text", "text": "这是更新后的 block 内容。" }
      ]
    }
  }'
```

发布更新会保存完整正文并返回知识库任务；草稿更新传 `publishMode=draft`，不会创建知识库任务。

### 3.8 启用或禁用文档

```bash
curl --fail-with-body \
  -X PUT \
  -H "Authorization: Bearer ${BOOK_V3_TOKEN}" \
  -H "Content-Type: application/json" \
  "${BOOK_REST_URL}/documents/${DOC_UNIQUE_ID}/enabled" \
  -d '{
    "brandCode": "demo_brand",
    "languageCode": "zh-CN",
    "enabled": false
  }'
```

启用时创建知识库 upsert 任务，禁用时创建知识库 delete 任务；成功创建任务并取得 `taskId` 后返回。

### 3.9 删除文档

REST DELETE 会删除该 `docUniqueId` 的全部语言版本，并为每种语言创建知识库删除任务。REST 调用没有 MCP Host 审批环节，但仍会校验 Boss Token 和既有角色权限。

```bash
curl --fail-with-body --get \
  -X DELETE \
  -H "Authorization: Bearer ${BOOK_V3_TOKEN}" \
  --data-urlencode "brandCode=${BRAND_CODE}" \
  --data-urlencode "languageCode=${LANGUAGE_CODE}" \
  "${BOOK_REST_URL}/documents/${DOC_UNIQUE_ID}"
```

## 4. OSS 资源上传后创建文档

正文保存前会自动订正支持的静态资源：`data:` 和非本平台 OSS 前缀的 HTTP/HTTPS 图片、视频、附件会重新上传；本平台完整 OSS URL 会转换为相对路径；`blob:`、`file:` 会返回明确的 `VALIDATION_ERROR`。调用方也可以继续使用以下手动上传流程。

自动订正 `data:` 图片示例：

```json
{
  "type": "image",
  "attrs": {
    "src": "data:image/png;base64,iVBORw0KGgo..."
  }
}
```

保存后 `src` 会被替换为类似 `/yddoc/demo_brand_zh-CN/asset/.../normalized-xxx.png` 的 OSS 相对路径。

`blob:` 和 `file:` 不会创建菜单或保存正文，分别返回：

```json
{
  "code": "VALIDATION_ERROR",
  "message": "blob: 资源仅在创建它的浏览器上下文中有效，服务端无法重新上传",
  "details": { "nodeType": "image", "attribute": "src" }
}
```

```json
{
  "code": "VALIDATION_ERROR",
  "message": "file: 资源指向调用方本地文件，服务端禁止读取，请先上传到 OSS",
  "details": { "nodeType": "video", "attribute": "src" }
}
```

### 4.1 获取预签名上传地址

新建文档尚无 `docUniqueId`，因此先生成一个调用链 `requestId`，且本步骤不要传 `docUniqueId`。

```bash
export RESOURCE_REQUEST_ID="demo-resource-create-001"

curl --fail-with-body \
  -X POST \
  -H "Authorization: Bearer ${BOOK_V3_TOKEN}" \
  -H "Content-Type: application/json" \
  "${BOOK_REST_URL}/resource-upload-sessions" \
  -d '{
    "brandCode": "demo_brand",
    "languageCode": "zh-CN",
    "fileName": "architecture.png",
    "fileSize": 245760,
    "contentType": "image/png",
    "resourceKind": "image",
    "requestId": "demo-resource-create-001"
  }'
```

返回示例：

```json
{
  "code": 200,
  "message": "success",
  "requestId": "demo-resource-create-001",
  "data": {
    "status": "ready",
    "requestId": "demo-resource-create-001",
    "uploadUrl": "https://example-bucket.oss.example.com/...signed-query...",
    "method": "PUT",
    "ossKey": "book/assets/architecture-abc.png",
    "readUrl": "https://cdn.example.com/book/assets/architecture-abc.png",
    "resourcePath": "/book/assets/architecture-abc.png",
    "verification": "client_put_2xx"
  }
}
```

保存返回的 `requestId`、`uploadUrl` 和 `resourcePath`。`uploadUrl` 应在上游预签名地址失效前尽快使用。

### 4.2 直接 PUT 到 OSS

OSS PUT 不携带 Boss Token：

```bash
export UPLOAD_URL="替换为上一步返回的 uploadUrl"

curl --fail-with-body \
  -X PUT \
  --upload-file ./architecture.png \
  "${UPLOAD_URL}"
```

v1 以本次 PUT 返回 2xx 作为上传成功依据，不额外执行服务端 OSS HEAD 校验。不要擅自添加预签名未包含的请求头，否则 OSS 可能判定签名不一致。

### 4.3 使用 OSS 相对路径创建并发布文档

将 `<RESOURCE_PATH>` 替换为第 4.1 步返回的 `resourcePath`，并放入 TipTap 资源节点。建议沿用相同 `requestId` 便于链路排查。

```bash
curl --fail-with-body \
  -X POST \
  -H "Authorization: Bearer ${BOOK_V3_TOKEN}" \
  -H "Content-Type: application/json" \
  "${BOOK_REST_URL}/documents" \
  -d '{
    "brandCode": "demo_brand",
    "languageCode": "zh-CN",
    "name": "带架构图的接入说明",
    "publishMode": "publish",
    "requestId": "demo-resource-create-001",
    "content": {
      "type": "doc",
      "content": [
        {
          "type": "paragraph",
          "content": [
            { "type": "text", "text": "系统架构如下：" }
          ]
        },
        {
          "type": "image",
          "attrs": {
            "src": "<RESOURCE_PATH>",
            "alt": "系统架构图",
            "title": "系统架构图"
          }
        }
      ]
    }
  }'
```

更新已有文档的资源时，第 4.1 步额外传入目标 `docUniqueId`，随后用同一 `docUniqueId` 调用 PATCH。

## 5. Codex 接入 MCP

在 `~/.codex/config.toml` 或项目级 `.codex/config.toml` 中加入：

```toml
[mcp_servers.book_v3]
url = "https://book.example.com/yddoc/api/mcp"
bearer_token_env_var = "BOOK_V3_TOKEN"
default_tools_approval_mode = "writes"
startup_timeout_sec = 20
tool_timeout_sec = 60
enabled = true

[mcp_servers.book_v3.tools.delete_document]
approval_mode = "prompt"
```

启动 Codex 前提供 Boss Token：

```bash
export BOOK_V3_TOKEN="替换为当前用户的 Boss Token"
```

`writes` 会对非只读工具请求审批；`delete_document` 又被明确设为 `prompt`，避免删除操作绕过 Host 审批。可在 Codex 中用 `/mcp` 检查连接状态。

可直接使用以下自然语言调用：

```text
查询 demo_brand 品牌 zh-CN 语言的文档目录树。
```

```text
读取 doc_demo_001 的 effective 版本，并概括正文内容。
```

```text
在 demo_brand / zh-CN 下创建并发布一篇名为“API 接入说明”的文档，正文包含一级标题和一段接入步骤。发布成功后返回 docUniqueId 和知识库 taskId。
```

删除时应明确给出目标 ID：

```text
删除 demo_brand 下 doc_demo_001 的全部语言版本。执行前展示工具参数并请求我的确认；调用 delete_document 时 confirmDocUniqueId 必须填写 doc_demo_001。
```

MCP 删除调用的实际参数结构如下：

```json
{
  "brandCode": "demo_brand",
  "languageCode": "zh-CN",
  "docUniqueId": "doc_demo_001",
  "confirmDocUniqueId": "doc_demo_001",
  "requestId": "demo-delete-001"
}
```

## 6. OpenAI Responses API 转发 Boss Token

以下示例把 book-v3 MCP 作为远程 MCP 工具接入 Responses API。除 `delete_document` 外的工具不要求 OpenAI 审批；删除工具仍会生成 `mcp_approval_request`。

```bash
export OPENAI_API_KEY="替换为 OpenAI API Key"
export OPENAI_MODEL="gpt-5.6"

curl --fail-with-body \
  https://api.openai.com/v1/responses \
  -H "Authorization: Bearer ${OPENAI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"${OPENAI_MODEL}\",
    \"input\": \"查询 demo_brand 品牌 zh-CN 语言的文档目录树\",
    \"tools\": [
      {
        \"type\": \"mcp\",
        \"server_label\": \"book_v3\",
        \"server_description\": \"查询和管理 book-v3 文档\",
        \"server_url\": \"${BOOK_MCP_URL}\",
        \"authorization\": \"${BOOK_V3_TOKEN}\",
        \"require_approval\": {
          \"never\": {
            \"tool_names\": [
              \"list_documents\",
              \"get_document\",
              \"create_document\",
              \"update_document\",
              \"set_document_enabled\",
              \"create_resource_upload\"
            ]
          }
        }
      }
    ]
  }"
```

`authorization` 的值不会被 Responses API 保存，也不会出现在 Response 对象中。初次调用以及后续通过 `previous_response_id` 继续调用时，都必须重新传入 `authorization`。

### 6.1 审批删除调用

当模型准备调用 `delete_document` 时，首次响应会包含类似内容：

```json
{
  "id": "mcpr_demo_001",
  "type": "mcp_approval_request",
  "name": "delete_document",
  "arguments": "{\"brandCode\":\"demo_brand\",\"languageCode\":\"zh-CN\",\"docUniqueId\":\"doc_demo_001\",\"confirmDocUniqueId\":\"doc_demo_001\"}",
  "server_label": "book_v3"
}
```

人工核对参数后，使用首次响应的 `id` 和审批项 `id` 继续请求。续调仍需传入同一个 MCP 工具定义和 Boss Token：

```bash
export PREVIOUS_RESPONSE_ID="resp_demo_001"
export APPROVAL_REQUEST_ID="mcpr_demo_001"

curl --fail-with-body \
  https://api.openai.com/v1/responses \
  -H "Authorization: Bearer ${OPENAI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"${OPENAI_MODEL}\",
    \"previous_response_id\": \"${PREVIOUS_RESPONSE_ID}\",
    \"input\": [
      {
        \"type\": \"mcp_approval_response\",
        \"approve\": true,
        \"approval_request_id\": \"${APPROVAL_REQUEST_ID}\"
      }
    ],
    \"tools\": [
      {
        \"type\": \"mcp\",
        \"server_label\": \"book_v3\",
        \"server_description\": \"查询和管理 book-v3 文档\",
        \"server_url\": \"${BOOK_MCP_URL}\",
        \"authorization\": \"${BOOK_V3_TOKEN}\",
        \"require_approval\": {
          \"never\": {
            \"tool_names\": [
              \"list_documents\",
              \"get_document\",
              \"create_document\",
              \"update_document\",
              \"set_document_enabled\",
              \"create_resource_upload\"
            ]
          }
        }
      }
    ]
  }"
```

如不同意删除，将 `approve` 改为 `false`。

## 7. 错误和部分成功

常见 HTTP 状态：

| HTTP 状态 | `code`             | 含义                                              |
| --------- | ------------------ | ------------------------------------------------- |
| 401       | `UNAUTHORIZED`     | Boss Token 缺失、格式错误或已失效                 |
| 403       | `FORBIDDEN`        | 当前角色没有目标品牌/语言的操作权限               |
| 404       | `NOT_FOUND`        | 文档、草稿或路由不存在                            |
| 409       | `CONFLICT`         | `expectedContentKey` 与当前正文不一致，或状态冲突 |
| 422       | `VALIDATION_ERROR` | 参数、TipTap JSON 或资源路径不合法                |
| 502       | `UPSTREAM_ERROR`   | Boss、OSS 或知识库上游调用失败                    |
| 502       | `PARTIAL_SUCCESS`  | 已完成部分有副作用的步骤，需人工判断后续动作      |

部分成功响应示例：

```json
{
  "code": "PARTIAL_SUCCESS",
  "message": "创建知识库同步任务失败",
  "requestId": "demo-publish-001",
  "details": {
    "status": "partial_success",
    "requestId": "demo-publish-001",
    "menuId": "10001",
    "docUniqueId": "doc_demo_001",
    "completedStages": ["create_menu", "disable_document", "save_content"],
    "failedStage": "knowledge_sync_task",
    "knowledgeTaskIds": [],
    "retryAction": "update_document"
  }
}
```

v1 没有严格创建幂等，也不会自动重试。请求超时或收到 `PARTIAL_SUCCESS` 后，不要直接重复创建；先用返回的 `docUniqueId` 查询当前状态，再决定调用 `update_document` 或人工处理。

## 8. 参考

- [book-v3 MCP 与 Open API 设计说明](./book-open-api.md)
- [OpenAI MCP and Connectors 官方文档](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)
- [Codex MCP 配置官方文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
