export * as SessionContextInsights from "./session-context-insights.js"

import { Schema } from "effect"
import { Agent } from "./agent.js"
import { Model } from "./model.js"
import { Money } from "./money.js"
import { TokenUsage } from "./token-usage.js"
import { SessionID } from "./session-id.js"
import { SessionMessage } from "./session-message.js"
import { NonNegativeInt, PositiveInt, optional, statics } from "./schema.js"

export const RequestID = Schema.String.check(Schema.isStartsWith("ctxreq_")).pipe(
  Schema.brand("SessionContextInsights.RequestID"),
  statics((schema) => ({ create: () => schema.make(`ctxreq_${crypto.randomUUID().replaceAll("-", "")}`) })),
)
export type RequestID = typeof RequestID.Type

export const Kind = Schema.Literals(["primary", "compaction", "generate", "title"])
export const Category = Schema.Literals(["system", "tools", "user", "inject", "assistant", "tool"])
export type Category = typeof Category.Type

export interface Composition extends Schema.Schema.Type<typeof Composition> {}
export const Composition = Schema.Struct({
  system: NonNegativeInt,
  tools: NonNegativeInt,
  user: NonNegativeInt,
  inject: NonNegativeInt,
  assistant: NonNegativeInt,
  tool: NonNegativeInt,
}).annotate({ identifier: "SessionContextInsights.Composition" })

export interface Request extends Schema.Schema.Type<typeof Request> {}
export const Request = Schema.Struct({
  id: RequestID,
  sessionID: SessionID,
  kind: Kind,
  agent: Agent.ID,
  model: Model.Ref,
  assistantMessageID: SessionMessage.ID.pipe(optional),
  time: NonNegativeInt,
  boundary: Schema.Literal("model-call-semantic-request"),
  estimation: Schema.Literal("text-characters-div-4"),
  estimatedTokens: NonNegativeInt,
  composition: Composition,
  incomplete: Schema.Boolean,
  itemCount: NonNegativeInt,
  contextWindow: PositiveInt.pipe(optional),
  /** Declared model output limit, reserved inside the same window as the input. */
  outputReserve: PositiveInt.pipe(optional),
  /** Declared model input limit, when the provider publishes one. */
  inputLimit: PositiveInt.pipe(optional),
}).annotate({ identifier: "SessionContextInsights.Request" })

export interface Item extends Schema.Schema.Type<typeof Item> {}
export const Item = Schema.Struct({
  index: NonNegativeInt,
  category: Category,
  name: Schema.String,
  estimatedTokens: NonNegativeInt,
  bytes: NonNegativeInt,
  hash: Schema.String.pipe(optional),
  omitted: Schema.Literals(["size-limit", "opaque-content", "unsupported-content"]).pipe(optional),
  /**
   * Tool origin, only present when it is distinguishable from the host registry: `mcp:<server>` or
   * `session`. Absent means a host-registered tool (builtin or plugin).
   */
  source: Schema.String.pipe(optional),
  /**
   * Non-tool origin that our own renderers mark unambiguously in the text, currently the skill
   * catalog block. Absent means plain prompt content; never inferred from arbitrary user text.
   */
  origin: Schema.Literal("skills").pipe(optional),
  /** Attachment descriptor for media parts. Bytes are never retained, so size is absent by design. */
  media: Schema.Struct({
    mediaType: Schema.String,
    filename: Schema.String.pipe(optional),
  }).pipe(optional),
  /** 1-based request index where this exact content (by hash) first appeared in the page. */
  introduced: NonNegativeInt.pipe(optional),
  /** Tool call/result identity so the browser can pair arguments with their outcome. */
  tool: Schema.Struct({
    name: Schema.String,
    callID: Schema.String,
    failed: Schema.Boolean.pipe(optional),
  }).pipe(optional),
}).annotate({ identifier: "SessionContextInsights.Item" })

export interface Detail extends Schema.Schema.Type<typeof Detail> {}
export const Detail = Schema.Struct({
  request: Request,
  items: Schema.Array(Item),
}).annotate({ identifier: "SessionContextInsights.Detail" })

export interface Content extends Schema.Schema.Type<typeof Content> {}
export const Content = Schema.Struct({
  item: Item,
  content: Schema.NullOr(Schema.String),
}).annotate({ identifier: "SessionContextInsights.Content" })

export interface Summary extends Schema.Schema.Type<typeof Summary> {}
export const Summary = Schema.Struct({
  capturedRequests: NonNegativeInt,
  latest: Schema.NullOr(Request),
  history: Schema.Literal("captured-requests-only"),
}).annotate({ identifier: "SessionContextInsights.Summary" })

