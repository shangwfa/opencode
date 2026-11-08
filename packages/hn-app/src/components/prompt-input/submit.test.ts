import { describe, expect, test, vi } from "vitest"
import { sendFollowupDraft } from "./submit"
import { withDraftText } from "./draft-text"

/**
 * 首条消息（首页 → 会话页）复用了 sendFollowupDraft：浏览器准备期间也必须先显示用户消息，
 * 否则用户会看到空对话。这里锁定「先乐观插入、失败回滚」的行为。
 */
function setup(overrides: { fail?: boolean } = {}) {
  const added: Array<{ id: string }> = []
  const removed: Array<{ messageID: string }> = []
  const statuses: string[] = []
  const promptAsync = vi.fn(async () => {
    if (overrides.fail) throw new Error("发送失败")
  })
  const data = {
    optimisticAdd: (input: { message: { id: string } }) => added.push({ id: input.message.id }),
    optimisticRemove: (input: { messageID: string }) => removed.push({ messageID: input.messageID }),
    setSessionStatus: (_sid: string, status: { type: string }) => statuses.push(status.type),
  }
  return { added, removed, statuses, promptAsync, data }
}

const draft = {
  sessionID: "ses_1",
  sessionDirectory: "",
  prompt: withDraftText([], "访问影刀社区"),
  context: [],
  agent: "build",
  model: { providerID: "Yd-DeepSeek", modelID: "deepseek-v4-1-flash-261017" },
}

describe("sendFollowupDraft 先显示消息再发送", () => {
  test("发送前已乐观插入用户消息，并置为忙碌", async () => {
    const s = setup()
    let addedBeforeSend = false
    s.promptAsync.mockImplementation(async () => {
      addedBeforeSend = s.added.length === 1
    })
    const ok = await sendFollowupDraft({
      client: { promptAsync: s.promptAsync, command: vi.fn() },
      data: s.data,
      draft,
      optimisticBusy: true,
    })
    expect(ok).toBe(true)
    expect(addedBeforeSend).toBe(true)
    expect(s.added).toHaveLength(1)
    expect(s.statuses[0]).toBe("busy")
  })

  test("发送失败时回滚乐观消息并恢复空闲", async () => {
    const s = setup({ fail: true })
    await expect(
      sendFollowupDraft({
        client: { promptAsync: s.promptAsync, command: vi.fn() },
        data: s.data,
        draft,
        optimisticBusy: true,
      }),
    ).rejects.toThrow("发送失败")
    expect(s.removed).toHaveLength(1)
    expect(s.removed[0]?.messageID).toBe(s.added[0]?.id)
    expect(s.statuses.at(-1)).toBe("idle")
  })
})
