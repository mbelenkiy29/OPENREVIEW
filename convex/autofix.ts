import { internalMutation } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { audit } from "./auth";
import { fixAllowance, hasEntitlement } from "./billing";
import { effectiveSettings } from "./scopes";
import { eligibleFixFinding } from "../src/fix-prompt";

// Autofix (repository setting, plans with fix.pullRequests): when a review completes, OpenReview's fix
// agent (fixPullRequestJobs.run) starts for its critical and high findings without anyone asking, for the
// pull request's author. Each run counts toward the plan's monthly fix pull requests (fixAllowance).
const severities = ["critical", "high"];
// shortcut: fixed cap of 3 fix pull requests per review; make it a setting if users ask.
const perReview = 3;

/** Whether a completed review should start Autofix: a GitHub App repository with fix pull requests and
 *  Autofix on, a plan that includes them, and at least one open critical or high finding. */
export async function autofixWanted(ctx: QueryCtx, review: Doc<"reviews">) {
  const repo = await ctx.db.get(review.repositoryId);
  if (!repo?.enabled || repo.connectionId || review.nativeP4) return false;
  const settings = await effectiveSettings(ctx, repo);
  if (!settings.fixPullRequests || !settings.autofix || !await hasEntitlement(ctx, review.organizationId, "fix.pullRequests")) return false;
  return (await ctx.db.query("findings").withIndex("by_review", (q) => q.eq("reviewId", review._id)).take(500)).some((f) => f.status === "open" && severities.includes(f.severity));
}

/** Picks the findings again when it runs (still the latest completed review, fixable at its head, no fix
 *  pull request on their issue yet; critical first) and starts one fix agent run for each. */
export const start = internalMutation({
  args: { reviewId: v.id("reviews") },
  handler: async (ctx, a): Promise<number> => {
    const review = await ctx.db.get(a.reviewId);
    if (!review || review.status !== "completed" || !await autofixWanted(ctx, review)) return 0;
    const repo = (await ctx.db.get(review.repositoryId))!;
    const pr = await ctx.db.query("pullRequests").withIndex("by_repo_number", (q) => q.eq("repositoryId", repo._id).eq("number", review.prNumber)).unique();
    if (!pr?.author) return 0;
    const latest = await ctx.db.query("reviews").withIndex("by_pr", (q) => q.eq("repositoryId", repo._id).eq("prNumber", review.prNumber)).order("desc").first();
    const minimumConfidence = (await effectiveSettings(ctx, repo)).minimumConfidence;
    const targets: Doc<"findings">[] = [];
    for (const f of await ctx.db.query("findings").withIndex("by_review", (q) => q.eq("reviewId", review._id)).take(500)) {
      if (!severities.includes(f.severity) || !eligibleFixFinding(f, review, latest?._id, minimumConfidence)) continue;
      const issue = f.issueId ? await ctx.db.get(f.issueId) : null;
      if (!issue?.fixPullRequestUrl) targets.push(f);
    }
    targets.sort((x, y) => severities.indexOf(x.severity) - severities.indexOf(y.severity));
    let started = 0;
    for (const finding of targets.slice(0, perReview)) {
      // Stops at the plan's monthly fix pull requests; the agent run gives its fix back if it never reaches the model.
      const allowance = await fixAllowance(ctx, review.organizationId);
      if (!allowance.allowed) { await audit(ctx, review.organizationId, undefined, "fix_pull_request.autofix_skipped", `${finding._id}: ${allowance.reason.slice(0, 300)}`); break; }
      await audit(ctx, review.organizationId, undefined, "fix_pull_request.autofix", `${finding._id} for @${pr.author.slice(0, 100)}`);
      await ctx.scheduler.runAfter(0, internal.fixPullRequestJobs.run, { findingId: finding._id, author: pr.author, automatic: true });
      started++;
    }
    return started;
  },
});
