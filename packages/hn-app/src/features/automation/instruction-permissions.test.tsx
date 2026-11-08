import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { InstructionPermissions } from "./instruction-permissions"
import { baseFetch } from "@/lib/base-api"

vi.mock("@/lib/base-api", () => ({ baseFetch: vi.fn() }))
let root: ReturnType<typeof createRoot> | undefined
let element: HTMLDivElement | undefined
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  element?.remove()
  vi.clearAllMocks()
})

it("展示具体操作与目标，由用户逐项仅本次批准；不自动授权", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.mocked(baseFetch).mockResolvedValueOnce({ data: [{ id: "per_1", action: "edit", resources: ["output/report.json"] }] })
    .mockResolvedValueOnce({ replied: true })
  element = document.createElement("div")
  document.body.append(element)
  root = createRoot(element)
  await act(async () => root?.render(<InstructionPermissions sessionId="ses_1" active />))
  expect(element.textContent).toContain("edit")
  expect(element.textContent).toContain("output/report.json")
  expect(baseFetch).toHaveBeenCalledTimes(1)
  await act(async () => [...element!.querySelectorAll("button")].find((b) => b.textContent === "仅本次允许")?.click())
  expect(baseFetch).toHaveBeenCalledWith("/api/sessions/ses_1/permissions/per_1/reply", {
    method: "POST", body: JSON.stringify({ decision: "once" }),
  })
  expect(element.textContent).not.toContain("output/report.json")
})
