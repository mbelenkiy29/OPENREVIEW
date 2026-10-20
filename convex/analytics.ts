import { mutation, query } from "./_generated/server";
import { audit, authorize } from "./auth";
import type {Id} from "./_generated/dataModel";
import { v } from "convex/values";
import {authenticated} from "./auth";
import {contextReadable,requireFindingReader} from "./repositoryContext";
import { visibleRepositories } from "./auth";
import { hasEntitlement } from "./billing";
import { historyFloor, upgradeNote } from "../src/plans";
import type { QueryCtx } from "./_generated/server";
// Without analytics.history a period may start no earlier than 30 days back.
const requireHistory = async (ctx: QueryCtx, organizationId: Id<"organizations">, since: number) => { if (since < historyFloor(Date.now()) && !await hasEntitlement(ctx, organizationId, "analytics.history")) throw new Error(upgradeNote["analytics.history"]); };

export const report = query({
  args: { token: v.string(), organizationId: v.id("organizations"), since: v.number(), until: v.number(), repositoryId: v.optional(v.id("repositories")), author: v.optional(v.string()), teamId: v.optional(v.id("teams")) },
  handler: async (ctx, a) => {
    if (!Number.isFinite(a.since) || !Number.isFinite(a.until) || a.until < a.since || a.until - a.since > 366 * 86400000) throw new Error("Choose a period of at most one year");
    const repos = await visibleRepositories(ctx,a.token,a.organizationId,a.teamId);
    await requireHistory(ctx, a.organizationId, a.since);
    const allowed = new Set(repos.map(r=>String(r._id)));
    if (a.repositoryId && !repos.some(r => r._id === a.repositoryId)) throw new Error("Repository not accessible");
    // ponytail: indexed period reads, not recent-record samples; daily aggregates when periods exceed Convex read limits.
    const [reviews, findings, usage] = await Promise.all([
      ctx.db.query("reviews").withIndex("by_org_time", q => q.eq("organizationId", a.organizationId).gte("createdAt", a.since).lte("createdAt", a.until)).collect(),
      ctx.db.query("findings").withIndex("by_org_time", q => q.eq("organizationId", a.organizationId).gte("createdAt", a.since).lte("createdAt", a.until)).collect(),
      ctx.db.query("usageEvents").withIndex("by_org_time", q => q.eq("organizationId", a.organizationId).gte("createdAt", a.since).lte("createdAt", a.until)).collect(),
    ]);
    const viewer=await authenticated(ctx,a.token),permitted=await Promise.all(reviews.map(r=>contextReadable(ctx,viewer._id,r)));
    const selected = reviews.filter((r,i)=>permitted[i]).filter(r => allowed.has(r.repositoryId) && (!a.repositoryId || r.repositoryId === a.repositoryId) && (!a.author || r.author === a.author.replace(/^@/, "")));
    const ids = new Set(selected.map(r => String(r._id))), severities = { critical: 0, high: 0, medium: 0, low: 0 };
    const readable=new Map<Id<"reviews">,Promise<boolean>>(reviews.map((r,i)=>[r._id,Promise.resolve(permitted[i]&&allowed.has(r.repositoryId))]));
    const mayReadReview=(id:Id<"reviews">)=>{
      let result=readable.get(id);
      if(!result){result=(async()=>{const review=await ctx.db.get(id);return !!review&&review.organizationId===a.organizationId&&allowed.has(review.repositoryId)&&await contextReadable(ctx,viewer._id,review);})();readable.set(id,result);}
      return result;
    };
    const visibleFindings=await Promise.all(findings.map(async f=>{
      if(!allowed.has(f.repositoryId)||!await mayReadReview(f.reviewId))return false;
      try{await requireFindingReader(ctx,viewer._id,f);return true;}catch{return false;}
    }));
    const visibleUsage=await Promise.all(usage.map(async u=>allowed.has(u.repositoryId)&&(!u.reviewId||await mayReadReview(u.reviewId))));

    const bugs = findings.filter((_,i)=>visibleFindings[i]).filter(f => allowed.has(f.repositoryId) && (!a.repositoryId || f.repositoryId === a.repositoryId) && (!a.author || f.author === a.author.replace(/^@/, "")));
    const costs = usage.filter((_,i)=>visibleUsage[i]).filter(u => allowed.has(u.repositoryId) && (!a.repositoryId || u.repositoryId === a.repositoryId) && (!a.author || (u.reviewId && ids.has(u.reviewId))));
    const daily: Record<string, { reviews: number; findings: number; cost: number; critical: number; high: number; medium: number; low: number }> = {};
    const day = (at: number) => daily[new Date(at).toISOString().slice(0, 10)] ??= { reviews: 0, findings: 0, cost: 0, critical: 0, high: 0, medium: 0, low: 0 };
    for (const r of selected) day(r.createdAt).reviews++;
    for (const f of bugs) { const d = day(f.createdAt); d.findings++; if (f.severity in severities) d[f.severity as keyof typeof severities]++; }
    for (const u of costs) day(u.createdAt).cost += u.estimatedCost;
    const completed = selected.filter(r => r.status === "completed");
    const rated = bugs.filter(f => f.lastFeedback === "useful" || f.lastFeedback === "not_useful" || f.lastFeedback === "false_positive");
    // 👍/👎 on OpenReview finding comments in the period (visible repositories, author filter via PR).
    const findingIds = new Set(bugs.map((f) => String(f._id)));
    const reactionRows = (await ctx.db.query("commentReactions").withIndex("by_org_time", (q) => q.eq("organizationId", a.organizationId).gte("createdAt", a.since).lte("createdAt", a.until)).take(5000))
      .filter((r) => allowed.has(r.repositoryId) && (!a.repositoryId || r.repositoryId === a.repositoryId) && (!a.author || (r.findingId && findingIds.has(String(r.findingId)))));
    const reactions = { up: reactionRows.filter((r) => r.reaction === "+1").length, down: reactionRows.filter((r) => r.reaction === "-1").length };
    const names = new Map(repos.map((r) => [String(r._id), r.fullName]));
    // Most upvoted finding comments in the period (Greptile's "Most Upvoted Comments").
    const upvotes = new Map<string, number>();
    for (const r of reactionRows) if (r.reaction === "+1" && r.findingId) upvotes.set(String(r.findingId), (upvotes.get(String(r.findingId)) ?? 0) + 1);
    const topComments = bugs.filter((f) => upvotes.has(String(f._id))).map((f) => ({ findingId: f._id, reviewId: f.reviewId, title: f.title, repository: names.get(String(f.repositoryId)) ?? "", prNumber: f.prNumber, upvotes: upvotes.get(String(f._id))! })).sort((p, q) => q.upvotes - p.upvotes).slice(0, 5);
    // Top contributors: reviewed PRs per PR author, with the repositories they shipped to.
    const byAuthor = new Map<string, { prs: Set<string>; repositories: Set<string> }>();
    for (const r of selected) if (r.author) { const x = byAuthor.get(r.author) ?? { prs: new Set(), repositories: new Set() }; x.prs.add(`${r.repositoryId}:${r.prNumber}`); x.repositories.add(names.get(String(r.repositoryId)) ?? ""); byAuthor.set(r.author, x); }
    const contributors = [...byAuthor].map(([author, x]) => ({ author, prs: x.prs.size, repositories: [...x.repositories].filter(Boolean) })).sort((p, q) => q.prs - p.prs).slice(0, 10);
    // Merge time (PR first seen → merge webhook), for PRs merged in the period; recorded since openedAt/mergedAt shipped.
    const merged = (await ctx.db.query("pullRequests").withIndex("by_org_merged", (q) => q.eq("organizationId", a.organizationId).gte("mergedAt", a.since).lte("mergedAt", a.until)).take(5000))
      .filter((p) => p.openedAt !== undefined && p.mergedAt! >= p.openedAt && allowed.has(p.repositoryId) && (!a.repositoryId || p.repositoryId === a.repositoryId) && (!a.author || p.author === a.author.replace(/^@/, "")));
    const mean = (xs: number[]) => xs.reduce((n, x) => n + x, 0) / xs.length;
    const group = (key: (p: (typeof merged)[number]) => string) => { const m = new Map<string, number[]>(); for (const p of merged) { const k = key(p); m.set(k, [...(m.get(k) ?? []), p.mergedAt! - p.openedAt!]); } return [...m]; };
    const spans = merged.map((p) => p.mergedAt! - p.openedAt!).sort((x, y) => x - y);
    const mergeTime = {
      count: spans.length,
      meanMs: spans.length ? mean(spans) : null,
      medianMs: spans.length ? (spans.length % 2 ? spans[(spans.length - 1) / 2] : (spans[spans.length / 2 - 1] + spans[spans.length / 2]) / 2) : null,
      daily: group((p) => new Date(p.mergedAt!).toISOString().slice(0, 10)).map(([date, xs]) => ({ date, meanMs: mean(xs), count: xs.length })).sort((p, q) => p.date.localeCompare(q.date)),
      byRepository: group((p) => String(p.repositoryId)).map(([id, xs]) => ({ repository: names.get(id) ?? "Unknown repository", meanMs: mean(xs), count: xs.length })).sort((p, q) => q.meanMs - p.meanMs).slice(0, 10),
    };
    return { reactions, topComments, contributors, mergeTime, bugRepositories: new Set(bugs.map((f) => f.repositoryId)).size, totalReviews: selected.length, completed: completed.length, totalPRs: new Set(selected.map(r => `${r.repositoryId}:${r.prNumber}`)).size, findings: bugs.length, severity: Object.fromEntries(["critical", "high", "medium", "low"].map(s => [s, bugs.filter(f => f.severity === s).length])), addressedRate: bugs.length ? bugs.filter(f => f.status === "resolved").length / bugs.length : null, usefulness: rated.length ? rated.filter(f => f.lastFeedback === "useful").length / rated.length : null, cost: costs.reduce((n, u) => n + u.estimatedCost, 0), tokens: costs.reduce((n, u) => n + u.inputTokens + u.outputTokens, 0), averageDuration: completed.length ? completed.reduce((n,r) => n + ((r.finishedAt ?? r.updatedAt) - r.createdAt), 0) / completed.length : null, daily: Object.entries(daily).sort(([a],[b]) => a.localeCompare(b)).map(([date, values]) => ({ date, ...values })), recent: selected.sort((a,b) => b.createdAt - a.createdAt).slice(0,10) };
  },
});

