export * as SessionContextOrigin from "./context-origin.js"

const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")

/**
 * Resolves an advertised request tool name to a provenance label that is knowable from durable
 * session state. Session custom tools are exact matches; MCP tools are matched by the sanitized
 * server prefix used by the tool registry (`<server>_<tool>`). Host-registered tools (builtin and
 * plugin) are indistinguishable here and stay unlabelled.
 */
export const resolve = (input: {
  readonly mcp: ReadonlyArray<string>
  readonly custom: ReadonlyArray<string>
}): ((name: string) => string | undefined) => {
  const session = new Set(input.custom.map(sanitize))
  const servers = input.mcp
    .map((server) => ({ server, prefix: `${sanitize(server)}_` }))
    .sort((left, right) => right.prefix.length - left.prefix.length)
  return (name) => {
    if (session.has(name)) return "session"
    const match = servers.find((entry) => name.startsWith(entry.prefix))
    return match === undefined ? undefined : `mcp:${match.server}`
  }
}
