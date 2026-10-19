import { internalMutation, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { audit, authenticated, authenticatedSession, authorize, service } from "./auth";
import { rateLimit } from "./rateLimit";
import { accrueCommission, applyChargeFacts, chargeFacts, checkoutReferral, codeOwner, codeWindowOpen, everMember, invoiceFacts, ledgerFor, ledgerLimit, mayHaveCommission, neverPaid, payoutAccountOf, payoutStatus, payoutsOff, publicLogin, recentSignIn, referralOfWorkspace, settleRedemption, signInAgain, verifiedEmail } from "./referralLedger";
import { REFERRAL_CODE_WINDOW_DAYS, REFERRAL_CURRENCY, REFERRAL_MIN_CREDIT_CENTS, REFERRAL_MIN_PAYOUT_CENTS, REFERRAL_PAYOUT_COUNTRIES, REFERRAL_PAYOUT_REVIEW_CENTS, generateReferralCode, referralBalances, referralConfig } from "../src/referrals";

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
  const live = referrals.filter((r) => r.status !== "void"), now = Date.now(), { commissions, redemptions } = await ledgerFor(ctx, user._id);
  const net = (referralId: Id<"referrals">) => commissions.filter((c) => c.status === "accrued" && c.referralId === referralId).reduce((sum, c) => sum + c.amount - c.reversed, 0);
  // Referred people are shown by GitHub username only; anyone else is numbered in sign-up order.
  const people = await Promise.all(referrals.map(async (r, i) => ({ _id: r._id, name: await publicLogin(ctx, r.referredUserId) ?? `Email sign-up #${i + 1}`, status: r.status, label: statusLabels[r.status], signedUpAt: r.attributedAt, commissionEndsAt: r.commissionEndsAt ?? null, earned: net(r._id) })));
  const names = new Map(people.map((p) => [p._id, p.name])), balance = referralBalances(commissions, redemptions, now)[REFERRAL_CURRENCY] ?? { available: 0, onHold: 0, redeemed: 0 };
  const workspaceName = async (id?: Id<"organizations">) => (id && (await ctx.db.get(id))?.name) || "a deleted workspace";
  const rows = [
    ...commissions.map((c) => ({ _id: c._id as string, at: c.paidAt, what: `Commission · ${names.get(c.referralId) ?? "a referral"}`, credit: undefined as Id<"organizations"> | undefined, amount: c.amount - c.reversed, status: c.status === "void" ? "void" : c.reversed >= c.amount ? "reversed" : c.availableAt > now ? "on hold" : "available", reversed: c.status === "accrued" ? c.reversed : 0, availableAt: c.availableAt, error: null })),
    ...redemptions.map((r) => ({ _id: r._id as string, at: r.createdAt, what: r.kind === "payout" ? "Cash out with Stripe" : "Credit", credit: r.creditOrganizationId, amount: -r.amount, status: r.status as string, reversed: 0, availableAt: null, error: r.status === "failed" ? r.error ?? null : null })),
  ].sort((x, y) => y.at - x.at).slice(0, 50);
  // Workspace names only for the rows shown.
  const activity = await Promise.all(rows.map(async ({ credit, ...row }) => credit ? { ...row, what: `Credit to ${await workspaceName(credit)}` } : row));
  // Credit goes on the bill of a workspace the caller administers that already has a Stripe customer.
  const memberships = (await ctx.db.query("organizationMembers").withIndex("by_user", (q) => q.eq("userId", user._id)).take(100)).filter((m) => m.role === "owner" || m.role === "admin");
  const workspaces = (await Promise.all(memberships.map(async (m) => (await ctx.db.query("billingAccounts").withIndex("by_org", (q) => q.eq("organizationId", m.organizationId)).first())?.customerId ? { organizationId: m.organizationId, name: await workspaceName(m.organizationId) } : null))).filter((w) => w !== null);
  // Cash payouts, when the deployment offers them: the caller's Stripe account as last read (the page refreshes it first).
  const account = referralConfig().payoutsEnabled ? await payoutAccountOf(ctx, user._id) : undefined; // undefined: payouts off; null: no account yet
  const payouts = account === undefined ? null : { state: !account ? "none" as const : account.transfers === "active" ? "active" as const : account.onboardedAt ? "restricted" as const : "incomplete" as const, countries: REFERRAL_PAYOUT_COUNTRIES, minPayout: REFERRAL_MIN_PAYOUT_CENTS, reviewAbove: REFERRAL_PAYOUT_REVIEW_CENTS };
  return { enabled: true as const, code: code?.code ?? null, login: await publicLogin(ctx, user._id), notified: Boolean(await verifiedEmail(ctx, user._id)), signedUp: live.length, subscribed: live.filter((r) => r.status === "active" || r.status === "ended").length, pending: live.filter((r) => r.status === "signed_up" || r.status === "pending").length, currency: REFERRAL_CURRENCY, ...balance, holdDays: referralConfig().holdDays, minCredit: REFERRAL_MIN_CREDIT_CENTS, people: people.reverse(), activity, workspaces, payouts };
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

// Clawback (Phase 3): referralJobs.resolveChargeEvent reads a refunded or disputed charge from Stripe
// and applies it to the commission of each invoice the charge paid.
export const applyChargeEvent = internalMutation({ args: { invoiceId: v.string(), charge: chargeFacts }, handler: (ctx, a) => applyChargeFacts(ctx, a.invoiceId, a.charge) });
export const customerMayHaveCommission = internalQuery({ args: { customer: v.string() }, handler: (ctx, a) => mayHaveCommission(ctx, a.customer) });

// Workspace credit (Phase 3): a negative Stripe customer balance transaction on a workspace the
// referrer administers, which Stripe applies to its next invoices.
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`; // Convex-side messages avoid Intl (formatMoney)
// Concurrent requests read the same ledger rows, so Convex retries one of them: no double spend.
// Past ledgerLimit redemptions, newer ones would go uncounted, so nothing more can be redeemed (fails closed).
const availableFor = async (ctx: QueryCtx, userId: Id<"users">) => {
  const { commissions, redemptions } = await ledgerFor(ctx, userId), full = redemptions.length >= ledgerLimit;
  if (full) console.error(JSON.stringify({ event: "referral.ledger_full", userId }));
  return { available: full ? 0 : referralBalances(commissions, redemptions, Date.now())[REFERRAL_CURRENCY]?.available ?? 0, redemptions };
};
const notAvailable = (available: number) => available > 0 ? `You have ${dollars(available)} available.` : "You have no earnings available to redeem yet.";
/** Requests a credit from the caller's available balance. Rejections return {ok:false} rather than
 *  throw, so every attempt counts against the rate limit. */
export const requestCredit = mutation({ args: { token: v.string(), organizationId: v.id("organizations"), amount: v.number() }, handler: async (ctx, a): Promise<{ ok: true } | { ok: false; error: string }> => {
  const { user } = await authorize(ctx, a.token, a.organizationId, true);
  const fail = (error: string) => ({ ok: false as const, error });
  if (!referralConfig().enabled) return fail("This deployment doesn’t run the referral program.");
  try { await rateLimit(ctx, `referral-credit:${user._id}`, 10, 3600000); } catch { return fail("Too many credit requests. Try again in an hour."); }
  if (!Number.isInteger(a.amount) || a.amount < REFERRAL_MIN_CREDIT_CENTS) return fail(`The smallest credit is ${dollars(REFERRAL_MIN_CREDIT_CENTS)}.`);
  const customerId = (await ctx.db.query("billingAccounts").withIndex("by_org", (q) => q.eq("organizationId", a.organizationId)).first())?.customerId;
  if (!customerId) return fail("This workspace has no Stripe billing account yet. Subscribe in Settings → Billing first.");
  const { available } = await availableFor(ctx, user._id);
  if (a.amount > available) return fail(notAvailable(available));
  const now = Date.now(), id = await ctx.db.insert("referralRedemptions", { userId: user._id, kind: "credit", amount: a.amount, currency: REFERRAL_CURRENCY, creditOrganizationId: a.organizationId, customerId, status: "processing", idempotencyKey: "", keyIssuedAt: now, attempts: 0, createdAt: now, updatedAt: now });
  await ctx.db.patch(id, { idempotencyKey: `referral-credit:${id}:1` });
  await audit(ctx, a.organizationId, user._id, "referral.credit_requested", id);
  await ctx.scheduler.runAfter(0, internal.referralJobs.processRedemption, { redemptionId: id });
  return { ok: true };
} });
/** Requests a cash payout to the caller's Stripe account. When it brings the caller's cash-outs over the
 *  review threshold in 30 days, it waits for an operator (referralOps:approveRedemption). Rejections return {ok:false} rather than throw, so every
 *  attempt counts against the rate limit. */
export const requestPayout = mutation({ args: { token: v.string(), amount: v.number() }, handler: async (ctx, a): Promise<{ ok: true; review: boolean } | { ok: false; error: string; signIn?: string }> => {
  const { user, session } = await authenticatedSession(ctx, a.token);
  const fail = (error: string) => ({ ok: false as const, error });
  if (!referralConfig().payoutsEnabled) return fail(payoutsOff);
  if (!recentSignIn(session)) return signInAgain;
  try { await rateLimit(ctx, `referral-payout:${user._id}`, 10, 3600000); } catch { return fail("Too many cash-out requests. Try again in an hour."); }
  if (!Number.isInteger(a.amount) || a.amount < REFERRAL_MIN_PAYOUT_CENTS) return fail(`The smallest cash-out is ${dollars(REFERRAL_MIN_PAYOUT_CENTS)}.`);
  const account = await payoutAccountOf(ctx, user._id);
  if (account?.transfers !== "active") return fail("Finish setting up payouts with Stripe first.");
  const { available, redemptions } = await availableFor(ctx, user._id), now = Date.now();
  if (a.amount > available) return fail(notAvailable(available));
  // Counted over 30 days, so splitting a cash-out doesn't skip the review.
  const review = redemptions.reduce((sum, r) => sum + (r.kind === "payout" && r.status !== "failed" && r.createdAt > now - 30 * 86400000 ? r.amount : 0), a.amount) > REFERRAL_PAYOUT_REVIEW_CENTS, id = await ctx.db.insert("referralRedemptions", { userId: user._id, kind: "payout", amount: a.amount, currency: REFERRAL_CURRENCY, accountId: account.accountId, status: review ? "review" : "processing", idempotencyKey: "", keyIssuedAt: now, attempts: 0, createdAt: now, updatedAt: now });
  await ctx.db.patch(id, { idempotencyKey: `referral-transfer:${id}:1` });
  if (review) console.log(JSON.stringify({ event: "referral.payout_review", redemptionId: id, amount: a.amount }));
  else await ctx.scheduler.runAfter(0, internal.referralJobs.processRedemption, { redemptionId: id });
  return { ok: true, review };
} });
/** The caller's payout setup, for referralJobs. Null when `recent` is asked for and the session is older than 15 minutes (or an API key). */
export const payoutContext = internalQuery({ args: { token: v.string(), recent: v.boolean() }, handler: async (ctx, a) => {
  const { user, session } = await authenticatedSession(ctx, a.token);
  if (a.recent && !recentSignIn(session)) return null;
  const account = await payoutAccountOf(ctx, user._id);
  return { userId: user._id, email: await verifiedEmail(ctx, user._id), account: account && { accountId: account.accountId, onboarded: account.onboardedAt !== undefined, transfers: account.transfers, updatedAt: account.updatedAt } };
} });
/** Links the account startPayoutSetup created. A concurrent setup sent the same idempotency key and got the same account, so the first saved row stands. */
export const savePayoutAccount = internalMutation({ args: { userId: v.id("users"), accountId: v.string(), country: v.string(), ...payoutStatus }, handler: async (ctx, a) => {
  const existing = await payoutAccountOf(ctx, a.userId), now = Date.now();
  if (existing) return { accountId: existing.accountId, onboarded: existing.onboardedAt !== undefined };
  await ctx.db.insert("referralPayoutAccounts", { ...a, ...(a.transfers === "active" ? { onboardedAt: now } : {}), createdAt: now, updatedAt: now });
  return { accountId: a.accountId, onboarded: a.transfers === "active" };
} });
/** Stores an account's status as just read from Stripe; onboardedAt is set the first time transfers are active. */
export const updatePayoutAccount = internalMutation({ args: { accountId: v.string(), ...payoutStatus }, handler: async (ctx, a) => {
  const row = await ctx.db.query("referralPayoutAccounts").withIndex("by_account", (q) => q.eq("accountId", a.accountId)).first();
  if (row) await ctx.db.patch(row._id, { transfers: a.transfers, requirements: a.requirements, ...(a.transfers === "active" && row.onboardedAt === undefined ? { onboardedAt: Date.now() } : {}), updatedAt: Date.now() });
} });
/** Claims a processing redemption for one run for 5 minutes, so two runs never post at once. Returns
 *  the row with, for a cash-out, the referrer's available balance (checked again before sending), or
 *  null when it is not runnable. */
export const leaseRedemption = internalMutation({ args: { redemptionId: v.id("referralRedemptions"), leaseId: v.string() }, handler: async (ctx, a) => {
  const r = await ctx.db.get(a.redemptionId), now = Date.now();
  if (!r || r.status !== "processing" || (r.leaseId && r.leaseId !== a.leaseId && (r.leaseUntil ?? 0) > now)) return null;
  await ctx.db.patch(r._id, { leaseId: a.leaseId, leaseUntil: now + 5 * 60000 });
  return { ...r, available: r.kind === "payout" ? (await availableFor(ctx, r.userId)).available : 0 };
} });
/** Ends a run that did not settle the redemption: it stays processing for the next run. `attempt`
 *  counts a failed post; `indeterminate` (a 5xx) stops all further posts; `paused` marks a payout held
 *  by the payouts switch (any other release clears it). Frees this run's lease. */
export const releaseRedemption = internalMutation({ args: { redemptionId: v.id("referralRedemptions"), leaseId: v.string(), error: v.optional(v.string()), attempt: v.boolean(), indeterminate: v.boolean(), paused: v.optional(v.boolean()) }, handler: async (ctx, a) => {
  const r = await ctx.db.get(a.redemptionId);
  if (!r || r.status !== "processing") return;
  await ctx.db.patch(r._id, { attempts: r.attempts + (a.attempt ? 1 : 0), ...(a.error ? { error: a.error.slice(0, 300) } : {}), ...(a.indeterminate && !r.indeterminateAt ? { indeterminateAt: Date.now() } : {}), pausedAt: a.paused ? r.pausedAt ?? Date.now() : undefined, ...(r.leaseId === a.leaseId ? { leaseId: undefined, leaseUntil: undefined } : {}), updatedAt: Date.now() });
} });
/** After a definite balance_insufficient and a lookup that found no transfer: Stripe keeps that answer
 *  under the key for 24 hours, so the next attempt (after a top-up) uses a new one. Lease holder only. */
export const rotateRedemptionKey = internalMutation({ args: { redemptionId: v.id("referralRedemptions"), leaseId: v.string() }, handler: async (ctx, a) => {
  const r = await ctx.db.get(a.redemptionId);
  if (r?.status !== "processing" || r.leaseId !== a.leaseId) return;
  await ctx.db.patch(r._id, { idempotencyKey: `referral-transfer:${r._id}:${Number(/:(\d+)$/.exec(r.idempotencyKey)?.[1] ?? 1) + 1}`, keyIssuedAt: Date.now() });
} });
/** The Stripe object exists, whichever run created it: always completes a processing row. */
export const completeRedemption = internalMutation({ args: { redemptionId: v.id("referralRedemptions"), stripeId: v.string() }, handler: async (ctx, a) => {
  const r = await ctx.db.get(a.redemptionId);
  if (r?.status === "processing") await settleRedemption(ctx, r, { stripeId: a.stripeId }, "referral.credit_applied");
} });
/** Fails a redemption, releasing its balance. Only the run holding the lease may, after it looked the
 *  object up and found nothing. */
export const failRedemption = internalMutation({ args: { redemptionId: v.id("referralRedemptions"), leaseId: v.string(), error: v.string() }, handler: async (ctx, a) => {
  const r = await ctx.db.get(a.redemptionId);
  if (r?.status === "processing" && r.leaseId === a.leaseId) await settleRedemption(ctx, r, { error: a.error }, "referral.credit_failed");
} });
/** Redemptions still processing, least recently updated first, for the reconcile cron. While payouts are
 *  off, cash-outs they paused are only counted, so they never crowd out credits. */
export const stuckRedemptions = internalQuery({ args: {}, handler: async (ctx) => {
  const processing = () => ctx.db.query("referralRedemptions").withIndex("by_status", (q) => q.eq("status", "processing")), off = !referralConfig().payoutsEnabled;
  const rows = await (off ? processing().filter((q) => q.eq(q.field("pausedAt"), undefined)) : processing()).take(100);
  return { rows: rows.map((r) => ({ _id: r._id, kind: r.kind, createdAt: r.createdAt, indeterminateAt: r.indeterminateAt ?? null, paused: r.pausedAt !== undefined, attempts: r.attempts })), paused: off ? (await processing().filter((q) => q.neq(q.field("pausedAt"), undefined)).take(1000)).length : 0 };
} });
