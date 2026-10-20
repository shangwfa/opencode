import {
  postMessageToAncestorWindows,
  type AncestorMessageWindow,
} from "@/shared/util/window-message";

export const REQUIREMENT_APP_ID_CHANGE_MESSAGE = "REQUIREMENT_APP_ID_CHANGE";

export interface RequirementAppIdChangeMessage {
  type: typeof REQUIREMENT_APP_ID_CHANGE_MESSAGE;
  payload: {
    appId: string;
  };
}

export function notifyRequirementParentAppId(
  appId: string,
  frameWindow: AncestorMessageWindow = window,
) {
  const value = appId.trim();
  if (!value) return;

  const message = {
    type: REQUIREMENT_APP_ID_CHANGE_MESSAGE,
    payload: { appId: value },
  } satisfies RequirementAppIdChangeMessage;

  postMessageToAncestorWindows(message, { frameWindow });
}

type NavigateTo = (path: string, options?: { replace?: boolean }) => void;

export function openRequirementProject(
  appId: string,
  navigate: NavigateTo,
  frameWindow?: AncestorMessageWindow,
) {
  const value = appId.trim();
  if (!value) return;
  notifyRequirementParentAppId(value, frameWindow);
  navigate(`/requirements/${encodeURIComponent(value)}`, {
    replace: true,
  });
}
