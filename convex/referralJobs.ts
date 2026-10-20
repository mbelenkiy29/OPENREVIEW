import { action, internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { sendEmail } from "../src/email";
import { StripeError, billingConfig, stripe, stripeGet, stripeKey, stripeV2 } from "../src/billing";
import { OfflineError, egressAllowed } from "../src/egress";
import { REFERRAL_PAYOUT_COUNTRIES, classifyStripeFailure, conversionEmail, referralConfig } from "../src/referrals";
import { chargeEvent, payoutsOff, signInAgain } from "./referralLedger";

// Referral program jobs that talk to other services: email, and Stripe for clawbacks, credits and payouts.
const appOrigin = () => new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
/** Tells the referrer, once, that a workspace they referred made its first payment. */
export const sendConversionNotice = internalAction({ args: { referralId: v.id("referrals") }, handler: async (ctx, a): Promise<"sent" | "skipped"> => {
  const notice = await ctx.runMutation(internal.referrals.claimConversionNotice, a);
  if (!notice) return "skipped";
  const { rateBps, months, holdDays } = referralConfig();
  const result = await sendEmail({ to: notice.to, ...conversionEmail({ name: notice.name, rateBps, months, holdDays, url: `${appOrigin()}/dashboard/settings/referrals` }) });
  return "skipped" in result ? "skipped" : "sent";
} });

type List<T> = { data: T[]; has_more: boolean };
/** Every item of a Stripe list, following has_more with starting_after. */
async function listAll<T extends { id: string }>(path: string, query: Record<string, unknown>, key: string): Promise<T[]> {
  const items: T[] = [];
  for (let more = true; more;) {
    const page = await stripeGet<List<T>>(path, { ...query, limit: 100, starting_after: items.at(-1)?.id }, key);
    items.push(...page.data);
    more = page.has_more && page.data.length > 0;
  }
  return items;
}

// Clawback: a refund or dispute event only says which charge changed. Its current state is read from
// Stripe (events can arrive out of order) and applied to every invoice the charge's PaymentIntent paid.
// shortcut: refund.failed, refund.updated and charge.dispute.updated are not subscribed; a failed refund or a changed dispute is corrected at that charge's next refund or dispute event.
export const resolveChargeEvent = internalAction({ args: { ...chargeEvent, attempt: v.optional(v.number()) }, handler: async (ctx, { attempt = 0, ...a }): Promise<string> => {
  try {
    const key = stripeKey(), fetchedAt = Date.now();
    const charge = await stripeGet<{ amount: number; amount_refunded: number; disputed: boolean; customer: string | null; payment_intent: string | null }>(`/v1/charges/${a.chargeId}`, {}, key);
    // A dispute event names no customer (the webhook checked a refund's): stop here for workspaces nobody referred.
    if (!a.customer && !(charge.customer && await ctx.runQuery(internal.referrals.customerMayHaveCommission, { customer: charge.customer }))) return "no referral";
    const dispute = charge.disputed ? (await stripeGet<List<{ id: string; status: string; amount: number }>>("/v1/disputes", { charge: a.chargeId, limit: 1 }, key)).data[0] : undefined;
    // A dispute's payment_intent can be null; the charge then names it.
    const paymentIntent = a.paymentIntent ?? charge.payment_intent;
    // shortcut: no verifyDue re-check (deferred), so a charge without a PaymentIntent is not clawed back; void its commission by hand with referralOps:voidCommission.
    if (!paymentIntent) { console.log(JSON.stringify({ event: "referral.charge_unresolved", kind: a.kind, reason: "no payment intent" })); return "no payment intent"; }
    const facts = { id: a.chargeId, amount: charge.amount, refunded: charge.amount_refunded, ...(dispute ? { dispute: { id: dispute.id, status: dispute.status, amount: dispute.amount } } : {}), fetchedAt };
    const payments = await listAll<{ id: string; invoice: string | { id: string } }>("/v1/invoice_payments", { payment: { type: "payment_intent", payment_intent: paymentIntent }, status: "paid" }, key);
    const outcomes = [];
    for (const p of payments) outcomes.push(await ctx.runMutation(internal.referrals.applyChargeEvent, { invoiceId: typeof p.invoice === "string" ? p.invoice : p.invoice.id, charge: facts }));
    // A refund or dispute can come before its invoice's commission (a late invoice.paid): checkInvoiceCharges looks again once it accrues.
    return outcomes.includes("applied") ? "applied" : "no commission";
  } catch (error) {
    // Stripe already has our 200 for the event, so a failed read is retried here (1, 4, 16 and 64 minutes), then logged.
    if (attempt < 4) { await ctx.scheduler.runAfter(60000 * 4 ** attempt, internal.referralJobs.resolveChargeEvent, { ...a, attempt: attempt + 1 }); return "retrying"; }
    console.error(JSON.stringify({ event: "referral.charge_unresolved", kind: a.kind, reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
    throw error;
  }
} });
/** Scheduled once a commission accrues: a refund or dispute of its invoice handled before then (a webhook
 *  outage and redelivery, a late invoice.paid) had no commission to take back. Each refunded or disputed
 *  charge of the invoice's PaymentIntents goes through resolveChargeEvent. Stripe read failures retry as there. */
export const checkInvoiceCharges = internalAction({ args: { invoiceId: v.string(), attempt: v.optional(v.number()) }, handler: async (ctx, { attempt = 0, invoiceId }): Promise<string> => {
  try {
    const key = stripeKey(), payments = await listAll<{ id: string; payment: { type: string; payment_intent?: unknown } }>("/v1/invoice_payments", { invoice: invoiceId, status: "paid" }, key);
    let queued = 0;
    for (const { payment } of payments) {
      if (payment.type !== "payment_intent" || typeof payment.payment_intent !== "string") continue;
      for (const c of await listAll<{ id: string; amount_refunded: number; disputed: boolean }>("/v1/charges", { payment_intent: payment.payment_intent }, key)) {
        if (c.amount_refunded > 0 || c.disputed) { await ctx.scheduler.runAfter(0, internal.referralJobs.resolveChargeEvent, { chargeId: c.id, kind: c.disputed ? "dispute" : "refund", paymentIntent: payment.payment_intent }); queued++; }
      }
    }
    return queued ? "queued" : "clean";
  } catch (error) {
    if (attempt < 4) { await ctx.scheduler.runAfter(60000 * 4 ** attempt, internal.referralJobs.checkInvoiceCharges, { invoiceId, attempt: attempt + 1 }); return "retrying"; }
    console.error(JSON.stringify({ event: "referral.invoice_unchecked", reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
    throw error;
  }
} });

// Redemptions. Each run leases the row, looks the Stripe object up first (a crashed run may have
// created it), checks the target, then posts with the row's stored idempotency key. Failures follow
// classifyStripeFailure: transient ones retry later with the same key, a 5xx is never posted again
// (only looked up), and a definite 4xx fails the row only after another lookup finds nothing. Stripe
// keeps a key about 24 hours; the lookup just before each post also covers older rows.
type Branch = { find(): Promise<string | null>; check(): Promise<string | null>; post(): Promise<string>; rejected: string; unchecked: string };
const customerGone = "This workspace’s Stripe customer no longer exists, so it can’t take credit.";
// The customer is the one the credit was requested for, so a workspace's later customer never gets it.
function creditBranch(r: Doc<"referralRedemptions">, customer: string): Branch {
  return {
    // The balance transactions list has no metadata filter: scan from shortly before the request.
    find: async () => (await listAll<{ id: string; metadata?: Record<string, string> | null }>(`/v1/customers/${customer}/balance_transactions`, { created: { gte: Math.floor(r.createdAt / 1000) - 300 } }, stripeKey())).find((t) => t.metadata?.referralRedemptionId === r._id)?.id ?? null,
    check: async () => {
      const c = await stripeGet<{ deleted?: boolean; currency?: string | null }>(`/v1/customers/${customer}`, {}, stripeKey());
      if (c.deleted) return customerGone;
      return c.currency && c.currency !== r.currency ? `This workspace is billed in ${c.currency.toUpperCase()}; referral credit is in ${r.currency.toUpperCase()}.` : null;
    },
    post: async () => (await stripe<{ id: string }>(`/v1/customers/${customer}/balance_transactions`, { amount: -r.amount, currency: r.currency, description: "OpenReview referral credit", metadata: { referralRedemptionId: r._id } }, stripeKey(), fetch, r.idempotencyKey)).id,
    rejected: "Stripe didn’t accept the credit, so the amount is back in your balance.",
    unchecked: "Stripe couldn’t check this workspace’s billing account, so the amount is back in your balance.",
  };
}
// A payout is a transfer from the platform's Stripe balance to the referrer's connected account,
// found again by its transfer_group. The account's status is read from Stripe right before posting.
// shortcut: Connect calls use STRIPE_SECRET_KEY; give them their own restricted key if Transfers write on the billing key is a concern.
function payoutBranch(ctx: ActionCtx, r: Doc<"referralRedemptions">, account: string): Branch {
  const group = `referral-redemption-${r._id}`;
  return {
    find: async () => (await stripeGet<List<{ id: string }>>("/v1/transfers", { transfer_group: group, limit: 1 }, stripeKey())).data[0]?.id ?? null,
    check: async () => (await refreshAccount(ctx, account)).transfers === "active" ? null : "Stripe can’t pay your account until its setup is complete (Continue setup under Settings → Referrals), so the amount is back in your balance.",
    post: async () => (await stripe<{ id: string }>("/v1/transfers", { amount: r.amount, currency: r.currency, destination: account, transfer_group: group, description: "OpenReview referral payout", metadata: { referralRedemptionId: r._id } }, stripeKey(), fetch, r.idempotencyKey)).id,
    rejected: "Stripe didn’t accept the payout, so the amount is back in your balance.",
    unchecked: "Stripe couldn’t check your payout account, so the amount is back in your balance.",
  };
}
async function runRedemption(ctx: ActionCtx, redemptionId: Id<"referralRedemptions">): Promise<string> {
  const leaseId = crypto.randomUUID(), r: (Doc<"referralRedemptions"> & { available: number }) | null = await ctx.runMutation(internal.referrals.leaseRedemption, { redemptionId, leaseId });
  if (!r) return "skipped";
  const release = async (outcome: string, error: unknown, attempt: boolean, indeterminate = false) => { await ctx.runMutation(internal.referrals.releaseRedemption, { redemptionId, leaseId, attempt, indeterminate, ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) }); return outcome; };
  const complete = async (stripeId: string) => { await ctx.runMutation(internal.referrals.completeRedemption, { redemptionId, stripeId }); return "completed"; };
  const fail = async (error: string) => { await ctx.runMutation(internal.referrals.failRedemption, { redemptionId, leaseId, error }); return "failed"; };
  const branch = r.kind === "credit" && r.customerId ? creditBranch(r, r.customerId) : r.kind === "payout" && r.accountId ? payoutBranch(ctx, r, r.accountId) : null;
  if (!branch) return release("unsupported", "This redemption has no Stripe target", false);
  let posting = false;
  try {
    const found = await branch.find();
    if (found) return await complete(found);
    if (r.indeterminateAt) return await release("indeterminate", null, false);
    // The payouts switch holds transfers (credits go on); the cron resumes them once it is back on.
    if (r.kind === "payout" && !referralConfig().payoutsEnabled) { await ctx.runMutation(internal.referrals.releaseRedemption, { redemptionId, leaseId, attempt: false, indeterminate: false, paused: true }); return "paused"; }
    // As approveRedemption: a cash-out not yet sent when refunds or disputes took the balance below zero is cancelled.
    if (r.kind === "payout" && r.available < 0) return await fail("Refunds or disputes since you asked for this cash-out left your balance below zero, so it wasn’t sent.");
    const problem = await branch.check();
    if (problem) return await fail(problem);
    posting = true;
    return await complete(await branch.post());
  } catch (error) {
    const kind = classifyStripeFailure(error);
    if (kind === "indeterminate" && posting) return release("indeterminate", error, true, true);
    if (kind === "definite") {
      // A customer Stripe doesn't have (deleted, or from the other Stripe mode) holds no credit: nothing to look up.
      if (r.kind === "credit" && error instanceof StripeError && error.status === 404 && error.code === "resource_missing") return await fail(customerGone);
      try {
        const found = await branch.find();
        if (found) return await complete(found);
        // The platform balance ran short: no transfer exists, and Stripe keeps this answer under the key, so the next try (after a top-up) gets a new key.
        if (posting && r.kind === "payout" && error instanceof StripeError && error.code === "balance_insufficient") { await ctx.runMutation(internal.referrals.rotateRedemptionKey, { redemptionId, leaseId }); return await release("retry", error, true); }
        return await fail(posting ? branch.rejected : branch.unchecked);
      } catch (again) { return release("retry", again, true); }
    }
    return release("retry", error, !(error instanceof OfflineError));
  }
}
/** Runs a redemption right after it is requested. */
export const processRedemption = internalAction({ args: { redemptionId: v.id("referralRedemptions") }, handler: (ctx, a) => runRedemption(ctx, a.redemptionId) });
/** Cron: retries redemptions still processing and reports the ones stuck for an operator
 *  (referralOps:resolveStuck). Runs while billing is on, even with the program switched off. */
export const reconcileRedemptions = internalAction({ args: {}, handler: async (ctx): Promise<number> => {
  if (!billingConfig().enabled || !egressAllowed("billing")) return 0;
  const now = Date.now(), { rows, paused } = await ctx.runQuery(internal.referrals.stuckRedemptions, {});
  // Payouts paused by the switch wait, without Stripe calls, until it is back on; they are not stuck, only counted.
  if (paused) console.log(JSON.stringify({ event: "referral.redemptions_paused", count: paused }));
  for (const r of rows) {
    if (!r.paused && ((r.indeterminateAt !== null && now - r.indeterminateAt > 86400000) || now - r.createdAt > 3 * 86400000)) console.error(JSON.stringify({ event: "referral.redemption_stuck", redemptionId: r._id, kind: r.kind, attempts: r.attempts, indeterminate: r.indeterminateAt !== null }));
    await runRedemption(ctx, r._id);
  }
  return rows.length;
} });

// Payout accounts (Phase 4): Stripe Connect Accounts v2 with the recipient configuration and the
// Express dashboard. Stripe hosts onboarding and keeps the identity and bank details.
// shortcut: no Connect notification banner (so no scoped CSP for /dashboard/settings/referrals in next.config.ts) or thin-event webhook; the status is re-read from Stripe on Referrals page loads and before every transfer.
type V2Account = { id: string; configuration?: { recipient?: { capabilities?: { stripe_balance?: { stripe_transfers?: { status?: string } } } } | null } | null; requirements?: { summary?: { minimum_deadline?: { status?: string | null } | null } | null } | null };
const transferStatuses = ["active", "pending", "restricted", "unsupported"] as const;
const payoutStatusOf = (a: V2Account) => {
  const status = a.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status, deadline = a.requirements?.summary?.minimum_deadline?.status;
  return { transfers: transferStatuses.find((s) => s === status) ?? ("unknown" as const), ...(deadline ? { requirements: deadline } : {}) };
};
async function refreshAccount(ctx: ActionCtx, accountId: string) {
  const status = payoutStatusOf(await stripeV2<V2Account>("GET", `/v2/core/accounts/${accountId}`, stripeKey(), { query: { include: ["configuration.recipient", "requirements"] } }));
  await ctx.runMutation(internal.referrals.updatePayoutAccount, { accountId, ...status });
  return status;
}
const hash8 = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].slice(0, 4).map((b) => b.toString(16).padStart(2, "0")).join("");
type PayoutStep = { ok: true; url: string } | { ok: false; error: string; signIn?: string };
/** Settings → Referrals → Set up payouts / Continue setup: creates the caller's connected account on first
 *  use, then returns a Stripe-hosted link: onboarding until it first could receive transfers, an update after. */
export const startPayoutSetup = action({ args: { token: v.string(), country: v.string() }, handler: async (ctx, a): Promise<PayoutStep> => {
  const context = await ctx.runQuery(internal.referrals.payoutContext, { token: a.token, recent: true });
  if (!referralConfig().payoutsEnabled) return { ok: false, error: payoutsOff };
  if (!context) return signInAgain;
  const key = stripeKey();
  let account: { accountId: string; onboarded: boolean } | null = context.account;
  if (!account) {
    const country = a.country.trim().toUpperCase(), email = context.email;
    if (!REFERRAL_PAYOUT_COUNTRIES.includes(country)) return { ok: false, error: "Cash payouts are available only to bank accounts in the United States for now." };
    // Stripe keeps v2 keys for 30 days: the key follows the request, so a new email or country is a new request, not a 409.
    const body = { ...(email ? { contact_email: email } : {}), identity: { country: country.toLowerCase() }, dashboard: "express", defaults: { responsibilities: { fees_collector: "application", losses_collector: "application" } }, configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } }, metadata: { userId: context.userId }, include: ["configuration.recipient", "identity", "requirements"] };
    let created: V2Account;
    try { created = await stripeV2<V2Account>("POST", "/v2/core/accounts", key, { body, idempotencyKey: `referral-account:${context.userId}:${country}:${await hash8(email ?? "")}` }); }
    catch (error) { if (error instanceof StripeError && error.status === 409 && error.type === "idempotency_error") return { ok: false, error: "Stripe is still working on an earlier payout setup request. Wait a minute, then try again." }; throw error; }
    account = await ctx.runMutation(internal.referrals.savePayoutAccount, { userId: context.userId, accountId: created.id, country, ...payoutStatusOf(created) });
  }
  const type = account.onboarded ? "account_update" : "account_onboarding", back = `${appOrigin()}/dashboard/settings/referrals?payouts=`;
  return { ok: true, url: (await stripeV2<{ url: string }>("POST", "/v2/core/account_links", key, { body: { account: account.accountId, use_case: { type, [type]: { configurations: ["recipient"], refresh_url: `${back}refresh`, return_url: `${back}return` } } } })).url };
} });
/** Re-reads the caller's payout account from Stripe (Settings → Referrals, on load). Null without one.
 *  At most once a minute per account: the page renders after every dashboard action, and a token holder could loop this. */
export const refreshMyPayoutAccount = action({ args: { token: v.string() }, handler: async (ctx, a): Promise<string | null> => {
  const account = (await ctx.runQuery(internal.referrals.payoutContext, { token: a.token, recent: false }))?.account;
  if (!referralConfig().payoutsEnabled || !account) return null;
  return Date.now() - account.updatedAt < 60000 ? account.transfers : (await refreshAccount(ctx, account.accountId)).transfers;
} });
/** Re-reads one payout account from Stripe (operators: `npx convex run referralJobs:refreshPayoutAccount`). */
export const refreshPayoutAccount = internalAction({ args: { accountId: v.string() }, handler: async (ctx, a): Promise<string> => (await refreshAccount(ctx, a.accountId)).transfers });
/** A one-time link into the caller's Stripe Express dashboard. It can change the bank account, so it
 *  needs the same recent sign-in as setup. */
export const payoutDashboardLink = action({ args: { token: v.string() }, handler: async (ctx, a): Promise<PayoutStep> => {
  const context = await ctx.runQuery(internal.referrals.payoutContext, { token: a.token, recent: true });
  if (!referralConfig().payoutsEnabled) return { ok: false, error: payoutsOff };
  if (!context) return signInAgain;
  if (!context.account?.onboarded) return { ok: false, error: "Finish setting up payouts with Stripe first." };
  return { ok: true, url: (await stripe<{ url: string }>(`/v1/accounts/${context.account.accountId}/login_links`, {}, stripeKey())).url };
} });