export interface Page extends Schema.Schema.Type<typeof Page> {}
export const Page = Schema.Struct({
  data: Schema.Array(Request),
  next: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "SessionContextInsights.Page" })

export interface Usage extends Schema.Schema.Type<typeof Usage> {}
export const Usage = Schema.Struct({ tokens: TokenUsage.Info, cost: Money.USD })
  .annotate({ identifier: "SessionContextInsights.Usage" })

export interface Point extends Schema.Schema.Type<typeof Point> {}
export const Point = Schema.Struct({
  request: Request,
  seq: NonNegativeInt,
  delta: Schema.NullOr(Schema.Int),
  turn: NonNegativeInt,
  status: Schema.Literals(["unknown", "running", "completed", "failed", "retried", "interrupted"]),
  actual: Schema.NullOr(Usage),
  elapsedMs: Schema.NullOr(NonNegativeInt),
  firstContentMs: Schema.NullOr(NonNegativeInt),
  modelMs: Schema.NullOr(NonNegativeInt),
  toolMs: Schema.NullOr(NonNegativeInt),
  /** First line of the user message that opened this request, truncated by the server. */
  brief: Schema.String.pipe(optional),
}).annotate({ identifier: "SessionContextInsights.Point" })

export interface ContextEvent extends Schema.Schema.Type<typeof ContextEvent> {}
export const ContextEvent = Schema.Struct({
  seq: NonNegativeInt,
  time: NonNegativeInt,
  type: Schema.Literals(["compaction", "inject", "skill", "model", "agent", "execution"]),
  label: Schema.String,
  /** What caused it: instruction keys, the activated skill name, or the selected agent. */
  source: Schema.String.pipe(optional),
  /** Turn the event contributed to, derived from the request sequence. */
  turn: NonNegativeInt.pipe(optional),
  /** Signed estimated-token change across the event; negative means reclaimed. Derived from adjacent requests. */
  tokens: Schema.Int.pipe(optional),
}).annotate({ identifier: "SessionContextInsights.ContextEvent" })

export interface FileActivity extends Schema.Schema.Type<typeof FileActivity> {}
export const FileActivity = Schema.Struct({
  path: Schema.String,
  action: Schema.Literals(["read", "write", "search"]),
  target: Schema.Literals(["file", "scope"]),
  calls: NonNegativeInt,
  failed: NonNegativeInt,
  nested: NonNegativeInt,
  lastSeq: NonNegativeInt,
  /**
   * Line delta derived from write/edit/patch tool inputs. Wheel-2 edits report their replacement
   * text rather than the file result, so this is the requested change, not the applied diff.
   */
  added: NonNegativeInt.pipe(optional),
  removed: NonNegativeInt.pipe(optional),
  /** Newest operations first, capped, so a row can expand into its own log. */
  ops: Schema.Array(
    Schema.Struct({
      seq: NonNegativeInt,
      failed: Schema.Boolean,
      nested: Schema.Boolean,
      added: NonNegativeInt.pipe(optional),
      removed: NonNegativeInt.pipe(optional),
    }),
  ).pipe(optional),
}).annotate({ identifier: "SessionContextInsights.FileActivity" })

export interface Attachment extends Schema.Schema.Type<typeof Attachment> {}
export const Attachment = Schema.Struct({
  requestID: RequestID,
  name: Schema.String,
  mediaType: Schema.String,
  filename: Schema.String.pipe(optional),
  bytes: NonNegativeInt,
}).annotate({ identifier: "SessionContextInsights.Attachment" })

export interface Epoch extends Schema.Schema.Type<typeof Epoch> {}
/** A change point: the request where the system prompt or tool schema set changed. */
export const Epoch = Schema.Struct({
  requestID: RequestID,
  seq: NonNegativeInt,
  time: NonNegativeInt,
  system: Schema.String,
  tools: Schema.String,
  systemChanged: Schema.Boolean,
  toolsChanged: Schema.Boolean,
}).annotate({ identifier: "SessionContextInsights.Epoch" })

export interface ToolUsage extends Schema.Schema.Type<typeof ToolUsage> {}
export const ToolUsage = Schema.Struct({
  name: Schema.String,
  calls: NonNegativeInt,
  failed: NonNegativeInt,
}).annotate({ identifier: "SessionContextInsights.ToolUsage" })

export interface CommandUsage extends Schema.Schema.Type<typeof CommandUsage> {}
export const CommandUsage = Schema.Struct({
  name: Schema.String,
  calls: NonNegativeInt,
  last: NonNegativeInt,
}).annotate({ identifier: "SessionContextInsights.CommandUsage" })

