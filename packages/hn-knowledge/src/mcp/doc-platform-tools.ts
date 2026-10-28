/** 文档平台 MCP 工具：复用 doc-platform OpenDocumentService，不重复实现业务流程。 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { OpenDocumentService } from "../doc-platform/index.js"
import {
  CreateDocumentInputSchema,
  CreateResourceUploadInputSchema,
  DeleteDocumentInputSchema,
  GetBlockInputSchema,
  GetDocumentInputSchema,
  SetDocumentEnabledInputSchema,
  UpdateBlockInputSchema,
  UpdateDocumentInputSchema,
} from "../doc-platform/open/schemas.js"

const KbSchema = z.string().trim().min(1).max(255).describe("知识库 slug 或 ID")
const DocumentTreeInputSchema = z.object({ kb: KbSchema }).strict()

function success(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
  }
}

function failure(error: unknown) {
  const data = {
    code: "DOCUMENT_MCP_ERROR",
    message: error instanceof Error ? error.message : String(error),
  }
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
  }
}

function registerDocumentTool(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: z.ZodObject<any>,
  operation: (
    service: OpenDocumentService,
    input: any,
  ) => Promise<Record<string, unknown>>,
  options: {
    destructive?: boolean
    idempotent?: boolean
    readOnly?: boolean
  } = {},
) {
  server.registerTool(
    name,
    {
      description,
      inputSchema: inputSchema.shape,
      annotations: {
        readOnlyHint: options.readOnly ?? false,
        destructiveHint: options.destructive ?? false,
        idempotentHint: options.idempotent ?? false,
        openWorldHint: false,
      },
    },
    async (input: any) => {
      try {
        return success(await operation(new OpenDocumentService(), input))
      } catch (error) {
        return failure(error)
      }
    },
  )
}

export function registerDocPlatformTools(server: McpServer): void {
  registerDocumentTool(
    server,
    "list_documents",
    "按知识库返回文档目录树（包含禁用项）。",
    DocumentTreeInputSchema,
    (service, input) => service.listDocuments(input),
    { readOnly: true, idempotent: true },
  )
  registerDocumentTool(
    server,
    "get_document",
    "读取文档的 published、draft 或 effective 版本 TipTap JSON。",
    GetDocumentInputSchema,
    (service, input) => service.getDocument(input),
    { readOnly: true, idempotent: true },
  )
  registerDocumentTool(
    server,
    "get_block",
    "按 blockId 读取文档一级 block。",
    GetBlockInputSchema,
    (service, input) => service.getBlock(input),
    { readOnly: true, idempotent: true },
  )
  registerDocumentTool(
    server,
    "create_document",
    "创建文档草稿或发布文档；正文使用 TipTap JSON，发布会创建知识库派生任务。",
    CreateDocumentInputSchema,
    (service, input) => service.createDocument(input),
  )
  registerDocumentTool(
    server,
    "update_document",
    "更新文档名称、目录位置，或保存 TipTap JSON 草稿/发布正文。",
    UpdateDocumentInputSchema,
    (service, input) => service.updateDocument(input),
  )
  registerDocumentTool(
    server,
    "update_block",
    "替换指定文档一级 block；发布时同步创建知识库派生任务。",
    UpdateBlockInputSchema,
    (service, input) => service.updateBlock(input),
  )
  registerDocumentTool(
    server,
    "set_document_enabled",
    "启用或禁用文档，并创建对应的知识库派生任务。",
    SetDocumentEnabledInputSchema,
    (service, input) => service.setDocumentEnabled(input),
  )
  registerDocumentTool(
    server,
    "delete_document",
    "永久删除文档及其知识库派生数据；调用时必须提供与 docUniqueId 完全相同的 confirmDocUniqueId。",
    DeleteDocumentInputSchema,
    (service, input) => {
      if (input.confirmDocUniqueId !== input.docUniqueId) {
        throw new Error("confirmDocUniqueId 必须与 docUniqueId 完全一致")
      }
      return service.deleteDocument(input)
    },
    { destructive: true, idempotent: true },
  )
  registerDocumentTool(
    server,
    "create_resource_upload",
    "为图片、视频、附件或画板资源创建上传会话。",
    CreateResourceUploadInputSchema,
    (service, input) => service.createResourceUpload(input),
    { idempotent: false },
  )
}
