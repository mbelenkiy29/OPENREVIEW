import { v } from "convex/values";
import { action, internalMutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { authorizeRepository } from "./auth";
import { reviewAllowance } from "./billing";
import { rateLimit } from "./rateLimit";
import { localReviewRequest, type LocalReviewProgress } from "../src/cli-review";

// Reviews of local commits from a logged-in CLI. A review counts against the plan like a pull request
// review, and its model calls are recorded as "cli-review" usage. Only the requester can read the result.
const stuckMs = 15 * 60_000, keepMs = 24 * 60 * 60_000;
type Started = { id: Id<"cliReviews"> } | { refused: string; status: 402 | 409 };

// Stores the upload first (mutations cannot hold several MB), then creates the review; a refused
// review deletes the upload again.
export const start = action({
  args: { token: v.string(), organizationId: v.id("organizations"), repositoryId: v.string(), baseSha: v.string(), headSha: v.string(), title: v.string(), mode: v.optional(v.string()), security: v.boolean(), instructions: v.optional(v.string()), diff: v.string(), files: v.array(v.object({ path: v.string(), sha: v.string(), content: v.string() })) },
  handler: async (ctx, a): Promise<Started> => {
    const { token, organizationId, ...request } = a;
    const { diff, files, ...meta } = localReviewRequest.parse(request);
    const inputStorageId = await ctx.storage.store(new Blob([JSON.stringify({ diff, files })], { type: "application/json" }));
    try {
      const started: Started = await ctx.runMutation(internal.cliReviews.create, { token, organizationId, ...meta, inputStorageId });
      if ("refused" in started) await ctx.storage.delete(inputStorageId);
      return started;
    } catch (error) {
      await ctx.storage.delete(inputStorageId);
      throw error;
    }
  },
});

export const create = internalMutation({
  args: { token: v.string(), organizationId: v.id("organizations"), repositoryId: v.string(), baseSha: v.string(), headSha: v.string(), title: v.string(), mode: v.optional(v.string()), security: v.boolean(), instructions: v.optional(v.string()), inputStorageId: v.id("_storage") },
  handler: async (ctx, a): Promise<Started> => {
    const repositoryId = ctx.db.normalizeId("repositories", a.repositoryId);
    if (!repositoryId) throw new Error("Repository not found");
    const { user, repo } = await authorizeRepository(ctx, a.token, repositoryId, true);
    if (repo.organizationId !== a.organizationId) throw new Error("Repository not found");
    await rateLimit(ctx, `review:${repo.organizationId}`, 20);
    if (!repo.enabled) return { refused: `${repo.fullName} is not enabled in OpenReview. Enable it under Repositories, or review with --local.`, status: 409 };
    if (!repo.indexedSha) return { refused: `${repo.fullName} has not been indexed yet. Try again once Repositories shows it ready, or review with --local.`, status: 409 };
    const allowance = await reviewAllowance(ctx, repo.organizationId);
    if (!allowance.allowed) return { refused: allowance.reason, status: 402 };
    const now = Date.now();
    const id = await ctx.db.insert("cliReviews", { organizationId: repo.organizationId, repositoryId, userId: user._id, status: "queued", baseSha: a.baseSha, headSha: a.headSha, title: a.title, ...(a.mode ? { mode: a.mode } : {}), security: a.security, ...(a.instructions ? { instructions: a.instructions } : {}), inputStorageId: a.inputStorageId, createdAt: now, updatedAt: now });
    await ctx.scheduler.runAfter(0, internal.cliReviewJobs.run, { id });
    await ctx.scheduler.runAfter(stuckMs, internal.cliReviews.expire, { id });
    await ctx.scheduler.runAfter(keepMs, internal.cliReviews.remove, { id });
    return { id };
  },
});

export const progress = query({
  args: { token: v.string(), organizationId: v.id("organizations"), id: v.string() },
  handler: async (ctx, a): Promise<LocalReviewProgress> => {
    const id = ctx.db.normalizeId("cliReviews", a.id), row = id ? await ctx.db.get(id) : null;
    if (!row || row.organizationId !== a.organizationId) throw new Error("Review not found");
    const { user } = await authorizeRepository(ctx, a.token, row.repositoryId);
    if (row.userId !== user._id) throw new Error("Review not found");
    return { id: row._id, status: row.status, stage: row.stage ?? null, error: row.error ?? null, result: row.result ? JSON.parse(row.result) : null };
  },
});

export const claim = internalMutation({
  args: { id: v.id("cliReviews") },
  handler: async (ctx, a) => {
    const row = await ctx.db.get(a.id);
    if (!row || row.status !== "queued" || !row.inputStorageId) return null;
    await ctx.db.patch(a.id, { status: "running", updatedAt: Date.now() });
    return { ...row, inputStorageId: row.inputStorageId };
  },
});

export const stage = internalMutation({
  args: { id: v.id("cliReviews"), stage: v.string() },
  handler: async (ctx, a) => {
    const row = await ctx.db.get(a.id);
    if (row?.status === "running") await ctx.db.patch(a.id, { stage: a.stage.slice(0, 100), updatedAt: Date.now() });
  },
});

// Ends a review and deletes the uploaded code; a review that already ended is left as it is.
export const finish = internalMutation({
  args: { id: v.id("cliReviews"), result: v.optional(v.string()), error: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const row = await ctx.db.get(a.id);
    if (!row || (row.status !== "queued" && row.status !== "running")) return;
    if (row.inputStorageId) await ctx.storage.delete(row.inputStorageId);
    await ctx.db.patch(a.id, { ...(a.error === undefined ? { status: "completed" as const, result: a.result } : { status: "failed" as const, error: a.error.slice(0, 2000) }), inputStorageId: undefined, updatedAt: Date.now() });
  },
});

// A review whose action died never finishes on its own.
export const expire = internalMutation({
  args: { id: v.id("cliReviews") },
  handler: async (ctx, a) => {
    const row = await ctx.db.get(a.id);
    if (!row || (row.status !== "queued" && row.status !== "running")) return;
    if (row.inputStorageId) await ctx.storage.delete(row.inputStorageId);
    await ctx.db.patch(a.id, { status: "failed", error: "The review did not finish in time. Run it again.", inputStorageId: undefined, updatedAt: Date.now() });
  },
});

export const remove = internalMutation({
  args: { id: v.id("cliReviews") },
  handler: async (ctx, a) => {
    const row = await ctx.db.get(a.id);
    if (!row) return;
    if (row.inputStorageId) await ctx.storage.delete(row.inputStorageId);
    await ctx.db.delete(a.id);
  },
});