/** Counts over the request page and its durable events; each figure is countable from stored facts. */
export interface Stats extends Schema.Schema.Type<typeof Stats> {}
export const Stats = Schema.Struct({
  requests: NonNegativeInt,
  turns: NonNegativeInt,
  steps: NonNegativeInt,
  injects: NonNegativeInt,
  compactions: NonNegativeInt,
  skills: NonNegativeInt,
  toolCalls: NonNegativeInt,
  /** Estimated tokens of skill-catalog content in this page (estimate, never billed). */
  skillTokens: NonNegativeInt.pipe(optional),
  tools: Schema.Array(ToolUsage),
  commands: Schema.Array(CommandUsage),
}).annotate({ identifier: "SessionContextInsights.Stats" })

export interface Analysis extends Schema.Schema.Type<typeof Analysis> {}
export const Analysis = Schema.Struct({
  points: Schema.Array(Point),
  events: Schema.Array(ContextEvent),
  files: Schema.Array(FileActivity),
  stats: Stats.pipe(optional),
  /** Media parts in this page: descriptors only, bytes are never retained. */
  attachments: Schema.Array(Attachment).pipe(optional),
  /** Inputs already admitted but not yet consumed by a model call. */
  pending: Schema.Struct({
    count: NonNegativeInt,
    first: NonNegativeInt.pipe(optional),
    last: NonNegativeInt.pipe(optional),
  }).pipe(optional),
  /** System prompt / tool schema change points inside this page. */
  epochs: Schema.Array(Epoch).pipe(optional),
  eventsTruncated: Schema.Boolean,
  next: NonNegativeInt.pipe(optional),
  scope: Schema.Literal("request-page"),
}).annotate({ identifier: "SessionContextInsights.Analysis" })

export interface SessionCard extends Schema.Schema.Type<typeof SessionCard> {}
export const SessionCard = Schema.Struct({
  sessionID: SessionID,
  title: Schema.String,
  parentID: Schema.NullOr(SessionID),
  forkID: Schema.NullOr(SessionID),
  running: Schema.Boolean,
  outcome: Schema.NullOr(Schema.Literals(["succeeded", "failed", "interrupted"])),
  updated: NonNegativeInt,
  usage: Usage,
  latest: Schema.NullOr(Request),
  /** Captured model calls for this session, i.e. its step count. */
  requests: NonNegativeInt.pipe(optional),
  /** Session creation time (ms), for elapsed-time display. */
  started: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "SessionContextInsights.SessionCard" })

export interface Family extends Schema.Schema.Type<typeof Family> {}
export const Family = Schema.Struct({
  rootID: SessionID,
  members: Schema.Array(SessionCard),
  complete: Schema.Boolean,
}).annotate({ identifier: "SessionContextInsights.Family" })

export interface Day extends Schema.Schema.Type<typeof Day> {}
export const Day = Schema.Struct({
  date: Schema.String,
  tokens: NonNegativeInt,
  cost: Money.USD,
  settlements: NonNegativeInt,
  /** Completed tool runs attributed to that day. */
  toolCalls: NonNegativeInt.pipe(optional),
  /** Turns (admitted user inputs) attributed to that day. */
  turns: NonNegativeInt.pipe(optional),
  /** Summed tool-run durations (ms) attributed to that day. */
  toolsMs: NonNegativeInt.pipe(optional),
  /** Summed step wall time (ms), charged to the day the step started. */
  wallMs: NonNegativeInt.pipe(optional),
  sessionIDs: Schema.Array(SessionID),
}).annotate({ identifier: "SessionContextInsights.Day" })

export interface Overview extends Schema.Schema.Type<typeof Overview> {}
export const Overview = Schema.Struct({
  sessions: Schema.Array(SessionCard),
  days: Schema.Array(Day),
  range: Schema.Struct({ from: NonNegativeInt, to: NonNegativeInt }),
  attribution: Schema.Literal("settlement-utc"),
  coverage: Schema.Literal("available-durable-events"),
}).annotate({ identifier: "SessionContextInsights.Overview" })

export const OverviewInput = Schema.Struct({
  sessionIDs: Schema.Array(SessionID).check(Schema.isMaxLength(500)),
  from: NonNegativeInt,
  to: NonNegativeInt,
}).annotate({ identifier: "SessionContextInsights.OverviewInput" })

export class RangeError extends Schema.TaggedError<RangeError>()("ContextInsightsRangeError", {
  message: Schema.String,
}, { httpApiStatus: 400 }) {}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()(
  "SessionContextRequestNotFoundError",
  {
    sessionID: SessionID,
    requestID: RequestID,
  },
  { httpApiStatus: 404 },
) {}
