import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { audit, authorize } from "./auth";
import { billingConfig, billingDecision, nextPeriodStart, periodKey, seatCount, trialEndsFrom } from "../src/billing";
import { referralConfig } from "../src/referrals";
import { anyCommission, chargeEvent, invoiceFacts, mayHaveCommission, referralCredit, referralStatus } from "./referralLedger";

// Billing state, the review gate and the workspace usage ledger. With BILLING_ENABLED unset every check allows.
// The account row (and with it the trial clock) starts with the first review or checkout, so
// workspaces created before billing was turned on still get their full trial.
async function members(ctx: QueryCtx, organizationId: Id<"organizations">) {
  return ctx.db.query("organizationMembers").withIndex("by_org", (q) => q.eq("organizationId", organizationId)).collect();
}
async function accountOf(ctx: QueryCtx, organizationId: Id<"organizations">) {
  return ctx.db.query("billingAccounts").withIndex("by_org", (q) => q.eq("organizationId", organizationId)).unique();
}
async function ensureAccount(ctx: MutationCtx, organizationId: Id<"organizations">): Promise<Doc<"billingAccounts">> {
  const existing = await accountOf(ctx, organizationId);
  if (existing) return existing;
  const id = await ctx.db.insert("billingAccounts", { organizationId, status: "trial", seats: seatCount(await members(ctx, organizationId)), trialEndsAt: trialEndsFrom(Date.now(), billingConfig()), updatedAt: Date.now() });
  return (await ctx.db.get(id))!;
}
async function usageOf(ctx: QueryCtx, organizationId: Id<"organizations">, period: string) {
  return ctx.db.query("billingUsage").withIndex("by_org_period", (q) => q.eq("organizationId", organizationId).eq("period", period)).unique();
}
// Usage counted against the allowance: settled cost plus what in-flight calls have reserved.
const spent = (usage: Doc<"billingUsage"> | null) => (usage?.usedMicros ?? 0) + (usage?.reservedMicros ?? 0);
export const choosePlanMessage = "Choose a plan for this workspace first: a workspace admin starts the free trial under Setup → Choose your plan";
/** A workspace that must choose a plan (new, on a billing deployment) and has no Stripe-confirmed choice yet. */
export async function planMissing(ctx: QueryCtx, organizationId: Id<"organizations">) {
  if (!billingConfig().enabled) return false;
  const organization = await ctx.db.get(organizationId);
  return Boolean(organization?.planRequired && !organization.planSelectedAt);
}
// The plan counts as chosen once Stripe confirms a subscription (a trial with a card, or paid).
async function recordPlanSelected(ctx: MutationCtx, organizationId: Id<"organizations">, status: string) {
  if (!["trialing", "active", "past_due", "checkout"].includes(status)) return;
  const organization = await ctx.db.get(organizationId);
  if (!organization || organization.planSelectedAt) return;
  await ctx.db.patch(organizationId, { planSelectedAt: Date.now(), plan: "starter" });
  await ctx.db.insert("auditEvents", { organizationId, action: "billing.plan_selected", target: "starter", createdAt: Date.now() });
}
// Called by reviews.enqueue: counts an allowed review, or records a blocked one with its reason. Model calls
// are what use the allowance (reserveUsage); this only stops a review that could not make any.
export async function reviewAllowance(ctx: MutationCtx, organizationId: Id<"organizations">): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const config = billingConfig();
  if (!config.enabled) return { allowed: true };
  if (await planMissing(ctx, organizationId)) return { allowed: false, reason: "Billing: " + choosePlanMessage };
  const account = await ensureAccount(ctx, organizationId), now = Date.now(), period = periodKey(now);
  const usage = await usageOf(ctx, organizationId, period);
  const decision = billingDecision(account, spent(usage), now, config);
  if (usage) await ctx.db.patch(usage._id, decision.allowed ? { reviews: usage.reviews + 1 } : { blocked: usage.blocked + 1 });
  else await ctx.db.insert("billingUsage", { organizationId, period, reviews: decision.allowed ? 1 : 0, blocked: decision.allowed ? 0 : 1 });
  return decision.allowed ? { allowed: true } : { allowed: false, reason: "Billing: " + decision.reason };
}
// Workspace side of an inference reservation (inferenceBudget.reserve, same transaction): refuses past the
// included usage and extra-usage cap with the billing reason, otherwise holds the amount until the call settles.
export async function reserveUsage(ctx: MutationCtx, organizationId: Id<"organizations">, micros: number): Promise<Id<"billingUsage"> | null> {
  const config = billingConfig();
  if (!config.enabled) return null;
  if (await planMissing(ctx, organizationId)) throw new ConvexError("Billing: " + choosePlanMessage);
  const account = await ensureAccount(ctx, organizationId), now = Date.now(), period = periodKey(now);
  const usage = await usageOf(ctx, organizationId, period);
  const decision = billingDecision(account, spent(usage), now, config, micros);
  if (!decision.allowed) throw new ConvexError("Billing: " + decision.reason);
  if (!usage) return ctx.db.insert("billingUsage", { organizationId, period, reviews: 0, blocked: 0, reservedMicros: micros });
  await ctx.db.patch(usage._id, { reservedMicros: (usage.reservedMicros ?? 0) + micros });
  return usage._id;
}
// Settles a reservation into the month it was made in; the part past the included usage is queued for Stripe.
export async function settleUsage(ctx: MutationCtx, usageId: Id<"billingUsage">, reservedMicros: number, amount: number) {
  const usage = await ctx.db.get(usageId);
  if (!usage) return;
  const account = await accountOf(ctx, usage.organizationId), decision = account ? billingDecision(account, 0, Date.now(), billingConfig()) : null;
  const before = usage.usedMicros ?? 0, after = before + amount, limit = decision?.plan === "starter" ? decision.limit! : null;
  const overage = limit === null ? 0 : Math.max(0, after - limit) - Math.max(0, before - limit);
  await ctx.db.patch(usage._id, { usedMicros: after, reservedMicros: Math.max(0, (usage.reservedMicros ?? 0) - reservedMicros), ...(overage ? { overageMicros: (usage.overageMicros ?? 0) + overage } : {}) });
  if (!overage) return;
  const id = await ctx.db.insert("billingMeterEvents", { organizationId: usage.organizationId, period: usage.period, micros: overage, status: "pending", attempts: 0, createdAt: Date.now() });
  await ctx.scheduler.runAfter(0, internal.billingJobs.reportUsage, { id });
}

