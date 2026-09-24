export * as Attachment from "./attachment.js"

import { Schema } from "effect"

export const ID = Schema.String.check(Schema.isPattern(/^att_[0-9A-Za-z]+$/)).pipe(Schema.brand("Attachment.ID"))
export type ID = typeof ID.Type
