import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { audit, authenticated, authorizeRepository, service } from "./auth";
import { requireContextReader, requireFindingReader } from "./repositoryContext";
import { effectiveSettings } from "./scopes";
import { rateLimit } from "./rateLimit";
import { cloudAgentValidator } from "./schema";
import { eligibleFixFinding, fixPrompt } from "../src/fix-prompt";
import { findingSchema } from "../src/engine/types";

// Handing findings to a cloud agent (Claude, Codex, Copilot, Cursor) by a pull request comment posted
// as the developer. A request is created here ("intent"), claimed exactly once by the web route that
// posts the comment ("posting"), then recorded as posted or failed. The bridge never claims these rows:
// it only accepts status "pending".
const intentMinutes = 10;

async function eligible(ctx: MutationCtx, review: Doc<"reviews">, repo: Doc<"repositories">, userId: Id<"users">, findingIds?: Id<"findings">[]) {
  const latest = await ctx.db.query("reviews").withIndex("by_pr", (q) => q.eq("repositoryId", repo._id).eq("prNumber", review.prNumber)).order("desc").first();
  if (latest?._id !== review._id || review.status !== "completed") throw new Error("Hand off findings from the latest completed review");
  if (!repo.enabled) throw new Error("Repository disabled");
  const config = await effectiveSettings(ctx, repo);
  const findings = (await ctx.db.query("findings").withIndex("by_pr", (q) => q.eq("repositoryId", repo._id).eq("prNumber", review.prNumber)).collect())
    .filter((f) => eligibleFixFinding(f, review, latest._id, config.minimumConfidence) && (!findingIds || findingIds.includes(f._id)));
  if (!findings.length) throw new Error("No eligible unresolved findings at this revision");
  for (const finding of findings) await requireFindingReader(ctx, userId, finding);
  return findings;
}
export const prepare = mutation({
  args: { token: v.string(), reviewId: v.id("reviews"), findingId: v.optional(v.id("findings")), agent: cloudAgentValidator },
  handler: async (ctx, a) => {
    const review = await ctx.db.get(a.reviewId);
    if (!review) throw new Error("Review not found");
    const { user, repo } = await authorizeRepository(ctx, a.token, review.repositoryId, true);
    await requireContextReader(ctx, user._id, review);
    await rateLimit(ctx, `cloud-handoff:${user._id}`, 20);
    if (repo.connectionId || review.nativeP4 || repo.installationId === undefined) throw new Error("Cloud agents start from GitHub pull request comments; this repository is not on the OpenReview GitHub App");
    const findings = await eligible(ctx, review, repo, user._id, a.findingId ? [a.findingId] : undefined);
    const prompt = fixPrompt(repo.fullName, `PR #${review.prNumber}`, findings.map((f) => ({ ...findingSchema.parse(f), fingerprint: f.fingerprint, agent: f.agent, commitSha: f.commitSha })), review.runtimeEvidence);
    const now = Date.now();
    return ctx.db.insert("fixRequests", { kind: "cloud", userId: user._id, organizationId: review.organizationId, repositoryId: repo._id, reviewId: review._id, headSha: review.headSha, findingIds: findings.map((f) => f._id), agent: `cloud:${a.agent}`, prompt, status: "intent", expiresAt: now + intentMinutes * 60000, createdAt: now, updatedAt: now });
  },
});
// The web route claims the request once, right before posting. Everything is checked again: the review
// may have been replaced or the findings resolved while the developer was signing in to GitHub.
export const claim = mutation({
  args: { token: v.string(), secret: v.string(), requestId: v.id("fixRequests") },
  handler: async (ctx, a) => {
    service(a.secret);
    const user = await authenticated(ctx, a.token);
    const request = await ctx.db.get(a.requestId);
    if (!request || request.kind !== "cloud" || request.userId !== user._id || request.status !== "intent" || request.expiresAt < Date.now()) throw new Error("This hand-off expired or was already sent; start it again from the Fix page");
    await ctx.db.patch(request._id, { status: "posting", updatedAt: Date.now() });
    const review = await ctx.db.get(request.reviewId);
    if (!review || review.headSha !== request.headSha) throw new Error("The review changed; start the hand-off again");
    const { repo } = await authorizeRepository(ctx, a.token, request.repositoryId, true);
    await requireContextReader(ctx, user._id, review);
    const findings = await eligible(ctx, review, repo, user._id, request.findingIds);
    // Claude replies in the finding's own thread when there is one finding with a published comment.
    let commentId: number | undefined;
    if (findings.length === 1)
      for (const r of await ctx.db.query("reviews").withIndex("by_pr", (q) => q.eq("repositoryId", repo._id).eq("prNumber", review.prNumber)).order("desc").take(50)) {
        const comment = (await ctx.db.query("reviewComments").withIndex("by_review", (q) => q.eq("reviewId", r._id)).take(200)).find((c) => c.fingerprint === findings[0].fingerprint && typeof c.githubId === "number");
        if (comment) { commentId = comment.githubId as number; break; }
      }
    const identity = await ctx.db.query("identities").withIndex("by_user", (q) => q.eq("userId", user._id)).filter((q) => q.eq(q.field("provider"), "github")).first();
    const githubId = identity ? Number(identity.providerUserId) : user.githubId;
    return { agent: request.agent.replace(/^cloud:/, ""), prompt: request.prompt, repository: repo.fullName, prNumber: review.prNumber, reviewId: review._id, fingerprint: findings.length === 1 ? findings[0].fingerprint : undefined, count: findings.length, commentId, githubId: githubId && Number.isInteger(githubId) ? githubId : undefined };
  },
});
export const complete = mutation({
  args: { token: v.string(), secret: v.string(), requestId: v.id("fixRequests"), commentUrl: v.optional(v.string()), postedAs: v.optional(v.string()), error: v.optional(v.string()) },
  handler: async (ctx, a) => {
    service(a.secret);
    const user = await authenticated(ctx, a.token);
    const request = await ctx.db.get(a.requestId);
    if (!request || request.kind !== "cloud" || request.userId !== user._id || request.status !== "posting") throw new Error("Hand-off not accessible");
    const posted = Boolean(a.commentUrl) && !a.error;
    await ctx.db.patch(request._id, { status: posted ? "posted" : "failed", ...(a.commentUrl ? { commentUrl: a.commentUrl.slice(0, 500) } : {}), ...(a.postedAs ? { postedAs: a.postedAs.slice(0, 100) } : {}), ...(a.error ? { error: a.error.slice(0, 500) } : {}), updatedAt: Date.now() });
    await audit(ctx, request.organizationId, user._id, posted ? "agent.cloud_handoff_posted" : "agent.cloud_handoff_failed", `${request.agent}:${request._id}`);
  },
});
export const status = query({
  args: { token: v.string(), requestId: v.id("fixRequests") },
  handler: async (ctx, a) => {
    const user = await authenticated(ctx, a.token);
    const request = await ctx.db.get(a.requestId);
    if (!request || request.kind !== "cloud" || request.userId !== user._id) return null;
    return { status: request.status, agent: request.agent.replace(/^cloud:/, ""), commentUrl: request.commentUrl, postedAs: request.postedAs, error: request.error };
  },
});
