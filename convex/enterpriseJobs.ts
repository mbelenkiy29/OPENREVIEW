import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { termsArgs } from "./enterprise";
import { stripe, stripeKey } from "../src/billing";

// Stripe side of an Enterprise contract (docs/billing.md, Enterprise contracts): two prices of its own on the
// Enterprise product, then a one-year subscription schedule that invoices the customer. Each call carries the
// idempotency key contract:<id>:<step>, so a retry after a failure makes nothing twice.
const priceId = (name: string) => { const id = process.env[name]; return id && /^price_[A-Za-z0-9]+$/.test(id) ? id : undefined; };

export const createContract = action({ args: { token: v.string(), organizationId: v.id("organizations"), ...termsArgs }, handler: async (ctx, a): Promise<string> => {
  const product = process.env.STRIPE_ENTERPRISE_PRODUCT_ID, meter = process.env.STRIPE_CONTRIBUTOR_METER_ID;
  // saveDraft checks the operator; these checks run first so a deployment that is not set up saves nothing.
  if (!product || !meter) throw new Error("Set STRIPE_ENTERPRISE_PRODUCT_ID and STRIPE_CONTRIBUTOR_METER_ID on Convex first (docs/billing.md)");
  const usagePrice = a.mode === "managed" ? a.usagePriceId ?? priceId("STRIPE_ENTERPRISE_USAGE_PRICE_ID") : undefined;
  if (a.mode === "managed" && !usagePrice) throw new Error("Set STRIPE_ENTERPRISE_USAGE_PRICE_ID on Convex, or enter a custom overage price");
  const draft = await ctx.runMutation(internal.enterprise.saveDraft, a);
  const key = stripeKey(), id = draft.contractId, metadata = { organizationId: a.organizationId, contractId: id };
  let customer = draft.customerId;
  if (!customer) {
    customer = (await stripe<{ id: string }>("/v1/customers", { metadata: { organizationId: a.organizationId } }, key, fetch, `customer:${a.organizationId}`)).id;
    await ctx.runMutation(internal.billing.linkCustomer, { organizationId: a.organizationId, customerId: customer });
  }
  const price = (step: string, params: Record<string, unknown>) => stripe<{ id: string }>("/v1/prices", { product, currency: "usd", metadata, ...params }, key, fetch, `contract:${id}:${step}`);
  // The commitment is billed for the year up front; contributors above it are billed monthly from the meter.
  const commit = await price("commit", { unit_amount: a.contributorPriceCents * 12, recurring: { interval: "year" } });
  const trueUp = await price("trueup", { unit_amount: a.contributorPriceCents, recurring: { interval: "month", usage_type: "metered", meter } });
  // Mixed yearly and monthly items need flexible billing mode. The schedule starts on the contract's first day and
  // cancels the subscription when the year ends, so a contract never renews by itself at last year's price.
  const schedule = await stripe<{ id: string }>("/v1/subscription_schedules", {
    customer, start_date: Math.floor(a.startsAt / 1000), end_behavior: "cancel", billing_mode: { type: "flexible" },
    phases: [{ items: [{ price: commit.id, quantity: a.committedContributors }, { price: trueUp.id }, ...(usagePrice ? [{ price: usagePrice }] : [])], duration: { interval: "year", interval_count: 1 }, collection_method: "send_invoice", invoice_settings: { days_until_due: a.netDays }, metadata }],
  }, key, fetch, `contract:${id}:schedule`);
  // Moving from Starter or Pro: that subscription ends the moment the contract starts and bills normally until
  // then. A contract already in force (started on the 1st of this month) ends it now and credits the unused time.
  if (draft.replaces) await stripe(`/v1/subscriptions/${draft.replaces}`, a.startsAt > Date.now() ? { cancel_at: Math.floor(a.startsAt / 1000), proration_behavior: "none" } : { cancel_at: Math.floor(Date.now() / 1000) + 60, proration_behavior: "create_prorations" }, key, fetch, `contract:${id}:cancelpro`);
  await ctx.runMutation(internal.enterprise.saveStripe, { token: a.token, organizationId: a.organizationId, contractId: id, ...(draft.replaces ? { migratedFrom: draft.replaces } : {}), stripe: { productId: product, commitPriceId: commit.id, contributorPriceId: trueUp.id, ...(usagePrice ? { usagePriceId: usagePrice } : {}), scheduleId: schedule.id } });
  return "created";
} });

// For the operator form: rebuilds the last three months of the contributor ledger from reviews (months from before
// the ledger have no rows), then returns the counts and the current subscription.
export const contributorHistory = action({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a): Promise<{ plan: string | null; seats: number; months: { period: string; contributors: number }[] }> => {
  const before = await ctx.runQuery(internal.enterprise.history, a);
  for (const m of before.months) await ctx.runMutation(internal.contributors.backfill, { organizationId: a.organizationId, period: m.period });
  return ctx.runQuery(internal.enterprise.history, a);
} });
