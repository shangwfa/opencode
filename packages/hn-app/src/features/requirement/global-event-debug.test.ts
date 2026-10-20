import { describe, expect, test } from "vitest";
import {
  appendGlobalEventDebugEntry,
  extractGlobalEventSessionMeta,
  isGlobalEventForSession,
  type RawGlobalEventDebugEntry,
} from "./global-event-debug";

const event = (type: string, properties: unknown) =>
  ({ type, properties }) as any;

const entry = (
  payload: RawGlobalEventDebugEntry["payload"],
  id = "evt",
  sessionID?: string,
): RawGlobalEventDebugEntry => ({
  id,
  at: 1000,
  directory: "/workspace",
  sessionID,
  payload,
});

describe("global event debug helpers", () => {
  test("extracts session metadata from message events", () => {
    expect(
      extractGlobalEventSessionMeta(
        event("message.updated", {
          sessionID: "ses_1",
          info: { id: "msg_1", sessionID: "ses_1" },
        }),
      ),
    ).toEqual({ sessionID: "ses_1", messageID: "msg_1" });

    expect(
      extractGlobalEventSessionMeta(
        event("message.removed", {
          sessionID: "ses_1",
          messageID: "msg_2",
        }),
      ),
    ).toEqual({ sessionID: "ses_1", messageID: "msg_2", partID: undefined });
  });

  test("extracts session metadata from part events", () => {
    expect(
      extractGlobalEventSessionMeta(
        event("message.part.updated", {
          sessionID: "ses_1",
          part: { id: "prt_1", messageID: "msg_1" },
        }),
      ),
    ).toEqual({
      sessionID: "ses_1",
      messageID: "msg_1",
      partID: "prt_1",
    });

    expect(
      extractGlobalEventSessionMeta(
        event("message.part.delta", {
          messageID: "msg_1",
          partID: "prt_3",
          field: "text",
          delta: "hello",
        }),
      ),
    ).toEqual({
      sessionID: undefined,
      messageID: "msg_1",
      partID: "prt_3",
    });

    expect(
      extractGlobalEventSessionMeta(
        event("message.part.removed", {
          sessionID: "ses_1",
          messageID: "msg_1",
          partID: "prt_2",
        }),
      ),
    ).toEqual({
      sessionID: "ses_1",
      messageID: "msg_1",
      partID: "prt_2",
    });
  });

  test("extracts session metadata from status, permission, question, and todo events", () => {
    expect(
      extractGlobalEventSessionMeta(
        event("session.status", {
          sessionID: "ses_1",
          status: { type: "busy" },
        }),
      ),
    ).toEqual({ sessionID: "ses_1" });
    expect(
      extractGlobalEventSessionMeta(
        event("session.updated", {
          info: { id: "ses_1" },
        }),
      ),
    ).toEqual({ sessionID: "ses_1" });
    expect(
      extractGlobalEventSessionMeta(
        event("permission.asked", {
          id: "perm_1",
          sessionID: "ses_1",
          messageID: "msg_1",
        }),
      ),
    ).toEqual({ sessionID: "ses_1", messageID: "msg_1" });
    expect(
      extractGlobalEventSessionMeta(
        event("question.replied", {
          sessionID: "ses_1",
          requestID: "q_1",
        }),
      ),
    ).toEqual({ sessionID: "ses_1" });
    expect(
      extractGlobalEventSessionMeta(
        event("todo.updated", {
          sessionID: "ses_1",
          todos: [],
        }),
      ),
    ).toEqual({ sessionID: "ses_1" });
  });

  test("does not match global events without session metadata", () => {
    expect(extractGlobalEventSessionMeta(event("project.updated", { id: "p1" }))).toEqual({});
    expect(isGlobalEventForSession(entry(event("lsp.updated", {})), "ses_1")).toBe(false);
  });

  test("filters only the requested session", () => {
    expect(
      isGlobalEventForSession(
        entry(event("message.updated", { info: { id: "msg_1", sessionID: "ses_1" } })),
        "ses_1",
      ),
    ).toBe(true);
    expect(
      isGlobalEventForSession(
        entry(event("message.updated", { info: { id: "msg_2", sessionID: "ses_2" } })),
        "ses_1",
      ),
    ).toBe(false);
    expect(
      isGlobalEventForSession(
        entry(event("message.updated", { info: { id: "msg_1", sessionID: "ses_1" } })),
        undefined,
      ),
    ).toBe(false);
    expect(
      isGlobalEventForSession(
        entry(event("message.part.delta", { messageID: "msg_1", partID: "prt_1" })),
        "ses_1",
      ),
    ).toBe(false);
  });

  test("falls back to raw stream session metadata for events without payload session id", () => {
    expect(
      isGlobalEventForSession(
        entry(
          event("message.part.delta", {
            messageID: "msg_1",
            partID: "prt_1",
            field: "text",
            delta: "hello",
          }),
          "evt",
          "ses_1",
        ),
        "ses_1",
      ),
    ).toBe(true);

    expect(
      isGlobalEventForSession(
        entry(
          event("message.part.delta", {
            messageID: "msg_1",
            partID: "prt_1",
            field: "text",
            delta: "hello",
          }),
          "evt",
          "ses_2",
        ),
        "ses_1",
      ),
    ).toBe(false);
  });

  test("keeps the newest entries within the configured limit", () => {
    const entries = Array.from({ length: 3 }, (_, index) =>
      entry(event("session.status", { sessionID: "ses_1" }), `evt_${index}`),
    );
    const next = appendGlobalEventDebugEntry(
      entries,
      entry(event("session.status", { sessionID: "ses_1" }), "evt_3"),
      2,
    );

    expect(next.map((item) => item.id)).toEqual(["evt_2", "evt_3"]);
  });
});
