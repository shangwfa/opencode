/** 模型/执行错误必须可见，不能把失败表现成一轮空回复。 */
export function sessionErrorText(error: unknown): string {
  if (typeof error === "string") return error
  if (!error || typeof error !== "object") return "执行失败，请重试或切换模型。"
  const message = "message" in error && typeof error.message === "string" ? error.message : "执行失败，请重试或切换模型。"
  if ("status" in error && error.status === 403 && message.includes("free models") && message.includes("IP address")) {
    return "当前免费模型被上游拒绝（HTTP 403，出口 IP 受限）。请切换其他模型后重新发送。"
  }
  return message
}
