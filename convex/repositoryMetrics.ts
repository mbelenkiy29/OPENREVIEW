import { query } from "./_generated/server";
import { v } from "convex/values";
import { visibleRepositories } from "./auth";

// Repositories table, "Avg. Time to Merge": mean PR first-seen → merge time per visible repository, for
// merges since `since` (at most 30 days back, inside every plan's analytics history).
// shortcut: reads the newest 1,000 merges in the window; read analyticsDaily once it carries merge times.
export const mergeTimes = query({
  args: { token: v.string(), organizationId: v.id("organizations"), teamId: v.optional(v.id("teams")), since: v.number() },
  handler: async (ctx, a) => {
    if (!Number.isFinite(a.since) || a.since < Date.now() - 31 * 86400000) throw new Error("Choose a period of at most 30 days");
    const allowed = new Set((await visibleRepositories(ctx, a.token, a.organizationId, a.teamId)).map((r) => String(r._id)));
    const merged = await ctx.db.query("pullRequests").withIndex("by_org_merged", (q) => q.eq("organizationId", a.organizationId).gte("mergedAt", a.since)).order("desc").take(1000);
    const spans: Record<string, number[]> = {};
    for (const p of merged) if (p.openedAt !== undefined && p.mergedAt! >= p.openedAt && allowed.has(String(p.repositoryId))) (spans[p.repositoryId] ??= []).push(p.mergedAt! - p.openedAt);
    return Object.fromEntries(Object.entries(spans).map(([id, xs]) => [id, xs.reduce((n, x) => n + x, 0) / xs.length]));
  },
});
