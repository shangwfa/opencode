import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { loadCcrConfig } from "./lib/config"
import { CcrStore, type CcrStorageBackend } from "./lib/store"
import { createMessageTransform } from "./lib/transform"

export type CcrPluginOptions = {
  enabled?: boolean
  /** Persist CCR entries through the host (e.g. PostgreSQL-backed Storage) so
   *  any server instance can retrieve originals. Falls back to in-memory only. */
  storage?: CcrStorageBackend
  /** Resolve the parent session of a subagent session, enabling ccr_retrieve
   *  to fall back to entries stored under ancestors (bounded walk). */
  resolveParent?: (sessionID: string) => Promise<string | undefined>
}

const RETRIEVE_DESCRIPTION = `Retrieve the full original content of a tool output that was truncated by context compression (CCR). When a previous tool result contains a marker like "[ccr:<hash>]", pass that hash to read the complete untruncated content.`

/** Default parent resolver for subagent sessions: lazily loads the host's
 *  Session service via the shared AppRuntime so ccr_retrieve can walk up to
 *  entries stored under the parent session. Dynamic import keeps this heavy
 *  path off the plugin's module graph; every failure degrades to undefined. */
const defaultResolveParent = (() => {
  let impl: ((sessionID: string) => Promise<string | undefined>) | undefined
  return async (sessionID: string): Promise<string | undefined> => {
    if (!impl) {
      try {
        const [{ Session }, { AppRuntime }, { Effect }] = await Promise.all([
          import("@/session/session"),
          import("@/effect/app-runtime"),
          import("effect"),
        ])
        impl = (sid: string) =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const info = yield* sessions.get(sid as Parameters<typeof sessions.get>[0])
              return info.parentID ?? undefined
            }).pipe(Effect.catch(() => Effect.succeed(undefined))),
          )
      } catch {
        return undefined
      }
    }
    try {
      return await impl(sessionID)
    } catch {
      return undefined
    }
  }
})()

export const CcrPlugin: Plugin = (async (_ctx, options?: CcrPluginOptions) => {
  if (options?.enabled !== true) {
    return {}
  }

  const config = loadCcrConfig()
  const store = new CcrStore(options.storage, config)

  return {
    "experimental.chat.messages.transform": createMessageTransform(store, config) as any,
    tool: {
      ccr_retrieve: tool({
        description: RETRIEVE_DESCRIPTION,
        args: {
          hash: tool.schema.string().describe("The 24-character hash from the [ccr:...] marker"),
        },
        async execute(args, toolCtx) {
          const respond = (result: Awaited<ReturnType<typeof store.retrieve>>) => {
            if (result.status === "available") return result.content
            if (result.status === "expired") {
              const ttl = result.ttlSeconds > 0 ? ` (CCR TTL: ${result.ttlSeconds} seconds)` : ""
              return [
                `Entry expired${ttl}.`,
                "Do not retry the same hash. Re-run the source command or re-read the source file to regenerate fresh content.",
              ].join(" ")
            }
            return [
              "Content not found. It may have been removed with its session or belong to a different session.",
              "To recover: if the compression marker references a file read, re-read that file (the path is in the marker; disk is the source of truth). If it was command output, re-run the command.",
            ].join(" ")
          }
          const resolveParent = options?.resolveParent ?? defaultResolveParent
          return respond(await store.retrieveAlongAncestry(toolCtx.sessionID, args.hash, resolveParent))
        },
      }),
    },
  }
}) satisfies Plugin
