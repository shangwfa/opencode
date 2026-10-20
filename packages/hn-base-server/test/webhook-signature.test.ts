import { describe, expect, it } from "bun:test"
import { createHmac } from "node:crypto"
import { safeEqual, verifyGitHub } from "../src/routes/git-webhook.js"

const SECRET = "glpat-webhook-secret"
const body = JSON.stringify({ action: "closed" })
const sign = (payload: string, secret = SECRET) =>
  "sha256=" + createHmac("sha256", secret).update(payload, "utf8").digest("hex")

describe("webhook/GitHub HMAC", () => {
  it("正确签名通过", () => {
    expect(verifyGitHub(sign(body), body, SECRET)).toBe(true)
  })

  it("错误 secret 被拒", () => {
    expect(verifyGitHub(sign(body, "other"), body, SECRET)).toBe(false)
  })

  it("篡改 body 被拒", () => {
    expect(verifyGitHub(sign(body), body + "x", SECRET)).toBe(false)
  })

  it("缺少 sha256= 前缀被拒", () => {
    expect(verifyGitHub(sign(body).slice(7), body, SECRET)).toBe(false)
  })

  it("空签名被拒", () => {
    expect(verifyGitHub(undefined, body, SECRET)).toBe(false)
  })
})

describe("webhook/safeEqual", () => {
  it("相同字符串为 true", () => {
    expect(safeEqual("abc", "abc")).toBe(true)
  })

  it("长度不同为 false（不抛错）", () => {
    expect(safeEqual("abc", "abcd")).toBe(false)
  })

  it("内容不同为 false", () => {
    expect(safeEqual("abc", "abd")).toBe(false)
  })
})
