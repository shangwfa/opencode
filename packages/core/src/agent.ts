export * as Agent from "./agent.js"

import path from "path"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Array, Context, Effect, Layer, Schema, Types } from "effect"
import { Agent } from "@opencode/schema/agent"
import { Global } from "@opencode/util/global"
import { Bus } from "./bus.js"
import { State } from "./state.js"

const SHELL_OUTPUT_GLOB = (data: string) => path.join(data, "shell", "*", "*")
const TOOL_OUTPUT_GLOB = (data: string) => path.join(data, "tool-output", "*")

export const ID = Agent.ID
export type ID = typeof ID.Type
export const Name = Agent.Name
export type Name = Agent.Name
export const defaultID = ID.make("build")

export const Color = Agent.Color

export const Info = Agent.Info
export type Info = Agent.Info

export { Event } from "@opencode/schema/agent"

/**
 * A configured `default_agent` that cannot run sessions. Typed rather than thrown so the
 * Session runner settles the pending execution instead of leaving the stream open.
 */
export class DefaultAgentUnusableError extends Schema.TaggedError<DefaultAgentUnusableError>()(
  "Agent.DefaultAgentUnusableError",
  { agent: ID },
) {
  override get message() {
    return `Configured default_agent "${this.agent}" cannot run as a session default`
  }
}

export interface Selection {
  readonly id: ID
  readonly info: Info | undefined
}

type Data = {
  agents: Map<ID, Types.DeepMutable<Info>>
  default?: ID
}

export type Editor = {
  list: () => readonly Info[]
  get: (id: ID) => Info | undefined
  default: (id: ID | undefined) => void
  update: (id: ID, fn: (agent: Types.DeepMutable<Info>) => void) => void
  remove: (id: ID) => void
}

export interface Interface extends State.Transformable<Editor> {
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  readonly resolve: (id?: ID | string) => Effect.Effect<Info | undefined>
  readonly select: (id?: ID | string) => Effect.Effect<Selection>
  /**
   * Resolves the Agent a Session without an explicit selection would run. Unlike `select`, an
   * unusable configured `default_agent` fails here: the operator named a default, so silently
   * running a different Agent would hide the misconfiguration.
   */
  readonly default: () => Effect.Effect<Info, DefaultAgentUnusableError>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Agent") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const global = yield* Global.Service
    const permissions: Info["permissions"] = [
      { action: "external_directory", resource: SHELL_OUTPUT_GLOB(global.data), effect: "allow" },
      { action: "external_directory", resource: TOOL_OUTPUT_GLOB(global.data), effect: "allow" },
      { action: "external_directory", resource: path.join(global.tmp, "*"), effect: "allow" },
      { action: "external_directory", resource: path.join(global.config, "*"), effect: "allow" },
    ]
    const state = State.create<Data, Editor>({
      name: "agent",
      initial: () => ({ agents: new Map() }),
      editor: (editor) => ({
        list: () => Array.fromIterable(editor.agents.values()) as Info[],
        get: (id) => editor.agents.get(id),
        default: (id) => {
          editor.default = id
        },
        update: (id, fn) => {
          const defaults = Info.default(id)
          const current =
            editor.agents.get(id) ??
            ({
              ...defaults,
              permissions: [...defaults.permissions, ...permissions],
            } as Types.DeepMutable<Info>)
          if (!editor.agents.has(id)) editor.agents.set(id, current)
          fn(current)
          current.id = id
        },
        remove: (id) => {
          editor.agents.delete(id)
        },
      }),
      notify: () => bus.publish(Agent.Event.Updated, {}).pipe(Effect.asVoid),
    })
    const selectable = (agent: Info | undefined) =>
      agent && agent.mode !== "subagent" && !agent.hidden ? agent : undefined
    /** Reason a configured `default_agent` cannot serve sessions, or undefined when it can. */
    const defaultConfigError = () => {
      const data = state.get()
      if (data.default === undefined) return undefined
      const configured = data.agents.get(data.default)
      if (!configured) return `default_agent "${data.default}" is not a known Agent`
      if (configured.mode === "subagent")
        return `default_agent "${data.default}" runs as a subagent and cannot be a session default`
      if (configured.hidden) return `default_agent "${data.default}" is hidden and cannot be a session default`
      return undefined
    }
    // Listing and selection stay permissive so one misconfigured `default_agent` cannot take the
    // whole service down. `Agent.default` is the strict read the Session runner uses before it
    // spends a model call on an Agent the operator did not actually choose.
    const selectedDefault = () => {
      const data = state.get()
      const configured = data.default ? selectable(data.agents.get(data.default)) : undefined
      if (configured) return configured
      const build = selectable(data.agents.get(ID.make("build")))
      if (build) return build
      for (const agent of data.agents.values()) {
        const fallback = selectable(agent)
        if (fallback) return fallback
      }
    }

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      get: Effect.fn("Agent.get")(function* (id) {
        return state.get().agents.get(id)
      }),
      resolve: Effect.fnUntraced(function* (id) {
        if (id !== undefined) return state.get().agents.get(ID.make(id))
        return selectedDefault()
      }),
      select: Effect.fn("Agent.select")(function* (id) {
        if (id !== undefined) {
          const selected = ID.make(id)
          return { id: selected, info: state.get().agents.get(selected) }
        }
        const info = selectedDefault()
        return { id: info?.id ?? defaultID, info }
      }),
      default: Effect.fn("Agent.default")(function* () {
        const data = state.get()
        if (data.default !== undefined && defaultConfigError())
          return yield* new DefaultAgentUnusableError({ agent: data.default })
        const info = selectedDefault()
        if (!info) return yield* new DefaultAgentUnusableError({ agent: defaultID })
        return info
      }),
      list: Effect.fn("Agent.list")(function* () {
        const agents = Array.fromIterable(state.get().agents.values())
        const selected = selectedDefault()
        if (!selected) return agents
        return [selected, ...agents.filter((agent) => agent.id !== selected.id)]
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Bus.node, Global.node] })