// Admin-set monthly extra-usage cap in dollars (0 turns extra usage off). Audited.
export const setSpendingCap = mutation({ args: { token: v.string(), organizationId: v.id("organizations"), capUsd: v.number() }, handler: async (ctx, a) => {
  const { user } = await authorize(ctx, a.token, a.organizationId, true);
  if (!billingConfig().enabled) throw new Error("Billing is disabled on this deployment");
  if (!Number.isFinite(a.capUsd) || a.capUsd < 0 || a.capUsd > 1_000_000) throw new Error("Enter a cap between $0 and $1,000,000");
  const account = await ensureAccount(ctx, a.organizationId), capUsd = Math.round(a.capUsd * 100) / 100;
  await ctx.db.patch(account._id, { spendCapUsd: capUsd, updatedAt: Date.now() });
  await audit(ctx, a.organizationId, user._id, "billing.spending_cap", String(capUsd));
} });
export const meterEvent = internalQuery({ args: { id: v.id("billingMeterEvents") }, handler: async (ctx, a) => {
  const event = await ctx.db.get(a.id);
  if (!event || event.status !== "pending") return null;
  return { ...event, customerId: (await accountOf(ctx, event.organizationId))?.customerId ?? null };
} });
export const meterResult = internalMutation({ args: { id: v.id("billingMeterEvents"), status: v.union(v.literal("reported"), v.literal("skipped"), v.literal("retry")), error: v.optional(v.string()) }, handler: async (ctx, a) => {
  const event = await ctx.db.get(a.id);
  if (!event || event.status !== "pending") return;
  if (a.status === "retry") {
    const attempts = event.attempts + 1;
    if (attempts >= 5) { await ctx.db.patch(event._id, { status: "failed", attempts, error: a.error?.slice(0, 300) }); return; }
    await ctx.db.patch(event._id, { attempts, error: a.error?.slice(0, 300) });
    await ctx.scheduler.runAfter(60_000 * 2 ** attempts, internal.billingJobs.reportUsage, { id: event._id });
    return;
  }
  await ctx.db.patch(event._id, { status: a.status, ...(a.status === "reported" ? { reportedAt: Date.now() } : {}), ...(a.error ? { error: a.error.slice(0, 300) } : {}) });
} });

