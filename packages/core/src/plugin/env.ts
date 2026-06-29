import { Effect } from "effect"
import { PluginV2 } from "../plugin"

// TODO: fix after merge - PluginV2.define no longer exists on the namespace
const define = (plugin: any) => plugin

export const EnvPlugin = define({
  id: PluginV2.ID.make("env"),
  effect: Effect.gen(function* () {
    return {
      "catalog.transform": Effect.fn(function* (evt: any) {
        for (const item of evt.provider.list()) {
          const key = item.provider.env.find((env: string) => process.env[env])
          if (!key) continue
          evt.provider.update(item.provider.id, (provider: any) => {
            provider.enabled = {
              via: "env",
              name: key,
            }
          })
        }
      }),
    }
  }),
})
