import type { CatalogStore } from "../../catalog-store.ts";
import type { ActionPolicyService } from "../../core/action-policy.ts";
import type { RuntimeDatabase } from "../storage/runtime-database.ts";
import type { ActionRunner, ActionRunResult } from "./action-runner.ts";
import type { ConnectionService } from "../../connection-service.ts";
import { emptyPolicyRules } from "../../core/action-policy.ts";

/** Internal host capability. Never decode this object from a public HTTP request. */
export interface ScopedActionInput {
  service: string;
  actionId: string;
  connectionId?: string;
  noAuth: boolean;
  input: unknown;
  signal?: AbortSignal;
}

export interface ScopedActionDependencies {
  catalog: Pick<CatalogStore, "actionsById">;
  policy: ActionPolicyService;
  runtimePolicy: RuntimeDatabase["runtimePolicyStore"];
  actions: Pick<ActionRunner, "run">;
  connections: Pick<ConnectionService, "getConnectionSummary">;
}

/** Reuses the normal runner without issuing a persistent runtime token per call. */
export function createScopedActionExecutor(options: ScopedActionDependencies) {
  return async (input: ScopedActionInput): Promise<ActionRunResult | undefined> => {
    const action = options.catalog.actionsById.get(input.actionId);
    if (!action || action.service !== input.service) throw new Error("Scoped action does not match its service.");
    // Policy rules support wildcards; host capabilities only allow literal action identities.
    if (!input.actionId || /[*?]/.test(input.actionId)) throw new Error("Scoped action must be an exact identity.");
    if (input.noAuth) {
      if (!action.execution.noAuthRunnable || input.connectionId !== undefined)
        throw new Error("Scoped public action is not eligible for no-auth execution.");
    } else if (!input.connectionId?.trim()) {
      // An empty connection grant means unrestricted in the existing engine policy.
      throw new Error("Scoped authenticated action requires a fixed connection.");
    }
    const connection = await options.connections.getConnectionSummary(input.service, undefined, input.connectionId);
    if (!connection || (input.noAuth ? connection.authType !== "no_auth" : connection.id !== input.connectionId || connection.authType === "no_auth"))
      throw new Error("Scoped connection is unavailable or has a different authentication mode.");
    const runtime = await options.runtimePolicy.get();
    const policy = options.policy.createSnapshot(runtime?.rules ?? emptyPolicyRules(), {
      allowedActions: [input.actionId],
      blockedActions: [],
      allowedConnections: [connection.id],
      allowedProxies: [],
      allowedTriggers: [],
    }, runtime?.updatedAt);
    return options.actions.run({
      actionId: input.actionId,
      connectionId: connection.id,
      input: input.input,
      caller: "mcp",
      policy,
      signal: input.signal,
    });
  };
}