export const status = query({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  const { user, member } = await authorize(ctx, a.token, a.organizationId);
  const config = billingConfig();
  if (!config.enabled) return { enabled: false as const };
  const stored = await accountOf(ctx, a.organizationId);
  const account = stored ?? { status: "trial", seats: 0, trialEndsAt: trialEndsFrom(Date.now(), config) } as Pick<Doc<"billingAccounts">, "status" | "seats" | "trialEndsAt"> & Partial<Doc<"billingAccounts">>;
  const now = Date.now(), usage = await usageOf(ctx, a.organizationId, periodKey(now));
  const decision = billingDecision({ status: account.status, seats: account.seats, trialEndsAt: account.trialEndsAt, pastDueSince: account.pastDueSince, subscriptionId: account.subscriptionId, spendCapUsd: account.spendCapUsd }, spent(usage), now, config);
  const organization = await ctx.db.get(a.organizationId);
  const admin = ["owner", "admin"].includes(member.role), referrals = admin && referralConfig().enabled;
  return { enabled: true as const, planRequired: Boolean(organization?.planRequired), planSelected: Boolean(organization?.planSelectedAt), planMissing: Boolean(organization?.planRequired && !organization.planSelectedAt), admin, referral: referrals ? await referralStatus(ctx, user._id, member.role, a.organizationId) : null, referralCredit: referrals ? await referralCredit(ctx, a.organizationId) : null, status: account.status, plan: decision.plan, allowed: decision.allowed, reason: decision.reason ?? null, limit: decision.limit, used: usage?.usedMicros ?? 0, reserved: usage?.reservedMicros ?? 0, overage: usage?.overageMicros ?? 0, capUsd: account.spendCapUsd ?? 0, resetsAt: nextPeriodStart(now), reviews: usage?.reviews ?? 0, blocked: usage?.blocked ?? 0, activeSeats: seatCount(await members(ctx, a.organizationId)), billedSeats: account.subscriptionId ? account.seats : null, trialEndsAt: account.trialEndsAt, trialStarted: Boolean(stored), trialDays: config.trialDays, trialUsageMicros: config.trialUsageMicros, currentPeriodEnd: account.currentPeriodEnd ?? null, pastDueSince: account.pastDueSince ?? null, graceDays: config.graceDays, usagePerSeatMicros: config.usagePerSeatMicros, hasCustomer: Boolean(account.customerId) };
} });

export const checkoutContext = internalQuery({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  await authorize(ctx, a.token, a.organizationId, true);
  if (!billingConfig().enabled) throw new Error("Billing is disabled on this deployment");
  const account = await accountOf(ctx, a.organizationId);
  return { customerId: account?.customerId ?? null, subscriptionId: account?.subscriptionId ?? null, status: account?.status ?? "trial", trialEndsAt: account?.trialEndsAt ?? trialEndsFrom(Date.now(), billingConfig()), seats: Math.max(1, seatCount(await members(ctx, a.organizationId))) };
} });
export const linkCustomer = internalMutation({ args: { organizationId: v.id("organizations"), customerId: v.string() }, handler: async (ctx, a) => {
  const account = await ensureAccount(ctx, a.organizationId);
  if (account.customerId && account.customerId !== a.customerId) throw new Error("Workspace already has a billing customer");
  const other = await ctx.db.query("billingAccounts").withIndex("by_customer", (q) => q.eq("customerId", a.customerId)).unique();
  if (other && other._id !== account._id) throw new Error("Billing customer belongs to another workspace");
  await ctx.db.patch(account._id, { customerId: a.customerId, updatedAt: Date.now() });
} });

