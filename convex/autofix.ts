import { internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { audit } from "./auth";
import { hasEntitlement } from "./billing";
import { effectiveSettings } from "./scopes";
import { fixPullRequestOpened } from "./issueLifecycle";
import { eligibleFixFinding } from "../src/fix-prompt";

// Autofix (Pro, repository setting): when a review completes, fix pull requests open for its
// critical and high findings without anyone asking. autofixJobs.run does the provider work.
const severities = ["critical", "high"];
// shortcut: fixed cap of 3 fix pull requests per review; make it a setting if users ask.
const perReview = 3;

/** Whether a completed review should start Autofix: GitHub App repositories with fix pull requests
 *  and Autofix on, on a plan that includes them, and at least one critical or high finding. */
export async function autofixWanted(ctx: QueryCtx, review: Doc<"reviews">) {
  const repo = await ctx.db.get(review.repositoryId);
  if (!repo?.enabled || repo.connectionId || review.nativeP4) return false;
  const settings = await effectiveSettings(ctx, repo);
  if (!settings.fixPullRequests || !settings.autofix || !await hasEntitlement(ctx, review.organizationId, "fix.pullRequests")) return false;
  return (await ctx.db.query("findings").withIndex("by_review", (q) => q.eq("reviewId", review._id)).take(500)).some((f) => f.status === "open" && severities.includes(f.severity));
}

/** The review's findings to fix, re-checked when the job runs: still the latest completed review,
 *  fixable at its head, and no fix pull request on their issue yet. Critical first. */
export const targets = internalQuery({
  args: { reviewId: v.id("reviews") },
  handler: async (ctx, a) => {
    const review = await ctx.db.get(a.reviewId);
    if (!review || review.status !== "completed" || !await autofixWanted(ctx, review)) return null;
    const repo = (await ctx.db.get(review.repositoryId))!;
    const latest = await ctx.db.query("reviews").withIndex("by_pr", (q) => q.eq("repositoryId", repo._id).eq("prNumber", review.prNumber)).order("desc").first();
    const minimumConfidence = (await effectiveSettings(ctx, repo)).minimumConfidence;
    const findings: Doc<"findings">[] = [];
    for (const f of await ctx.db.query("findings").withIndex("by_review", (q) => q.eq("reviewId", review._id)).take(500)) {
      if (!severities.includes(f.severity) || !eligibleFixFinding(f, review, latest?._id, minimumConfidence)) continue;
      const issue = f.issueId ? await ctx.db.get(f.issueId) : null;
      if (!issue?.fixPullRequestUrl) findings.push(f);
    }
    findings.sort((x, y) => severities.indexOf(x.severity) - severities.indexOf(y.severity));
    return { repo, prNumber: review.prNumber, headSha: review.headSha, findings: findings.slice(0, perReview) };
  },
});

export const record = internalMutation({
  args: { findingId: v.id("findings"), url: v.optional(v.string()), note: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const finding = await ctx.db.get(a.findingId);
    if (!finding) return;
    if (a.url) await fixPullRequestOpened(ctx, finding, a.url, true);
    await audit(ctx, finding.organizationId, undefined, a.url ? "fix_pull_request.autofix" : "fix_pull_request.autofix_skipped", `${finding._id}: ${(a.url ?? a.note ?? "").slice(0, 300)}`);
  },
});
