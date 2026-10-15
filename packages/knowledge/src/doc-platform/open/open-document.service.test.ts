import { describe, expect, it, mock } from "bun:test"

const knowledgeBase = {
  id: "kb-test-id",
  slug: "kb-test",
  languageCode: "zh-cn",
  settings: {},
}
const tableSymbols = {
  knowledgeBases: { id: {}, slug: {} },
  menus: { id: {}, knowledgeBaseId: {} },
  documents: { id: {}, knowledgeBaseId: {} },
}
const insertValues = mock(async () => undefined)
const updateWhere = mock(async () => undefined)
const enqueueDocumentSync = mock(async () => undefined)

mock.module("../../db/index.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [knowledgeBase] }),
      }),
    }),
    insert: () => ({ values: insertValues }),
    update: () => ({ set: () => ({ where: updateWhere }) }),
  },
  ...tableSymbols,
}))
mock.module("../services/sync-worker.service.js", () => ({
  syncWorkerService: { enqueueDocumentSync },
}))
mock.module("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => conditions,
  eq: (...values: unknown[]) => values,
}))

const { OpenDocumentService } = await import("./open-document.service.js")

describe("OpenDocumentService publish task enqueue", () => {
  it("创建并发布文档只入队一次 RAG 派生任务", async () => {
    enqueueDocumentSync.mockClear()
    insertValues.mockClear()
    updateWhere.mockClear()

    const service = new OpenDocumentService()
    const result = await service.createDocument({
      kb: "kb-test",
      name: "MCP 发布测试",
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "正文" }] }],
      },
      publishMode: "publish",
    })

    expect(enqueueDocumentSync).toHaveBeenCalledTimes(1)
    expect(enqueueDocumentSync).toHaveBeenCalledWith(
      "kb-test-id",
      result.docUniqueId,
      "upsert",
      true,
    )
  })
})
