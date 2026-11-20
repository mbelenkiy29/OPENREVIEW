import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { billingConfig, periodKey } from "../src/billing";
import { contributorKey, isBotAuthor } from "../src/contributors";

// The active-contributor ledger Enterprise contracts are billed from (docs/roadmap/enterprise-plan.md, E1.2): one row
// per pull request author per UTC month, written when a review completes. Nothing is written with billing off.

// The OpenReview user a pull request author is, when they linked that account: a provider identity on the
// repository's connection, or for GitHub a sign-in identity or the legacy users.githubId account.
async function userFor(ctx: QueryCtx, connectionId: Id<"providerConnections"> | undefined, login: string): Promise<Id<"users"> | undefined> {
  if (connectionId) return (await ctx.db.query("providerIdentities").withIndex("by_connection_username", (q) => q.eq("connectionId", connectionId).eq("username", login)).first())?.userId;
  const linked = await ctx.db.query("identities").withIndex("by_provider_login", (q) => q.eq("provider", "github").eq("login", login)).first();
  if (linked) return linked.userId;
  return (await ctx.db.query("users").withIndex("by_login", (q) => q.eq("login", login)).take(5)).find((u) => u.githubId !== undefined)?._id;
}

/** Records the author of a completed review as active in the month `at` falls in; a second review changes nothing. */
export async function recordContributor(ctx: MutationCtx, review: Doc<"reviews">, at: number) {
  if (!billingConfig().enabled) return;
  // Review rows from before `author` was copied onto them fall back to the pull request.
  const login = review.author ?? (await ctx.db.query("pullRequests").withIndex("by_repo_number", (q) => q.eq("repositoryId", review.repositoryId).eq("number", review.prNumber)).first())?.author;
  if (!login?.trim()) return;
  const connectionId = (await ctx.db.get(review.repositoryId))?.connectionId, provider = connectionId ? (await ctx.db.get(connectionId))?.kind ?? "unknown" : "github";
  const userId = await userFor(ctx, connectionId, login), key = contributorKey({ provider, connectionId, login, userId })!, period = periodKey(at);
  const existing = await ctx.db.query("activeContributors").withIndex("by_org_period_key", (q) => q.eq("organizationId", review.organizationId).eq("period", period).eq("key", key)).first();
  if (existing) return;
  const own = await ctx.db.query("billingAccounts").withIndex("by_org", (q) => q.eq("organizationId", review.organizationId)).unique();
  // A workspace billed under another's contract follows that contract's non-billable authors.
  const account = own?.contractGroupId ? await ctx.db.query("billingAccounts").withIndex("by_org", (q) => q.eq("organizationId", own.contractGroupId!)).unique() : own;
  await ctx.db.insert("activeContributors", { organizationId: review.organizationId, period, key, login, provider, userId, firstReviewId: review._id, firstAt: at, bot: isBotAuthor(login, account?.contract?.nonBillableAuthors) });
}

export const contributorRows = (ctx: QueryCtx, organizationId: Id<"organizations">, period: string) => ctx.db.query("activeContributors").withIndex("by_org_period_key", (q) => q.eq("organizationId", organizationId).eq("period", period)).collect();
/** A month's rows across the workspaces of one contract, one per person: someone active in two of them counts once. */
export async function groupContributorRows(ctx: QueryCtx, organizationIds: Id<"organizations">[], period: string) {
  const byKey = new Map<string, Doc<"activeContributors">>();
  for (const id of organizationIds) for (const row of await contributorRows(ctx, id, period)) { const seen = byKey.get(row.key); if (!seen || row.firstAt < seen.firstAt) byKey.set(row.key, row); }
  return [...byKey.values()];
}
/** Billable contributors in a month (bots are listed but not counted). */
export const contributorCount = async (ctx: QueryCtx, organizationId: Id<"organizations">, period: string) => (await contributorRows(ctx, organizationId, period)).filter((r) => !r.bot).length;

// Rebuilds one month from its reviews: at contract start, and after an author links an account or the contract's
// non-billable list changes. Run with `npx convex run contributors:backfill '{"organizationId":"…","period":"2026-11"}'`.
// shortcut: the month is cleared on the first page and refilled over the next pages, so the count dips while it runs,
// and the clear reads every row at once; keep rows keyed by a run id and swap at the end if a month passes ~5,000 contributors.
export const backfill = internalMutation({ args: { organizationId: v.id("organizations"), period: v.string(), cursor: v.optional(v.string()) }, handler: async (ctx, a) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(a.period)) throw new Error("period is YYYY-MM");
  const [year, month] = a.period.split("-").map(Number), start = Date.UTC(year, month - 1, 1), end = Date.UTC(year, month, 1);
  if (!a.cursor) for (const row of await contributorRows(ctx, a.organizationId, a.period)) await ctx.db.delete(row._id);
  // by_org_time is by creation; a review created up to 31 days before the month can still finish in it.
  const page = await ctx.db.query("reviews").withIndex("by_org_time", (q) => q.eq("organizationId", a.organizationId).gte("createdAt", start - 31 * 86400000).lt("createdAt", end)).paginate({ cursor: a.cursor ?? null, numItems: 200 });
  for (const review of page.page) if (review.status === "completed" && review.finishedAt !== undefined && review.finishedAt >= start && review.finishedAt < end) await recordContributor(ctx, review, review.finishedAt);
  if (!page.isDone) await ctx.scheduler.runAfter(0, internal.contributors.backfill, { ...a, cursor: page.continueCursor });
} });
