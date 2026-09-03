import type { Plugin } from "@opencode-ai/plugin"
import { getConfig } from "./lib/config"
import { createCompressMessageTool, createCompressRangeTool } from "./lib/compress"
import { compressDisabledByOpencode, type HostPermissionSnapshot } from "./lib/host-permissions"
import { Logger } from "./lib/logger"
import { createSessionState } from "./lib/state"
import { setStorageBackend, type DcpStorageBackend } from "./lib/state/persistence"
import { PromptStore } from "./lib/prompts/store"
import {
  createChatMessageTransformHandler,
  createCommandExecuteHandler,
  createEventHandler,
  createSystemPromptHandler,
  createTextCompleteHandler,
} from "./lib/hooks"
import { configureClientAuth, isSecureMode } from "./lib/auth"

export type DcpPluginOptions = {
  enabled?: boolean
  /** Persist DCP session state through the host (e.g. PostgreSQL-backed Storage) so
   *  multiple server instances share the same view. Falls back to local filesystem. */
  storage?: DcpStorageBackend
}

// Built-in vendored copy of @tarquinen/opencode-dcp (AGPL-3.0). Differences
// from the npm plugin: gated by `dcp.enabled` in opencode.jsonc, no autoUpdate
// (versioned with the repo), and no `config` hook mutations — permission and
// primary_tools injection are handled through opencode.jsonc / dcp.jsonc.
export const DcpPlugin: Plugin = (async (ctx, options?: DcpPluginOptions) => {
  if (options?.enabled !== true) {
    return {}
  }

  if (options.storage) {
    setStorageBackend(options.storage)
  }

  const config = getConfig(ctx)

  if (!config.enabled) {
    return {}
  }

  const logger = new Logger(config.debug)
  const state = createSessionState()
  const prompts = new PromptStore(logger, ctx.directory, config.experimental.customPrompts)
  const hostPermissions: HostPermissionSnapshot = {
    global: undefined,
    agents: {},
  }

  if (isSecureMode()) {
    configureClientAuth(ctx.client)
  }

  logger.info("DCP initialized", {
    strategies: config.strategies,
  })

  const compressToolContext = {
    client: ctx.client,
    state,
    logger,
    config,
    prompts,
  }

  return {
    "experimental.chat.system.transform": createSystemPromptHandler(state, logger, config, prompts),
    "experimental.chat.messages.transform": createChatMessageTransformHandler(
      ctx.client,
      state,
      logger,
      config,
      prompts,
      hostPermissions,
    ) as any,
    "experimental.text.complete": createTextCompleteHandler(),
    "command.execute.before": createCommandExecuteHandler(
      ctx.client,
      state,
      logger,
      config,
      ctx.directory,
      hostPermissions,
    ),
    event: createEventHandler(state, logger),
    tool: {
      ...(config.compress.permission !== "deny" && {
        compress:
          config.compress.mode === "message"
            ? createCompressMessageTool(compressToolContext)
            : createCompressRangeTool(compressToolContext),
      }),
    },
  }
}) satisfies Plugin
