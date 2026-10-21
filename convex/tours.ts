import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { authorizeRepository } from "./auth";
import { rateLimit } from "./rateLimit";

// Tours cost a model call, so asking for one needs write access and is rate limited per workspace.
export const context = internalQuery({ args: { token: v.string(), reviewId: v.id("reviews") }, handler: async (ctx, a) => {
  const review = await ctx.db.get(a.reviewId);
  if (!review) throw new Error("Review not found");
  await authorizeRepository(ctx, a.token, review.repositoryId, true);
  return review;
} });
export const reserve = internalMutation({ args: { organizationId: v.id("organizations") }, handler: async (ctx, a) => { await rateLimit(ctx, `tour:${a.organizationId}`, 10); } });
export const save = internalMutation({ args: { reviewId: v.id("reviews"), steps: v.array(v.object({ title: v.string(), explanation: v.string(), files: v.array(v.string()) })) }, handler: async (ctx, a) => {
  await ctx.db.patch(a.reviewId, { tour: { steps: a.steps, createdAt: Date.now() } });
} });
