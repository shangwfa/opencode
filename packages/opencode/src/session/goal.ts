import { Effect, Layer, Context, Option } from "effect"
import { generateObject, streamObject, type ModelMessage } from "ai"
import z from "zod"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { InstanceState } from "@/effect/instance-state"
import * as Log from "@opencode-ai/core/util/log"
import { Provider } from "@/provider/provider"
import type { ModelNotFoundError } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { SessionID } from "./schema"
import { MessageV2 } from "./message-v2"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database, dialect } from "../storage/db"
import { SessionGoalTable } from "./goal.pg"
import { eq } from "drizzle-orm"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const log = Log.create({ service: "session.goal" })

export type Goal = {
  condition: string
  react: number
}

export const Verdict = z.object({
  ok: z.boolean(),
  impossible: z.boolean().optional(),
  reason: z.string(),
})
export type Verdict = z.infer<typeof Verdict>

const JUDGE_SYSTEM = `You are evaluating a stop-condition hook. Read the conversation transcript carefully, then judge whether the user-provided condition is satisfied.

Your response must be a JSON object with one of these shapes:
- {"ok": true, "reason": "<quote evidence from the transcript that satisfies the condition>"}
- {"ok": false, "reason": "<quote what is missing or what blocks the condition>"}
- {"ok": false, "impossible": true, "reason": "<explain why the condition can never be satisfied>"}

Always include a "reason" field, quoting specific text from the transcript whenever possible. If the transcript does not contain clear evidence that the condition is satisfied, return {"ok": false, "reason": "insufficient evidence in transcript"}.

Only use {"ok": false, "impossible": true} when the condition is genuinely unachievable in this session — for example: the condition is self-contradictory, it depends on a resource or capability that is unavailable, or the assistant has explicitly tried, exhausted reasonable approaches, and stated it cannot be done. Apply your own judgment when deciding this — the assistant claiming the goal is impossible is evidence, not proof; independently confirm the condition is genuinely unachievable rather than deferring to the assistant's self-assessment. Do not use it just because the goal has not been reached yet or because progress is slow. When in doubt, return {"ok": false} without "impossible".`

const judgeUser = (condition: string) =>
  `Based on the conversation transcript above, has the following stopping condition been satisfied? Answer based on transcript evidence only.

Condition: ${condition}`

export interface Interface {
  readonly set: (sessionID: SessionID, condition: string) => Effect.Effect<void>
  readonly get: (sessionID: SessionID) => Effect.Effect<Goal | undefined>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
  readonly bumpReact: (sessionID: SessionID) => Effect.Effect<number>
  readonly evaluate: (input: {
    condition: string
    msgs: SessionV1.WithParts[]
    model: { providerID: string; modelID: string }
  }) => Effect.Effect<Verdict, ModelNotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoal") {}

const dbQuery = <T>(fn: (d: Parameters<typeof Database.use>[0] extends (trx: infer D) => unknown ? D : never) => T) =>
  Effect.promise(() => Database.use(fn) as Promise<T>)

const mirrorUpsert = (sessionID: SessionID, goal: Goal) =>
  dialect !== "pg"
    ? Effect.void
    : dbQuery((d: any) =>
        d
          .insert(SessionGoalTable as any)
          .values({
            session_id: sessionID as string,
            condition: goal.condition,
            react: goal.react,
            status: "active",
          })
          .onConflictDoUpdate({
            target: (SessionGoalTable as any).session_id,
            set: { condition: goal.condition, react: goal.react, status: "active" },
          })
          .run(),
      )

const mirrorDelete = (sessionID: SessionID) =>
  dialect !== "pg"
    ? Effect.void
    : dbQuery((d: any) =>
        d.delete(SessionGoalTable as any).where(eq(SessionGoalTable.session_id as any, sessionID as string)).run(),
      )

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const auth = yield* Auth.Service
    const config = yield* Config.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionGoal.state")(function* () {
        return { goals: new Map<string, Goal>() }
      }),
    )

    const set = Effect.fn("SessionGoal.set")(function* (sessionID: SessionID, condition: string) {
      const data = yield* InstanceState.get(state)
      data.goals.set(sessionID, { condition, react: 0 })
      log.info("goal set", { sessionID, condition })
      yield* mirrorUpsert(sessionID, { condition, react: 0 }).pipe(Effect.catchCause(() => Effect.void))
    })

    const get = Effect.fn("SessionGoal.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.goals.get(sessionID)
    })

    const clear = Effect.fn("SessionGoal.clear")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      data.goals.delete(sessionID)
      log.info("goal cleared", { sessionID })
      yield* mirrorDelete(sessionID).pipe(Effect.catchCause(() => Effect.void))
    })

    const bumpReact = Effect.fn("SessionGoal.bumpReact")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const goal = data.goals.get(sessionID)
      if (!goal) return 0
      goal.react += 1
      yield* mirrorUpsert(sessionID, goal).pipe(Effect.catchCause(() => Effect.void))
      return goal.react
    })

    const evaluate = Effect.fn("SessionGoal.evaluate")(function* (input: {
      condition: string
      msgs: SessionV1.WithParts[]
      model: { providerID: string; modelID: string }
    }) {
      const cfg = yield* config.get()
      const resolved = yield* provider.getModel(input.model.providerID as any, input.model.modelID as any)
      const language = yield* provider.getLanguage(resolved)
      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined

      const authInfo = yield* auth.get(input.model.providerID as any).pipe(Effect.orDie)
      const isOpenaiOauth = input.model.providerID === "openai" && (authInfo as any)?.type === "oauth"

      const conversation = yield* MessageV2.toModelMessagesEffect(input.msgs, resolved)

      const clip = (_key: string, value: unknown) =>
        typeof value === "string" && value.length > 500 ? `«${value.length} chars: ${value.slice(0, 200)}…»` : value
      const fullMessages = [
        ...(isOpenaiOauth ? [] : [{ role: "system", content: JUDGE_SYSTEM }]),
        ...conversation,
        { role: "user", content: judgeUser(input.condition) },
      ]
      log.debug("goal judge transcript", {
        condition: input.condition,
        messageCount: fullMessages.length,
        messages: JSON.stringify(fullMessages, clip),
      })

      const params = {
        experimental_telemetry: {
          isEnabled: cfg.experimental?.openTelemetry,
          tracer,
          metadata: { userId: cfg.username ?? "unknown" },
        },
        temperature: 0,
        messages: [
          ...(isOpenaiOauth ? [] : [{ role: "system", content: JUDGE_SYSTEM } satisfies ModelMessage]),
          ...conversation,
          {
            role: "user",
            content: judgeUser(input.condition),
          } satisfies ModelMessage,
        ],
        model: language,
        schema: Verdict,
      } satisfies Parameters<typeof generateObject>[0]

      if (isOpenaiOauth) {
        return yield* Effect.promise(async () => {
          const result = streamObject({
            ...params,
            providerOptions: ProviderTransform.providerOptions(resolved, {
              instructions: JUDGE_SYSTEM,
              store: false,
            }),
            onError: () => {},
          })
          for await (const part of result.fullStream) {
            if (part.type === "error") throw part.error
          }
          return Verdict.parse(await result.object)
        })
      }

      return yield* Effect.promise(() => generateObject(params).then((r) => Verdict.parse(r.object)))
    })

    return Service.of({ set, get, clear, bumpReact, evaluate })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Provider.node, Auth.node, Config.node],
})

export * as Goal from "./goal"
