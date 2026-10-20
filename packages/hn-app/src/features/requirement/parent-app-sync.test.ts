import { describe, expect, it, vi } from "vitest";
import {
  notifyRequirementParentAppId,
  REQUIREMENT_APP_ID_CHANGE_MESSAGE,
} from "./parent-app-sync";

function frame(input?: {
  parent?: { postMessage: ReturnType<typeof vi.fn> };
  top?: { postMessage: ReturnType<typeof vi.fn> };
}) {
  const current = {
    parent: undefined as unknown,
    top: undefined as unknown,
    postMessage: vi.fn(),
  };
  current.parent = input?.parent ?? current;
  current.top = input?.top ?? current;
  return current as unknown as Window;
}

describe("notifyRequirementParentAppId", () => {
  it("does not post outside an iframe", () => {
    const current = frame();

    notifyRequirementParentAppId("app-a", current);

    expect(current.postMessage).not.toHaveBeenCalled();
  });

  it("posts the selected appId to the parent window", () => {
    const parent = { postMessage: vi.fn() };
    const current = frame({ parent });

    notifyRequirementParentAppId(" app-a ", current);

    expect(parent.postMessage).toHaveBeenCalledWith(
      {
        type: REQUIREMENT_APP_ID_CHANGE_MESSAGE,
        payload: { appId: "app-a" },
      },
      "*",
    );
  });

  it("also posts to top when it is a distinct ancestor", () => {
    const parent = { postMessage: vi.fn() };
    const top = { postMessage: vi.fn() };
    const current = frame({ parent, top });

    notifyRequirementParentAppId("app-a", current);

    const expectedMessage = {
      type: REQUIREMENT_APP_ID_CHANGE_MESSAGE,
      payload: { appId: "app-a" },
    };
    expect(parent.postMessage).toHaveBeenCalledWith(expectedMessage, "*");
    expect(top.postMessage).toHaveBeenCalledWith(expectedMessage, "*");
  });

  it("does not post an empty appId", () => {
    const parent = { postMessage: vi.fn() };
    const current = frame({ parent });

    notifyRequirementParentAppId("   ", current);

    expect(parent.postMessage).not.toHaveBeenCalled();
  });
});
