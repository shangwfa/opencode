import { describe, expect, test } from "vitest";
import {
  parseArtifactEventsJsonl,
  filterVisibleEvents,
  groupEventsByMessage,
  assignArtifactEventsToMessages,
  resolveEventStage,
  type ArtifactEvent,
} from "./artifact-event";
import type { StageConfig } from "./flows/config";

const validEvent = (overrides?: Partial<ArtifactEvent>): ArtifactEvent => ({
  id: "evt_001",
  stageId: "requirement-discussion",
  agent: "specer",
  artifactPath: "analysis/REQ-1/spec/spec.md",
  artifactKind: "spec",
  title: "需求文档已更新",
  summary: "补充了按钮文案调整说明",
  createdAt: "2026-07-14T10:01:00.000Z",
  ...overrides,
});

describe("parseArtifactEventsJsonl", () => {
  test("parses single valid line", () => {
    const raw = JSON.stringify(validEvent());
    const events = parseArtifactEventsJsonl(raw);
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe("evt_001");
    expect(events[0]!.title).toBe("需求文档已更新");
  });

  test("parses multiple lines", () => {
    const raw = [
      JSON.stringify(validEvent({ id: "evt_001", createdAt: "2026-07-14T10:00:00Z" })),
      JSON.stringify(validEvent({ id: "evt_002", createdAt: "2026-07-14T09:00:00Z" })),
    ].join("\n");
    const events = parseArtifactEventsJsonl(raw);
    expect(events).toHaveLength(2);
    // sorted by createdAt ascending
    expect(events[0]!.id).toBe("evt_002");
    expect(events[1]!.id).toBe("evt_001");
  });

  test("sorts explicit timezone offsets by their actual instant", () => {
    const raw = [
      JSON.stringify(validEvent({ id: "later", createdAt: "2026-07-14T10:30:00+08:00" })),
      JSON.stringify(validEvent({ id: "earlier", createdAt: "2026-07-14T02:00:00Z" })),
    ].join("\n");
    expect(parseArtifactEventsJsonl(raw).map((event) => event.id)).toEqual([
      "earlier",
      "later",
    ]);
  });

  test("skips empty lines", () => {
    const raw = `\n${JSON.stringify(validEvent())}\n\n`;
    const events = parseArtifactEventsJsonl(raw);
    expect(events).toHaveLength(1);
  });

  test("skips invalid JSON lines", () => {
    const raw = [
      "not json",
      JSON.stringify(validEvent()),
      "{broken",
    ].join("\n");
    const events = parseArtifactEventsJsonl(raw);
    expect(events).toHaveLength(1);
  });

  test("skips objects missing required fields", () => {
    const raw = [
      JSON.stringify({ id: "x", stageId: "y" }),
      JSON.stringify(validEvent()),
    ].join("\n");
    const events = parseArtifactEventsJsonl(raw);
    expect(events).toHaveLength(1);
  });

  test("handles empty string", () => {
    expect(parseArtifactEventsJsonl("")).toEqual([]);
  });

  test("preserves optional fields when present", () => {
    const event = validEvent({
      summary: "test summary",
      checksum: "abc123",
      causedByMessageId: "msg_001",
    });
    const events = parseArtifactEventsJsonl(JSON.stringify(event));
    expect(events[0]!.summary).toBe("test summary");
    expect(events[0]!.checksum).toBe("abc123");
    expect(events[0]!.causedByMessageId).toBe("msg_001");
  });

  test("optional fields are undefined when absent", () => {
    const event = validEvent();
    delete (event as Partial<ArtifactEvent>).summary;
    delete (event as Partial<ArtifactEvent>).checksum;
    delete (event as Partial<ArtifactEvent>).causedByMessageId;
    const events = parseArtifactEventsJsonl(JSON.stringify(event));
    expect(events[0]!.summary).toBeUndefined();
    expect(events[0]!.checksum).toBeUndefined();
    expect(events[0]!.causedByMessageId).toBeUndefined();
  });

  test("preserves causedByMessageId on commit events", () => {
    const events = parseArtifactEventsJsonl(
      JSON.stringify({
        id: "evt_commit",
        type: "commitMsg",
        agent: "dyn-build",
        message: "feat: update",
        causedByMessageId: "msg_user",
        createdAt: "2026-07-14T10:00:00Z",
      }),
    );
    expect(events[0]?.causedByMessageId).toBe("msg_user");
  });

  test("handles wrapper object with content field (like /file/content response)", () => {
    const inner = JSON.stringify(validEvent());
    const wrapped = JSON.stringify({ content: inner });
    // The raw JSONL should NOT be wrapped — each line is the event itself.
    // But if it comes wrapped, the parser should skip it gracefully.
    const events = parseArtifactEventsJsonl(wrapped);
    expect(events).toHaveLength(0);
  });
});

