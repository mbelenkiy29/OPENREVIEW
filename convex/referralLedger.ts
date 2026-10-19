import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { audit } from "./auth";
import { v, type Infer, type ObjectType } from "convex/values";
import { REFERRAL_CODE_WINDOW_DAYS, REFERRAL_CURRENCY, addMonthsUTC, commissionAmount, commissionBase, normalizeReferralCode, referralConfig, reversalTarget } from "../src/referrals";

// Referral helpers shared by sign-in, workspace creation and the referral functions (no endpoints).
export async function codeOwner(ctx: QueryCtx, code: unknown) {
  const normalized = normalizeReferralCode(code);
  return normalized ? ctx.db.query("referralCodes").withIndex("by_code", (q) => q.eq("code", normalized)).first() : null;
}
// Attributes a user created by this sign-in to the code's owner. Never throws: a bad code or a
// referral bug must not break sign-in.
export async function recordReferralSignup(ctx: MutationCtx, userId: Id<"users">, code: string | undefined) {
  if (!code || !referralConfig().enabled) return;
  try {
    const owner = await codeOwner(ctx, code);
    if (!owner || owner.userId === userId || await ctx.db.query("referrals").withIndex("by_referred_user", (q) => q.eq("referredUserId", userId)).first()) return;
    // shortcut: automatic fraud matching (card/email/domain) would hold the referral here; operators void abuse with referralOps:voidReferral.
    const now = Date.now();
    await ctx.db.insert("referrals", { referrerId: owner.userId, referredUserId: userId, source: "link", status: "signed_up", attributedAt: now, updatedAt: now });
  } catch (error) { console.error(JSON.stringify({ event: "referral.signup_failed", error: error instanceof Error ? error.message.slice(0, 200) : "unknown" })); }
}
export const referralOfWorkspace = (ctx: QueryCtx, organizationId: Id<"organizations">) => ctx.db.query("referrals").withIndex("by_referred_org", (q) => q.eq("referredOrganizationId", organizationId)).first();
// The referred person's first workspace carries the referral; one referral per workspace.
export async function bindReferralOnWorkspace(ctx: MutationCtx, userId: Id<"users">, organizationId: Id<"organizations">) {
  if (!referralConfig().enabled) return;
  const referral = await ctx.db.query("referrals").withIndex("by_referred_user", (q) => q.eq("referredUserId", userId)).first();
  if (referral?.status !== "signed_up" || await referralOfWorkspace(ctx, organizationId)) return;
  await ctx.db.patch(referral._id, { referredOrganizationId: organizationId, status: "pending", boundAt: Date.now(), updatedAt: Date.now() });
}

export const isMember = async (ctx: QueryCtx, organizationId: Id<"organizations">, userId: Id<"users">) => Boolean(await ctx.db.query("organizationMembers").withIndex("by_org_user", (q) => q.eq("organizationId", organizationId).eq("userId", userId)).unique());
/** A current member, or someone who was one and has since left (self-referral check). Any audit row
 *  of theirs counts: creating a workspace writes none, but its creator can only leave after promoting another owner. */
export async function everMember(ctx: QueryCtx, organizationId: Id<"organizations">, userId: Id<"users">) {
  return await isMember(ctx, organizationId, userId) || Boolean(await ctx.db.query("auditEvents").withIndex("by_org_user", (q) => q.eq("organizationId", organizationId).eq("userId", userId)).first());
}
/** The address to email a user at: the latest provider-verified identity, else a verified notification address. */
export async function verifiedEmail(ctx: QueryCtx, userId: Id<"users">): Promise<string | null> {
  const identity = (await ctx.db.query("identities").withIndex("by_user", (q) => q.eq("userId", userId)).take(20)).filter((i) => i.emailVerified && i.email).sort((a, b) => b.lastLoginAt - a.lastLoginAt)[0];
  if (identity?.email) return identity.email;
  return (await ctx.db.query("notificationPreferences").withIndex("by_user_org", (q) => q.eq("userId", userId)).take(100)).filter((p) => p.email && p.emailVerifiedAt).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.email ?? null;
}
/** A login safe to show to someone else: GitHub usernames only. Email and Google logins are an
 *  email address's local part, so they are never shown (null). */
export async function publicLogin(ctx: QueryCtx, userId: Id<"users">) {
  const user = await ctx.db.get(userId);
  return user?.githubId !== undefined ? user.login : null;
}

