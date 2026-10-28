import { z } from "zod";

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 200 * 1024 * 1024;

export const BrandCodeSchema = z.string().trim().min(1).max(64);
export const LanguageCodeSchema = z.string().trim().min(1).max(32);
export const DocUniqueIdSchema = z.string().trim().min(1).max(128);
export const MenuIdSchema = z.union([
  z.string().trim().min(1).max(128),
  z.number().int().nonnegative(),
]);
export const RequestIdSchema = z.string().trim().min(1).max(128);
export const PublishModeSchema = z.enum(["draft", "publish"]);
export const BlockIdSchema = z
  .string()
  .trim()
  .regex(/^blk_[0-9a-z-]{12,64}$/i, "blockId 格式无效");

export const TiptapDocumentSchema = z
  .object({
    type: z.literal("doc"),
    content: z.array(z.unknown()).default([]),
  })
  .passthrough();

/**
 * v2 scope:知识库维度(slug 或 id)
 * (v1 的 brandCode/languageCode 随多租户知识库模型废弃)
 */
export const KbRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .describe("知识库 slug 或 id");

export const DocumentScopeSchema = z
  .object({
    kb: KbRefSchema,
  })
  .strict();

export const DocumentTreeInputSchema = DocumentScopeSchema;

export const GetDocumentInputSchema = DocumentScopeSchema.extend({
  docUniqueId: DocUniqueIdSchema,
  version: z.enum(["published", "draft", "effective"]).default("effective"),
}).strict();

export const GetBlockInputSchema = DocumentScopeSchema.extend({
  docUniqueId: DocUniqueIdSchema,
  blockId: BlockIdSchema,
  version: z.enum(["published", "draft", "effective"]).default("effective"),
}).strict();

export const TiptapBlockSchema = z
  .object({
    type: z.string().trim().min(1).max(128),
    attrs: z.record(z.string(), z.unknown()).optional(),
    content: z.array(z.unknown()).optional(),
  })
  .passthrough()
  .refine((block) => block.type !== "doc" && block.type !== "text", {
    message: "一级 block 类型无效",
  });

export const UpdateBlockInputSchema = DocumentScopeSchema.extend({
  docUniqueId: DocUniqueIdSchema,
  blockId: BlockIdSchema,
  block: TiptapBlockSchema,
  publishMode: PublishModeSchema,
  requestId: RequestIdSchema.optional(),
}).strict();

export const CreateDocumentInputSchema = DocumentScopeSchema.extend({
  name: z.string().trim().min(1).max(200),
  parentId: MenuIdSchema.optional(),
  previousId: MenuIdSchema.optional(),
  content: TiptapDocumentSchema,
  publishMode: PublishModeSchema,
  requestId: RequestIdSchema.optional(),
}).strict();

export const UpdateDocumentInputSchema = DocumentScopeSchema.extend({
  docUniqueId: DocUniqueIdSchema,
  name: z.string().trim().min(1).max(200).optional(),
  parentId: MenuIdSchema.optional(),
  previousId: MenuIdSchema.optional(),
  content: TiptapDocumentSchema.optional(),
  publishMode: PublishModeSchema.optional(),
  expectedContentKey: z.string().trim().min(1).max(1024).optional(),
  requestId: RequestIdSchema.optional(),
})
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.name === undefined &&
      value.parentId === undefined &&
      value.previousId === undefined &&
      value.content === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "至少需要提供一个要更新的字段",
      });
    }
    if (value.content !== undefined && value.publishMode === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "更新正文时 publishMode 必填",
      });
    }
    if (value.publishMode !== undefined && value.content === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "指定 publishMode 时 content 必填",
      });
    }
  });

export const SetDocumentEnabledInputSchema = DocumentScopeSchema.extend({
  docUniqueId: DocUniqueIdSchema,
  enabled: z.boolean(),
  requestId: RequestIdSchema.optional(),
}).strict();

export const DeleteDocumentInputSchema = DocumentScopeSchema.extend({
  docUniqueId: DocUniqueIdSchema,
  confirmDocUniqueId: DocUniqueIdSchema.optional(),
  requestId: RequestIdSchema.optional(),
}).strict();

export const ResourceKindSchema = z.enum([
  "image",
  "video",
  "attachment",
  "board",
]);

export const CreateResourceUploadInputSchema = DocumentScopeSchema.extend({
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((name) => {
      const dot = name.lastIndexOf(".");
      const base = dot > 0 ? name.slice(0, dot) : name;
      return /^[\u4e00-\u9fa5a-zA-Z0-9_-]+$/.test(base);
    }, "文件名仅支持中文、英文、数字、下划线和中划线"),
  fileSize: z.number().int().positive().max(MAX_RESOURCE_BYTES),
  contentType: z.string().trim().min(1).max(128),
  resourceKind: ResourceKindSchema,
  docUniqueId: DocUniqueIdSchema.optional(),
  requestId: RequestIdSchema.optional(),
})
  .strict()
  .superRefine((value, ctx) => {
    if (value.resourceKind === "image" && value.fileSize > 20 * 1024 * 1024) {
      ctx.addIssue({ code: "custom", message: "图片大小不能超过 20MB" });
    }
    if (
      value.resourceKind === "image" &&
      !value.contentType.startsWith("image/")
    ) {
      ctx.addIssue({
        code: "custom",
        message: "图片资源的 contentType 必须为 image/*",
      });
    }
  });

export type DocumentTreeInput = z.infer<typeof DocumentTreeInputSchema>;
export type GetDocumentInput = z.infer<typeof GetDocumentInputSchema>;
export type GetBlockInput = z.infer<typeof GetBlockInputSchema>;
export type UpdateBlockInput = z.infer<typeof UpdateBlockInputSchema>;
export type CreateDocumentInput = z.infer<typeof CreateDocumentInputSchema>;
export type UpdateDocumentInput = z.infer<typeof UpdateDocumentInputSchema>;
export type SetDocumentEnabledInput = z.infer<
  typeof SetDocumentEnabledInputSchema
>;
export type DeleteDocumentInput = z.infer<typeof DeleteDocumentInputSchema>;
export type CreateResourceUploadInput = z.infer<
  typeof CreateResourceUploadInputSchema
>;
export type TiptapDocument = z.infer<typeof TiptapDocumentSchema>;

export { MAX_DOCUMENT_BYTES };
