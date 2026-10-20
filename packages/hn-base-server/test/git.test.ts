/**
 * Git 工具与凭据加密单测。
 */
import { describe, expect, it } from "bun:test"
import { decryptSecret, encryptSecret, maskSecret } from "../src/lib/crypto.js"
import { gitUsername, netrcLine, resolveRepo } from "../src/lib/git/types.js"

describe("resolveRepo", () => {
  it("https URL + .git", () => {
    expect(resolveRepo("https://gitlab.com/group/sub/repo.git")).toEqual({
      host: "gitlab.com",
      path: "group/sub/repo",
    })
  })

  it("scp 形式", () => {
    expect(resolveRepo("git@gitlab.company.com:group/repo.git")).toEqual({
      host: "gitlab.company.com",
      path: "group/repo",
    })
  })

  it("GitLab /-/tree 段", () => {
    expect(resolveRepo("https://gitlab.com/group/repo/-/tree/main")).toEqual({
      host: "gitlab.com",
      path: "group/repo",
    })
  })

  it("GitHub /tree 段", () => {
    expect(resolveRepo("https://github.com/owner/repo/tree/main/src")).toEqual({
      host: "github.com",
      path: "owner/repo",
    })
  })

  it("纯 owner/repo", () => {
    expect(resolveRepo("owner/repo")).toEqual({ host: undefined, path: "owner/repo" })
  })

  it("空串", () => {
    expect(resolveRepo("  ")).toEqual({ path: "" })
  })

  it("尾部斜杠被剥离", () => {
    expect(resolveRepo("https://gitlab.com/group/repo/")).toEqual({
      host: "gitlab.com",
      path: "group/repo",
    })
  })
})

describe("git 凭据约定", () => {
  it("GitHub 用 x-access-token 作为用户名", () => {
    expect(gitUsername("github")).toBe("x-access-token")
  })

  it("GitLab 用 oauth2", () => {
    expect(gitUsername("gitlab")).toBe("oauth2")
  })

  it("netrc 行包含 host/login/password", () => {
    expect(netrcLine("gitlab.com", "oauth2", "tkn")).toBe("machine gitlab.com login oauth2 password tkn")
  })
})

describe("crypto", () => {
  it("加解密往返", () => {
    const secret = "glpat-abcdefghijklmnop"
    const payload = encryptSecret(secret)
    expect(payload).not.toContain(secret)
    expect(decryptSecret(payload)).toBe(secret)
  })

  it("同一明文两次加密密文不同（随机 IV）", () => {
    const a = encryptSecret("token-value-123")
    const b = encryptSecret("token-value-123")
    expect(a).not.toBe(b)
    expect(decryptSecret(a)).toBe("token-value-123")
    expect(decryptSecret(b)).toBe("token-value-123")
  })

  it("篡改密文会解密失败（GCM 完整性）", () => {
    const payload = encryptSecret("token-value-123")
    const parts = payload.split(".")
    const tampered = [parts[0], parts[1], Buffer.from("evil").toString("base64")].join(".")
    expect(() => decryptSecret(tampered)).toThrow()
  })

  it("格式无效时报错", () => {
    expect(() => decryptSecret("not-a-valid-payload")).toThrow("凭据格式无效")
  })

  it("脱敏保留首尾", () => {
    expect(maskSecret("glpat-abcdefghijklmnop")).toBe("glpa…mnop")
    expect(maskSecret("short")).toBe("****")
  })
})
