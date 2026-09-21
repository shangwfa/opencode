import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Form } from "@opencode/core/form"
import { Hitl } from "@opencode/core/hitl/index"
import { Location } from "@opencode/core/location"
import { ProjectTable } from "@opencode/core/project/sql"
import { SessionTable } from "@opencode/core/session/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionSchema } from "@opencode/core/session/schema"
import { Project } from "@opencode/schema/project"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const forms = AppNodeBuilder.build(LayerNode.group([Bus.node, Form.node]), [Location.node.replace(current)])
const it = testEffect(forms)

const formID = Form.ID.create("frm_test")
const formPublicID = Form.ID.create("frm_public")
const formCancelledID = Form.ID.create("frm_cancelled")
const formPersistedID = Form.ID.create("frm_persisted")
const formForeignID = Form.ID.create("frm_foreign")
const formAbsentID = Form.ID.create("frm_absent")
const formLiveID = Form.ID.create("frm_live")
const input = {
  id: formID,
  sessionID: SessionSchema.ID.make("ses_test"),
  title: "Test form",
  fields: [{ key: "name", type: "string", required: true }],
} satisfies Form.CreateInput

describe("Form", () => {
  it.effect("validates absolute URI formats without restricting schemes", () =>
    Effect.sync(() => {
      const fields = [{ key: "uri", type: "string", format: "uri" }] satisfies ReadonlyArray<Form.Field>

      expect(Form.validateAnswer(fields, { uri: "https://example.com/path" })).toBeUndefined()
      expect(Form.validateAnswer(fields, { uri: "mailto:user@example.com" })).toBeUndefined()
      expect(Form.validateAnswer(fields, { uri: "relative/path" })).toBe("Expected URI for form field: uri")
      expect(Form.validateAnswer(fields, { uri: "://invalid" })).toBe("Expected URI for form field: uri")
    }),
  )

  it.effect("returns a terminal cancelled state from ask", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const bus = yield* Bus.Service
      const created = yield* Deferred.make<Form.Info>()
      const unsubscribe = yield* bus.listen((event) =>
        event.type === Form.Event.Created.type
          ? Deferred.succeed(created, (event.data as { readonly form: Form.Info }).form).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.ask(input).pipe(Effect.forkScoped)
      const form = yield* Deferred.await(created)

      yield* service.cancel(form.id)

      expect(yield* Fiber.join(fiber)).toEqual({ status: "cancelled" })
      expect(yield* service.state(form.id)).toEqual({ status: "cancelled" })
    }),
  )

  it.effect("supports the temporary global mcp elicitation owner", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const created = yield* service.create({
        sessionID: "global",
        title: "MCP input",
        fields: [{ key: "name", type: "string", required: true }],
      })
      expect(created.sessionID).toBe("global")
      expect(created.title).toBe("MCP input")

      const owned = yield* service.list({ sessionID: "global" })
      expect(owned.map((form) => form.id)).toEqual([created.id])
      expect(yield* service.list({ sessionID: "other" })).toEqual([])

      yield* service.reply({ id: created.id, answer: { name: "Ava" } })
      expect(yield* service.state(created.id)).toEqual({ status: "answered", answer: { name: "Ava" } })

      const externalOnly = yield* service.create({
        sessionID: "global",
        title: "External setup",
        fields: [{ key: "setup", type: "external", url: "https://example.com/setup" }],
      })
      yield* service.reply({ id: externalOnly.id, answer: { setup: true } })
      expect(yield* service.state(externalOnly.id)).toEqual({ status: "answered", answer: { setup: true } })
    }),
  )

  it.effect("gates required fields and rejects inactive answers via when", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const created = yield* service.create({
        sessionID: "global",
        title: "Conditional form",
        fields: [
          { key: "confirm", type: "boolean", required: true },
          { key: "reason", type: "string", required: true, when: [{ key: "confirm", op: "eq", value: false }] },
        ],
      })

      const inactive = yield* service
        .reply({ id: created.id, answer: { confirm: true, reason: "x" } })
        .pipe(Effect.flip)
      expect(inactive).toEqual(
        new Form.InvalidAnswerError({ id: created.id, message: "Form field is not active: reason" }),
      )

      const missing = yield* service.reply({ id: created.id, answer: { confirm: false } }).pipe(Effect.flip)
      expect(missing).toEqual(
        new Form.InvalidAnswerError({ id: created.id, message: "Missing required form field: reason" }),
      )

      yield* service.reply({ id: created.id, answer: { confirm: false, reason: "not ready" } })
      expect(yield* service.state(created.id)).toEqual({
        status: "answered",
        answer: { confirm: false, reason: "not ready" },
      })
    }),
  )

  it.effect("evaluates when against multiselect answers as inclusion", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const options = [
        { value: "go", label: "Go" },
        { value: "ts", label: "TypeScript" },
      ]
      const created = yield* service.create({
        sessionID: "global",
        title: "Multiselect form",
        fields: [
          { key: "langs", type: "multiselect", options },
          { key: "goVersion", type: "string", required: true, when: [{ key: "langs", op: "eq", value: "go" }] },
        ],
      })

      const missing = yield* service.reply({ id: created.id, answer: { langs: ["go", "ts"] } }).pipe(Effect.flip)
      expect(missing).toEqual(
        new Form.InvalidAnswerError({ id: created.id, message: "Missing required form field: goVersion" }),
      )

      yield* service.reply({ id: created.id, answer: { langs: ["ts"] } })
      expect(yield* service.state(created.id)).toEqual({ status: "answered", answer: { langs: ["ts"] } })
    }),
  )

  it.effect("requires every when condition to match and treats empty when as active", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const created = yield* service.create({
        sessionID: "global",
        title: "Dependent form",
        fields: [
          { key: "a", type: "boolean" },
          { key: "b", type: "boolean" },
          {
            key: "x",
            type: "string",
            required: true,
            when: [
              { key: "a", op: "eq", value: true },
              { key: "b", op: "eq", value: true },
            ],
          },
          { key: "z", type: "string", required: true, when: [] },
        ],
      })

      const missingX = yield* service.reply({ id: created.id, answer: { a: true, b: true, z: "ok" } }).pipe(Effect.flip)
      expect(missingX).toEqual(
        new Form.InvalidAnswerError({ id: created.id, message: "Missing required form field: x" }),
      )

      const inactiveX = yield* service
        .reply({ id: created.id, answer: { a: true, b: false, x: "nope", z: "ok" } })
        .pipe(Effect.flip)
      expect(inactiveX).toEqual(new Form.InvalidAnswerError({ id: created.id, message: "Form field is not active: x" }))

      const missingZ = yield* service.reply({ id: created.id, answer: { a: true, b: false } }).pipe(Effect.flip)
      expect(missingZ).toEqual(
        new Form.InvalidAnswerError({ id: created.id, message: "Missing required form field: z" }),
      )

      yield* service.reply({ id: created.id, answer: { a: true, b: false, z: "ok" } })
      expect(yield* service.state(created.id)).toEqual({ status: "answered", answer: { a: true, b: false, z: "ok" } })
    }),
  )

  it.effect("evaluates neq against multiselect answers as non-inclusion", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const options = [
        { value: "go", label: "Go" },
        { value: "ts", label: "TypeScript" },
      ]
      const created = yield* service.create({
        sessionID: "global",
        title: "Selection form",
        fields: [
          { key: "langs", type: "multiselect", options },
          { key: "note", type: "string", required: true, when: [{ key: "langs", op: "neq", value: "go" }] },
        ],
      })

      const missing = yield* service.reply({ id: created.id, answer: { langs: ["ts"] } }).pipe(Effect.flip)
      expect(missing).toEqual(
        new Form.InvalidAnswerError({ id: created.id, message: "Missing required form field: note" }),
      )

      // an answered-but-empty multiselect also satisfies neq
      const missingEmpty = yield* service.reply({ id: created.id, answer: { langs: [] } }).pipe(Effect.flip)
      expect(missingEmpty).toEqual(
        new Form.InvalidAnswerError({ id: created.id, message: "Missing required form field: note" }),
      )

      const inactive = yield* service.reply({ id: created.id, answer: { langs: ["go"], note: "x" } }).pipe(Effect.flip)
      expect(inactive).toEqual(
        new Form.InvalidAnswerError({ id: created.id, message: "Form field is not active: note" }),
      )

      yield* service.reply({ id: created.id, answer: { langs: ["go"] } })
      expect(yield* service.state(created.id)).toEqual({ status: "answered", answer: { langs: ["go"] } })
    }),
  )

  it.effect("treats unanswered when references as false and cascades inactivity", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const created = yield* service.create({
        sessionID: "global",
        title: "Cascading form",
        fields: [
          { key: "a", type: "boolean" },
          { key: "b", type: "string", when: [{ key: "a", op: "eq", value: true }] },
          // neq also fails against an unanswered reference, and hiding b cascades here through
          // the reject-inactive-answers rule: b can never be answered while a is false.
          { key: "c", type: "string", required: true, when: [{ key: "b", op: "neq", value: "x" }] },
        ],
      })

      const inactive = yield* service.reply({ id: created.id, answer: { a: false, b: "yes" } }).pipe(Effect.flip)
      expect(inactive).toEqual(new Form.InvalidAnswerError({ id: created.id, message: "Form field is not active: b" }))

      yield* service.reply({ id: created.id, answer: { a: false } })
      expect(yield* service.state(created.id)).toEqual({ status: "answered", answer: { a: false } })
    }),
  )

  it.effect("rejects invalid when definitions at creation", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const flipCreate = (fields: Form.CreateInput["fields"]) =>
        service.create({ sessionID: "global", title: "Invalid form", fields }).pipe(Effect.flip)

      expect(
        yield* flipCreate([{ key: "b", type: "string", when: [{ key: "missing", op: "eq", value: "x" }] }]),
      ).toEqual(
        new Form.InvalidFormError({ message: "Form field condition must reference an earlier field: b -> missing" }),
      )

      expect(
        yield* flipCreate([
          { key: "a", type: "string" },
          { key: "a", type: "string" },
        ]),
      ).toEqual(new Form.InvalidFormError({ message: "Duplicate form field key: a" }))

      expect(
        yield* flipCreate([
          { key: "a", type: "external", url: "https://example.com" },
          { key: "a", type: "string" },
        ]),
      ).toEqual(new Form.InvalidFormError({ message: "Duplicate form field key: a" }))

      expect(
        yield* flipCreate([
          { key: "a", type: "boolean" },
          { key: "b", type: "string", when: [{ key: "a", op: "eq", value: "yes" }] },
        ]),
      ).toEqual(new Form.InvalidFormError({ message: "Form field condition value must be a boolean: b -> a" }))

      expect(
        yield* flipCreate([
          { key: "a", type: "string", options: [{ value: "x", label: "X" }] },
          { key: "b", type: "string", when: [{ key: "a", op: "eq", value: "y" }] },
        ]),
      ).toEqual(
        new Form.InvalidFormError({
          message: "Form field condition value must be one of the field's options: b -> a",
        }),
      )
    }),
  )

  it.effect("requires external field acknowledgements", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const created = yield* service.create({
        sessionID: "global",
        title: "External setup",
        fields: [
          { key: "authorization", type: "external", url: "https://example.com/setup", title: "Open setup" },
          { key: "name", type: "string", required: true },
        ],
      })

      const invalidAnswers: ReadonlyArray<Form.Answer> = [
        { name: "Ava" },
        { authorization: false, name: "Ava" },
        { authorization: "yes", name: "Ava" },
      ]
      for (const answer of invalidAnswers) {
        expect(yield* service.reply({ id: created.id, answer }).pipe(Effect.flip)).toEqual(
          new Form.InvalidAnswerError({
            id: created.id,
            message: "External form field must be acknowledged: authorization",
          }),
        )
      }

      yield* service.reply({ id: created.id, answer: { authorization: true, name: "Ava" } })
      expect(yield* service.state(created.id)).toEqual({
        status: "answered",
        answer: { authorization: true, name: "Ava" },
      })
    }),
  )

  it.effect("cleans up created forms when event publication fails", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const bus = yield* Bus.Service
      const unsubscribe = yield* bus.listen((event) =>
        event.type === Form.Event.Created.type ? Effect.die("create listener failed") : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      expect(Exit.isFailure(yield* Effect.exit(service.create(input)))).toBe(true)
      expect(yield* service.get(formID).pipe(Effect.flip)).toEqual(new Form.NotFoundError({ id: formID }))

      yield* unsubscribe
      expect(yield* service.create(input)).toMatchObject({ id: formID })
    }),
  )

  it.effect("keeps forms pending when reply event publication fails", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const bus = yield* Bus.Service
      yield* service.create(input)
      const unsubscribe = yield* bus.listen((event) =>
        event.type === Form.Event.Replied.type ? Effect.die("reply listener failed") : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      expect(Exit.isFailure(yield* Effect.exit(service.reply({ id: formID, answer: { name: "Ava" } })))).toBe(true)
      expect(yield* service.state(formID)).toEqual({ status: "pending" })

      yield* unsubscribe
      yield* service.reply({ id: formID, answer: { name: "Ava" } })
      expect(yield* service.state(formID)).toEqual({ status: "answered", answer: { name: "Ava" } })
    }),
  )
})