// Commission ledger (Phase 2): the coupon at Checkout and one commission per paid invoice.
/** A workspace that has never paid: no subscription linked and no commission earned from it. */
export async function neverPaid(ctx: QueryCtx, organizationId: Id<"organizations">) {
  if ((await ctx.db.query("billingAccounts").withIndex("by_org", (q) => q.eq("organizationId", organizationId)).first())?.subscriptionId) return false;
  const referral = await referralOfWorkspace(ctx, organizationId);
  return !referral || !await ctx.db.query("referralCommissions").withIndex("by_referral", (q) => q.eq("referralId", referral._id)).first();
}
export const codeWindowOpen = async (ctx: QueryCtx, organizationId: Id<"organizations">) => ((await ctx.db.get(organizationId))?.createdAt ?? 0) >= Date.now() - REFERRAL_CODE_WINDOW_DAYS * 86400000;
/** The referral a Checkout from this workspace uses: the workspace's own, or else the caller's unpaid
 *  one, which moves here only for the owner of a never-paid workspace created after the sign-up, and
 *  only while the workspace it is on has never subscribed (a trial's $0 invoices pay nothing). The
 *  coupon is withheld when the referrer is or was a member of the workspace. */
export async function checkoutReferral(ctx: QueryCtx, userId: Id<"users">, role: string, organizationId: Id<"organizations">): Promise<{ referral: Doc<"referrals">; move: boolean; discount: boolean } | null> {
  const coupon = referralConfig().couponId !== null, bound = await referralOfWorkspace(ctx, organizationId);
  if (bound) return { referral: bound, move: false, discount: coupon && bound.status === "pending" && bound.firstPaidAt === undefined && !await everMember(ctx, organizationId, bound.referrerId) };
  const mine = await ctx.db.query("referrals").withIndex("by_referred_user", (q) => q.eq("referredUserId", userId)).first(), organization = await ctx.db.get(organizationId);
  if (!mine || !(mine.status === "signed_up" || (mine.status === "pending" && mine.firstPaidAt === undefined)) || role !== "owner" || !organization || organization.createdAt < mine.attributedAt || !await neverPaid(ctx, organizationId) || (mine.referredOrganizationId !== undefined && !await neverPaid(ctx, mine.referredOrganizationId)) || await everMember(ctx, organizationId, mine.referrerId)) return null;
  // shortcut: two Checkout sessions left open at once (they expire after 24h) can both carry the coupon; expire the earlier session on a move if this is abused.
  return { referral: mine, move: true, discount: coupon };
}
/** Settings → Billing for admins: who referred the workspace, whether Checkout applies the discount,
 *  and whether a referral code can still be added. */
export async function referralStatus(ctx: QueryCtx, userId: Id<"users">, role: string, organizationId: Id<"organizations">) {
  const found = await checkoutReferral(ctx, userId, role, organizationId), live = found?.referral.status === "void" ? null : found;
  return { referred: Boolean(live), invitedBy: live ? await publicLogin(ctx, live.referral.referrerId) : null, discount: live?.discount ?? false, canApply: !found && await codeWindowOpen(ctx, organizationId) && await neverPaid(ctx, organizationId) };
}
/** Voids a referral and its commissions still on hold; available ones stay (a later balance can go negative). */
export async function voidReferralRows(ctx: MutationCtx, referral: Doc<"referrals">, reason: string) {
  const now = Date.now(), voidReason = reason.slice(0, 200);
  await ctx.db.patch(referral._id, { status: "void", voidedAt: now, voidReason, updatedAt: now });
  for (const c of await ctx.db.query("referralCommissions").withIndex("by_referral", (q) => q.eq("referralId", referral._id)).collect()) if (c.status === "accrued" && c.availableAt > now) await ctx.db.patch(c._id, { status: "void", voidReason, updatedAt: now });
}

// What the Stripe webhook forwards about a paid invoice (cents; times in ms). All optional: old and
// unexpected payloads still apply to billing, and accrual skips what it cannot use.
// shortcut: livemode is not recorded; test and live mode run on separate Convex deployments.
export const invoiceFacts = { customer: v.string(), subscription: v.optional(v.string()), id: v.optional(v.string()), amountPaid: v.optional(v.number()), amountOverpaid: v.optional(v.number()), total: v.optional(v.number()), totalExcludingTax: v.optional(v.number()), currency: v.optional(v.string()), invoiceCreated: v.optional(v.number()), paidAt: v.optional(v.number()) };
/** Accrues the referrer's commission for one paid invoice. Runs in its own scheduled mutation, never in
 *  the billing webhook, so a failure here cannot affect billing. Returns the outcome. */
