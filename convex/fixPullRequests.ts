import { internalMutation, internalQuery, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { audit, authorizeRepository } from "./auth";
import { requireContextReader, requireFindingReader } from "./repositoryContext";
import { effectiveSettings } from "./scopes";
import { rateLimit } from "./rateLimit";
import { eligibleFixFinding } from "../src/fix-prompt";

// "Open a fix PR" from the dashboard: the same fix pull request "@openreview fix this in a new PR"
// opens, started by a signed-in user with repository write access. Only GitHub App repositories, since
// the user's linked GitHub account must be checked for write access on GitHub too.

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
    return { github: !repo.connectionId && !review.nativeP4, enabled: settings.fixPullRequests === true, permission: await contentsPermission(ctx, repo) };
  },
});
export const authorizeOpen = internalMutation({
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
    if (!eligibleFixFinding(finding, review, latest._id, settings.minimumConfidence)) throw new Error("This finding can no longer be fixed at this revision");
    const identity = await ctx.db.query("identities").withIndex("by_user", (q) => q.eq("userId", user._id)).filter((q) => q.eq(q.field("provider"), "github")).first();
    const githubId = identity ? Number(identity.providerUserId) : user.githubId;
    if (!githubId || !Number.isInteger(githubId)) throw new Error("Sign in with GitHub once to link your GitHub account; fix pull requests check your write access on GitHub");
    await audit(ctx, review.organizationId, user._id, "fix_pull_request.requested", finding._id);
    return { userId: user._id, organizationId: review.organizationId, repositoryId: repo._id, githubId };
  },
});
export const finding = internalQuery({ args: { findingId: v.id("findings") }, handler: async (ctx, a) => ctx.db.get(a.findingId) });
export const recordResult = internalMutation({
  args: { organizationId: v.id("organizations"), userId: v.id("users"), findingId: v.id("findings"), opened: v.boolean(), detail: v.string() },
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
