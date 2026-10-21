import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { authorizeRepository } from "./auth";

// "Reviewed" checkboxes in the Code tab: private to each developer and reset by a new head.
export const list = query({ args: { token: v.string(), reviewId: v.id("reviews") }, handler: async (ctx, a) => {
  const review = await ctx.db.get(a.reviewId);
  if (!review) throw new Error("Review not found");
  const { user } = await authorizeRepository(ctx, a.token, review.repositoryId);
  const rows = await ctx.db.query("fileReviews").withIndex("by_user_pr", (q) => q.eq("userId", user._id).eq("repositoryId", review.repositoryId).eq("prNumber", review.prNumber)).take(2000);
  return rows.filter((r) => r.headSha === review.headSha).map((r) => r.path);
} });
export const mark = mutation({ args: { token: v.string(), reviewId: v.id("reviews"), path: v.string(), reviewed: v.boolean() }, handler: async (ctx, a) => {
  const review = await ctx.db.get(a.reviewId);
  if (!review) throw new Error("Review not found");
  if (!a.path || a.path.length > 1000) throw new Error("Invalid path");
  const { user } = await authorizeRepository(ctx, a.token, review.repositoryId);
  const old = (await ctx.db.query("fileReviews").withIndex("by_user_pr", (q) => q.eq("userId", user._id).eq("repositoryId", review.repositoryId).eq("prNumber", review.prNumber)).take(2000)).find((r) => r.path === a.path);
  if (!a.reviewed) { if (old) await ctx.db.delete(old._id); return; }
  const row = { organizationId: review.organizationId, userId: user._id, repositoryId: review.repositoryId, prNumber: review.prNumber, path: a.path, headSha: review.headSha, updatedAt: Date.now() };
  if (old) await ctx.db.patch(old._id, row); else await ctx.db.insert("fileReviews", row);
} });
