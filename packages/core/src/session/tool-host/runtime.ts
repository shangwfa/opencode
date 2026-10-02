export { Effect, Schema } from "effect"
export { SessionTool } from "@opencode/schema/session-tool"
export { definition, execute } from "../../tool/runtime"
export { isToolDefinition, toToolInfo } from "../tool-definition"

// Retain the existing V1 helper contract; this does not claim complete Zod compatibility.
const builder = (typeName: string) => ({
  _def: { typeName, description: undefined as string | undefined },
  description: undefined as string | undefined,
  describe(description: string) {
    this.description = description
    this._def.description = description
    return this
  },
  isOptional() {
    return this._def.typeName === "ZodOptional"
  },
})
export const tool = Object.assign((definition: unknown) => definition, {
  schema: {
    string: () => builder("ZodString"),
    number: () => builder("ZodNumber"),
    boolean: () => builder("ZodBoolean"),
    array: () => builder("ZodArray"),
    object: () => builder("ZodObject"),
    optional: (inner: ReturnType<typeof builder>) => ({
      ...inner,
      _def: { typeName: "ZodOptional" },
      isOptional: () => true,
    }),
  },
})
