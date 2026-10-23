import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

// Deletes what sign-in leaves behind: rate-limit counters a day after their window ends, magic links
// after 30 days (convex/authFunnel.ts reads them until then), and SAML request ids a day after they
// were made (they expire in 10 minutes). Every 6 hours (convex/crons.ts), up to 200 rows of each per
// run, continuing at once while any table has more.
export const prune = internalMutation({ args: {}, handler: async (ctx): Promise<{ counters: number; links: number; samlRequests: number }> => {
  const now = Date.now(), day = 86_400_000;
  const counters = await ctx.db.query("rateLimits").withIndex("by_expiry", (q) => q.gt("expiresAt", 0).lt("expiresAt", now - day)).take(200);
  const links = await ctx.db.query("loginTokens").withIndex("by_creation_time", (q) => q.lt("_creationTime", now - 30 * day)).take(200);
  const samlRequests = await ctx.db.query("ssoRequests").withIndex("by_creation_time", (q) => q.lt("_creationTime", now - day)).take(200);
  for (const row of [...counters, ...links, ...samlRequests]) await ctx.db.delete(row._id);
  if ([counters, links, samlRequests].some((rows) => rows.length === 200)) await ctx.scheduler.runAfter(0, internal.authHygiene.prune, {});
  return { counters: counters.length, links: links.length, samlRequests: samlRequests.length };
} });

// Once, after deploying: counters last written before expiresAt existed never expire, and the old
// sign-in ones are keyed by the raw address. Dropping a counter still in use only restarts its window.
//   npx convex run authHygiene:dropUnexpiringCounters
export const dropUnexpiringCounters = internalMutation({ args: {}, handler: async (ctx): Promise<{ deleted: number }> => {
  const rows = await ctx.db.query("rateLimits").withIndex("by_expiry", (q) => q.eq("expiresAt", undefined)).take(500);
  for (const row of rows) await ctx.db.delete(row._id);
  if (rows.length === 500) await ctx.scheduler.runAfter(0, internal.authHygiene.dropUnexpiringCounters, {});
  return { deleted: rows.length };
} });
