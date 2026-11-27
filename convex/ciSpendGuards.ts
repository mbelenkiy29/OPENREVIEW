import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { audit, authorize } from "./auth";
import { adminEmails } from "./notifications";
import { workspacePurging } from "./dataControls";
import { ciCostEnabled } from "../src/ci-audit-github";
import type { CiAudit } from "../src/ci-audit";

// Spend guard v1 (Organization Settings → CI Cost, behind CI_COST_ENABLED): a monthly GitHub Actions budget,
// the workflows that must keep running, and where alerts go. convex/ciSpendGuardJobs.ts checks once a day.
const maxRepositories = 20;
const criticalValidator = v.object({ repositoryId: v.id("repositories"), path: v.string() });

export const guard = query({
  args: { token: v.string(), organizationId: v.id("organizations") },
  handler: async (ctx, a) => {
    await authorize(ctx, a.token, a.organizationId, true);
    const row = await ctx.db.query("ciSpendGuards").withIndex("by_org", (q) => q.eq("organizationId", a.organizationId)).unique();
    const channels = (await ctx.db.query("notificationChannels").withIndex("by_org", (q) => q.eq("organizationId", a.organizationId)).take(100)).map((c) => ({ _id: c._id, channelId: c.channelId }));
    // Workflows a member can mark critical: those seen in each repository's latest finished audit.
    const repos = (await ctx.db.query("repositories").withIndex("by_org", (q) => q.eq("organizationId", a.organizationId)).take(500)).filter((r) => r.installationId && !r.connectionId);
    const workflows: { repositoryId: typeof repos[number]["_id"]; fullName: string; path: string; name: string }[] = [];
    for (const r of repos) {
      const latest = await ctx.db.query("ciAudits").withIndex("by_repo", (q) => q.eq("repositoryId", r._id)).order("desc").filter((q) => q.eq(q.field("status"), "done")).first();
      if (!latest?.report) continue;
      try { for (const w of (JSON.parse(latest.report) as CiAudit).workflows) if (w.path.startsWith(".github/workflows/")) workflows.push({ repositoryId: r._id, fullName: r.fullName, path: w.path, name: w.name }); } catch { /* unreadable report */ }
    }
    return { guard: row, channels, workflows };
  },
});

export const save = mutation({
  args: { token: v.string(), organizationId: v.id("organizations"), monthlyBudget: v.optional(v.number()), critical: v.array(criticalValidator), dailySummary: v.boolean(), channelId: v.optional(v.id("notificationChannels")) },
  handler: async (ctx, a) => {
    if (!ciCostEnabled()) throw new Error("The CI cost report is not switched on for this deployment");
    const { user } = await authorize(ctx, a.token, a.organizationId, true);
    if (await workspacePurging(ctx, a.organizationId)) throw new Error("This workspace is being deleted");
    if (a.monthlyBudget !== undefined && !(Number.isFinite(a.monthlyBudget) && a.monthlyBudget > 0 && a.monthlyBudget <= 1_000_000)) throw new Error("Enter a monthly budget between $1 and $1,000,000, or leave it empty");
    if (a.critical.length > 50) throw new Error("Mark at most 50 critical workflows");
    for (const c of a.critical) {
      const repo = await ctx.db.get(c.repositoryId);
      if (!repo || repo.organizationId !== a.organizationId || !/^\.github\/workflows\/[\w./-]{1,200}$/.test(c.path)) throw new Error("Critical workflow not found in this workspace");
    }
    if (a.channelId) { const channel = await ctx.db.get(a.channelId); if (!channel || channel.organizationId !== a.organizationId) throw new Error("Slack channel not found in this workspace"); }
    const existing = await ctx.db.query("ciSpendGuards").withIndex("by_org", (q) => q.eq("organizationId", a.organizationId)).unique();
    const fields = { monthlyBudget: a.monthlyBudget, critical: a.critical, dailySummary: a.dailySummary, channelId: a.channelId, updatedBy: user._id, updatedAt: Date.now() };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("ciSpendGuards", { organizationId: a.organizationId, ...fields });
    await audit(ctx, a.organizationId, user._id, "ci.guard.saved", a.monthlyBudget ? `budget ${a.monthlyBudget}` : "no budget");
  },
});

export const all = internalQuery({ args: {}, handler: async (ctx) => (await ctx.db.query("ciSpendGuards").take(1000)).map((g) => g._id) });

// What one daily check needs: the workspace's GitHub App repositories, its critical workflows by name,
// the admins with verified email, and the Slack channel to post to.
export const checkContext = internalQuery({
  args: { guardId: v.id("ciSpendGuards") },
  handler: async (ctx, a) => {
    const guard = await ctx.db.get(a.guardId);
    const organization = guard && await ctx.db.get(guard.organizationId);
    if (!guard || !organization) return null;
    const repos = (await ctx.db.query("repositories").withIndex("by_org", (q) => q.eq("organizationId", guard.organizationId)).take(500)).filter((r) => r.enabled && r.installationId && !r.connectionId).slice(0, maxRepositories);
    const critical = (await Promise.all(guard.critical.map(async (c) => { const r = await ctx.db.get(c.repositoryId); return r ? { repository: r.fullName, path: c.path } : null; }))).filter((c) => c !== null);
    const channel = guard.channelId ? await ctx.db.get(guard.channelId) : null;
    return {
      guard, workspace: organization.name,
      repositories: repos.map((r) => ({ repositoryId: r._id, fullName: r.fullName, installationId: r.installationId! })),
      critical, recipients: await adminEmails(ctx, guard.organizationId),
      slack: channel ? { installationId: channel.installationId, channelId: channel.channelId } : null,
    };
  },
});

export const recordCheck = internalMutation({
  args: { guardId: v.id("ciSpendGuards"), at: v.number(), period: v.string(), total: v.number(), repositories: v.array(v.object({ repositoryId: v.id("repositories"), fullName: v.string(), cost: v.number(), minutes: v.number(), error: v.optional(v.string()) })), problems: v.array(v.object({ repository: v.string(), path: v.string(), name: v.string(), problem: v.string() })) },
  handler: async (ctx, { guardId, ...lastCheck }) => {
    if (await ctx.db.get(guardId)) await ctx.db.patch(guardId, { lastCheck });
  },
});
