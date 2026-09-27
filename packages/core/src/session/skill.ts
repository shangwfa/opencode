export * as SessionSkill from "./skill.js"

import type { Session } from "@opencode/schema/session"
import { Effect, Option } from "effect"
import { Instance } from "../instance/service.js"
import { Plugin } from "../plugin/service.js"
import { Skill } from "../skill.js"
import { SessionSkills } from "./skills.js"
import { SkillNotFoundError } from "./error.js"

export const get = Effect.fn("SessionSkill.get")(function* (input: { session: Session.Info; skill: Skill.ID }) {
  const instances = yield* Instance.Service
  const resolve = Effect.gen(function* () {
    const overlay = Option.getOrUndefined(yield* Effect.serviceOption(SessionSkills.Service))
    if (overlay) {
      const resolved = yield* overlay.get(input.session, input.skill)
      if (resolved) return resolved.skill
    }
    const skills = yield* Skill.Service
    return yield* skills.get(input.skill)
  })
  const skill = yield* Plugin.awaitActivation.pipe(Effect.andThen(resolve), instances.provide(input.session))
  if (!skill) return yield* new SkillNotFoundError({ skill: input.skill })
  return skill
})
