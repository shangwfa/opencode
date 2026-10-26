import { Sandbox } from "@vercel/sandbox"
import { singleSubmissionFetch } from "./transport.js"

export type Connection = {
  readonly teamId: string
  readonly projectId: string
  readonly token: string
  readonly name: string
  readonly signal?: AbortSignal
  readonly fetch?: Parameters<typeof Sandbox.get>[0]["fetch"]
}

function validate(input: Connection) {
  for (const key of ["teamId", "projectId", "token", "name"] as const) {
    if (!input[key].trim()) throw new Error(`Missing Vercel sandbox ${key}`)
  }
}

/** Metadata only: browsing must never resume a stopped workspace. */
export async function inspect(input: Connection) {
  validate(input)
  const sandbox = await Sandbox.get({ ...input, fetch: singleSubmissionFetch(input.fetch), resume: false })
  return {
    name: sandbox.name,
    persistent: sandbox.persistent,
    status: sandbox.status,
    generation: sandbox.currentSession().sessionId,
  }
}

/** Existing bindings must fail closed, never retrieve-or-create a fresh workspace. */
export async function resume(input: Connection) {
  validate(input)
  const sandbox = await Sandbox.get({ ...input, fetch: singleSubmissionFetch(input.fetch), resume: true })
  const session = sandbox.currentSession()
  if (session.status !== "running") throw new Error("Vercel sandbox did not become running")
  // Pin data operations to this VM; Sandbox methods can auto-resume and replay them.
  return { sandbox, session, generation: session.sessionId }
}

export type ActiveConnection = Awaited<ReturnType<typeof resume>>
