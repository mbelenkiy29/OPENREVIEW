import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { audit } from "./auth";

// Operator tools for the referral program: `npx convex run referralOps:<fn> '{...}'`.

/** Voids a referral (abuse, self-referral found by hand): it stops counting and earns nothing more. */
export const voidReferral = internalMutation({ args: { referralId: v.id("referrals"), reason: v.string() }, handler: async (ctx, a) => {
  const referral = await ctx.db.get(a.referralId);
  if (!referral) throw new Error("Referral not found");
  if (referral.status === "void") return;
  const now = Date.now();
  await ctx.db.patch(referral._id, { status: "void", voidedAt: now, voidReason: a.reason.slice(0, 200), updatedAt: now });
  // A deleted workspace keeps no rows, so its audit log is not recreated.
  if (referral.referredOrganizationId && await ctx.db.get(referral.referredOrganizationId)) await audit(ctx, referral.referredOrganizationId, undefined, "referral.voided", referral._id);
} });
