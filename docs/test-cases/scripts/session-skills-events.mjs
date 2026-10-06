// Tool call IDs live in event.data.id, not the event envelope's id.
export function toolCalls(events, name) {
  return events
    .filter((event) => event.type === "session.tool.input.started" && event.data?.name === name)
    .map((started) => {
      const id = started.data.id
      const ended = events.find((event) => event.type === "session.tool.input.ended" && event.data?.id === id)
      let input
      try {
        input = JSON.parse(ended?.data?.text ?? "null")
      } catch {
        input = undefined
      }
      return {
        started,
        input,
        success: events.find((event) => event.type === "session.tool.success" && event.data?.id === id),
        failed: events.find((event) => event.type === "session.tool.failed" && event.data?.id === id),
      }
    })
}
