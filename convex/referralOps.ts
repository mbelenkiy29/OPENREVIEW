import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { audit } from "./auth";
import { ledgerFor, settleRedemption, voidReferralRows } from "./referralLedger";
import { REFERRAL_CURRENCY, referralBalances } from "../src/referrals";

// Operator tools for the referral program: `npx convex run referralOps:<fn> '{...}'`.
// shortcut: no reaccrue op; if an accrue job failed, run `referrals:accrue` by hand with the invoice's facts from the Stripe Dashboard.

/** Voids a referral (abuse, self-referral found by hand): it stops counting and earns nothing more.
 *  Its commissions still on hold are voided too; ones already available stay. */
export const voidReferral = internalMutation({ args: { referralId: v.id("referrals"), reason: v.string() }, handler: async (ctx, a) => {
  const referral = await ctx.db.get(a.referralId);
  if (!referral) throw new Error("Referral not found");
  if (referral.status === "void") return;
  await voidReferralRows(ctx, referral, a.reason);
  // A deleted workspace keeps no rows, so its audit log is not recreated.
  if (referral.referredOrganizationId && await ctx.db.get(referral.referredOrganizationId)) await audit(ctx, referral.referredOrganizationId, undefined, "referral.voided", referral._id);
} });
/** Voids one commission, for example after a credit note that credited the customer balance without a refund. */
export const voidCommission = internalMutation({ args: { commissionId: v.id("referralCommissions"), reason: v.string() }, handler: async (ctx, a) => {
  const commission = await ctx.db.get(a.commissionId);
  if (!commission) throw new Error("Commission not found");
  if (commission.status === "void") return;
  await ctx.db.patch(commission._id, { status: "void", voidReason: a.reason.slice(0, 200), updatedAt: Date.now() });
  if (await ctx.db.get(commission.referredOrganizationId)) await audit(ctx, commission.referredOrganizationId, undefined, "referral.commission_voided", commission._id);
} });
/** Settles a credit or cash-out stuck in processing (referral.redemption_stuck) after checking Stripe by hand:
 *  completed with the Stripe object's id, or failed, which returns the amount to the referrer's balance. */
export const resolveStuck = internalMutation({ args: { redemptionId: v.id("referralRedemptions"), outcome: v.union(v.literal("completed"), v.literal("failed")), stripeId: v.optional(v.string()) }, handler: async (ctx, a) => {
  const redemption = await ctx.db.get(a.redemptionId);
  if (!redemption) throw new Error("Redemption not found");
  if (redemption.status !== "processing") throw new Error(`The redemption is already ${redemption.status}`);
  // A run holding the lease may be posting right now; settling under it could credit twice.
  if ((redemption.leaseUntil ?? 0) > Date.now()) throw new Error("A run is processing this redemption; try again in 5 minutes");
  if (a.outcome === "completed" && !a.stripeId) throw new Error("Pass the Stripe object's id as stripeId");
  await settleRedemption(ctx, redemption, a.outcome === "completed" ? { stripeId: a.stripeId! } : { error: `This ${redemption.kind === "payout" ? "cash-out" : "credit"} couldn’t be completed, so the amount is back in your balance.` }, `referral.redemption_${a.outcome}`);
} });
// Cash-outs above the review threshold wait in `review` (logged as referral.payout_review).
function inReview<T extends { status: string }>(redemption: T | null): T {
  if (!redemption) throw new Error("Redemption not found");
  if (redemption.status !== "review") throw new Error(`The redemption is ${redemption.status}, not in review`);
  return redemption;
}
/** Sends a reviewed cash-out: it moves to processing and is transferred right away. Refused when refunds
 *  or disputes during the review left the referrer's balance below zero (the cash-out is already counted). */
export const approveRedemption = internalMutation({ args: { redemptionId: v.id("referralRedemptions") }, handler: async (ctx, a) => {
  const redemption = inReview(await ctx.db.get(a.redemptionId)), { commissions, redemptions } = await ledgerFor(ctx, redemption.userId);
  const available = referralBalances(commissions, redemptions, Date.now())[REFERRAL_CURRENCY]?.available ?? 0;
  if (available < 0) throw new Error(`Refunds or disputes since the request leave the referrer ${-available} cents short; reject the cash-out or wait for new commissions`);
  await ctx.db.patch(a.redemptionId, { status: "processing", keyIssuedAt: Date.now(), updatedAt: Date.now() });
  await ctx.scheduler.runAfter(0, internal.referralJobs.processRedemption, { redemptionId: a.redemptionId });
} });
/** Declines a reviewed cash-out: the amount returns to the referrer's balance, and they see `reason`. */
export const rejectRedemption = internalMutation({ args: { redemptionId: v.id("referralRedemptions"), reason: v.string() }, handler: async (ctx, a) => {
  inReview(await ctx.db.get(a.redemptionId));
  await ctx.db.patch(a.redemptionId, { status: "failed", error: a.reason.slice(0, 300), updatedAt: Date.now() });
} });
