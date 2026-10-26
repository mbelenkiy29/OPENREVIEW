import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { authorize, repositoryAccess, visibleRepositories } from "./auth";
import { contextReadable } from "./repositoryContext";
import { priorityOf } from "../src/priority";

// Read models behind the MCP tools get_review_status, report (pr_status) and list_unresolved_comments.
// Same access rules as the dashboard: visible repositories only, and reviews whose cross-repository
// context the reader may see.

// Newest review of a pull request whose context the reader may see, and the pull request's open
// findings from reviews the reader may see. Read by pull request, not by the newest review: that one
// may still be queued, running or failed, and a finding not re-reported stays open on its older review.
async function latestOpen(ctx: QueryCtx, userId: Id<"users">, repositoryId: Id<"repositories">, prNumber: number, limit: number) {
  const reviews = await ctx.db.query("reviews").withIndex("by_pr", (q) => q.eq("repositoryId", repositoryId).eq("prNumber", prNumber)).order("desc").take(20);
  let latest: Doc<"reviews"> | undefined;
  for (const r of reviews) if (await contextReadable(ctx, userId, r)) { latest = r; break; }
  const readable = new Map<Id<"reviews">, boolean>(), open: Doc<"findings">[] = [];
  for (const f of await ctx.db.query("findings").withIndex("by_pr_status", (q) => q.eq("repositoryId", repositoryId).eq("prNumber", prNumber).eq("status", "open")).take(limit)) {
    if (!readable.has(f.reviewId)) { const r = await ctx.db.get(f.reviewId); readable.set(f.reviewId, !!r && await contextReadable(ctx, userId, r)); }
    if (readable.get(f.reviewId)) open.push(f);
  }
  return { latest, open };
}

// Latest review of one pull request, whether it covers the current head, and the pull request's open findings.
export const prStatus = query({ args: { token: v.string(), organizationId: v.id("organizations"), repositoryId: v.id("repositories"), prNumber: v.number() }, handler: async (ctx, a) => {
  const { user } = await authorize(ctx, a.token, a.organizationId);
  // One repository lookup, not a scan of every visible one.
  const repo = await repositoryAccess(ctx, user._id, a.repositoryId).then((r) => r.repo, () => null);
  if (!repo || repo.organizationId !== a.organizationId) throw new Error("Repository not accessible");
  const pr = await ctx.db.query("pullRequests").withIndex("by_repo_number", (q) => q.eq("repositoryId", repo._id).eq("number", a.prNumber)).unique();
  const { latest, open } = await latestOpen(ctx, user._id, repo._id, a.prNumber, 500);
  return {
    repository: repo.fullName, prNumber: a.prNumber,
    pullRequest: pr ? { title: pr.title, state: pr.state, author: pr.author, headSha: pr.headSha, url: pr.url } : null,
    review: latest ? { reviewId: latest._id, status: latest.status, verdict: latest.verdict ?? null, headSha: latest.headSha, coversCurrentHead: pr ? latest.headSha === pr.headSha : null, findingCount: latest.findingCount ?? 0, reviewScore: latest.reviewScore ?? null, updatedAt: latest.updatedAt } : null,
    unresolved: open.length,
  };
} });

// Open findings on the caller's own open pull requests (matched by their provider login).
export const unresolvedForUser = query({ args: { token: v.string(), organizationId: v.id("organizations"), repositoryId: v.optional(v.id("repositories")) }, handler: async (ctx, a) => {
  const { user } = await authorize(ctx, a.token, a.organizationId);
  const repos = await visibleRepositories(ctx, a.token, a.organizationId);
  if (a.repositoryId && !repos.some((r) => r._id === a.repositoryId)) throw new Error("Repository not accessible");
  const names = new Map(repos.filter((r) => !a.repositoryId || r._id === a.repositoryId).map((r) => [r._id as string, r.fullName]));
  const prs = (await ctx.db.query("pullRequests").withIndex("by_org", (q) => q.eq("organizationId", a.organizationId)).order("desc").take(1000))
    .filter((p) => p.state === "open" && p.author.toLowerCase() === user.login.toLowerCase() && names.has(p.repositoryId)).slice(0, 50);
  const out = [];
  // The 200-finding output cap also bounds reads across the 50 pull requests.
  for (const pr of prs) {
    if (out.length >= 200) break;
    for (const f of (await latestOpen(ctx, user._id, pr.repositoryId, pr.number, 200 - out.length)).open) {
      out.push({ findingId: f._id, reviewId: f.reviewId, repository: names.get(pr.repositoryId)!, prNumber: pr.number, pullRequest: pr.title, title: f.title, severity: f.severity, priority: priorityOf(f.severity), category: f.category, filePath: f.filePath, line: f.startLine, suggestedFix: f.suggestedFix });
    }
  }
  return { login: user.login, pullRequests: prs.length, findings: out };
} });
