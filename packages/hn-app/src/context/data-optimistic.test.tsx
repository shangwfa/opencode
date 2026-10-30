import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { DataProvider, useData, type DataContextValue } from "./data"
import { ServerProvider } from "./sdk"

/**
 * 浏览器会话在准备阶段就会写入 shell 消息，服务端消息列表因此非空。
 * 刚发出（尚未落库）的用户消息不能被这次合并覆盖，否则表现为
 * 「发出去的消息先消失、稍后才重新出现」。
 */
it("服务端已有 shell 消息时，未落库的乐观用户消息不会被合并覆盖", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const shell = { id: "msg_shell", sessionID: "ses_pending", role: "assistant", time: { created: 1 } } as never
  const user = { id: "msg_user", sessionID: "ses_pending", role: "user", time: { created: 2 } } as never
  const bridge = {
    subscribe: () => () => {},
    loadMessages: vi.fn(async () => [{ message: shell, parts: [] }]),
  }
  let data: DataContextValue | undefined
  const Probe = () => {
    data = useData()
    return null
  }
  const container = document.createElement("div")
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        <ServerProvider directory="/workspace">
          <DataProvider bridge={bridge as never}>
            <Probe />
          </DataProvider>
        </ServerProvider>,
      ),
    )
    await act(async () => data!.optimisticAdd({ sessionID: "ses_pending", message: user, parts: [] }))
    expect(data!.state.message.ses_pending?.map((item) => item.id)).toEqual(["msg_user"])

    // 服务端此时只返回 shell（用户消息还没落库）
    await act(async () => data!.loadMessages("ses_pending", { force: true }))
    expect(data!.state.message.ses_pending?.map((item) => item.id)).toEqual(["msg_shell", "msg_user"])

    // 服务端回显同 id 后不再重复保留
    bridge.loadMessages.mockResolvedValueOnce([{ message: shell, parts: [] }, { message: user, parts: [] }])
    await act(async () => data!.loadMessages("ses_pending", { force: true }))
    expect(data!.state.message.ses_pending?.map((item) => item.id)).toEqual(["msg_shell", "msg_user"])
  } finally {
    await act(async () => root.unmount())
  }
})
