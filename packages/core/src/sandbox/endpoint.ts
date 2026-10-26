export * as SandboxEndpoint from "./endpoint.js"

/**
 * Endpoint strings are scheme-less `host[:port][/path]` for OpenSandbox, while
 * Vercel returns a full HTTPS route URL. Consumers historically hard-coded
 * `http://`, so these helpers prefer an embedded scheme and fall back to the
 * caller's default — one place to keep that contract straight.
 */
const HTTP_SCHEME = /^https?:\/\//
const WS_SCHEME = /^wss?:\/\//

export const httpUrl = (endpoint: string, protocol: "http" | "https" = "http"): string =>
  HTTP_SCHEME.test(endpoint) ? endpoint : `${protocol}://${endpoint}`

export const wsUrl = (endpoint: string): string => {
  if (WS_SCHEME.test(endpoint)) return endpoint
  if (endpoint.startsWith("https://")) return `wss://${endpoint.slice("https://".length)}`
  if (endpoint.startsWith("http://")) return `ws://${endpoint.slice("http://".length)}`
  return `ws://${endpoint}`
}
