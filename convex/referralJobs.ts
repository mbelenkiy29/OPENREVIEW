import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { sendEmail } from "../src/email";
import { conversionEmail, referralConfig } from "../src/referrals";

// Referral program jobs that talk to other services (email now; Stripe lookups come later).
const appOrigin = () => new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
/** Tells the referrer, once, that a workspace they referred made its first payment. */
export const sendConversionNotice = internalAction({ args: { referralId: v.id("referrals") }, handler: async (ctx, a): Promise<"sent" | "skipped"> => {
  const notice = await ctx.runMutation(internal.referrals.claimConversionNotice, a);
  if (!notice) return "skipped";
  const { rateBps, months, holdDays } = referralConfig();
  const result = await sendEmail({ to: notice.to, ...conversionEmail({ name: notice.name, rateBps, months, holdDays, url: `${appOrigin()}/dashboard/settings/referrals` }) });
  return "skipped" in result ? "skipped" : "sent";
} });
