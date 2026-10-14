import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";
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

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function queryScope(req: NextApiRequest) {
  // v2:languageCode 由知识库自身属性决定,不再透传
  return {
    brandCode: first(req.query.brandCode),
  };
}

function sendSuccess(res: NextApiResponse, data: unknown, requestId?: string) {
  return res
    .status(200)
    .json({ code: 200, message: "success", requestId, data });
}

function sendError(res: NextApiResponse, error: unknown, requestId: string) {
  let normalized: BookOpenError;
  if (error instanceof z.ZodError) {
    normalized = new BookOpenError("VALIDATION_ERROR", "请求参数校验失败", {
      issues: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  } else {
    normalized = asBookOpenError(error);
  }
  return res.status(normalized.status).json({
    code: normalized.code,
    message: normalized.message,
    requestId,
    details: normalized.details,
  });
}

export async function handleOpenRest(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const startedAt = Date.now();
  const correlationId =
    first(req.headers["x-request-id"]) ||
    (typeof crypto !== "undefined" ? crypto.randomUUID() : `${Date.now()}`);
  let route = "unknown";
  let outcome = "success";
  let errorCode: string | undefined;
  try {
    const identity = await authenticateRequest(req);
    const service = new BookDocumentService(identity);
    const segments = (req.query.path as string[] | undefined) ?? [];

    if (
      segments.length === 1 &&
      segments[0] === "document-tree" &&
      req.method === "GET"
    ) {
      route = "GET document-tree";
      const input = DocumentTreeInputSchema.parse(queryScope(req));
      return sendSuccess(
        res,
        await service.listDocuments(input),
        correlationId,
      );
    }

    if (
      segments.length === 1 &&
      segments[0] === "documents" &&
      req.method === "POST"
    ) {
      route = "POST documents";
      const input = CreateDocumentInputSchema.parse({
        ...queryScope(req),
        ...req.body,
        requestId: req.body?.requestId || correlationId,
      });
      return sendSuccess(
        res,
        await service.createDocument(input),
        correlationId,
      );
    }

    if (segments[0] === "documents" && segments[1]) {
      const docUniqueId = segments[1];
      if (segments.length === 4 && segments[2] === "blocks" && segments[3]) {
        const blockId = segments[3];
        if (req.method === "GET") {
          route = "GET document block";
          const input = GetBlockInputSchema.parse({
            ...queryScope(req),
            docUniqueId,
            blockId,
            version: first(req.query.version),
          });
          return sendSuccess(res, await service.getBlock(input), correlationId);
        }
        if (req.method === "PATCH") {
          route = "PATCH document block";
          const input = UpdateBlockInputSchema.parse({
            ...queryScope(req),
            ...req.body,
            docUniqueId,
            blockId,
            requestId: req.body?.requestId || correlationId,
          });
          return sendSuccess(
            res,
            await service.updateBlock(input),
            correlationId,
          );
        }
      }
      if (segments.length === 2 && req.method === "GET") {
        route = "GET document";
        const input = GetDocumentInputSchema.parse({
          ...queryScope(req),
          docUniqueId,
          version: first(req.query.version),
        });
        return sendSuccess(
          res,
          await service.getDocument(input),
          correlationId,
        );
      }
      if (segments.length === 2 && req.method === "PATCH") {
        route = "PATCH document";
        const input = UpdateDocumentInputSchema.parse({
          ...req.body,
          docUniqueId,
          requestId: req.body?.requestId || correlationId,
        });
        return sendSuccess(
          res,
          await service.updateDocument(input),
          correlationId,
        );
      }
      if (
        segments.length === 3 &&
        segments[2] === "enabled" &&
        req.method === "PUT"
      ) {
        route = "PUT document enabled";
        const input = SetDocumentEnabledInputSchema.parse({
          ...queryScope(req),
          ...req.body,
          docUniqueId,
          requestId: req.body?.requestId || correlationId,
        });
        return sendSuccess(
          res,
          await service.setDocumentEnabled(input),
          correlationId,
        );
      }
      if (segments.length === 2 && req.method === "DELETE") {
        route = "DELETE document";
        const input = DeleteDocumentInputSchema.parse({
          ...queryScope(req),
          docUniqueId,
          requestId: correlationId,
        });
        return sendSuccess(
          res,
          await service.deleteDocument(input),
          correlationId,
        );
      }
    }

    if (
      segments.length === 1 &&
      segments[0] === "resource-upload-sessions" &&
      req.method === "POST"
    ) {
      route = "POST resource-upload-sessions";
      const input = CreateResourceUploadInputSchema.parse({
        ...queryScope(req),
        ...req.body,
        requestId: req.body?.requestId || correlationId,
      });
      return sendSuccess(
        res,
        await service.createResourceUpload(input),
        correlationId,
      );
    }

    throw new BookOpenError("NOT_FOUND", "Open API 路由不存在");
  } catch (error) {
    outcome = "error";
    errorCode =
      error instanceof z.ZodError
        ? "VALIDATION_ERROR"
        : asBookOpenError(error).code;
    return sendError(res, error, correlationId);
  } finally {
    console.info(
      JSON.stringify({
        event: "book_open_api_request",
        requestId: correlationId,
        route,
        method: req.method,
        outcome,
        errorCode,
        durationMs: Date.now() - startedAt,
      }),
    );
  }
}
