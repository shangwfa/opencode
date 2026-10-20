export type AncestorMessageTarget = "parent" | "top";

export type AncestorMessageWindow = Pick<Window, "parent" | "top" | "postMessage">;

export interface PostMessageToAncestorWindowsOptions {
  frameWindow?: AncestorMessageWindow;
  targetOrigin?: string;
  targets?: AncestorMessageTarget[];
}

export function ancestorWindows(
  frameWindow: AncestorMessageWindow = window,
  targets: AncestorMessageTarget[] = ["parent", "top"],
): Window[] {
  return targets
    .map((target) => frameWindow[target])
    .filter(
      (target, index, all): target is Window =>
        !!target && target !== frameWindow && all.indexOf(target) === index,
    );
}

export function postMessageToAncestorWindows(
  message: unknown,
  options: PostMessageToAncestorWindowsOptions = {},
) {
  const {
    frameWindow = window,
    targetOrigin = "*",
    targets,
  } = options;

  for (const target of ancestorWindows(frameWindow, targets)) {
    target.postMessage(message, targetOrigin);
  }
}