const subscriptionArgs = v.object({ id: v.string(), customer: v.string(), status: v.string(), quantity: v.number(), itemId: v.optional(v.string()), currentPeriodEnd: v.optional(v.number()), organizationId: v.optional(v.string()) });
// Signed Stripe events, applied at most once; subscription events older than the last applied
// one are recorded but ignored, so redelivery and reordering cannot roll state back.
export const applyStripeEvent = internalMutation({ args: { eventId: v.string(), type: v.string(), created: v.number(), checkout: v.optional(v.object({ organizationId: v.string(), customer: v.string(), subscription: v.optional(v.string()) })), subscription: v.optional(subscriptionArgs), invoice: v.optional(v.object(invoiceFacts)), charge: v.optional(v.object(chargeEvent)) }, handler: async (ctx, a): Promise<string> => {
  if (await ctx.db.query("stripeEvents").withIndex("by_event", (q) => q.eq("eventId", a.eventId)).unique()) return "duplicate";
  const record = async (outcome: string) => { await ctx.db.insert("stripeEvents", { eventId: a.eventId, type: a.type.slice(0, 100), outcome, createdAt: Date.now() }); return outcome; };
  const byCustomer = (customer: string) => ctx.db.query("billingAccounts").withIndex("by_customer", (q) => q.eq("customerId", customer)).unique();
  if (a.checkout) {
    const organizationId = ctx.db.normalizeId("organizations", a.checkout.organizationId);
    if (!organizationId || !await ctx.db.get(organizationId)) return record("unknown workspace");
    const account = await ensureAccount(ctx, organizationId);
    if (account.customerId && account.customerId !== a.checkout.customer) return record("customer mismatch");
    await ctx.db.patch(account._id, { customerId: a.checkout.customer, ...(a.checkout.subscription ? { subscriptionId: a.checkout.subscription } : {}), updatedAt: Date.now() });
    // A completed subscription Checkout collected the card and created the subscription.
    if (a.checkout.subscription) await recordPlanSelected(ctx, organizationId, "checkout");
    return record("linked");
  }
  if (a.subscription) {
    const s = a.subscription;
    const account = await byCustomer(s.customer);
    if (!account) return record("unknown customer");
    if (s.organizationId && s.organizationId !== account.organizationId) return record("workspace mismatch");
    if (account.lastEventCreated && a.created < account.lastEventCreated) return record("stale");
    const deleted = a.type === "customer.subscription.deleted";
    await ctx.db.patch(account._id, { subscriptionId: s.id, subscriptionItemId: s.itemId, status: deleted ? "canceled" : s.status, seats: s.quantity, currentPeriodEnd: s.currentPeriodEnd, pastDueSince: s.status === "past_due" ? account.pastDueSince ?? a.created : undefined, lastEventCreated: a.created, updatedAt: Date.now() });
    if (!deleted) await recordPlanSelected(ctx, account.organizationId, s.status);
    return record(deleted ? "canceled" : s.status);
  }
  if (a.invoice) {
    const account = await byCustomer(a.invoice.customer);
    if (!account || (a.invoice.subscription && account.subscriptionId && a.invoice.subscription !== account.subscriptionId)) return record("unknown customer");
    if (a.type === "invoice.payment_failed") await ctx.db.patch(account._id, { status: "past_due", pastDueSince: account.pastDueSince ?? a.created, updatedAt: Date.now() });
    if (a.type === "invoice.paid" && account.status === "past_due") await ctx.db.patch(account._id, { status: "active", pastDueSince: undefined, updatedAt: Date.now() });
    // Referral commissions accrue in their own job, so a referral bug can never fail this webhook.
    if (a.type === "invoice.paid" && referralConfig().enabled && a.invoice.id && a.invoice.subscription) await ctx.scheduler.runAfter(0, internal.referrals.accrue, { ...a.invoice, paidAt: a.invoice.paidAt ?? a.created });
    return record(a.type);
  }
  // Refunds and disputes claw referral commissions back, so this follows billing rather than
  // REFERRALS_ENABLED: switching the program off does not stop clawbacks. A refund without a customer
  // never paid an invoice; a dispute names no customer, so its job checks the charge's.
  if (a.charge && billingConfig().enabled && (a.charge.customer ? await mayHaveCommission(ctx, a.charge.customer) : a.charge.kind === "dispute" && await anyCommission(ctx))) {
    await ctx.scheduler.runAfter(0, internal.referralJobs.resolveChargeEvent, a.charge);
    return record("referral check queued");
  }
  return record("ignored");
} });

// Switching Stripe from test to live mode: test customers and subscriptions do not exist in live
// mode, so every workspace drops its Stripe links and returns to its trial (same end date). Run once
// with `npx convex run billing:forgetStripeLinks '{"confirm":"switch-stripe-mode"}' --prod`.
export const forgetStripeLinks = internalMutation({ args: { confirm: v.literal("switch-stripe-mode") }, handler: async (ctx): Promise<number> => {
  const accounts = await ctx.db.query("billingAccounts").collect();
  for (const account of accounts) await ctx.db.patch(account._id, { customerId: undefined, subscriptionId: undefined, subscriptionItemId: undefined, currentPeriodEnd: undefined, pastDueSince: undefined, lastEventCreated: undefined, status: "trial", seats: seatCount(await members(ctx, account.organizationId)), updatedAt: Date.now() });
  return accounts.length;
} });

// Seat changes resync the subscription quantity (only for active subscriptions).
export async function scheduleSeatSync(ctx: MutationCtx, organizationId: Id<"organizations">) {
  if (!billingConfig().enabled) return;
  const account = await accountOf(ctx, organizationId);
  if (account?.subscriptionId && account.subscriptionItemId && ["active", "trialing", "past_due"].includes(account.status)) await ctx.scheduler.runAfter(0, internal.billingJobs.syncSeats, { organizationId });
}
export const seatSyncTarget = internalQuery({ args: { organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  const account = await accountOf(ctx, a.organizationId);
  if (!account?.subscriptionId || !account.subscriptionItemId) return null;
  return { subscriptionId: account.subscriptionId, itemId: account.subscriptionItemId, billed: account.seats, seats: Math.max(1, seatCount(await members(ctx, a.organizationId))) };
} });
