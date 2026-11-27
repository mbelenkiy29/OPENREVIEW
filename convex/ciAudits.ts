import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { audit, authorizeRepository, visibleRepositories } from "./auth";
import { cooldown } from "./rateLimit";
import { ciCostEnabled } from "../src/ci-audit-github";

// In-app CI cost report (Organization Settings → CI Cost, behind CI_COST_ENABLED): a 30-day audit of a
// GitHub repository's Actions history, read with the installation's token (convex/ciAuditJobs.ts). The
// GitHub App needs the optional Actions: Read permission; without it a request fails with that reason.
const keep = 5;

// The latest audit of each repository the member can see (GitHub App repositories only).
export const list = query({
  args: { token: v.string(), organizationId: v.id("organizations") },
  handler: async (ctx, a) => {
    const repos = (await visibleRepositories(ctx, a.token, a.organizationId)).filter((r) => r.installationId && !r.connectionId);
    return Promise.all(repos.map(async (r) => {
      const latest = await ctx.db.query("ciAudits").withIndex("by_repo", (q) => q.eq("repositoryId", r._id)).order("desc").first();
      return { repositoryId: r._id, fullName: r.fullName, enabled: r.enabled, latest: latest ? { _id: latest._id, status: latest.status, error: latest.error, report: latest.report, createdAt: latest.createdAt, updatedAt: latest.updatedAt } : null };
    }));
  },
});

// Admins start an audit; one per repository every ten minutes, since each spends GitHub API requests.
export const request = mutation({
  args: { token: v.string(), repositoryId: v.id("repositories") },
  handler: async (ctx, a) => {
    if (!ciCostEnabled()) throw new Error("The CI cost report is not switched on for this deployment");
    const { user, repo } = await authorizeRepository(ctx, a.token, a.repositoryId, true, true);
    if (!repo.installationId || repo.connectionId) throw new Error("CI audits need a repository connected through the GitHub App");
    await cooldown(ctx, `ci-audit:${repo._id}`, 600000).catch(() => { throw new Error("This repository was audited in the last ten minutes. Try again shortly."); });
    const now = Date.now();
    const auditId = await ctx.db.insert("ciAudits", { organizationId: repo.organizationId, repositoryId: repo._id, requestedBy: user._id, status: "queued", createdAt: now, updatedAt: now });
    await ctx.scheduler.runAfter(0, internal.ciAuditJobs.run, { auditId });
    await audit(ctx, repo.organizationId, user._id, "ci.audit.requested", repo.fullName);
    return auditId;
  },
});

export const job = internalQuery({
  args: { auditId: v.id("ciAudits") },
  handler: async (ctx, a) => {
    const row = await ctx.db.get(a.auditId);
    const repo = row && await ctx.db.get(row.repositoryId);
    return row && repo ? { audit: row, repo } : null;
  },
});

export const progress = internalMutation({
  args: { auditId: v.id("ciAudits"), status: v.union(v.literal("running"), v.literal("done"), v.literal("failed")), report: v.optional(v.string()), error: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const row = await ctx.db.get(a.auditId);
    if (!row) return;
    await ctx.db.patch(a.auditId, { status: a.status, updatedAt: Date.now(), ...(a.report !== undefined ? { report: a.report } : {}), ...(a.error !== undefined ? { error: a.error.slice(0, 500) } : {}) });
    if (a.status === "running") return;
    // Keep the latest few audits per repository.
    const older = await ctx.db.query("ciAudits").withIndex("by_repo", (q) => q.eq("repositoryId", row.repositoryId)).order("desc").collect();
    for (const old of older.slice(keep)) await ctx.db.delete(old._id);
  },
});