describe("Form persistence parity", () => {
  const itDb = testEffect(
    AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, Form.node]), [Location.node.replace(current)]),
  )

  // hitl_request.session_id references session, and the sqlite test database
  // enforces foreign keys: seed the rows the asks hang off.
  const seedSessions = Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: "ses_test" as never,
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

  const persistedAsk = (overrides: Partial<Hitl.NewPending> = {}): Hitl.NewPending => ({
    id: "frm_persisted",
    kind: "question",
    directory: "/project",
    sessionID: "ses_test",
    ownerID: "owner-a",
    payload: { title: "Persisted", fields: [{ key: "name", type: "string", required: true }], metadata: null },
    ...overrides,
  })

  // Production reaches Form through the location middleware, which provides the
  // per-location graph (including Location.Service); the compiled test graph
  // exposes the service on the outer layer without it, so directory scoping
  // inside Form would silently degrade to "". Provide it the same way the
  // middleware does.
  const locationService = Location.Service.of(location({ directory: AbsolutePath.make("/project") }))
  const inLocation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, Location.Service, locationService)

  itDb.effect("keeps a persisted form listable and replyable across graphs", () =>
    Effect.gen(function* () {
      yield* seedSessions
      // Another graph created a form (cache unreachable from this instance):
      // the persisted row is the only trace. V1 Form had no user dimension,
      // so userID is not a filtering concern.
      yield* Hitl.insertPending(persistedAsk({ id: "frm_public" }))
      const service = yield* Form.Service

      const listed = yield* inLocation(service.list())
      expect(listed.map((form) => form.id)).toContain(formPublicID)

      const publicID = formPublicID
      yield* inLocation(service.reply({ id: publicID, answer: { name: "Ava" } }))
      expect((yield* Hitl.row("frm_public"))!.status).toBe("replied")
    }),
  )

  itDb.effect("settles user cancellation as rejected so salvage covers it", () =>
    Effect.gen(function* () {
      yield* seedSessions
      const service = yield* Form.Service
      // Ask the way the question tool does: metadata.tool is the salvage
      // locator that maps the row back to its dangling tool part.
      const created = yield* service.create({
        ...input,
        id: formCancelledID,
        metadata: { tool: { messageID: "msg_test", id: "toolu_test" } },
      })

      yield* inLocation(service.cancel(created.id))

      // V1 Form was memory-only, but V2 persists forms for restart recovery.
      // Align cancellation with V1 Question's decision-delivered semantics:
      // the row becomes rejected so the salvage sweep still generates a
      // failed tool result when the holding run is gone.
      const row = (yield* Hitl.row(created.id))!
      expect(row.status).toBe("rejected")
      expect(row.close_reason).toBe("decision-delivered")

      const backfillable = yield* Hitl.backfillables("question")
      expect(backfillable.map((action) => action.id)).toContain(created.id)
    }),
  )

  itDb.effect("rebuilds a form from its persisted row when the local cache misses it", () =>
    Effect.gen(function* () {
      yield* seedSessions
      yield* Hitl.insertPending(persistedAsk())
      const service = yield* Form.Service

      const rebuiltID = formPersistedID
      const rebuilt = yield* inLocation(service.getOrLoad(rebuiltID))
      expect(rebuilt.id).toBe(formPersistedID)
      expect(rebuilt.sessionID).toBe("ses_test")
      expect(rebuilt.title).toBe("Persisted")

      // Cache hits still win over the persisted mirror.
      const live = yield* service.create({ ...input, id: formLiveID })
      expect(yield* inLocation(service.getOrLoad(live.id))).toEqual(live)

      // Rows that are not questions are not forms, even under a form id.
      yield* Hitl.insertPending(
        persistedAsk({
          id: formForeignID,
          kind: "permission",
          payload: { action: "shell", resources: [], source: { type: "tool", messageID: "msg", id: "tool" } },
        }),
      )
      const foreign = yield* inLocation(service.getOrLoad(formForeignID)).pipe(Effect.flip)
      expect(foreign).toEqual(new Form.NotFoundError({ id: formForeignID }))

      const absent = yield* inLocation(service.getOrLoad(formAbsentID)).pipe(Effect.flip)
      expect(absent).toEqual(new Form.NotFoundError({ id: formAbsentID }))
    }),
  )
})
