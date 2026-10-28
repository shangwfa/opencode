import { createHash, randomUUID } from "node:crypto";
import { BookOpenError } from "./errors";
import type { TiptapDocument } from "./schemas";

export const BLOCK_ID_PATTERN = /^blk_[0-9a-z-]{12,64}$/i;

export interface TiptapBlock {
  type: string;
  attrs?: Record<string, unknown>;
  content?: unknown[];
  [key: string]: unknown;
}

interface MaterializeBlockIdsOptions {
  seed?: string;
}

function cloneDocument(content: TiptapDocument): TiptapDocument {
  return JSON.parse(JSON.stringify(content)) as TiptapDocument;
}

function deterministicBlockId(
  seed: string,
  index: number,
  attempt: number = 0,
): string {
  const hex = createHash("sha256")
    .update(`${seed}:${index}:${attempt}`)
    .digest("hex")
    .slice(0, 32);
  return `blk_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function generatedBlockId(): string {
  return `blk_${randomUUID()}`;
}

function asBlock(value: unknown): TiptapBlock {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BookOpenError(
      "VALIDATION_ERROR",
      "一级 block 必须是 TipTap 节点对象",
    );
  }
  const block = value as TiptapBlock;
  if (!block.type || block.type === "doc" || block.type === "text") {
    throw new BookOpenError("VALIDATION_ERROR", "一级 block 类型无效");
  }
  return block;
}

export function blockIdOf(block: TiptapBlock): string | undefined {
  const blockId = block.attrs?.blockId;
  return typeof blockId === "string" && BLOCK_ID_PATTERN.test(blockId)
    ? blockId
    : undefined;
}

/**
 * 只为 doc.content 的一级节点补 ID。读取历史文档时传 seed 得到稳定 ID；
 * 新建文档时不传 seed，生成可长期持久化的随机 UUID。
 */
export function materializeTopLevelBlockIds(
  content: TiptapDocument,
  options: MaterializeBlockIdsOptions = {},
): TiptapDocument {
  const cloned = cloneDocument(content);
  const usedIds = new Set<string>();
  cloned.content = cloned.content.map((value, index) => {
    const block = asBlock(value);
    const existing = blockIdOf(block);
    let blockId = existing && !usedIds.has(existing) ? existing : "";
    let attempt = 0;
    while (!blockId || usedIds.has(blockId)) {
      blockId = options.seed
        ? deterministicBlockId(options.seed, index, attempt)
        : generatedBlockId();
      attempt += 1;
    }
    usedIds.add(blockId);
    block.attrs = { ...(block.attrs ?? {}), blockId };
    return block;
  });
  return cloned;
}

export function findTopLevelBlock(
  content: TiptapDocument,
  blockId: string,
): { index: number; block: TiptapBlock } {
  const index = content.content.findIndex((value) => {
    const block = asBlock(value);
    return blockIdOf(block) === blockId;
  });
  if (index < 0) {
    throw new BookOpenError("NOT_FOUND", "block 不存在", { blockId });
  }
  return { index, block: asBlock(content.content[index]) };
}

export function replaceTopLevelBlock(
  content: TiptapDocument,
  blockId: string,
  replacement: TiptapBlock,
): { content: TiptapDocument; block: TiptapBlock } {
  const cloned = cloneDocument(content);
  const current = findTopLevelBlock(cloned, blockId);
  const next = asBlock(JSON.parse(JSON.stringify(replacement)) as unknown);
  if (next.type !== current.block.type) {
    throw new BookOpenError(
      "VALIDATION_ERROR",
      "block 更新不允许修改节点类型",
      {
        blockId,
        currentType: current.block.type,
        requestedType: next.type,
      },
    );
  }
  next.attrs = { ...(next.attrs ?? {}), blockId };
  cloned.content[current.index] = next;
  return { content: cloned, block: next };
}
