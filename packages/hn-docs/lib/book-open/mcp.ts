import {
  createMcpHandler,
  McpServer,
  type AuthInfo,
  type McpRequestContext,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { NextApiRequest, NextApiResponse } from "next";
import { authenticateRequest } from "./auth";
import { asBookOpenError, BookOpenError } from "./errors";
import {
  CreateDocumentInputSchema,
  CreateResourceUploadInputSchema,
  DeleteDocumentInputSchema,
  DocumentTreeInputSchema,
  GetBlockInputSchema,
  GetDocumentInputSchema,
  SetDocumentEnabledInputSchema,
  UpdateBlockInputSchema,
  UpdateDocumentInputSchema,
} from "./schemas";
import { BookDocumentService } from "./service-client";
import type { BossIdentity } from "./types";

function identityFromContext(ctx: McpRequestContext): BossIdentity {
  const authInfo = ctx.authInfo;
  if (!authInfo?.token || !authInfo.clientId) {
    throw new BookOpenError("UNAUTHORIZED", "MCP 请求未通过 Boss Token 鉴权");
  }
  return {
    token: authInfo.token,
    userUuid: authInfo.clientId,
    roleCodeList: authInfo.scopes,
  };
}

function successResult(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function errorResult(error: unknown) {
  const normalized = asBookOpenError(error);
  const data = {
    code: normalized.code,
    message: normalized.message,
    details: normalized.details,
  };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

async function runTool<T extends Record<string, unknown>>(
  toolName: string,
  input: Record<string, unknown>,
  operation: () => Promise<T>,
) {
  const startedAt = Date.now();
  let outcome = "success";
  let errorCode: string | undefined;
  try {
    return successResult(await operation());
  } catch (error) {
    outcome = "error";
    errorCode = asBookOpenError(error).code;
    return errorResult(error);
  } finally {
    console.info(
      JSON.stringify({
        event: "book_mcp_tool_call",
        toolName,
        requestId:
          typeof input.requestId === "string" ? input.requestId : undefined,
        outcome,
        errorCode,
        durationMs: Date.now() - startedAt,
      }),
    );
  }
}

function buildServer(ctx: McpRequestContext): McpServer {
  const service = new BookDocumentService(identityFromContext(ctx));
  const server = new McpServer(
    { name: "book-v3-documents", version: "1.1.0" },
    {
      instructions:
        "管理 book-v3 文档。正文仅接受 TipTap JSON。data: 图片、视频和附件会自动重新上传；完整 OSS URL 与平台 OSS 域名及路径前缀一致时转为相对路径，不一致时安全下载后重新上传；blob: 和 file: 会返回明确错误。也可先调用 create_resource_upload 手动上传资源。发布成功表示文档已保存、知识库同步任务已创建并返回 taskId，不等待知识库后台执行完成。创建草稿默认禁用。delete_document 会删除所有语言版本，调用前必须由 MCP Host 获取用户审批。",
    },
  );

  server.registerTool(
    "list_documents",
    {
      title: "查询文档目录树",
      description: "按品牌和语言返回 book-v3 管理端目录树。",
      inputSchema: DocumentTreeInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) =>
      runTool("list_documents", input, () => service.listDocuments(input)),
  );

  server.registerTool(
    "get_document",
    {
      title: "查询文档详情",
      description: "查询 published、draft 或 effective 版本的 TipTap JSON。",
      inputSchema: GetDocumentInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) => runTool("get_document", input, () => service.getDocument(input)),
  );

  server.registerTool(
    "get_block",
    {
      title: "查询文档一级 block",
      description:
        "按 blockId 查询 published、draft 或 effective 版本中的一级 TipTap block。",
      inputSchema: GetBlockInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) => runTool("get_block", input, () => service.getBlock(input)),
  );

  server.registerTool(
    "create_document",
    {
      title: "创建文档",
      description:
        "创建草稿或发布文档。保存前自动订正支持的非标准静态资源。发布仅在正文保存、知识库任务创建且文档启用全部成功后返回 success。",
      inputSchema: CreateDocumentInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (input) =>
      runTool("create_document", input, () => service.createDocument(input)),
  );

  server.registerTool(
    "update_document",
    {
      title: "更新文档",
      description:
        "更新文档元数据，或将 TipTap JSON 订正静态资源后保存为草稿/发布内容。",
      inputSchema: UpdateDocumentInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (input) =>
      runTool("update_document", input, () => service.updateDocument(input)),
  );

  server.registerTool(
    "update_block",
    {
      title: "更新文档一级 block",
      description:
        "仅替换指定一级 block 的内容，不允许改变节点类型。保存草稿时不更新知识库；发布时保存完整文档并创建知识库 upsert 任务。",
      inputSchema: UpdateBlockInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (input) => runTool("update_block", input, () => service.updateBlock(input)),
  );

  server.registerTool(
    "set_document_enabled",
    {
      title: "设置文档启用状态",
      description:
        "启用时创建知识库 upsert 任务；禁用时创建知识库 delete 任务。",
      inputSchema: SetDocumentEnabledInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) =>
      runTool("set_document_enabled", input, () =>
        service.setDocumentEnabled(input),
      ),
  );

  server.registerTool(
    "delete_document",
    {
      title: "删除所有语言版本的文档",
      description:
        "永久删除 docUniqueId 对应的全部语言版本，并为每种语言创建知识库删除任务。必须由 MCP Host 提示用户审批。",
      inputSchema: DeleteDocumentInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) =>
      runTool("delete_document", input, async () => {
        if (input.confirmDocUniqueId !== input.docUniqueId) {
          throw new BookOpenError(
            "VALIDATION_ERROR",
            "confirmDocUniqueId 必须与 docUniqueId 完全一致",
          );
        }
        return service.deleteDocument(input);
      }),
  );

  server.registerTool(
    "create_resource_upload",
    {
      title: "创建资源上传地址",
      description:
        "为图片、视频、附件或画板资源生成 OSS 预签名 PUT 地址和 resourcePath。v1 不执行服务端 HEAD 校验。",
      inputSchema: CreateResourceUploadInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (input) =>
      runTool("create_resource_upload", input, () =>
        service.createResourceUpload(input),
      ),
  );

  return server;
}

const mcpHttpHandler = createMcpHandler(buildServer, {
  legacy: "stateless",
  responseMode: "auto",
  onerror: (error) => {
    console.error(
      JSON.stringify({
        event: "book_mcp_protocol_error",
        message: error.message,
      }),
    );
  },
});

const nodeHandler = toNodeHandler(mcpHttpHandler, {
  onerror: (error) => {
    console.error(
      JSON.stringify({
        event: "book_mcp_adapter_error",
        message: error.message,
      }),
    );
  },
});

export async function handleMcpRequest(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  try {
    const contentLength = Number(req.headers["content-length"] || 0);
    if (contentLength > 3 * 1024 * 1024) {
      return res
        .status(413)
        .json({ code: "PAYLOAD_TOO_LARGE", message: "请求体不能超过 3MB" });
    }
    const identity = await authenticateRequest(req);
    const authInfo: AuthInfo = {
      token: identity.token,
      clientId: identity.userUuid,
      scopes: identity.roleCodeList,
    };
    (req as NextApiRequest & { auth: AuthInfo }).auth = authInfo;
    return nodeHandler(req, res);
  } catch (error) {
    const normalized = asBookOpenError(error);
    if (normalized.code === "UNAUTHORIZED") {
      res.setHeader("WWW-Authenticate", 'Bearer realm="book-v3-mcp"');
    }
    return res.status(normalized.status).json({
      code: normalized.code,
      message: normalized.message,
    });
  }
}