export async function accrueCommission(ctx: MutationCtx, f: ObjectType<typeof invoiceFacts>): Promise<string> {
  const config = referralConfig();
  if (!config.enabled || !f.id || !f.subscription || f.amountPaid === undefined || f.total === undefined || !f.currency || f.invoiceCreated === undefined) return "incomplete";
  const invoiceId = f.id, account = await ctx.db.query("billingAccounts").withIndex("by_customer", (q) => q.eq("customerId", f.customer)).first();
  // Subscription invoices only: one-off invoices for the same customer earn nothing.
  if (!account || (account.subscriptionId && account.subscriptionId !== f.subscription)) return "unknown subscription";
  const referral = await referralOfWorkspace(ctx, account.organizationId);
  if (!referral || !["pending", "active", "ended"].includes(referral.status)) return "no referral";
  if (await ctx.db.query("referralCommissions").withIndex("by_invoice", (q) => q.eq("invoiceId", invoiceId)).first()) return "duplicate";
  if (f.currency !== REFERRAL_CURRENCY) { console.log(JSON.stringify({ event: "referral.currency_skipped", currency: f.currency.slice(0, 10) })); return "other currency"; }
  const base = commissionBase({ amountPaid: f.amountPaid, amountOverpaid: f.amountOverpaid, total: f.total, totalExcludingTax: f.totalExcludingTax });
  if (base <= 0) return "nothing paid";
  // Self-referral: the referrer is, or once was, a member of the workspace they referred.
  if (await everMember(ctx, account.organizationId, referral.referrerId)) { await voidReferralRows(ctx, referral, "referrer is or was a member of the workspace"); return "void"; }
  // The window starts at the earliest paid invoice, so a late month-1 invoice moves it back.
  const now = Date.now(), paidAt = f.paidAt ?? now, first = referral.firstPaidAt === undefined;
  const windowStart = Math.min(referral.windowStart ?? Infinity, f.invoiceCreated), commissionEndsAt = addMonthsUTC(windowStart, config.months), ended = f.invoiceCreated >= commissionEndsAt;
  await ctx.db.patch(referral._id, { windowStart, commissionEndsAt, ...(first ? { status: "active" as const, firstPaidAt: paidAt } : ended ? { status: "ended" as const } : {}), updatedAt: now });
  if (first) await ctx.scheduler.runAfter(0, internal.referralJobs.sendConversionNotice, { referralId: referral._id });
  if (ended) return "ended";
  await ctx.db.insert("referralCommissions", { referralId: referral._id, referrerId: referral.referrerId, referredOrganizationId: account.organizationId, invoiceId, subscriptionId: f.subscription, currency: f.currency, base, rateBps: config.rateBps, amount: commissionAmount(base, config.rateBps), reversed: 0, status: "accrued", invoiceCreated: f.invoiceCreated, paidAt, availableAt: paidAt + config.holdDays * 86400000, createdAt: now, updatedAt: now });
  return "accrued";
}

// Clawback and redemption (Phase 3).
export const anyCommission = async (ctx: QueryCtx) => Boolean(await ctx.db.query("referralCommissions").first());
/** Whether a charge of this Stripe customer could have paid a commissioned invoice, so charge events for
 *  everyone else are skipped: its workspace carries a referral, or the workspace is unknown (deleted after
 *  paying; the purge drops its billing account) and the deployment has commissions at all. */
export async function mayHaveCommission(ctx: QueryCtx, customer: string) {
  const account = await ctx.db.query("billingAccounts").withIndex("by_customer", (q) => q.eq("customerId", customer)).first();
  return account ? Boolean(await referralOfWorkspace(ctx, account.organizationId)) : anyCommission(ctx);
}
// What the webhook forwards about a refunded or disputed charge (http.ts): only which charge changed.
export const chargeEvent = { chargeId: v.string(), kind: v.union(v.literal("refund"), v.literal("dispute")), customer: v.optional(v.string()), paymentIntent: v.optional(v.string()) };
// One charge as just fetched from Stripe (cents; fetchedAt in ms).
export const chargeFacts = v.object({ id: v.string(), amount: v.number(), refunded: v.number(), dispute: v.optional(v.object({ id: v.string(), status: v.string(), amount: v.number() })), fetchedAt: v.number() });
/** Stores a charge's current refund and dispute state on the invoice's commission and recomputes the
 *  clawback. Ordered by when we fetched it, never by event time: an older fetch changes nothing. */
