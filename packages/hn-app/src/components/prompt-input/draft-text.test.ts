import { describe, expect, it } from "vitest"
import { withDraftText } from "./draft-text"
import type { Prompt } from "@/context/prompt"

const image = (id: string): Prompt[number] => ({
  type: "image",
  id,
  filename: `${id}.png`,
  mime: "image/png",
  dataUrl: "data:image/png;base64,AAA",
})

describe("withDraftText", () => {
  it("无 text part 时补上并保留附件", () => {
    const next = withDraftText([image("a")], "看图")
    expect(next).toHaveLength(2)
    expect(next[0]).toMatchObject({ type: "image", id: "a" })
    expect(next[1]).toMatchObject({ type: "text", content: "看图", end: 2 })
  })

  it("已有空 text part 时就地写入（附件不丢）", () => {
    const current: Prompt = [{ type: "text", content: "", start: 0, end: 0 }, image("a")]
    const next = withDraftText(current, "你好世界")
    expect(next).toHaveLength(2)
    expect(next[0]).toMatchObject({ type: "text", content: "你好世界", end: 4 })
    expect(next[1]).toMatchObject({ type: "image", id: "a" })
  })

  it("多附件全部保留且顺序不变", () => {
    const current: Prompt = [image("a"), image("b"), { type: "text", content: "", start: 0, end: 0 }]
    const next = withDraftText(current, "x")
    expect(next.filter((p) => p.type === "image").map((p) => (p as { id: string }).id)).toEqual(["a", "b"])
  })

  it("多余 text part 置空，避免文本重复", () => {
    const current: Prompt = [
      { type: "text", content: "old", start: 0, end: 3 },
      { type: "text", content: "old2", start: 0, end: 4 },
    ]
    const next = withDraftText(current, "new")
    expect(next[0]).toMatchObject({ content: "new" })
    expect(next[1]).toMatchObject({ content: "" })
  })

  it("空文本（纯图片发送）不破坏附件", () => {
    const next = withDraftText([image("a")], "")
    expect(next.filter((p) => p.type === "image")).toHaveLength(1)
  })
})