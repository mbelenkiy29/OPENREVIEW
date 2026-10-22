import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

// Recomputes one organization's analytics rows for one UTC day from reviews and findings created
// that day (idempotent: rows for the day are replaced). "Addressed" reflects the findings' current
// status, so recent days are recomputed regularly as fixes land; commit outcome signals count on the
// day they were recorded.
export const dayBounds = (day: string) => { const start = Date.parse(day + "T00:00:00.000Z"); return { start, end: start + 86400000 }; };
export const rollupDay = internalMutation({ args: { organizationId: v.id("organizations"), day: v.string() }, handler: async (ctx, a) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.day)) throw new Error("Invalid day");
  const { start, end } = dayBounds(a.day);
  const reviews = await ctx.db.query("reviews").withIndex("by_org_time", (q) => q.eq("organizationId", a.organizationId).gte("createdAt", start).lt("createdAt", end)).take(4000);
  const findings = await ctx.db.query("findings").withIndex("by_org_time", (q) => q.eq("organizationId", a.organizationId).gte("createdAt", start).lt("createdAt", end)).take(4000);
  // shortcut: an org-day with over 4,000 reviews, findings or signals is undercounted (logged below); page this mutation if one ever does.
  const signals = await ctx.db.query("findingSignals").withIndex("by_org_time", (q) => q.eq("organizationId", a.organizationId).gte("createdAt", start).lt("createdAt", end)).take(4000);
  if (reviews.length === 4000 || findings.length === 4000 || signals.length === 4000) console.warn(`analytics rollup capped at 4,000 rows for ${a.organizationId} ${a.day}`);
  const rows = new Map<string, { repositoryId: Id<"repositories">; author: string; reviews: number; completed: number; findings: number; high: number; addressed: number; useful: number; notUseful: number; commitAddressed: number; ignored: number }>();
  const row = (repositoryId: Id<"repositories">, author?: string) => { const k = `${repositoryId}|${author ?? ""}`; let r = rows.get(k); if (!r) rows.set(k, r = { repositoryId, author: author ?? "", reviews: 0, completed: 0, findings: 0, high: 0, addressed: 0, useful: 0, notUseful: 0, commitAddressed: 0, ignored: 0 }); return r; };
  for (const r of reviews) { const x = row(r.repositoryId, r.author); x.reviews++; if (r.status === "completed") x.completed++; }
  for (const f of findings) {
    const x = row(f.repositoryId, f.author);
    x.findings++;
    if (f.severity === "critical" || f.severity === "high") x.high++;
    if (f.status === "resolved") x.addressed++;
    if (f.lastFeedback === "useful") x.useful++;
    if (f.lastFeedback === "not_useful" || f.lastFeedback === "false_positive") x.notUseful++;
  }
  // Outcome signals count on the day they were recorded (fix commit reviewed, or merge).
  for (const sig of signals) { const x = row(sig.repositoryId, sig.author); if (sig.signal === "addressed") x.commitAddressed++; else if (sig.signal === "ignored") x.ignored++; }
  for (const old of await ctx.db.query("analyticsDaily").withIndex("by_org_day", (q) => q.eq("organizationId", a.organizationId).eq("day", a.day)).take(2000)) await ctx.db.delete(old._id);
  for (const r of rows.values()) await ctx.db.insert("analyticsDaily", { organizationId: a.organizationId, day: a.day, ...r, updatedAt: Date.now() });
  return rows.size;
} });
// Cron entry: recompute the last `days` days for every organization (one mutation per org-day),
// 10 organizations per transaction so even 90 days stays under 1,000 scheduled functions.
export const sweep = internalMutation({ args: { days: v.optional(v.number()), cursor: v.optional(v.string()) }, handler: async (ctx, a) => {
  const days = Math.min(Math.max(a.days ?? 2, 1), 90), today = Date.now();
  const page = await ctx.db.query("organizations").paginate({ numItems: 10, cursor: a.cursor ?? null });
  for (const { _id: organizationId } of page.page) for (let i = 0; i < days; i++) await ctx.scheduler.runAfter(0, internal.analyticsRollup.rollupDay, { organizationId, day: new Date(today - i * 86400000).toISOString().slice(0, 10) });
  if (!page.isDone) await ctx.scheduler.runAfter(0, internal.analyticsRollup.sweep, { days, cursor: page.continueCursor });
  return page.page.length * days;
} });