// Trends from the daily rollup (no raw scans): per-day series, per-repository and per-author
// totals, addressed rate and estimated time saved. Counts only, for repositories the viewer can see.
export const trends = query({
  args: { token: v.string(), organizationId: v.id("organizations"), since: v.number(), until: v.number(), repositoryId: v.optional(v.id("repositories")), author: v.optional(v.string()), teamId: v.optional(v.id("teams")) },
  handler: async (ctx, a) => {
    if (!Number.isFinite(a.since) || !Number.isFinite(a.until) || a.until < a.since || a.until - a.since > 366 * 86400000) throw new Error("Choose a period of at most one year");
    const repos = await visibleRepositories(ctx, a.token, a.organizationId, a.teamId);
    await requireHistory(ctx, a.organizationId, a.since);
    if (a.repositoryId && !repos.some((r) => r._id === a.repositoryId)) throw new Error("Repository not accessible");
    const names = new Map(repos.map((r) => [String(r._id), r.fullName]));
    const from = new Date(a.since).toISOString().slice(0, 10), to = new Date(a.until).toISOString().slice(0, 10), author = a.author?.replace(/^@/, "");
    const rows = (await ctx.db.query("analyticsDaily").withIndex("by_org_day", (q) => q.eq("organizationId", a.organizationId).gte("day", from).lte("day", to)).take(20000))
      .filter((r) => names.has(String(r.repositoryId)) && (!a.repositoryId || r.repositoryId === a.repositoryId) && (!author || r.author === author));
    const days: string[] = [];
    for (let t = Date.parse(from + "T00:00:00Z"); t <= Date.parse(to + "T00:00:00Z") && days.length < 367; t += 86400000) days.push(new Date(t).toISOString().slice(0, 10));
    const empty = () => ({ reviews: 0, findings: 0, high: 0, addressed: 0, useful: 0, notUseful: 0, commitAddressed: 0, ignored: 0 });
    const byDay = new Map(days.map((d) => [d, empty()])), byRepo = new Map<string, ReturnType<typeof empty>>(), byAuthor = new Map<string, ReturnType<typeof empty>>();
    const add = (m: Map<string, ReturnType<typeof empty>>, k: string, r: ReturnType<typeof empty>) => { const x = m.get(k) ?? empty(); x.reviews += r.reviews; x.findings += r.findings; x.high += r.high; x.addressed += r.addressed; x.useful += r.useful; x.notUseful += r.notUseful; x.commitAddressed += r.commitAddressed; x.ignored += r.ignored; m.set(k, x); };
    for (const stored of rows) { const r = { ...stored, commitAddressed: stored.commitAddressed ?? 0, ignored: stored.ignored ?? 0 }; add(byDay, r.day, r); add(byRepo, String(r.repositoryId), r); if (r.author) add(byAuthor, r.author, r); }
    const organization = await ctx.db.get(a.organizationId), minutes = organization?.analyticsMinutesPerFinding ?? 15;
    const totals = [...byDay.values()].reduce((t, d) => ({ reviews: t.reviews + d.reviews, findings: t.findings + d.findings, high: t.high + d.high, addressed: t.addressed + d.addressed, useful: t.useful + d.useful, notUseful: t.notUseful + d.notUseful, commitAddressed: t.commitAddressed + d.commitAddressed, ignored: t.ignored + d.ignored }), empty());
    const top = (m: Map<string, ReturnType<typeof empty>>, label: (k: string) => string, limit = 10) => [...m].map(([k, x]) => ({ key: k, label: label(k), ...x })).sort((p, q) => q.findings - p.findings || q.reviews - p.reviews).slice(0, limit);
    return {
      days: days.map((d) => ({ day: d, ...byDay.get(d)! })),
      totals,
      addressedRate: totals.findings ? totals.addressed / totals.findings : null,
      // Of the findings with a recorded outcome: share fixed by a follow-up commit rather than merged open.
      fixRate: totals.commitAddressed + totals.ignored ? totals.commitAddressed / (totals.commitAddressed + totals.ignored) : null,
      minutesPerFinding: minutes,
      hoursSaved: Math.round((totals.addressed * minutes) / 6) / 10,
      // Every visible repository (bounded), so each leaderboard can sort its own way.
      byRepository: top(byRepo, (k) => names.get(k) ?? "Unknown repository", Infinity),
      byAuthor: top(byAuthor, (k) => "@" + k),
      updatedAt: rows.reduce((m, r) => Math.max(m, r.updatedAt), 0) || null,
    };
  },
});
export const setMinutesPerFinding = mutation({ args: { token: v.string(), organizationId: v.id("organizations"), minutes: v.number() }, handler: async (ctx, a) => {
  const { user } = await authorize(ctx, a.token, a.organizationId, true);
  if (!Number.isInteger(a.minutes) || a.minutes < 1 || a.minutes > 480) throw new Error("Use 1 to 480 minutes per finding");
  await ctx.db.patch(a.organizationId, { analyticsMinutesPerFinding: a.minutes });
  await audit(ctx, a.organizationId, user._id, "analytics.minutes_per_finding_changed", String(a.minutes));
} });
