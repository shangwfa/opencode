export async function parseSSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: unknown) => void | Promise<void>,
) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let last = ""
  let retry = 1000

  const abort = () => {
    void reader.cancel().catch(() => undefined)
  }

  signal.addEventListener("abort", abort)

  try {
    while (!signal.aborted) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined as Uint8Array | undefined }))
      if (chunk.done) break

      buf += decoder.decode(chunk.value, { stream: true })
      buf = buf.replace(/\r\n/g, "\n").replace(/\r/g, "\n")

      const chunks = buf.split("\n\n")
      buf = chunks.pop() ?? ""

      for (const chunk of chunks) {
        const data: string[] = []
        for (const line of chunk.split("\n")) {
          if (line.startsWith("data:")) {
            data.push(line.replace(/^data:\s*/, ""))
            continue
          }
          if (line.startsWith("id:")) {
            last = line.replace(/^id:\s*/, "")
            continue
          }
          if (line.startsWith("retry:")) {
            const parsed = Number.parseInt(line.replace(/^retry:\s*/, ""), 10)
            if (!Number.isNaN(parsed)) retry = parsed
          }
        }

        if (!data.length) continue
        const raw = data.join("\n")
        try {
          await onEvent(JSON.parse(raw))
        } catch {
          await onEvent({
            type: "sse.message",
            properties: {
              data: raw,
              id: last || undefined,
              retry,
            },
          })
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", abort)
    reader.releaseLock()
  }
}
