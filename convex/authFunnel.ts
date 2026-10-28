import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internalAccount } from "./conversions";

// The sign-in funnel per UTC day, to compare sign-in emails with real accounts and their activation.
// Internal, so only the Convex dashboard or CLI can run it:
//   npx convex run authFunnel:report '{"since":1767225600000,"until":1767830400000}'
// Requests refused before Convex (another site's form, a failed bot check, a rate limit) are counted
// from the web app's `auth.magic_link` log lines; delivery and bounces are in Resend.
//   linksCreated / emailsSent  magic links stored / accepted by Resend (loginTokens, kept 30 days)
//   linksUsed / newAccounts    of those, used / used and created the account (the rest are returning users)
//   signups                    verified sign-ups by method (conversionEvents), internal accounts left out
//   activated                  of those sign-ups, how many own a workspace that reached each milestone
export const report = internalQuery({ args: { since: v.number(), until: v.number() }, handler: async (ctx, a) => {
  if (!Number.isFinite(a.since) || !Number.isFinite(a.until) || a.until <= a.since || a.until - a.since > 92 * 86_400_000) throw new Error("Choose a period of at most 92 days");
  const cap = 4000, cohortCap = 1000, day = (at: number) => new Date(at).toISOString().slice(0, 10);
  const links = await ctx.db.query("loginTokens").withIndex("by_creation_time", (q) => q.gte("_creationTime", a.since).lt("_creationTime", a.until)).take(cap);
  const signups = await ctx.db.query("conversionEvents").withIndex("by_name_at", (q) => q.eq("name", "signup_verified").gte("at", a.since).lt("at", a.until)).take(cap);
  type Day = { linksCreated: number; emailsSent: number; linksUsed: number; newAccounts: number; signups: Record<string, number>; internalSignups: number };
  const days = new Map<string, Day>(), at = (d: string) => days.get(d) ?? days.set(d, { linksCreated: 0, emailsSent: 0, linksUsed: 0, newAccounts: 0, signups: {}, internalSignups: 0 }).get(d)!;
  for (const link of links) {
    const row = at(day(link._creationTime));
    row.linksCreated++;
    if (link.resendId) row.emailsSent++;
    if (link.usedAt) row.linksUsed++;
    if (link.createdUser) row.newAccounts++;
  }
  const activated = { cohort: 0, github_app_installed: 0, first_repository_connected: 0, first_review_completed: 0 };
  for (const [i, signup] of signups.entries()) {
    const user = signup.userId && await ctx.db.get(signup.userId), row = at(day(signup.at));
    if (user && await internalAccount(ctx, user)) { row.internalSignups++; continue; }
    row.signups[signup.method ?? "unknown"] = (row.signups[signup.method ?? "unknown"] ?? 0) + 1;
    if (!user || i >= cohortCap) continue;
    activated.cohort++;
    const owned: Id<"organizations">[] = (await ctx.db.query("organizationMembers").withIndex("by_user", (q) => q.eq("userId", user._id)).take(10)).filter((m) => m.role === "owner").map((m) => m.organizationId);
    for (const name of ["github_app_installed", "first_repository_connected", "first_review_completed"] as const) {
      for (const org of owned) if (await ctx.db.query("conversionEvents").withIndex("by_key", (q) => q.eq("key", `${name}:${org}`)).first()) { activated[name]++; break; }
    }
  }
  return {
    days: [...days].sort(([x], [y]) => x.localeCompare(y)).map(([date, row]) => ({ date, ...row })),
    activated,
    capped: links.length === cap || signups.length === cap || signups.length > cohortCap,
  };
} });
