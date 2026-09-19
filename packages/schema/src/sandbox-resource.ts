export * as SandboxResource from "./sandbox-resource.js"

import { Schema } from "effect"

/** CPU quantity: whole cores, fractional cores, or millicores (e.g., "2", "0.5", "500m"). */
export const Cpu = Schema.String.check(Schema.isPattern(/^\d+(\.\d+)?m?$/)).annotate({
  identifier: "SandboxResource.cpu",
  description: 'CPU quantity: whole cores, fractional cores, or millicores (e.g., "2", "0.5", "500m").',
})

/** Memory quantity with binary or decimal IEC suffix (e.g., "2Gi", "512Mi", "1G"). */
export const Memory = Schema.String.check(
  Schema.isPattern(/^\d+(Ki|Mi|Gi|Ti|K|M|G|T)$/),
).annotate({
  identifier: "SandboxResource.memory",
  description: 'Memory quantity with binary or decimal IEC suffix (e.g., "2Gi", "512Mi", "1G").',
})

export interface Resource extends Schema.Schema.Type<typeof Resource> {}
export const Resource = Schema.Struct({
  cpu: Cpu,
  memory: Memory,
}).annotate({ identifier: "SandboxResource" })

const SIGNAL_NAMES: Readonly<Record<number, string>> = {
  1: "SIGHUP",
  6: "SIGABRT",
  9: "SIGKILL",
  13: "SIGPIPE",
  15: "SIGTERM",
}

export const signalName = (sig: number): string => SIGNAL_NAMES[sig] ?? `SIG${sig}`

export const exitSignal = (exitCode: number | null | undefined): string | undefined =>
  typeof exitCode === "number" && exitCode >= 128 ? signalName(exitCode - 128) : undefined
