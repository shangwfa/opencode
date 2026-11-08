import { expect, it, vi } from "vitest"

vi.mock("./auth", () => ({ authEnabled: true, getStoredToken: () => "test", hnBaseUrl: "http://base" }))
vi.mock("./base-api", () => ({ baseFetchRaw: vi.fn() }))

import { baseFetchRaw } from "./base-api"
import { readSandboxFile } from "./rest"

it("会话文件不存在时报告错误，不回退到其他工作区或误报空文件", async () => {
  vi.mocked(baseFetchRaw).mockResolvedValueOnce(new Response(null, { status: 404 }))
  await expect(readSandboxFile("/workspace/output/report.json", { sessionId: "ses_1" })).rejects.toThrow("文件不存在或已无法访问")
})

it("会话文件确实为空时保留空内容", async () => {
  vi.mocked(baseFetchRaw).mockResolvedValueOnce(Response.json({ type: "text", content: "" }))
  await expect(readSandboxFile("/workspace/empty.txt", { sessionId: "ses_1" })).resolves.toMatchObject({ content: "", binary: false })
})
