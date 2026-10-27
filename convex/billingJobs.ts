import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { StripeError, checkoutTrialEnd, stripe, stripeKey } from "../src/billing";
import { referralConfig } from "../src/referrals";

// Stripe Checkout / Customer Portal sessions for workspace admins, and seat-quantity sync.
const appOrigin = () => new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
const returnPaths = { settings: "/dashboard/settings/billing", onboarding: "/dashboard/onboarding/plan" } as const;
// Tags these sessions in the Stripe Dashboard so this flow can be compared with others.
const integrationIdentifier = "openreview-starter-seats-qkvmhzrt";
// One Stripe price per tier (docs/roadmap/pricing-tiers.md); upgrades of an existing subscription go through the portal.
const priceVariables = { starter: "STRIPE_SEAT_PRICE_ID", pro: "STRIPE_PRO_PRICE_ID" } as const;
export const checkout = action({ args: { token: v.string(), organizationId: v.id("organizations"), returnTo: v.optional(v.union(v.literal("settings"), v.literal("onboarding"))), tier: v.optional(v.union(v.literal("starter"), v.literal("pro"))) }, handler: async (ctx, a): Promise<string> => {
  const context = await ctx.runQuery(internal.billing.checkoutContext, { token: a.token, organizationId: a.organizationId });
  if (context.subscriptionId && ["active", "trialing", "past_due"].includes(context.status)) throw new Error("This workspace already has a subscription; manage it in the billing portal");
  const variable = priceVariables[a.tier ?? "starter"], key = stripeKey(), price = process.env[variable];
  if (!price || !/^price_[A-Za-z0-9]+$/.test(price)) throw new Error(`Configure ${variable}`);
  let customer = context.customerId;
  if (!customer) {
    customer = (await stripe<{ id: string }>("/v1/customers", { metadata: { organizationId: a.organizationId } }, key, fetch, `customer:${a.organizationId}`)).id;
    await ctx.runMutation(internal.billing.linkCustomer, { organizationId: a.organizationId, customerId: customer });
  }
  // The card is always collected, even for a trial; any remaining trial carries over, so the first
  // charge waits for it.
  // Checkout also takes a promotion code (for example a single-use code for a free month; docs/billing.md).
  const back = appOrigin() + returnPaths[a.returnTo ?? "settings"], trialEnd = checkoutTrialEnd(context.trialEndsAt, Date.now());
  // A referred workspace that has not paid yet gets the referral coupon. Stripe takes either discounts or
  // allow_promotion_codes, so the coupon replaces promotion codes for that one session.
  const referral = referralConfig().enabled ? await ctx.runMutation(internal.referrals.prepareCheckout, { token: a.token, organizationId: a.organizationId }) : null;
  const params = { mode: "subscription", customer, client_reference_id: a.organizationId, payment_method_collection: "always", integration_identifier: integrationIdentifier, allow_promotion_codes: true, line_items: [{ price, quantity: context.seats }], subscription_data: { metadata: { organizationId: a.organizationId, ...(referral ? { referralId: referral.referralId } : {}) }, ...(trialEnd ? { trial_end: trialEnd } : {}) }, success_url: `${back}?checkout=success`, cancel_url: `${back}?checkout=cancelled` };
  const create = (extra: Record<string, unknown> = {}) => stripe<{ url: string }>("/v1/checkout/sessions", { ...params, ...extra }, key);
  if (!referral) return (await create()).url;
  try { return (await create({ allow_promotion_codes: undefined, discounts: [{ coupon: referral.coupon }] })).url; }
  catch (error) {
    // A used-up, expired or deleted coupon must not block subscribing: retry once without it.
    if (!(error instanceof StripeError) || error.status !== 400 || !["coupon_expired", "resource_missing"].includes(error.code ?? "")) throw error;
    // resource_missing also covers other missing objects (then the retry fails the same way); param tells them apart.
    // shortcut: no referralOps:report coupon-health check; operators watch for this log line instead.
    console.log(JSON.stringify({ event: "referral.coupon_unavailable", code: error.code, param: error.param }));
    return (await create()).url;
  }
} });
export const portal = action({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a): Promise<string> => {
  const context = await ctx.runQuery(internal.billing.checkoutContext, a);
  if (!context.customerId) throw new Error("Start a subscription first");
  // The configuration lists the plans to switch between (with prorations) and turns quantity changes off.
  const configuration = process.env.STRIPE_PORTAL_CONFIGURATION_ID;
  if (configuration && !/^bpc_[A-Za-z0-9]+$/.test(configuration)) throw new Error("STRIPE_PORTAL_CONFIGURATION_ID must be a bpc_… id");
  return (await stripe<{ url: string }>("/v1/billing_portal/sessions", { customer: context.customerId, return_url: `${appOrigin()}/dashboard/settings/billing`, ...(configuration ? { configuration } : {}) }, stripeKey())).url;
} });
export const syncSeats = internalAction({ args: { organizationId: v.id("organizations") }, handler: async (ctx, a): Promise<string> => {
  const target = await ctx.runQuery(internal.billing.seatSyncTarget, a);
  if (!target || target.seats === target.billed) return "unchanged";
  await stripe(`/v1/subscriptions/${target.subscriptionId}`, { items: [{ id: target.itemId, quantity: target.seats }], proration_behavior: "create_prorations" }, stripeKey(), fetch, `seats:${target.subscriptionId}:${target.seats}:${target.billed}`);
  return "updated";
} });
