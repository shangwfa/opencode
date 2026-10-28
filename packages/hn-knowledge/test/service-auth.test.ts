import { afterAll, beforeEach, expect, test } from "bun:test"
import { Hono } from "hono"
import { requireKnowledgeService } from "../src/middleware/service-auth.js"

const previous = process.env.KNOWLEDGE_SERVICE_TOKEN
const app = new Hono().use("*", requireKnowledgeService).get("/admin", (c) => c.json({ ok: true }))
beforeEach(() => { process.env.KNOWLEDGE_SERVICE_TOKEN = "test-service-token" })
afterAll(() => { if (previous === undefined) delete process.env.KNOWLEDGE_SERVICE_TOKEN; else process.env.KNOWLEDGE_SERVICE_TOKEN = previous })
test("缺少服务凭据时拒绝启动数据面操作", async () => {
  delete process.env.KNOWLEDGE_SERVICE_TOKEN
  expect((await app.request("/admin")).status).toBe(503)
})
test("浏览器用户 token 不能替代服务凭据", async () => {
  expect((await app.request("/admin", { headers: { authorization: "Bearer user-session" } })).status).toBe(401)
})
test("错误及不同字节长度的凭据都被拒绝", async () => {
  for (const token of ["", "wrong", "x".repeat(18)]) {
    expect((await app.request("/admin", { headers: { "x-knowledge-service-token": token } })).status).toBe(401)
  }
})
test("正确服务凭据可访问", async () => {
  expect((await app.request("/admin", { headers: { "x-knowledge-service-token": "test-service-token" } })).status).toBe(200)
})
