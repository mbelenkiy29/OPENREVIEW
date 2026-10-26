import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { fixAllowance, hasEntitlement, releaseFix } from "./billing";
import { upgradeNote } from "../src/plans";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { audit, authorizeRepository } from "./auth";
import { requireContextReader, requireFindingReader } from "./repositoryContext";
import { effectiveSettings } from "./scopes";
import { rateLimit } from "./rateLimit";
import { eligibleFixFinding } from "../src/fix-prompt";
import { recordConversion } from "./conversions";

// "Fix with OpenReview" from the dashboard, and "@openreview fix this in a new PR": OpenReview's fix agent
// (fixPullRequestJobs.run) edits the code and opens a pull request on a new branch. Each run counts against
// the plan's monthly agent fixes. Only GitHub App repositories, since the requester's GitHub account must
// be checked for write access on GitHub too.

/** Whether the repository's GitHub App installation granted Contents: Read and write. */
async function contentsPermission(ctx: QueryCtx, repo: Doc<"repositories">): Promise<"write" | "read" | "unknown"> {
  if (repo.connectionId || repo.installationId === undefined) return "unknown";
  const installationId = repo.installationId;
  const installation = await ctx.db.query("githubInstallations").withIndex("by_installation", (q) => q.eq("installationId", installationId)).unique();
  if (!installation?.permissions) return "unknown";
  return installation.permissions.contents === "write" ? "write" : "read";
}
export const availability = query({
  args: { token: v.string(), reviewId: v.id("reviews") },
  handler: async (ctx, a) => {
    const review = await ctx.db.get(a.reviewId);
    if (!review) throw new Error("Review not found");
    const { repo } = await authorizeRepository(ctx, a.token, review.repositoryId);
    const settings = await effectiveSettings(ctx, repo);
    return { github: !repo.connectionId && !review.nativeP4, enabled: settings.fixPullRequests === true, entitled: await hasEntitlement(ctx, review.organizationId, "fix.pullRequests"), permission: await contentsPermission(ctx, repo) };
  },
});
// A run that is still queued or running for the same finding, so a double click doesn't spend twice.
async function activeRun(ctx: MutationCtx, reviewId: Id<"reviews">, findingId: Id<"findings">, now: number) {
  const runs = await ctx.db.query("fixRequests").withIndex("by_review", (q) => q.eq("reviewId", reviewId)).filter((q) => q.and(q.eq(q.field("kind"), "hosted"), q.gt(q.field("expiresAt"), now))).collect();
  return runs.some((r) => (r.status === "queued" || r.status === "running") && r.findingIds?.includes(findingId));
}
const runWindow = 15 * 60_000;
export const start = mutation({
  args: { token: v.string(), findingId: v.id("findings") },
  handler: async (ctx, a) => {
    const finding = await ctx.db.get(a.findingId);
    const review = finding ? await ctx.db.get(finding.reviewId) : null;
    if (!finding || !review) throw new Error("Finding not found");
    const { user, repo } = await authorizeRepository(ctx, a.token, review.repositoryId, true);
    await requireContextReader(ctx, user._id, review);
    await requireFindingReader(ctx, user._id, finding);
    await rateLimit(ctx, `fix-pull-request:${user._id}`, 10);
    if (repo.connectionId || review.nativeP4) throw new Error("Fix pull requests from the dashboard are available for GitHub App repositories; on other providers reply “@openreview fix this” in the finding thread");
    if (!repo.enabled) throw new Error("Repository disabled");
    const latest = await ctx.db.query("reviews").withIndex("by_pr", (q) => q.eq("repositoryId", repo._id).eq("prNumber", review.prNumber)).order("desc").first();
    if (latest?._id !== review._id || review.status !== "completed") throw new Error("Open a fix pull request from the latest completed review");
    const settings = await effectiveSettings(ctx, repo);
    if (settings.fixPullRequests !== true) throw new Error("Fix pull requests are turned off for this repository; a workspace admin can allow them in repository settings");
    if (!await hasEntitlement(ctx, review.organizationId, "fix.pullRequests")) throw new Error(upgradeNote["fix.pullRequests"]);
    if (!eligibleFixFinding(finding, review, latest._id, settings.minimumConfidence)) throw new Error("This finding can no longer be fixed at this revision");
    const identity = await ctx.db.query("identities").withIndex("by_user", (q) => q.eq("userId", user._id)).filter((q) => q.eq(q.field("provider"), "github")).first();
    const githubId = identity ? Number(identity.providerUserId) : user.githubId;
    if (!githubId || !Number.isInteger(githubId)) throw new Error("Sign in with GitHub once to link your GitHub account; fix pull requests check your write access on GitHub");
    const now = Date.now();
    if (await activeRun(ctx, review._id, finding._id, now)) throw new Error("OpenReview is already fixing this finding; wait for that run to finish");
    const allowance = await fixAllowance(ctx, review.organizationId);
    if (!allowance.allowed) throw new Error(allowance.reason.replace(/^Billing: /, ""));
    const requestId = await ctx.db.insert("fixRequests", { userId: user._id, organizationId: review.organizationId, repositoryId: repo._id, reviewId: review._id, headSha: review.headSha, findingIds: [finding._id], agent: "openreview", prompt: "", status: "queued", kind: "hosted", expiresAt: now + runWindow, createdAt: now, updatedAt: now });
    await audit(ctx, review.organizationId, user._id, "fix_pull_request.requested", finding._id);
    await ctx.scheduler.runAfter(0, internal.fixPullRequestJobs.run, { findingId: finding._id, requestId, userId: user._id, githubId });
    return requestId;
  },
});
// "@openreview fix this in a new PR" from a comment author the reply job already checked; returns the line
// the reply shows. The fix agent replies in the same thread when it finishes.
export const startFromComment = internalMutation({
  args: { findingId: v.id("findings"), author: v.string(), prNumber: v.number(), commentId: v.optional(v.union(v.number(), v.string())) },
  handler: async (ctx, a): Promise<string> => {
    const finding = await ctx.db.get(a.findingId);
    if (!finding) throw new Error("Finding not found");
    if (!await hasEntitlement(ctx, finding.organizationId, "fix.pullRequests")) {
      await recordConversion(ctx, "paywall", `fix.pullRequests:${finding.organizationId}`, { organizationId: finding.organizationId, method: "fix.pullRequests" });
      return upgradeNote["fix.pullRequests"];
    }
    const allowance = await fixAllowance(ctx, finding.organizationId);
    if (!allowance.allowed) return allowance.reason.replace(/^Billing: /, "");
    await audit(ctx, finding.organizationId, undefined, "fix_pull_request.requested", `${finding._id} by @${a.author.slice(0, 100)}`);
    await ctx.scheduler.runAfter(0, internal.fixPullRequestJobs.run, { findingId: finding._id, author: a.author, replyTo: { prNumber: a.prNumber, ...(a.commentId !== undefined ? { commentId: a.commentId } : {}) } });
    return "OpenReview's fix agent is preparing a fix pull request and will reply here with the link.";
  },
});
export const progress = internalMutation({
  args: { requestId: v.id("fixRequests"), status: v.union(v.literal("running"), v.literal("opened"), v.literal("failed")), error: v.optional(v.string()), pullRequestUrl: v.optional(v.string()) },
  handler: async (ctx, { requestId, ...patch }) => { await ctx.db.patch(requestId, { ...patch, updatedAt: Date.now() }); },
});
// A run that stopped before its first model call gives its agent fix back.
export const release = internalMutation({ args: { organizationId: v.id("organizations") }, handler: (ctx, a) => releaseFix(ctx, a.organizationId) });
export const finding = internalQuery({ args: { findingId: v.id("findings") }, handler: async (ctx, a) => ctx.db.get(a.findingId) });
export const recordResult = internalMutation({
  args: { organizationId: v.id("organizations"), userId: v.optional(v.id("users")), findingId: v.id("findings"), opened: v.boolean(), detail: v.string() },
  handler: async (ctx, a) => {
    await audit(ctx, a.organizationId, a.userId, a.opened ? "fix_pull_request.opened" : "fix_pull_request.skipped", `${a.findingId}: ${a.detail.slice(0, 300)}`);
  },
});
/** Permissions read from a fresh installation token, so settings show what GitHub actually granted. */
export const recordPermissions = internalMutation({
  args: { installationId: v.number(), permissions: v.record(v.string(), v.string()) },
  handler: async (ctx, a) => {
    const installation = await ctx.db.query("githubInstallations").withIndex("by_installation", (q) => q.eq("installationId", a.installationId)).unique();
    if (installation) await ctx.db.patch(installation._id, { permissions: a.permissions, permissionsCheckedAt: Date.now() });
  },
});
