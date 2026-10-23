import type { MutationCtx } from "./_generated/server";
// Fixed-window counter: throws once `maximum` calls landed in the current window. It throws before
// writing, and a throw rolls back the whole mutation, so several limits checked in one mutation are
// all-or-nothing. Returns the count including this call; rows carry expiresAt so convex/authHygiene.ts
// can prune them.
export async function rateLimit(
  ctx: MutationCtx,
  key: string,
  maximum: number,
  windowMs = 60000,
) {
  const now = Date.now(),
    window = Math.floor(now / windowMs),
    expiresAt = (window + 1) * windowMs;
  const record = await ctx.db
    .query("rateLimits")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  if (record && record.window === window) {
    if (record.count >= maximum)
      throw new Error("Rate limit exceeded; retry after the current window");
    await ctx.db.patch(record._id, { count: record.count + 1, expiresAt });
    return record.count + 1;
  }
  if (record) await ctx.db.patch(record._id, { window, count: 1, expiresAt });
  else await ctx.db.insert("rateLimits", { key, window, count: 1, expiresAt });
  return 1;
}

// Email a signed-in member can send to any address (workspace invitations, notification-address
// checks) shares one deployment-wide daily ceiling, USER_EMAIL_DAILY (default 200). It is separate
// from sign-in links (convex/identity.ts), so neither can use up the other's share of the quota.
export function otherUserEmailLimit(ctx: MutationCtx) {
  const daily = Number(process.env.USER_EMAIL_DAILY);
  return rateLimit(ctx, "email-other:global", Number.isInteger(daily) && daily > 0 ? daily : 200, 86_400_000);
}
