import type { Sandbox } from "@vercel/sandbox"

export type Transport = NonNullable<Parameters<typeof Sandbox.get>[0]["fetch"]>

/** SDK retries share RequestInit: reuse that attempt, never resend an uncertain mutation. */
export function singleSubmissionFetch(raw: Transport = globalThis.fetch): Transport {
  const attempts = new WeakMap<object, Promise<Response>>()
  return Object.assign(
    (input: Parameters<Transport>[0], init?: Parameters<Transport>[1]) => {
      const request = input instanceof Request ? input : undefined
      const url = new URL(request?.url ?? String(input))
      const method = (init?.method ?? request?.method ?? "GET").toUpperCase()
      const key = init ?? request
      if (!key || ((method === "GET" || method === "HEAD") && url.searchParams.get("resume") !== "true")) {
        return raw(input, init)
      }
      const existing = attempts.get(key)
      if (existing) return existing
      // Do not clone or consume the response: successful command/log streams must remain streaming.
      const attempt = Promise.resolve().then(() => raw(input, { ...init, redirect: "error" }))
      attempts.set(key, attempt)
      return attempt
    },
    { preconnect(...args: Parameters<Transport["preconnect"]>) { raw.preconnect?.(...args) } },
  )
}
