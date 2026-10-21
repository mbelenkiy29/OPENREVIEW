"use node";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import { budgetModel } from "./budgetModel";
import { buildTour } from "../src/pull-tour";
import { ModelFailure } from "../src/engine/model";

// Builds the Code tab's guided tour for a finished review once, on request.
export const generate = action({ args: { token: v.string(), reviewId: v.id("reviews") }, handler: async (ctx, a): Promise<void> => {
  const review = await ctx.runQuery(internal.tours.context, a);
  if (review.tour) return;
  const diff = await ctx.runAction(api.reviewDiff.load, a);
  if (diff.source === "unavailable" || !diff.files.length) throw new Error(diff.reason ?? "The reviewed diff is not available");
  await ctx.runMutation(internal.tours.reserve, { organizationId: review.organizationId });
  const record = (u: { inputTokens: number; outputTokens: number; estimatedCost: number; latencyMs: number }) => ctx.runMutation(internal.usage.record, { repositoryId: review.repositoryId, kind: "tour", inputTokens: u.inputTokens, outputTokens: u.outputTokens, estimatedCost: u.estimatedCost, durationMs: u.latencyMs });
  try {
    const { steps, usage } = await buildTour(await budgetModel(ctx, review.organizationId), { title: review.title ?? `#${review.prNumber}`, summary: review.summary, files: diff.files });
    await record(usage);
    await ctx.runMutation(internal.tours.save, { reviewId: a.reviewId, steps });
  } catch (error) {
    if (error instanceof ModelFailure) await record(error.usage);
    throw error;
  }
} });
