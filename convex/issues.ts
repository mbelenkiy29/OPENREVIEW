import { internalMutation, mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { audit, authorize, authorizeRepository, repositoryAccess, visibleRepositories } from "./auth";
import { contextReadable, requireContextReader, requireFindingReader } from "./repositoryContext";
import { fixEligibility, readableExplanation } from "./findings";
import { recordFindingFeedback } from "./feedbackCore";
import { rateLimit } from "./rateLimit";
import { activeIssue, fixPullRequestOpened, issueEvent, issueStatuses, syncIssueStatus, trackFinding } from "./issueLifecycle";

// Issues inbox: tickets built from findings (lifecycle rules in issueLifecycle.ts). Reading follows
// the same repository and context access as findings; changing an issue needs repository write access.
async function login(ctx: QueryCtx, userId: Id<"users"> | undefined) {
  return userId ? (await ctx.db.get(userId))?.login : undefined;
}
async function prState(ctx: QueryCtx, repositoryId: Id<"repositories">, number: number) {
  return (await ctx.db.query("pullRequests").withIndex("by_repo_number", (q) => q.eq("repositoryId", repositoryId).eq("number", number)).unique())?.state;
}

export const list = query({
  args: {
    token: v.string(),
    organizationId: v.id("organizations"),
    teamId: v.optional(v.id("teams")),
    cursor: v.optional(v.string()),
    repositoryId: v.optional(v.id("repositories")),
    // "active" (default: open and in progress), "all", or one status.
    status: v.optional(v.string()),
    // "me", "none", or absent for anyone.
    assignee: v.optional(v.string()),
    severity: v.optional(v.string()),
    category: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const reader = await authorize(ctx, a.token, a.organizationId);
    const allowed = new Set((await visibleRepositories(ctx, a.token, a.organizationId, a.teamId)).map((r) => String(r._id)));
    if (a.repositoryId && !allowed.has(a.repositoryId)) throw new Error("Repository not accessible in selected scope");
    if (!allowed.size) return { page: [], isDone: true, continueCursor: "" };
    const statuses = !a.status || a.status === "active" ? ["open", "in_progress"] : a.status === "all" ? null : [a.status];
    // shortcut: filters scan the workspace's issues newest first, like findings.list; add status and assignee indexes if inboxes reach thousands of issues.
    const result = await ctx.db.query("issues").withIndex("by_org_last", (q) => q.eq("organizationId", a.organizationId)).order("desc")
      .filter((q) => q.and(
        q.or(...[...allowed].map((id) => q.eq(q.field("repositoryId"), id))),
        a.repositoryId ? q.eq(q.field("repositoryId"), a.repositoryId) : true,
        statuses ? q.or(...statuses.map((s) => q.eq(q.field("status"), s))) : true,
        a.severity ? q.eq(q.field("severity"), a.severity) : true,
        a.category ? q.eq(q.field("category"), a.category) : true,
        a.assignee === "me" ? q.eq(q.field("assigneeId"), reader.user._id) : a.assignee === "none" ? q.eq(q.field("assigneeId"), undefined) : true,
      ))
      .paginate({ numItems: 30, cursor: a.cursor ?? null });
    const page = await Promise.all(result.page.map(async (issue) => {
      const finding = await ctx.db.get(issue.latestFindingId), review = finding ? await ctx.db.get(finding.reviewId) : null;
      if (!finding) return null;
      try { await requireFindingReader(ctx, reader.user._id, finding); } catch { return null; }
      if (review && !await contextReadable(ctx, reader.user._id, review)) return null;
      return { ...issue, prNumber: finding.prNumber, reviewId: finding.reviewId, filePath: finding.filePath, startLine: finding.startLine, prState: await prState(ctx, issue.repositoryId, finding.prNumber), assignee: await login(ctx, issue.assigneeId) };
    }));
    return { ...result, page: page.filter((r) => r !== null) };
  },
});

export const get = query({
  args: { token: v.string(), organizationId: v.id("organizations"), number: v.number() },
  handler: async (ctx, a) => {
    const issue = await ctx.db.query("issues").withIndex("by_org_number", (q) => q.eq("organizationId", a.organizationId).eq("number", a.number)).unique();
    if (!issue) throw new Error("Issue not found");
    const { user, member } = await authorizeRepository(ctx, a.token, issue.repositoryId);
    const finding = (await ctx.db.get(issue.latestFindingId))!, review = await ctx.db.get(finding.reviewId);
    if (review) await requireContextReader(ctx, user._id, review);
    await requireFindingReader(ctx, user._id, finding);
    const occurrences = await Promise.all((await ctx.db.query("findings").withIndex("by_issue", (q) => q.eq("issueId", issue._id)).take(50))
      .map(async (f) => ({ _id: f._id, prNumber: f.prNumber, reviewId: f.reviewId, status: f.status, createdAt: f.createdAt, prState: await prState(ctx, f.repositoryId, f.prNumber) })));
    const events = await Promise.all((await ctx.db.query("issueEvents").withIndex("by_issue", (q) => q.eq("issueId", issue._id)).take(500))
      .map(async (e) => ({ ...e, actor: await login(ctx, e.actorId) })));
    // People who can be assigned: members with write access to this repository.
    const members = (await Promise.all((await ctx.db.query("organizationMembers").withIndex("by_org", (q) => q.eq("organizationId", issue.organizationId)).collect())
      .map(async (m) => { try { const { user } = await repositoryAccess(ctx, m.userId, issue.repositoryId, true); return { userId: user._id, login: user.login }; } catch { return null; } })))
      .filter((m) => m !== null);
    return {
      issue: { ...issue, assignee: await login(ctx, issue.assigneeId) },
      finding: { ...readableExplanation(finding, review), canFix: await fixEligibility(ctx, a.token)(finding, review) },
      occurrences: occurrences.sort((x, y) => y.createdAt - x.createdAt),
      events,
      members,
      canWrite: member.role !== "viewer" && members.some((m) => m.userId === user._id),
    };
  },
});

async function writable(ctx: Parameters<typeof authorizeRepository>[0], token: string, issueId: Id<"issues">) {
  const issue = await ctx.db.get(issueId);
  if (!issue) throw new Error("Issue not found");
  const { user } = await authorizeRepository(ctx, token, issue.repositoryId, true);
  return { issue, user };
}

export const setStatus = mutation({
  args: { token: v.string(), issueId: v.id("issues"), status: v.string(), comment: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const { issue, user } = await writable(ctx, a.token, a.issueId);
    if (!(issueStatuses as readonly string[]).includes(a.status) || (a.comment?.length ?? 0) > 5000) throw new Error("Invalid status");
    if (issue.status === a.status) return;
    await ctx.db.patch(issue._id, { status: a.status, updatedAt: Date.now() });
    await issueEvent(ctx, issue, "status", `${issue.status.replaceAll("_", " ")} → ${a.status.replaceAll("_", " ")}${a.comment ? `: ${a.comment}` : ""}`, user._id);
    await audit(ctx, issue.organizationId, user._id, "issue.status", `#${issue.number}:${a.status}`);
    // A closing decision also applies to every open occurrence, so pull request threads and learned
    // preferences follow it, exactly as feedback on each finding would.
    if (!activeIssue(a.status))
      for (const f of await ctx.db.query("findings").withIndex("by_issue", (q) => q.eq("issueId", issue._id)).take(200))
        if (f.status === "open") await recordFindingFeedback(ctx, f, { value: a.status, comment: a.comment ?? `Set on issue #${issue.number}`, userId: user._id });
  },
});

export const assign = mutation({
  args: { token: v.string(), issueId: v.id("issues"), assigneeId: v.optional(v.id("users")) },
  handler: async (ctx, a) => {
    const { issue, user } = await writable(ctx, a.token, a.issueId);
    if (issue.assigneeId === a.assigneeId) return;
    // The assignee must be able to work on the repository (a member with write access, team rules included).
    const assignee = a.assigneeId ? (await repositoryAccess(ctx, a.assigneeId, issue.repositoryId, true).catch(() => { throw new Error("Assign a workspace member with write access to this repository"); })).user : undefined;
    await ctx.db.patch(issue._id, { assigneeId: a.assigneeId, updatedAt: Date.now() });
    await issueEvent(ctx, issue, "assigned", assignee ? `Assigned to @${assignee.login}` : "Unassigned", user._id);
    await audit(ctx, issue.organizationId, user._id, "issue.assigned", `#${issue.number}:${assignee?.login ?? "none"}`);
  },
});

export const comment = mutation({
  args: { token: v.string(), issueId: v.id("issues"), body: v.string() },
  handler: async (ctx, a) => {
    const { issue, user } = await writable(ctx, a.token, a.issueId);
    const body = a.body.trim();
    if (!body || body.length > 5000) throw new Error("Comments are 1 to 5,000 characters");
    await rateLimit(ctx, `issue-comment:${user._id}`, 20);
    await issueEvent(ctx, issue, "comment", body, user._id);
    await ctx.db.patch(issue._id, { updatedAt: Date.now() });
  },
});

/** A fix pull request was opened for an occurrence, from the dashboard or by Autofix. */
export const recordFixPullRequest = internalMutation({
  args: { findingId: v.id("findings"), url: v.string(), automatic: v.boolean() },
  handler: async (ctx, a) => fixPullRequestOpened(ctx, await ctx.db.get(a.findingId), a.url, a.automatic),
});

/** One-off for findings stored before issues existed:
 *  `npx convex run issues:backfill '{}'`. Idempotent; continues itself in batches. */
export const backfill = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, a): Promise<number> => {
    const page = await ctx.db.query("findings").order("asc").paginate({ numItems: 200, cursor: a.cursor ?? null });
    let linked = 0;
    for (const f of page.page as Doc<"findings">[]) {
      if (f.issueId) continue;
      await trackFinding(ctx, f, true, f.updatedAt);
      if (f.status !== "open") await syncIssueStatus(ctx, (await ctx.db.get(f._id))!, f.status);
      linked++;
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.issues.backfill, { cursor: page.continueCursor });
    return linked;
  },
});