export async function applyChargeFacts(ctx: MutationCtx, invoiceId: string, charge: Infer<typeof chargeFacts>): Promise<string> {
  const commission = await ctx.db.query("referralCommissions").withIndex("by_invoice", (q) => q.eq("invoiceId", invoiceId)).first();
  if (!commission) return "no commission";
  if ((commission.charges?.find((c) => c.id === charge.id)?.fetchedAt ?? -1) >= charge.fetchedAt) return "stale";
  // shortcut: an invoice paid by several charges is reversed as if the charges seen so far were all of it; list GET /v1/invoice_payments?invoice=<id> here if partial payments are turned on.
  const charges = [...(commission.charges ?? []).filter((c) => c.id !== charge.id), charge];
  await ctx.db.patch(commission._id, { charges, reversed: reversalTarget(commission.amount, charges), updatedAt: Date.now() });
  return "applied";
}
/** A referrer's commissions and redemptions, for balances. */
export async function ledgerFor(ctx: QueryCtx, userId: Id<"users">) {
  // shortcut: 5000 rows each; add a running-balance table if a referrer ever gets close.
  const commissions = await ctx.db.query("referralCommissions").withIndex("by_referrer", (q) => q.eq("referrerId", userId)).take(5000);
  return { commissions, redemptions: await ctx.db.query("referralRedemptions").withIndex("by_user", (q) => q.eq("userId", userId)).take(5000) };
}
/** Referral credit applied to a workspace's bill (Settings → Billing), in cents. */
export const referralCredit = async (ctx: QueryCtx, organizationId: Id<"organizations">) => (await ctx.db.query("referralRedemptions").withIndex("by_credit_org", (q) => q.eq("creditOrganizationId", organizationId)).take(1000)).reduce((sum, r) => sum + (r.status === "completed" ? r.amount : 0), 0);
/** Ends a redemption that is still processing (completed with its Stripe id, or failed, which
 *  releases the balance) and audits it on the credited workspace while that still exists. */
export async function settleRedemption(ctx: MutationCtx, redemption: Doc<"referralRedemptions">, outcome: { stripeId: string } | { error: string }, action: string) {
  const now = Date.now();
  await ctx.db.patch(redemption._id, { ...("stripeId" in outcome ? { status: "completed" as const, stripeId: outcome.stripeId, completedAt: now } : { status: "failed" as const, error: outcome.error.slice(0, 300) }), leaseId: undefined, leaseUntil: undefined, updatedAt: now });
  if (redemption.creditOrganizationId && await ctx.db.get(redemption.creditOrganizationId)) await audit(ctx, redemption.creditOrganizationId, undefined, action, redemption._id);
}

// Cash payouts (Phase 4): transfers to the referrer's Stripe Connect account (Accounts v2, recipient).
export const payoutAccountOf = (ctx: QueryCtx, userId: Id<"users">) => ctx.db.query("referralPayoutAccounts").withIndex("by_user", (q) => q.eq("userId", userId)).first();
/** An account's transfer status and earliest requirement deadline, as read from Stripe. */
export const payoutStatus = { transfers: v.union(v.literal("active"), v.literal("pending"), v.literal("restricted"), v.literal("unsupported"), v.literal("unknown")), requirements: v.optional(v.string()) };
// Setting up payouts and cashing out need a browser sign-in from the last 15 minutes, so an older
// stolen session or an API key (no session) can't add a bank account or move money. A session started
// by linking another provider keeps the linking session's sign-in time (signedInAt).
// shortcut: no security-notice emails and no first-payout delay; add them here if account takeover is seen despite this gate.
export const recentSignIn = (session: Doc<"sessions"> | null) => session !== null && Date.now() - (session.signedInAt ?? session.createdAt) < 15 * 60000;
export const signInAgain = { ok: false as const, error: "Sign in again to continue.", signIn: "/login?next=/dashboard/settings/referrals&reauth=1" };
export const payoutsOff = "This deployment doesn’t offer cash payouts.";
