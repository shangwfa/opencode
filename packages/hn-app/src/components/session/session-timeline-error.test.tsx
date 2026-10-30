import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it } from "vitest"
import type { Message } from "@/types/opencode"
import { SessionTimeline } from "./session-timeline"

/** 失败轮次可能没有任何 assistant 消息可承载错误，界面必须显式告知用户。 */
it("执行失败且没有 assistant 消息时显示失败原因，而不是一片空白", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const user = { id: "msg_u", sessionID: "ses_1", role: "user", time: { created: 1 } } as Message
  const container = document.createElement("div")
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        <SessionTimeline
          messages={[user]}
          parts={{ msg_u: [{ id: "p1", type: "text", text: "你知道影刀这家公司么" } as never] }}
          working={false}
          executionError={{ type: "unknown", message: "provider.rate-limit" }}
        />,
      ),
    )
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain("执行失败")
    expect(alert?.textContent).toContain("provider.rate-limit")
  } finally {
    await act(async () => root.unmount())
  }
})

it("仍在执行时不显示失败横幅，只保留思考态", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement("div")
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        <SessionTimeline messages={[]} parts={{}} working phaseLabel="思考中" executionError={{ message: "旧错误" }} />,
      ),
    )
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.textContent).toContain("思考中")
  } finally {
    await act(async () => root.unmount())
  }
})
