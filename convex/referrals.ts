import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { audit, authenticated, authorize, service } from "./auth";
import { rateLimit } from "./rateLimit";
import { accrueCommission, checkoutReferral, codeOwner, codeWindowOpen, everMember, invoiceFacts, neverPaid, publicLogin, referralOfWorkspace, verifiedEmail } from "./referralLedger";
import { REFERRAL_CODE_WINDOW_DAYS, REFERRAL_CURRENCY, generateReferralCode, referralConfig } from "../src/referrals";

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
  // shortcut: the oldest 500 referrals and 5000 commissions only; paginate or aggregate when a referrer brings in more.
  const referrals = await ctx.db.query("referrals").withIndex("by_referrer", (q) => q.eq("referrerId", user._id)).take(500);
  const live = referrals.filter((r) => r.status !== "void"), now = Date.now();
  const commissions = (await ctx.db.query("referralCommissions").withIndex("by_referrer", (q) => q.eq("referrerId", user._id)).take(5000)).filter((c) => c.status === "accrued");
  const net = (rows: typeof commissions) => rows.reduce((sum, c) => sum + c.amount - c.reversed, 0);
  // Referred people are shown by GitHub username only; anyone else is numbered in sign-up order.
  const people = await Promise.all(referrals.map(async (r, i) => ({ _id: r._id, name: await publicLogin(ctx, r.referredUserId) ?? `Email sign-up #${i + 1}`, status: r.status, label: statusLabels[r.status], signedUpAt: r.attributedAt, commissionEndsAt: r.commissionEndsAt ?? null, earned: net(commissions.filter((c) => c.referralId === r._id)) })));
  return { enabled: true as const, code: code?.code ?? null, login: await publicLogin(ctx, user._id), notified: Boolean(await verifiedEmail(ctx, user._id)), signedUp: live.length, subscribed: live.filter((r) => r.status === "active" || r.status === "ended").length, pending: live.filter((r) => r.status === "signed_up" || r.status === "pending").length, currency: REFERRAL_CURRENCY, available: net(commissions.filter((c) => c.availableAt <= now)), onHold: net(commissions.filter((c) => c.availableAt > now)), holdDays: referralConfig().holdDays, people: people.reverse() };
} });

/** What a referral link shows before sign-up (web server only): the owner's GitHub username or null.
 *  Null overall for an unknown code or when the program is off. */
export const preview = query({ args: { secret: v.string(), code: v.string() }, handler: async (ctx, a) => {
  service(a.secret);
  if (!referralConfig().enabled) return null;
  const owner = await codeOwner(ctx, a.code);
  return owner ? { login: await publicLogin(ctx, owner.userId) } : null;
} });

/** Adds a referral code to a workspace that has none (Settings → Billing, admins). Rejections return
 *  {ok:false} rather than throw, so every attempt counts against the rate limit. */
export const applyCode = mutation({ args: { token: v.string(), organizationId: v.id("organizations"), code: v.string() }, handler: async (ctx, a): Promise<{ ok: true } | { ok: false; error: string }> => {
  const { user } = await authorize(ctx, a.token, a.organizationId, true);
  if (!referralConfig().enabled) return { ok: false, error: "This deployment doesn’t run the referral program." };
  try { await rateLimit(ctx, `referral-apply:${user._id}`, 5, 3600000); } catch { return { ok: false, error: "Too many referral code attempts. Try again in an hour." }; }
  const fail = (error: string) => ({ ok: false as const, error }), owner = await codeOwner(ctx, a.code);
  if (!owner) return fail("That referral code doesn’t exist. Check it and try again.");
  if (owner.userId === user._id) return fail("You can’t use your own referral code.");
  if (await referralOfWorkspace(ctx, a.organizationId)) return fail("This workspace already has a referral.");
  if (!await codeWindowOpen(ctx, a.organizationId)) return fail(`A referral code can be added only in a workspace’s first ${REFERRAL_CODE_WINDOW_DAYS} days.`);
  if (!await neverPaid(ctx, a.organizationId)) return fail("A referral code can’t be added to a workspace that has subscribed.");
  if (await everMember(ctx, a.organizationId, owner.userId)) return fail("The code’s owner is or was a member of this workspace.");
  const referredUser = (userId: Id<"users">) => ctx.db.query("referrals").withIndex("by_referred_user", (q) => q.eq("referredUserId", userId)).first();
  if ((await referredUser(owner.userId))?.referrerId === user._id) return fail("You referred the code’s owner, so you can’t use their code.");
  // One referral per person: an existing one binds here only if it is unbound and from the same referrer.
  const mine = await referredUser(user._id), now = Date.now(), bind = { referredOrganizationId: a.organizationId, status: "pending" as const, boundAt: now, updatedAt: now };
  if (mine && mine.referrerId !== owner.userId) return fail("Your account was already referred by someone else.");
  if (mine && mine.status !== "signed_up") return fail("Your account’s referral can’t be added to this workspace.");
  // shortcut: automatic fraud matching would hold a code applied by an account older than the code (existing_user); operators void abuse with referralOps:voidReferral.
  const referralId = mine?._id ?? await ctx.db.insert("referrals", { referrerId: owner.userId, referredUserId: user._id, source: "code", attributedAt: now, ...bind });
  if (mine) await ctx.db.patch(mine._id, bind);
  await audit(ctx, a.organizationId, user._id, "referral.code_applied", referralId);
  return { ok: true };
} });

/** Called by billingJobs.checkout before it creates the session: binds or moves the caller's referral
 *  when the rules allow, and returns the coupon when the workspace has not paid yet. */
export const prepareCheckout = internalMutation({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a): Promise<{ referralId: Id<"referrals">; coupon: string } | null> => {
  const { user, member } = await authorize(ctx, a.token, a.organizationId, true);
  const config = referralConfig(), found = config.enabled ? await checkoutReferral(ctx, user._id, member.role, a.organizationId) : null;
  if (!found) return null;
  if (found.move) await ctx.db.patch(found.referral._id, { referredOrganizationId: a.organizationId, status: "pending", boundAt: Date.now(), updatedAt: Date.now() });
  return found.discount && config.couponId ? { referralId: found.referral._id, coupon: config.couponId } : null;
} });
/** Scheduled by the invoice.paid webhook (billing.applyStripeEvent). */
export const accrue = internalMutation({ args: invoiceFacts, handler: (ctx, a) => accrueCommission(ctx, a) });
/** Claims the one conversion email for a referral: the referrer's address and the referred person's
 *  public name, or null when it was already sent or there is no verified address. */
export const claimConversionNotice = internalMutation({ args: { referralId: v.id("referrals") }, handler: async (ctx, a): Promise<{ to: string; name: string | null } | null> => {
  const referral = await ctx.db.get(a.referralId);
  if (!referral || referral.noticeSentAt || referral.status === "void") return null;
  await ctx.db.patch(referral._id, { noticeSentAt: Date.now() });
  const to = await verifiedEmail(ctx, referral.referrerId);
  return to ? { to, name: await publicLogin(ctx, referral.referredUserId) } : null;
} });
