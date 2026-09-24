export * as SessionAppId from "./session-app-id.js"

import { Schema } from "effect"

export const AppId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]{1,128}$/)).annotate({
  identifier: "Session.AppId",
  description: "Business application identifier (1-128 ASCII letters, digits, underscore, dot, or hyphen).",
})
export type AppId = typeof AppId.Type
