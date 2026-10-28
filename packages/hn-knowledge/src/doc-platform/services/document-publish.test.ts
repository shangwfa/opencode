import { beforeEach, expect, mock, test } from "bun:test"

let events: string[] = []
let failEnqueue = false
const row = { id: "doc-1", knowledgeBaseId: "kb-1", status: "draft", content: "old", draftContentJson: { type: "doc" } }
const store = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }),
  update: () => ({ set: (patch: object) => ({ where: () => ({ returning: async () => {
    events.push("persist")
    return [{ ...row, ...patch }]
  } }) }) }),
  transaction: async (run: (tx: unknown) => Promise<unknown>) => {
    const result = await run(store)
    events.push("commit")
    return result
  },
}
mock.module("../../db/index.js", () => ({ db: store, documents: {}, knowledgeBases: {}, menus: {} }))
mock.module("./sync-worker.service.js", () => ({ syncWorkerService: {
  enqueueDocumentSync: async () => {
    events.push("enqueue")
    if (failEnqueue) throw new Error("queue unavailable")
  },
  wake: () => { events.push("wake") },
} }))
const { DocumentService } = await import("./document.service.js")
const service = new DocumentService()
beforeEach(() => { events = []; failEnqueue = false })

test("正文和派生任务先在事务中保存，提交后才启动 worker，并清除已发布草稿", async () => {
  const doc = await service.publish("kb-1", "doc-1", { contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "new" }] }] } })
  expect(events).toEqual(["persist", "enqueue", "commit", "wake"])
  expect(doc.draftContentJson).toBeNull()
})

test("任务入队失败不启动 worker", async () => {
  failEnqueue = true
  await expect(service.publish("kb-1", "doc-1", { contentJson: { type: "doc" }, plainTextContent: "new" })).rejects.toThrow("queue unavailable")
  expect(events).not.toContain("wake")
  expect(events).not.toContain("commit")
})
