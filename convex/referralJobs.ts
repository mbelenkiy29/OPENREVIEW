import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { sendEmail } from "../src/email";
import { StripeError, billingConfig, stripe, stripeGet, stripeKey } from "../src/billing";
import { OfflineError, egressAllowed } from "../src/egress";
import { classifyStripeFailure, conversionEmail, referralConfig } from "../src/referrals";
import { chargeEvent } from "./referralLedger";

// Referral program jobs that talk to other services: email, and Stripe for clawbacks and credits.
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
    if (outcomes.includes("applied")) return "applied";
    // A refund can arrive before its invoice's commission (a late invoice.paid): look again on the retry ladder below.
    // shortcut: no verifyDue re-check (deferred); a commission created after the last retry (a hand-run accrue) keeps the refund unless voided by hand.
    if (a.customer && payments.length && outcomes.every((o) => o === "no commission") && attempt < 4) { await ctx.scheduler.runAfter(60000 * 4 ** attempt, internal.referralJobs.resolveChargeEvent, { ...a, attempt: attempt + 1 }); return "retrying"; }
    return "no commission";
  } catch (error) {
    // Stripe already has our 200 for the event, so a failed read is retried here (1, 4, 16 and 64 minutes), then logged.
    if (attempt < 4) { await ctx.scheduler.runAfter(60000 * 4 ** attempt, internal.referralJobs.resolveChargeEvent, { ...a, attempt: attempt + 1 }); return "retrying"; }
    console.error(JSON.stringify({ event: "referral.charge_unresolved", kind: a.kind, reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
    throw error;
  }
} });

// Redemptions. Each run leases the row, looks the Stripe object up first (a crashed run may have
// created it), checks the target, then posts with the row's stored idempotency key. Failures follow
// classifyStripeFailure: transient ones retry later with the same key, a 5xx is never posted again
// (only looked up), and a definite 4xx fails the row only after another lookup finds nothing. Stripe
// keeps a key about 24 hours; the lookup just before each post also covers older rows.
type Branch = { find(): Promise<string | null>; check(): Promise<string | null>; post(): Promise<string> };
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
  };
}
async function runRedemption(ctx: ActionCtx, redemptionId: Id<"referralRedemptions">): Promise<string> {
  const leaseId = crypto.randomUUID(), r: Doc<"referralRedemptions"> | null = await ctx.runMutation(internal.referrals.leaseRedemption, { redemptionId, leaseId });
  if (!r) return "skipped";
  const release = async (outcome: string, error: unknown, attempt: boolean, indeterminate = false) => { await ctx.runMutation(internal.referrals.releaseRedemption, { redemptionId, leaseId, attempt, indeterminate, ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) }); return outcome; };
  const complete = async (stripeId: string) => { await ctx.runMutation(internal.referrals.completeRedemption, { redemptionId, stripeId }); return "completed"; };
  const fail = async (error: string) => { await ctx.runMutation(internal.referrals.failRedemption, { redemptionId, leaseId, error }); return "failed"; };
  // shortcut: credits only; payouts (Phase 4) add a transfer branch with the same find/check/post steps, and rotateRedemptionKey for balance_insufficient.
  if (r.kind !== "credit" || !r.customerId) return release("unsupported", "Payouts are not available yet", false);
  const branch = creditBranch(r, r.customerId);
  let posting = false;
  try {
    const found = await branch.find();
    if (found) return await complete(found);
    if (r.indeterminateAt) return await release("indeterminate", null, false);
    const problem = await branch.check();
    if (problem) return await fail(problem);
    posting = true;
    return await complete(await branch.post());
  } catch (error) {
    const kind = classifyStripeFailure(error);
    if (kind === "indeterminate" && posting) return release("indeterminate", error, true, true);
    if (kind === "definite") {
      // A customer Stripe doesn't have (deleted, or from the other Stripe mode) holds no credit: nothing to look up.
      if (error instanceof StripeError && error.status === 404 && error.code === "resource_missing") return await fail(customerGone);
      try { const found = await branch.find(); return found ? await complete(found) : await fail(posting ? "Stripe didn’t accept the credit, so the amount is back in your balance." : "Stripe couldn’t check this workspace’s billing account, so the amount is back in your balance."); }
      catch (again) { return release("retry", again, true); }
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
  const now = Date.now(), rows = await ctx.runQuery(internal.referrals.stuckRedemptions, {});
  for (const r of rows) {
    if ((r.indeterminateAt !== null && now - r.indeterminateAt > 86400000) || now - r.createdAt > 3 * 86400000) console.error(JSON.stringify({ event: "referral.redemption_stuck", redemptionId: r._id, kind: r.kind, attempts: r.attempts, indeterminate: r.indeterminateAt !== null }));
    await runRedemption(ctx, r._id);
  }
  return rows.length;
} });
