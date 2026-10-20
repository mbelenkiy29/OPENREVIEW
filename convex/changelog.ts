import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { rateLimit } from "./rateLimit";

// Changelog email (convex/changelogJobs.ts). Subscribers are kept by Resend, so all that is stored
// here is the sign-up rate limit (by address hash) and which entries the last digest covered.
export const limitSubscribe = internalMutation({ args: { emailHash: v.string() }, handler: (ctx, a) => rateLimit(ctx, `changelog-subscribe:${a.emailHash}`, 3, 3600000) });

export const digestKeys = internalQuery({ args: {}, handler: async (ctx) => (await ctx.db.query("changelogDigests").first())?.keys ?? null });

export const recordDigest = internalMutation({ args: { keys: v.string() }, handler: async (ctx, a) => {
  const row = await ctx.db.query("changelogDigests").first();
  if (row) await ctx.db.patch(row._id, { keys: a.keys, sentAt: Date.now() });
  else await ctx.db.insert("changelogDigests", { keys: a.keys, sentAt: Date.now() });
} });
