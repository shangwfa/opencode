import { useEffect, useRef, useState } from "react"
import { fetchRequirementV2 } from "@/api/requirement/requirements-v2"
import { ApiUnauthorizedError } from "@/api/requirement/client"
import type { AggregateRequirement } from "@/api/requirement/types"

/**
 * 需求状态轮询（Solid createStore/on → React useState/useEffect，语义一致）。
 * 源：src/pages/requirement/requirementCreateChat/use-polled-requirement-status.ts
 */

export type RequirementStatusPhase =
  | "loading"
  | "preparing"
  | "ready"
  | "failed";

export type RequirementStatusState = {
  phase: RequirementStatusPhase;
  requirement: AggregateRequirement | null;
  error: string | null;
};

const POLL_INTERVAL_MS = 2500;

function resolvePhase(status: string): RequirementStatusPhase {
  if (status === "preparing") return "preparing";
  if (status === "failed") return "failed";
  if (status === "open" || status === "pending_publish" || status === "done")
    return "ready";
  return "preparing";
}

export function usePolledRequirementStatus(reqId: string | undefined) {
  const [state, setState] = useState<RequirementStatusState>({
    phase: "loading",
    requirement: null,
    error: null,
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 以 token 防止过期请求写回状态（对齐源 currentId 检查）
    let currentId: string | undefined = reqId;

    const poll = async (id: string) => {
      if (currentId !== id) return;
      try {
        const req = await fetchRequirementV2(id);
        if (currentId !== id) return;
        const phase = resolvePhase(req.status);
        setState({ phase, requirement: req, error: null });
        if (phase === "preparing") {
          timer = setTimeout(() => void poll(id), POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (currentId !== id) return;
        if (err instanceof ApiUnauthorizedError) {
          setState((prev) => ({ ...prev, phase: "failed", error: "用户未登录，请重新登录" }));
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("不存在或已删除")) {
          setState((prev) => ({ ...prev, phase: "failed", error: "需求不存在或已删除" }));
          return;
        }
        timer = setTimeout(() => void poll(id), POLL_INTERVAL_MS);
      }
    };

    if (!reqId) {
      setState({ phase: "loading", requirement: null, error: null });
      return () => {
        currentId = undefined;
        if (timer) clearTimeout(timer);
      };
    }

    setState({ phase: "loading", requirement: null, error: null });
    void poll(reqId);

    return () => {
      currentId = undefined;
      if (timer) clearTimeout(timer);
    };
  }, [reqId]);

  const mutate = (req: AggregateRequirement | null) => {
    setState((prev) => ({ ...prev, requirement: req }));
  };

  return { state, mutate };
}
