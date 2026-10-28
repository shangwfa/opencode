import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Hono } from "hono"
import { GraphBrowseNotFoundError } from "../src/graph/pg-adapter/browse.js"

const calls = {
  relations: mock(async (input: unknown) => ({ input })), subgraph: mock(async (input: unknown) => ({ input })),
  neighborhood: mock(async (input: unknown) => ({ input })), paths: mock(async (input: unknown) => ({ input })),
  provenance: mock(async (input: unknown) => ({ input })), relationTypes: mock(async (input: unknown) => ({ input })),
}
const getService = mock(async () => calls)
mock.module("../src/graph/browse-services.js", () => ({ getGraphBrowseService: getService }))
const { graphBrowseRoutes } = await import("../src/graph/routes/browse.js")
const app = new Hono().route("/api/graph", graphBrowseRoutes)
const sourceId = "11111111-1111-4111-8111-111111111111"
const targetId = "22222222-2222-4222-8222-222222222222"
const scope = { knowledgeBaseId: "kb-a" }
beforeEach(() => { mock.clearAllMocks() })

describe("Graph relation HTTP contracts", () => {
  const post = (path: string, body: unknown) => app.request(`/api/graph/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })
  test("requires KB and validates UUID before initialization", async () => {
    expect((await app.request(`/api/graph/nodes/${sourceId}/relations`)).status).toBe(400)
    expect((await app.request("/api/graph/nodes/not-a-uuid/relations?knowledgeBaseId=kb-a")).status).toBe(400)
    expect(getService).not.toHaveBeenCalled()
  })
  test("parses direction, relation filter and pagination", async () => {
    const response = await app.request(`/api/graph/nodes/${sourceId}/relations?knowledgeBaseId=kb-a&direction=incoming&relationTypes=uses,contains&limit=2&offset=3`)
    expect(response.status).toBe(200)
    expect(calls.relations).toHaveBeenCalledWith({ ...scope, nodeId: sourceId, direction: "incoming", relationTypes: ["uses", "contains"], limit: 2, offset: 3 })
  })
  test("rejects oversized limits and unknown options", async () => {
    expect((await app.request(`/api/graph/nodes/${sourceId}/relations?knowledgeBaseId=kb-a&limit=201`)).status).toBe(400)
    expect((await app.request(`/api/graph/nodes/${sourceId}/relations?knowledgeBaseId=kb-a&sql=select`)).status).toBe(400)
    expect(getService).not.toHaveBeenCalled()
  })
  for (const [path, body, call] of [
    ["subgraph", { ...scope, nodeTypes: ["service"], attributes: { active: true }, nodeSetLabel: "backend", documentId: "doc-a" }, calls.subgraph],
    ["neighborhood", { ...scope, seedIds: [sourceId], direction: "outgoing", maxDepth: 2 }, calls.neighborhood],
    ["paths", { ...scope, sourceId, targetId, maxDepth: 3 }, calls.paths],
    ["edges/provenance", { ...scope, sourceId, targetId, relationshipName: "uses" }, calls.provenance],
  ] as const) {
    test(`${path} delegates valid input`, async () => {
      const response = await post(path, body)
      expect(response.status).toBe(200)
      expect((await response.json() as any).success).toBe(true)
      expect(call).toHaveBeenCalledTimes(1)
      expect((call.mock.calls[0]![0] as any).knowledgeBaseId).toBe("kb-a")
    })
    test(`${path} rejects missing scope`, async () => {
      const { knowledgeBaseId: _, ...missing } = body
      expect((await post(path, missing)).status).toBe(400)
      expect(getService).not.toHaveBeenCalled()
    })
  }
  test("rejects invalid JSON, empty seeds, nested attributes and excessive depth", async () => {
    expect((await app.request("/api/graph/subgraph", { method: "POST", headers: { "content-type": "application/json" }, body: "{" })).status).toBe(400)
    expect((await post("neighborhood", { ...scope, seedIds: [] })).status).toBe(400)
    expect((await post("paths", { ...scope, sourceId, targetId, maxDepth: 5 })).status).toBe(400)
    expect((await post("subgraph", { ...scope, attributes: { unsafe: { $gt: 1 } } })).status).toBe(400)
    expect(getService).not.toHaveBeenCalled()
  })
  test("relation type pagination requires scope", async () => {
    expect((await app.request("/api/graph/relation-types")).status).toBe(400)
    expect((await app.request("/api/graph/relation-types?knowledgeBaseId=kb-a&limit=2")).status).toBe(200)
    expect(calls.relationTypes).toHaveBeenCalledWith({ ...scope, limit: 2, offset: 0 })
  })
  test("maps scoped not-found to 404 and does not expose SQL errors", async () => {
    calls.relations.mockRejectedValueOnce(new GraphBrowseNotFoundError("节点或关系不存在于指定知识库"))
    expect((await app.request(`/api/graph/nodes/${sourceId}/relations?knowledgeBaseId=kb-a`)).status).toBe(404)
    const log = spyOn(console, "error").mockImplementation(() => {})
    try {
      calls.relations.mockRejectedValueOnce(new Error("private database query"))
      const response = await app.request(`/api/graph/nodes/${sourceId}/relations?knowledgeBaseId=kb-a`)
      expect(response.status).toBe(500)
      expect(await response.text()).not.toContain("private database query")
      expect(log).toHaveBeenCalledTimes(1)
    } finally { log.mockRestore() }
  })
})