describe("filterVisibleEvents", () => {
  test("returns all events (first version)", () => {
    const events = [
      validEvent({ id: "evt_001" }),
      validEvent({ id: "evt_002" }),
    ];
    expect(filterVisibleEvents(events)).toHaveLength(2);
  });
});

describe("groupEventsByMessage", () => {
  test("groups events by causedByMessageId when it exists in messageIds", () => {
    const events = [
      validEvent({ id: "evt_001", causedByMessageId: "msg_A" }),
      validEvent({ id: "evt_002", causedByMessageId: "msg_B" }),
      validEvent({ id: "evt_003", causedByMessageId: "msg_A" }),
    ];
    const groups = groupEventsByMessage(events, ["msg_A", "msg_B"]);
    expect(groups.get("msg_A")).toHaveLength(2);
    expect(groups.get("msg_B")).toHaveLength(1);
  });

  test("events with causedByMessageId not in messageIds go to null key", () => {
    const events = [
      validEvent({ id: "evt_001", causedByMessageId: "msg_unknown" }),
    ];
    const groups = groupEventsByMessage(events, ["msg_A"]);
    expect(groups.get(null)).toHaveLength(1);
  });

  test("events without causedByMessageId go to null key", () => {
    const events = [
      validEvent({ id: "evt_001" }),
      validEvent({ id: "evt_002" }),
    ];
    const groups = groupEventsByMessage(events, ["msg_A"]);
    expect(groups.get(null)).toHaveLength(2);
  });

  test("empty events returns empty map", () => {
    const groups = groupEventsByMessage([], ["msg_A"]);
    expect(groups.size).toBe(0);
  });
});

