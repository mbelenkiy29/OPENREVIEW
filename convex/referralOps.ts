import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { audit } from "./auth";
import { voidReferralRows } from "./referralLedger";

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
