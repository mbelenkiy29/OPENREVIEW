import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { authenticated, service } from "./auth";
import { codeOwner, publicLogin } from "./referralLedger";
import { generateReferralCode, referralConfig } from "../src/referrals";

// Referral program, personal side: each signed-in user's code and the people who signed up with it.
// Everything returns "off" unless referralConfig().enabled.

/** The caller's referral code, created on first use (idempotent). Null when the program is off. */
export const ensureCode = mutation({ args: { token: v.string() }, handler: async (ctx, a): Promise<string | null> => {
  const user = await authenticated(ctx, a.token);
  if (!referralConfig().enabled) return null;
  const existing = await ctx.db.query("referralCodes").withIndex("by_user", (q) => q.eq("userId", user._id)).first();
  if (existing) return existing.code;
  // 30^8 codes: a collision is vanishingly rare, but never reuse someone else's.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateReferralCode(crypto.getRandomValues(new Uint8Array(32)));
    if (await codeOwner(ctx, code)) continue;
    await ctx.db.insert("referralCodes", { userId: user._id, code, createdAt: Date.now() });
    return code;
  }
  throw new Error("Could not create a referral code; try again");
} });

const statusLabels = { signed_up: "signed up", pending: "workspace created", active: "subscribed", ended: "commission ended", void: "void" } as const;
export const overview = query({ args: { token: v.string() }, handler: async (ctx, a) => {
  const user = await authenticated(ctx, a.token);
  if (!referralConfig().enabled) return { enabled: false as const };
  const code = await ctx.db.query("referralCodes").withIndex("by_user", (q) => q.eq("userId", user._id)).first();
  // shortcut: the oldest 500 referrals only; paginate when a referrer brings in more.
  const referrals = await ctx.db.query("referrals").withIndex("by_referrer", (q) => q.eq("referrerId", user._id)).take(500);
  const live = referrals.filter((r) => r.status !== "void");
  // Referred people are shown by GitHub username only; anyone else is numbered in sign-up order.
  const people = await Promise.all(referrals.map(async (r, i) => ({ _id: r._id, name: await publicLogin(ctx, r.referredUserId) ?? `Email sign-up #${i + 1}`, status: r.status, label: statusLabels[r.status], signedUpAt: r.attributedAt, commissionEndsAt: r.commissionEndsAt ?? null })));
  return { enabled: true as const, code: code?.code ?? null, login: await publicLogin(ctx, user._id), signedUp: live.length, subscribed: live.filter((r) => r.status === "active" || r.status === "ended").length, pending: live.filter((r) => r.status === "signed_up" || r.status === "pending").length, people: people.reverse() };
} });

/** What a referral link shows before sign-up (web server only): the owner's GitHub username or null.
 *  Null overall for an unknown code or when the program is off. */
export const preview = query({ args: { secret: v.string(), code: v.string() }, handler: async (ctx, a) => {
  service(a.secret);
  if (!referralConfig().enabled) return null;
  const owner = await codeOwner(ctx, a.code);
  return owner ? { login: await publicLogin(ctx, owner.userId) } : null;
} });
