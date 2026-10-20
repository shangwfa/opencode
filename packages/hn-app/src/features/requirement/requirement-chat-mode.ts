import { OPENCODE_DIRECTORY_ROUTE_SLUG } from "./opencode-directory";

const CHAT_DIR = OPENCODE_DIRECTORY_ROUTE_SLUG;

export function requirementNotFound(err: unknown) {
  return (
    err instanceof Error &&
    (err.message.includes("不存在") || err.message.includes("已删除"))
  );
}

/** 需求中心 appId，与路由 `/requirements/:repo`、对话 `/requirement-chat/:repo` 一致 */
export function requirementListPath(repo: string) {
  return `/requirements/${encodeURIComponent(repo.trim())}`;
}

export function requirementDetailPath(repo: string, reqId: string) {
  return `${requirementListPath(repo)}/requirement/${encodeURIComponent(reqId.trim())}`;
}

export function requirementRecordingUploadsPath(repo: string, reqId: string) {
  return `${routerBase()}${requirementDetailPath(repo, reqId)}/recordings`;
}

const routerBase = () =>
  (import.meta.env.VITE_ROUTER_BASE as string | undefined)?.trim() ?? "";

function buildRequirementChatPath(input: {
  repo: string;
  sessionId: string;
  reqId: string;
  fresh?: boolean;
}) {
  const repo = encodeURIComponent(input.repo.trim());
  const sid = encodeURIComponent(input.sessionId.trim());
  const q = new URLSearchParams({ req: input.reqId.trim() });
  if (input.fresh) q.set("fresh", "1");
  return `/${encodeURIComponent(CHAT_DIR)}/requirement-chat/${repo}/${sid}?${q.toString()}`;
}

export function requirementChatPath(input: {
  repo: string;
  sessionId: string;
  reqId: string;
  fresh?: boolean;
}) {
  return `${routerBase()}${buildRequirementChatPath(input)}`;
}

export function requirementChatPathRelative(input: {
  repo: string;
  sessionId: string;
  reqId: string;
  fresh?: boolean;
}) {
  return buildRequirementChatPath(input);
}
