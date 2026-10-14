export const bookOpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "book-v3 Document Open API",
    version: "1.1.0",
    description:
      "使用 Boss Bearer Token 管理 book-v3 文档。知识库同步以成功创建任务并返回 taskId 为完成。",
  },
  servers: [{ url: "/yddoc/api/open/v1" }],
  security: [{ bearerAuth: [] }],
  paths: {
    "/document-tree": {
      get: {
        operationId: "listDocuments",
        summary: "查询文档目录树",
        parameters: [
          { $ref: "#/components/parameters/kb" },
          ,
        ],
        responses: { "200": { $ref: "#/components/responses/Success" } },
      },
    },
    "/documents": {
      post: {
        operationId: "createDocument",
        summary: "创建文档并保存草稿或完成发布",
        description:
          "保存前自动订正 data: 和非本平台 OSS 前缀的图片、视频、附件资源；blob:、file: 返回参数错误。",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateDocument" },
            },
          },
        },
        responses: {
          "200": { $ref: "#/components/responses/Success" },
          "422": { $ref: "#/components/responses/Error" },
          "502": { $ref: "#/components/responses/PartialSuccess" },
        },
      },
    },
    "/documents/{docUniqueId}": {
      get: {
        operationId: "getDocument",
        summary: "查询文档详情及 TipTap JSON",
        parameters: [
          { $ref: "#/components/parameters/docUniqueId" },
          { $ref: "#/components/parameters/kb" },
          ,
          {
            name: "version",
            in: "query",
            schema: {
              type: "string",
              enum: ["published", "draft", "effective"],
              default: "effective",
            },
          },
        ],
        responses: { "200": { $ref: "#/components/responses/Success" } },
      },
      patch: {
        operationId: "updateDocument",
        summary: "更新文档元数据或正文",
        description:
          "更新正文前自动订正 data: 和非本平台 OSS 前缀的图片、视频、附件资源；blob:、file: 返回参数错误。",
        parameters: [{ $ref: "#/components/parameters/docUniqueId" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UpdateDocument" },
            },
          },
        },
        responses: {
          "200": { $ref: "#/components/responses/Success" },
          "409": { $ref: "#/components/responses/Error" },
          "422": { $ref: "#/components/responses/Error" },
          "502": { $ref: "#/components/responses/PartialSuccess" },
        },
      },
      delete: {
        operationId: "deleteDocument",
        summary: "删除所有语言版本并创建知识库删除任务",
        parameters: [
          { $ref: "#/components/parameters/docUniqueId" },
          { $ref: "#/components/parameters/kb" },
          ,
        ],
        responses: {
          "200": { $ref: "#/components/responses/Success" },
          "502": { $ref: "#/components/responses/PartialSuccess" },
        },
      },
    },
    "/documents/{docUniqueId}/enabled": {
      put: {
        operationId: "setDocumentEnabled",
        summary: "启用或禁用文档并创建对应知识库任务",
        parameters: [{ $ref: "#/components/parameters/docUniqueId" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SetEnabled" },
            },
          },
        },
        responses: {
          "200": { $ref: "#/components/responses/Success" },
          "502": { $ref: "#/components/responses/PartialSuccess" },
        },
      },
    },
    "/documents/{docUniqueId}/blocks/{blockId}": {
      get: {
        operationId: "getBlock",
        summary: "查询文档一级 block",
        description:
          "历史文档缺少 blockId 时返回稳定的兼容 ID；GET 不会写回正文。",
        parameters: [
          { $ref: "#/components/parameters/docUniqueId" },
          { $ref: "#/components/parameters/blockId" },
          { $ref: "#/components/parameters/kb" },
          ,
          {
            name: "version",
            in: "query",
            schema: {
              type: "string",
              enum: ["published", "draft", "effective"],
              default: "effective",
            },
          },
        ],
        responses: {
          "200": { $ref: "#/components/responses/Success" },
          "404": { $ref: "#/components/responses/Error" },
        },
      },
      patch: {
        operationId: "updateBlock",
        summary: "更新文档一级 block",
        description:
          "仅允许替换同类型的一级 block。draft 保存不更新知识库；publish 保存完整文档并创建知识库 upsert 任务。",
        parameters: [
          { $ref: "#/components/parameters/docUniqueId" },
          { $ref: "#/components/parameters/blockId" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UpdateBlock" },
            },
          },
        },
        responses: {
          "200": { $ref: "#/components/responses/Success" },
          "404": { $ref: "#/components/responses/Error" },
          "422": { $ref: "#/components/responses/Error" },
          "502": { $ref: "#/components/responses/PartialSuccess" },
        },
      },
    },
    "/resource-upload-sessions": {
      post: {
        operationId: "createResourceUpload",
        summary: "获取文档资源的 OSS 预签名 PUT 地址",
        description:
          "v1 以调用方 PUT 返回 2xx 为上传成功依据，不执行服务端 OSS HEAD。",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateResourceUpload" },
            },
          },
        },
        responses: { "200": { $ref: "#/components/responses/Success" } },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "Boss access token",
      },
    },
    parameters: {
      kb: {
        name: "kb",
        in: "query",
        required: true,
        schema: { type: "string" },
      },
      languageCode: {
        name: "languageCode",
        in: "query",
        required: true,
        schema: { type: "string" },
      },
      docUniqueId: {
        name: "docUniqueId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      blockId: {
        name: "blockId",
        in: "path",
        required: true,
        schema: {
          type: "string",
          pattern: "^blk_[0-9A-Za-z-]{12,64}$",
        },
      },
    },
    schemas: {
      TiptapDocument: {
        type: "object",
        required: ["type", "content"],
        properties: {
          type: { const: "doc" },
          content: { type: "array", items: {} },
        },
      },
      Scope: {
        type: "object",
        required: ["kb"],
        properties: {
          kb: { type: "string", description: "知识库 slug 或 id" },
        },
      },
      CreateDocument: {
        allOf: [
          { $ref: "#/components/schemas/Scope" },
          {
            type: "object",
            required: ["name", "content", "publishMode"],
            properties: {
              name: { type: "string", maxLength: 200 },
              parentId: { oneOf: [{ type: "string" }, { type: "integer" }] },
              previousId: { oneOf: [{ type: "string" }, { type: "integer" }] },
              content: { $ref: "#/components/schemas/TiptapDocument" },
              publishMode: { type: "string", enum: ["draft", "publish"] },
              requestId: { type: "string" },
            },
          },
        ],
      },
      UpdateDocument: {
        allOf: [
          { $ref: "#/components/schemas/Scope" },
          {
            type: "object",
            properties: {
              name: { type: "string", maxLength: 200 },
              parentId: {
                oneOf: [{ type: "string" }, { type: "integer" }],
              },
              previousId: {
                oneOf: [{ type: "string" }, { type: "integer" }],
              },
              content: { $ref: "#/components/schemas/TiptapDocument" },
              publishMode: {
                type: "string",
                enum: ["draft", "publish"],
              },
              expectedContentKey: { type: "string" },
              requestId: { type: "string" },
            },
          },
        ],
      },
      TiptapBlock: {
        type: "object",
        required: ["type"],
        properties: {
          type: { type: "string" },
          attrs: { type: "object", additionalProperties: true },
          content: { type: "array", items: {} },
        },
        additionalProperties: true,
      },
      UpdateBlock: {
        allOf: [
          { $ref: "#/components/schemas/Scope" },
          {
            type: "object",
            required: ["block", "publishMode"],
            properties: {
              block: { $ref: "#/components/schemas/TiptapBlock" },
              publishMode: {
                type: "string",
                enum: ["draft", "publish"],
              },
              requestId: { type: "string" },
            },
          },
        ],
      },
      SetEnabled: {
        allOf: [
          { $ref: "#/components/schemas/Scope" },
          {
            type: "object",
            required: ["enabled"],
            properties: {
              enabled: { type: "boolean" },
              requestId: { type: "string" },
            },
          },
        ],
      },
      CreateResourceUpload: {
        allOf: [
          { $ref: "#/components/schemas/Scope" },
          {
            type: "object",
            required: ["fileName", "fileSize", "contentType", "resourceKind"],
            properties: {
              fileName: { type: "string" },
              fileSize: { type: "integer", minimum: 1 },
              contentType: { type: "string" },
              resourceKind: {
                type: "string",
                enum: ["image", "video", "attachment", "board"],
              },
              docUniqueId: { type: "string" },
              requestId: { type: "string" },
            },
          },
        ],
      },
      ApiResponse: {
        type: "object",
        properties: {
          code: { oneOf: [{ type: "integer" }, { type: "string" }] },
          message: { type: "string" },
          requestId: { type: "string" },
          data: {},
          details: { type: "object" },
        },
      },
    },
    responses: {
      Success: {
        description: "操作成功",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiResponse" },
          },
        },
      },
      Error: {
        description: "请求失败",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiResponse" },
          },
        },
      },
      PartialSuccess: {
        description: "部分步骤已成功，返回可继续操作的文档标识",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiResponse" },
          },
        },
      },
    },
  },
} as const;
