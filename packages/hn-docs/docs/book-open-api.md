# book-v3 MCP 与 Open API

本模块使用 Boss 登录 Token 提供文档目录查询、详情查询、创建、更新、启停、全语言删除和 OSS 资源上传地址生成能力。REST 与 MCP 共用 `BookDocumentService`，不会相互通过 HTTP 调用。

可复制的 REST、OSS、Codex MCP 与 Responses API 示例见 [调用示例](./book-open-call-examples.md)。

## 环境变量

沿用项目现有的 Boss、文档和知识库服务地址配置：

```bash
NEXT_PUBLIC_BOSS_URL=https://boss.example.com
NEXT_PUBLIC_BASE_URL=https://api.example.com
NEXT_PUBLIC_YDDOC_API_URL=https://yddoc-api.example.com
```

Token 只从 `Authorization: Bearer <token>` 读取，不接受 Query 或 Cookie Token。

## 地址

- MCP：`/yddoc/api/mcp`
- MCP 健康检查：`/yddoc/api/mcp/health`
- REST：`/yddoc/api/open/v1`
- OpenAPI 3.1：`/yddoc/api/openapi.json`

国际环境未配置 `/yddoc` basePath，部署地址相应去掉 `/yddoc`。

## REST 接口

- `GET /document-tree?brandCode=&languageCode=`
- `GET /documents/{docUniqueId}?brandCode=&languageCode=&version=effective`
- `POST /documents`
- `PATCH /documents/{docUniqueId}`
- `GET /documents/{docUniqueId}/blocks/{blockId}?brandCode=&languageCode=&version=effective`
- `PATCH /documents/{docUniqueId}/blocks/{blockId}`
- `PUT /documents/{docUniqueId}/enabled`
- `DELETE /documents/{docUniqueId}?brandCode=&languageCode=`
- `POST /resource-upload-sessions`

## MCP 工具

- `list_documents`
- `get_document`
- `create_document`
- `update_document`
- `get_block`
- `update_block`
- `set_document_enabled`
- `delete_document`
- `create_resource_upload`

`delete_document` 标记为 destructive，MCP Host 必须配置审批。REST DELETE 没有 MCP 审批流程，仅执行 Token 校验。

## 一级 block 更新

每个 `doc.content` 一级节点通过 `attrs.blockId` 标识，格式为 `blk_<uuid>`。编辑器在新增、粘贴或读取旧正文时自动为缺失或重复的 ID 补值，生成过程不进入撤销历史。

历史文档在 Open API 读取时会根据品牌、语言、文档和节点位置生成稳定的兼容 ID，但 GET 不写回 OSS。第一次整篇保存或 block 更新时，所有一级 blockId 会随正文持久化。

`update_block` 和对应 REST PATCH 只允许替换同类型一级节点：列表、表格等容器作为一个整体更新，不支持直接寻址内部的 listItem、tableCell。`publishMode=draft` 保存草稿且不更新知识库；`publishMode=publish` 保存发布内容，并使用更新后的完整文档创建知识库 upsert 任务。

## 带资源的新建流程

1. 调用 `create_resource_upload`，保存返回的 `requestId`、`resourcePath`、`ossKey` 和 `uploadUrl`。
2. 调用方使用返回的预签名 URL 执行 PUT；v1 以 PUT 返回 2xx 为上传成功依据，不执行 OSS HEAD。
3. TipTap JSON 使用返回的 `resourcePath` OSS 相对路径。
4. 调用 `create_document` 完成草稿保存或发布；建议沿用相同 `requestId` 便于链路排查。

更新既有文档时，`create_resource_upload` 应传 `docUniqueId`，以目标文档上下文申请 OSS 地址。

新建文档尚无 `docUniqueId` 时，服务端基于 `requestId` 生成数字临时 OSS 上下文；已有文档继续使用 `docUniqueId`。对外返回的仍是调用方原始 `requestId`。

v1 不签发或校验资源票据，也不验证 OSS 对象是否实际存在；仅校验正文资源必须是 book-v3 OSS 相对路径。调用方负责确保 OSS PUT 返回 2xx 后再提交文档。

## 静态资源自动订正

`create_document` 和 `update_document` 在保存正文前自动处理图片、视频、附件、画板预览图以及 `rpaFlow.data-blocks` JSON：

- `data:`：解码、按现有大小和类型规则重新上传，替换为 `resourcePath`。
- `blob:`：返回 `VALIDATION_ERROR`，提示只能由创建 Blob 的浏览器读取并上传。
- `file:`：返回 `VALIDATION_ERROR`，禁止服务端读取调用方或服务器本地文件。
- 完整 HTTP/HTTPS URL：与 `/api/noauth/v1/yddoc/oss/domain` 返回值比较 origin 和路径前缀；相同则去掉域名、Query、Fragment，保留 OSS 相对路径；不同则下载后重新上传。
- 已经是 OSS 相对路径：去掉 Query、Fragment 后直接保留。

外部下载不转发 Boss Token、Cookie 等认证信息；每次 DNS 解析及重定向都会拒绝内网、回环和保留地址。图片最大 20MB，其他资源最大 200MB；单篇文档最多自动重新上传 50 个资源。SVG 图片不自动搬运。

所有环境均对 `winrobot-pub-a.oss-cn-hangzhou.aliyuncs.com` 和 `xybot-oss-1302949341.cos.ap-shanghai.myqcloud.com` 提供受限豁免：仅 HTTPS 且域名精确匹配时，允许解析到 RFC1918 或 `100.64.0.0/10` 地址。回环、链路本地、云元数据、保留地址和 IPv6 内网地址仍然禁止；重定向目标会重新独立校验。

外部图片响应头错误时，如果文件内容可通过魔数明确识别为 PNG、JPEG、GIF 或 WebP，服务端会使用实际图片类型继续搬运；无法识别的内容不会仅凭 URL 文件扩展名作为图片放行。

REST 与 MCP 当前请求体上限均为 3MB，因此 `data:` 仅适合小型资源；较大的图片、视频和附件仍应使用 `create_resource_upload` 直接 PUT OSS，避免 Base64 膨胀请求体。

资源订正中的任一步失败时，不保存或发布正文。由于 v1 没有 OSS 删除接口，失败前已经重新上传成功的资源可能成为孤立对象，后续专项治理。

## 发布完成语义

创建发布文档的内部顺序：

```text
创建菜单 → 禁用 → 上传正文 → 保存发布内容 → 创建知识库同步任务 → 启用
```

只有全部步骤成功才返回 `status: success`。知识库同步以成功创建任务并返回 `taskId` 为完成，不等待后台任务执行结束。

发生部分成功时返回 `PARTIAL_SUCCESS`，其中包含：

- `menuId`
- `docUniqueId`
- `completedStages`
- `failedStage`
- `retryAction`

v1 不自动重试，也不提供严格创建幂等；网络不确定性下可能出现重复文档。

## 验证命令

```bash
pnpm typecheck:book-open
pnpm test:book-open
pnpm build
```