describe("assignArtifactEventsToMessages", () => {
  const messages = [
    { id: "msg_1", time: { created: 1000 } },
    { id: "msg_2", time: { created: 2000 } },
    { id: "msg_3", time: { created: 3000 } },
  ];

  test("assigns by causedByMessageId first", () => {
    const events = [
      validEvent({ id: "evt_001", causedByMessageId: "msg_2", createdAt: "2026-07-14T10:00:00Z" }),
    ];
    const groups = assignArtifactEventsToMessages(events, messages);
    expect(groups.get("msg_2")).toHaveLength(1);
    expect(groups.get(null)).toBeUndefined();
  });

  test("falls back to createdAt nearest preceding message", () => {
    const events = [
      validEvent({ id: "evt_001", createdAt: "1970-01-01T00:00:02Z" }),
    ];
    const groups = assignArtifactEventsToMessages(events, messages);
    expect(groups.get("msg_2")).toHaveLength(1);
  });

  test("puts events before all messages into trailing null key", () => {
    const events = [
      validEvent({ id: "evt_001", createdAt: "1970-01-01T00:00:00Z" }),
    ];
    const groups = assignArtifactEventsToMessages(events, messages);
    expect(groups.get(null)).toHaveLength(1);
  });

  test("returns empty map when no events", () => {
    const groups = assignArtifactEventsToMessages([], messages);
    expect(groups.size).toBe(0);
  });

  test("uses assistant parentID when causedByMessageId points to assistant", () => {
    const allMessages = [
      ...messages,
      { id: "asst_1", role: "assistant" as const, agent: "builder", parentID: "msg_2", time: { created: 2100, completed: 2500 } },
    ];
    const events = [
      validEvent({ id: "evt_001", causedByMessageId: "asst_1", agent: "builder", createdAt: "2026-07-14T10:00:00Z" }),
    ];
    const groups = assignArtifactEventsToMessages(events, allMessages);
    expect(groups.get("msg_2")).toHaveLength(1);
    expect(groups.get(null)).toBeUndefined();
  });

  test("falls back to same-agent assistant parentID when causedByMessageId is missing and createdAt is unreliable", () => {
    const allMessages = [
      ...messages,
      { id: "asst_1", role: "assistant" as const, agent: "builder", parentID: "msg_2", time: { created: 2100, completed: 2500 } },
      { id: "asst_2", role: "assistant" as const, agent: "reviewer", parentID: "msg_3", time: { created: 3100, completed: 3500 } },
    ];
    // createdAt 明显早于所有消息，时间回退会进 trailing；但 agent 匹配应把它挂到 msg_2
    const events = [
      validEvent({ id: "evt_001", agent: "builder", createdAt: "1970-01-01T00:00:00Z" }),
    ];
    const groups = assignArtifactEventsToMessages(events, allMessages);
    expect(groups.get("msg_2")).toHaveLength(1);
    expect(groups.get(null)).toBeUndefined();
  });

  test("accepts an eight-hour timezone offset within a bounded window", () => {
    const userTime = Date.parse("2026-09-23T08:00:00Z");
    const allMessages = [
      { id: "user_1", role: "user" as const, time: { created: userTime - 1_000 } },
      {
        id: "asst_1",
        role: "assistant" as const,
        agent: "dyn-build",
        parentID: "user_1",
        time: { created: userTime, completed: userTime + 5_000 },
      },
    ];
    const groups = assignArtifactEventsToMessages(
      [validEvent({ agent: "dyn-build", createdAt: "2026-09-23T00:00:03Z" })],
      allMessages,
    );
    expect(groups.get("user_1")).toHaveLength(1);
  });

  test("pairs malformed historical times to same-agent turns from newest to oldest", () => {
    const first = Date.parse("2026-09-23T12:40:00Z");
    const second = Date.parse("2026-09-23T12:46:00Z");
    const allMessages = [
      { id: "user_1", role: "user" as const, time: { created: first } },
      { id: "asst_1", role: "assistant" as const, agent: "dyn-orchestrator", parentID: "user_1", time: { created: first + 1_000, completed: first + 30_000 } },
      { id: "user_2", role: "user" as const, time: { created: second } },
      { id: "asst_2", role: "assistant" as const, agent: "dyn-orchestrator", parentID: "user_2", time: { created: second + 1_000, completed: second + 30_000 } },
    ];
    const groups = assignArtifactEventsToMessages(
      [
        validEvent({ id: "evt_old", agent: "dyn-orchestrator", createdAt: "2026-09-23T00:00:01Z" }),
        validEvent({ id: "evt_new", agent: "dyn-orchestrator", createdAt: "2026-09-23T00:01:40Z" }),
      ],
      allMessages,
    );
    expect(groups.get("user_1")?.map((event) => event.id)).toEqual(["evt_old"]);
    expect(groups.get("user_2")?.map((event) => event.id)).toEqual(["evt_new"]);
  });
});

describe("resolveEventStage", () => {
  const stages: StageConfig[] = [
    { id: "specer", label: "需求讨论", agent: "specer", artifactPath: "analysis/REQ-1/spec/spec.md", artifactKind: "spec" },
    { id: "planner", label: "方案规划", agent: "planner", artifactPath: "analysis/REQ-1/plan/plan.md", artifactKind: "plan" },
    { id: "layout-designer", label: "布局设计", agent: "layout-designer", artifactPath: "analysis/REQ-1/template/layout-designer.json", artifactKind: "layout_design" },
  ];

  test("matches stage by stageId", () => {
    const event = validEvent({ stageId: "planner", agent: "planner" });
    const stage = resolveEventStage(event, stages);
    expect(stage?.id).toBe("planner");
  });

  test("falls back to agent when stageId does not match any stage", () => {
    // Agent may write a generic stageId like "requirement-discussion" that does not exist in flow config.
    const event = validEvent({ stageId: "requirement-discussion", agent: "specer" });
    const stage = resolveEventStage(event, stages);
    expect(stage?.id).toBe("specer");
  });

  test("returns undefined when neither stageId nor agent matches", () => {
    const event = validEvent({ stageId: "unknown", agent: "unknown" });
    expect(resolveEventStage(event, stages)).toBeUndefined();
  });
});
