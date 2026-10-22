"use node";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { ConvexError } from "convex/values";
import { anthropicDefaults, HttpModel, modelFromEnvironment, type ModelCache } from "../src/engine/model";
import { decryptCredential } from "../src/credentials";
import { egressAllowed } from "../src/egress";
import { InferenceBudgetError, modelAllowed, type InferenceBilling } from "../src/inference-billing";
// With a workspace, calls also use that workspace's monthly usage (billing on); its refusal reason is shown as is.
export function inferenceBilling(ctx: ActionCtx, organizationId?: Id<"organizations">): InferenceBilling {
  return {
    async reserve(quote) {
      try { return await ctx.runMutation(internal.inferenceBudget.reserve, { ...quote, organizationId }); }
      catch (error) {
        if (error instanceof ConvexError && typeof error.data === "string") throw new InferenceBudgetError(error.data);
        throw new InferenceBudgetError("Inference budget unavailable, exhausted, or model pricing unsupported; no provider request was sent");
      }
    },
    async settle(id, usage) { await ctx.runMutation(internal.inferenceBudget.settle, { id: id as Id<"inferenceReservations">, ...usage }); },
  };
}
// The workspace's own key when it saved one: its provider bills it, so the operator's inference budget is
// not reserved, and workspace or repository model settings (models of the operator's provider) do not apply.
// Without a model from the caller the workspace's chosen model applies; a choice no longer on the operator's
// list falls back to the operator's model.
export async function budgetModel(ctx: ActionCtx, organizationId: Id<"organizations">, model?: string, cache?: ModelCache) {
  // Offline mode keeps model traffic on the operator's endpoint, so saved workspace keys are ignored there.
  const key = egressAllowed("workspace-model") ? await ctx.runQuery(internal.modelKeys.forWorkspace, { organizationId }) : null;
  if (!key) {
    const chosen = model ?? await ctx.runQuery(internal.scopes.workspaceModel, { organizationId });
    return modelFromEnvironment(chosen && modelAllowed(chosen) ? chosen : undefined, cache, inferenceBilling(ctx, organizationId));
  }
  const anthropic = key.provider === "anthropic";
  return new HttpModel({
    provider: key.provider,
    apiKey: decryptCredential(key.credentials, `${organizationId}:model`),
    model: key.model ?? (anthropic ? anthropicDefaults.model : "gpt-4.1"),
    ...(!key.model && anthropic ? { taskModels: anthropicDefaults.tasks } : {}),
    structuredOutput: process.env.LLM_STRUCTURED_OUTPUT !== "false",
    workspaceKey: true,
  }, cache);
}
