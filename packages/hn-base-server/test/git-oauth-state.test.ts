import { describe, expect, test } from "bun:test"
import { signState, verifyState } from "../src/lib/git/oauth.js"

describe("重新授权上下文", () => {
  const state = {
    userId: "user_owner", provider: "github" as const,
    baseUrl: "https://github.com", scope: "write" as const,
    displayName: "GitHub", instanceId: "gp_existing", exp: Date.now() + 60_000,
  }

  test("签名保留原连接 ID，回调可以原位更新", () => {
    expect(verifyState(signState(state))).toEqual(state)
  })

  test("不能通过篡改 state 替换要更新的连接", () => {
    const signed = signState(state)
    const [, signature] = signed.split(".")
    const forged = Buffer.from(JSON.stringify({ ...state, instanceId: "gp_other" })).toString("base64url")
    expect(verifyState(`${forged}.${signature}`)).toBeUndefined()
  })

  test("过期重新授权请求不生效", () => {
    expect(verifyState(signState(state), state.exp)).toBeUndefined()
  })
})
