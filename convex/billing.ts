import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { audit, authorize } from "./auth";
import { billingConfig, billingDecision, fixRunLimit, reviewsLeft, freeTakenReason, liveSubscription, nextPeriodStart, openSubscription, periodKey, resetText, seatCount, trialEndsFrom } from "../src/billing";
import { entitled, entitlements, planCatalog, planEntitlements, planForPrice, upgradeNote, type Entitlement, type Plan } from "../src/plans";
import { referralConfig } from "../src/referrals";
import { anyCommission, chargeEvent, invoiceFacts, mayHaveCommission, referralCredit, referralStatus } from "./referralLedger";
import { lifecycleEmail } from "./lifecycleEmails";
import { recordConversion } from "./conversions";
import { operatorOwned } from "./operator";

// Billing state, the review gate and the workspace usage ledger. With BILLING_ENABLED unset every check allows.
// The account row starts with the first review or checkout. Without a subscription a workspace is on
// the Free plan; the paid-plan trial (trialEndsAt) starts when the workspace first opens Checkout.
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
// Until the first Checkout links a customer, the trial is a full one starting now.
const paidTrialEndsAt = (account: { customerId?: string; trialEndsAt: number } | null, now: number) => account?.customerId ? account.trialEndsAt : trialEndsFrom(now, billingConfig());
const spent = (usage: Doc<"billingUsage"> | null) => (usage?.usedMicros ?? 0) + (usage?.reservedMicros ?? 0);
// A workspace an operator owns (convex/operator.ts) bills like a self-hosted install: unlimited usage and fixes, every
// feature, nothing reported to Stripe. Its usage is still counted, and the deployment's inference budget still caps it.
async function configFor(ctx: QueryCtx, organizationId: Id<"organizations">) {
  const config = billingConfig();
  return config.enabled && await operatorOwned(ctx, organizationId) ? { ...config, enabled: false } : config;
}
export const choosePlanMessage = "Choose a plan for this workspace first: a workspace admin picks Free, Starter or Pro under Setup → Choose your plan";
/** A workspace that must choose a plan (new, on a billing deployment) and has no Stripe-confirmed choice yet. */
export async function planMissing(ctx: QueryCtx, organizationId: Id<"organizations">) {
  if (!(await configFor(ctx, organizationId)).enabled) return false;
  const organization = await ctx.db.get(organizationId);
  return Boolean(organization?.planRequired && !organization.planSelectedAt);
}
// A paid plan counts as chosen once Stripe confirms a subscription (a trial with a card, or paid). The
// Checkout event does not name the plan, so the subscription event records it, including later switches.
async function recordPlanSelected(ctx: MutationCtx, organizationId: Id<"organizations">, status: string, plan?: Plan) {
  if (!["trialing", "active", "past_due", "checkout"].includes(status)) return;
  const organization = await ctx.db.get(organizationId);
  if (!organization || (organization.planSelectedAt && (!plan || organization.plan === plan))) return;
  await ctx.db.patch(organizationId, { ...(organization.planSelectedAt ? {} : { planSelectedAt: Date.now() }), ...(plan ? { plan } : {}) });
  if (plan) await ctx.db.insert("auditEvents", { organizationId, action: organization.plan ? "billing.plan_changed" : "billing.plan_selected", target: plan, createdAt: Date.now() });
}
// One Free allowance per owner, so new workspaces are no way to more free usage: a workspace that chose its plan
// at signup (planRequired) gets none while an owner has another Free workspace created before it, and before it
// chooses, any other one counts. Returns that workspace's name. Workspaces from before plans keep their allowance.
async function freeElsewhere(ctx: QueryCtx, organizationId: Id<"organizations">, now: number): Promise<string | undefined> {
  const organization = await ctx.db.get(organizationId);
  if (!organization?.planRequired || await operatorOwned(ctx, organizationId)) return;
  for (const owner of (await members(ctx, organizationId)).filter((m) => m.role === "owner"))
    for (const other of await ctx.db.query("organizationMembers").withIndex("by_user", (q) => q.eq("userId", owner.userId)).collect()) {
      if (other.role !== "owner" || other.organizationId === organizationId) continue;
      const workspace = await ctx.db.get(other.organizationId);
      if (!workspace || (workspace.planRequired && !workspace.planSelectedAt) || (organization.planSelectedAt && workspace._creationTime > organization._creationTime)) continue;
      const account = await accountOf(ctx, workspace._id);
      if (!account || billingDecision(account, 0, now, billingConfig()).plan === "free") return workspace.name;
    }
}
// billingDecision with the one-Free-per-owner rule, which only a Free workspace looks up.
async function decide(ctx: QueryCtx, organizationId: Id<"organizations">, account: Parameters<typeof billingDecision>[0], used: number, now: number, request = 0) {
  const config = await configFor(ctx, organizationId), decision = billingDecision(account, used, now, config, request);
  return decision.plan === "free" ? billingDecision(account, used, now, config, request, await freeElsewhere(ctx, organizationId, now)) : decision;
}
// Free needs no Stripe confirmation, so the workspace can start at once. Returns the name of the owner's
// other Free workspace instead when that one already has the Free allowance.
export async function startOnFree(ctx: MutationCtx, organizationId: Id<"organizations">, userId: Id<"users">): Promise<string | undefined> {
  const organization = await ctx.db.get(organizationId);
  if (!organization || organization.planSelectedAt) return;
  const taken = await freeElsewhere(ctx, organizationId, Date.now());
  if (taken) return taken;
  await ctx.db.patch(organizationId, { planSelectedAt: Date.now(), plan: "free" });
  await audit(ctx, organizationId, userId, "billing.plan_selected", "free");
}
export const chooseFreePlan = mutation({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  const { user } = await authorize(ctx, a.token, a.organizationId, true);
  if (!billingConfig().enabled) throw new Error("Billing is disabled on this deployment");
  const taken = await startOnFree(ctx, a.organizationId, user._id);
  if (taken) throw new ConvexError("Billing: " + freeTakenReason(taken));
} });
// Whether the workspace's plan includes a feature; with billing off every feature is unlocked.
export async function hasEntitlement(ctx: QueryCtx, organizationId: Id<"organizations">, key: Entitlement) {
  const config = await configFor(ctx, organizationId);
  if (!config.enabled) return true;
  const account = await accountOf(ctx, organizationId);
  return account ? entitled(billingDecision(account, 0, Date.now(), config).plan, key, account.legacy) : false;
}
const entitlementKey = v.union(...entitlements.map((key) => v.literal(key)));
export const entitlement = internalQuery({ args: { organizationId: v.id("organizations"), key: entitlementKey }, handler: (ctx, a) => hasEntitlement(ctx, a.organizationId, a.key) });
// The Pro features this workspace's plan lacks, for the dashboard's <Locked> settings (none with billing off).
export const locked = query({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  await authorize(ctx, a.token, a.organizationId);
  const held = await Promise.all(entitlements.map((key) => hasEntitlement(ctx, a.organizationId, key)));
  return entitlements.filter((_, i) => !held[i]);
} });
// Called by reviews.enqueue: counts an allowed review, or records a blocked one with its reason. Model calls
// are what use the allowance (reserveUsage); this only stops a review that could not make any.
export async function reviewAllowance(ctx: MutationCtx, organizationId: Id<"organizations">): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const config = billingConfig();
  if (!config.enabled) return { allowed: true };
  if (await planMissing(ctx, organizationId)) return { allowed: false, reason: "Billing: " + choosePlanMessage };
  const account = await ensureAccount(ctx, organizationId), now = Date.now(), period = periodKey(now);
  const usage = await usageOf(ctx, organizationId, period);
  const decision = await decide(ctx, organizationId, account, spent(usage), now);
  if (usage) await ctx.db.patch(usage._id, decision.allowed ? { reviews: usage.reviews + 1 } : { blocked: usage.blocked + 1 });
  else await ctx.db.insert("billingUsage", { organizationId, period, reviews: decision.allowed ? 1 : 0, blocked: decision.allowed ? 0 : 1 });
  return decision.allowed ? { allowed: true } : { allowed: false, reason: "Billing: " + decision.reason };
}
// Called before a hosted agent fix run: counts it against the plan's monthly fix runs (fixRunLimit). The run's
// model calls still draw on the usage allowance through reserveUsage. releaseFix gives the run back if it never starts.
export async function fixAllowance(ctx: MutationCtx, organizationId: Id<"organizations">): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const config = billingConfig();
  if (!config.enabled) return { allowed: true };
  if (await planMissing(ctx, organizationId)) return { allowed: false, reason: "Billing: " + choosePlanMessage };
  const account = await ensureAccount(ctx, organizationId), now = Date.now(), period = periodKey(now);
  const usage = await usageOf(ctx, organizationId, period);
  const decision = await decide(ctx, organizationId, account, spent(usage), now);
  if (!decision.allowed) return { allowed: false, reason: "Billing: " + decision.reason };
  if (decision.plan === "free") return { allowed: false, reason: "Billing: " + upgradeNote["fix.pullRequests"] };
  // No limit: an operator's workspace (decide), whose runs are still counted.
  const limit = fixRunLimit(decision, account.seats, config), used = usage?.fixes ?? 0;
  if (limit !== null && used >= limit) return { allowed: false, reason: `Billing: This workspace used its ${limit} agent fixes for this month. They reset on ${resetText(now)}.${decision.plan === "starter" ? ` Pro includes ${config.proFixesPerSeat} per seat; a workspace admin can upgrade in Organization Settings → Billing & Usage.` : ""}` };
  if (usage) await ctx.db.patch(usage._id, { fixes: used + 1 });
  else await ctx.db.insert("billingUsage", { organizationId, period, reviews: 0, blocked: 0, fixes: 1 });
  return { allowed: true };
}
export async function releaseFix(ctx: MutationCtx, organizationId: Id<"organizations">) {
  const usage = await usageOf(ctx, organizationId, periodKey(Date.now()));
  if (usage?.fixes) await ctx.db.patch(usage._id, { fixes: usage.fixes - 1 });
}
// Workspace side of an inference reservation (inferenceBudget.reserve, same transaction): refuses past the
// included usage and extra-usage cap with the billing reason, otherwise holds the amount until the call settles.
export async function reserveUsage(ctx: MutationCtx, organizationId: Id<"organizations">, micros: number): Promise<Id<"billingUsage"> | null> {
  const config = billingConfig();
  if (!config.enabled) return null;
  if (await planMissing(ctx, organizationId)) throw new ConvexError("Billing: " + choosePlanMessage);
  const account = await ensureAccount(ctx, organizationId), now = Date.now(), period = periodKey(now);
  const usage = await usageOf(ctx, organizationId, period);
  const decision = await decide(ctx, organizationId, account, spent(usage), now, micros);
  if (!decision.allowed) throw new ConvexError("Billing: " + decision.reason);
  if (!usage) return ctx.db.insert("billingUsage", { organizationId, period, reviews: 0, blocked: 0, reservedMicros: micros });
  await ctx.db.patch(usage._id, { reservedMicros: (usage.reservedMicros ?? 0) + micros });
  return usage._id;
}
// Settles a reservation into the month it was made in; the part past the included usage is queued for Stripe.
export async function settleUsage(ctx: MutationCtx, usageId: Id<"billingUsage">, reservedMicros: number, amount: number) {
  const usage = await ctx.db.get(usageId);
  if (!usage) return;
  const account = await accountOf(ctx, usage.organizationId), decision = account ? billingDecision(account, 0, Date.now(), await configFor(ctx, usage.organizationId)) : null;
  const before = usage.usedMicros ?? 0, after = before + amount, limit = decision?.plan === "starter" || decision?.plan === "pro" ? decision.limit! : null;
  const overage = limit === null ? 0 : Math.max(0, after - limit) - Math.max(0, before - limit);
  // Usage alerts: each threshold once per period; a jump past both sends only the 100% email.
  const sent = usage.alertsSent ?? [], crossed = decision?.limit ? [80, 100].filter((p) => !sent.includes(p) && after * 100 >= decision.limit! * p) : [];
  await ctx.db.patch(usage._id, { usedMicros: after, reservedMicros: Math.max(0, (usage.reservedMicros ?? 0) - reservedMicros), ...(overage ? { overageMicros: (usage.overageMicros ?? 0) + overage } : {}), ...(crossed.length ? { alertsSent: [...sent, ...crossed] } : {}) });
  if (crossed.length) await ctx.scheduler.runAfter(0, internal.notificationJobs.usageAlert, { usageId, threshold: crossed.at(-1)! });
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
  // An operator's own workspace has no plan or quota; the Billing page says so.
  if (await operatorOwned(ctx, a.organizationId)) return { enabled: false as const, exempt: true as const };
  const stored = await accountOf(ctx, a.organizationId);
  const account = stored ?? { status: "trial", seats: 0, trialEndsAt: 0 } as Pick<Doc<"billingAccounts">, "status" | "seats" | "trialEndsAt"> & Partial<Doc<"billingAccounts">>;
  const now = Date.now(), usage = await usageOf(ctx, a.organizationId, periodKey(now));
  const facts = { status: account.status, seats: account.seats, trialEndsAt: account.trialEndsAt, pastDueSince: account.pastDueSince, subscriptionId: account.subscriptionId, spendCapUsd: account.spendCapUsd, plan: account.plan };
  const taken = billingDecision(facts, 0, now, config).plan === "free" ? await freeElsewhere(ctx, a.organizationId, now) : undefined;
  const decision = billingDecision(facts, spent(usage), now, config, 0, taken);
  const organization = await ctx.db.get(a.organizationId);
  const admin = ["owner", "admin"].includes(member.role), referrals = admin && referralConfig().enabled;
  // A subscription with neither recorded yet (from before they were) counts as having one: Checkout always collects a card.
  const cards = [account.subscriptionPaymentMethod, account.customerPaymentMethod], hasPaymentMethod = cards.includes(true) || (Boolean(account.subscriptionId) && cards.every((c) => c === undefined));
  return { enabled: true as const, planRequired: Boolean(organization?.planRequired), planSelected: Boolean(organization?.planSelectedAt), planMissing: Boolean(organization?.planRequired && !organization.planSelectedAt), admin, referral: referrals ? await referralStatus(ctx, user._id, member.role, a.organizationId) : null, referralCredit: referrals ? await referralCredit(ctx, a.organizationId) : null, status: account.status, plan: decision.plan, planName: decision.plan === "disabled" ? null : planCatalog[decision.plan].name, legacy: Boolean(account.legacy && decision.plan === "starter"), entitlements: planEntitlements(decision.plan, account.legacy), allowed: decision.allowed, reason: decision.reason ?? null, limit: decision.limit, used: usage?.usedMicros ?? 0, reserved: usage?.reservedMicros ?? 0, overage: usage?.overageMicros ?? 0, capUsd: account.spendCapUsd ?? 0, resetsAt: nextPeriodStart(now), reviews: usage?.reviews ?? 0, blocked: usage?.blocked ?? 0, activeSeats: seatCount(await members(ctx, a.organizationId)), billedSeats: account.subscriptionId ? account.seats : null, trialEndsAt: paidTrialEndsAt(account, now), trialStarted: Boolean(account.customerId), trialDays: config.trialDays, freeUsageMicros: config.freeUsageMicros, currentPeriodEnd: account.currentPeriodEnd ?? null, pastDueSince: account.pastDueSince ?? null, graceDays: config.graceDays, usagePerSeatMicros: config.usagePerSeatMicros, proUsagePerSeatMicros: config.proUsagePerSeatMicros, hasCustomer: Boolean(account.customerId), hasPaymentMethod, freeElsewhere: taken ?? null, fixes: { used: usage?.fixes ?? 0, limit: fixRunLimit(decision, account.seats, config) }, starterFixesPerSeat: config.starterFixesPerSeat, proFixesPerSeat: config.proFixesPerSeat, reviewsLeft: reviewsLeft(decision.limit, (usage?.usedMicros ?? 0) + (usage?.reservedMicros ?? 0), (await ctx.db.query("usageEvents").withIndex("by_org_time", (q) => q.eq("organizationId", a.organizationId).gt("createdAt", now - 30 * 86400000)).order("desc").take(2000)).filter((e) => e.kind === "review")) };
} });

export const checkoutContext = internalQuery({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  const { user } = await authorize(ctx, a.token, a.organizationId, true);
  if (!billingConfig().enabled) throw new Error("Billing is disabled on this deployment");
  const account = await accountOf(ctx, a.organizationId);
  return { userId: user._id, customerId: account?.customerId ?? null, subscriptionId: account?.subscriptionId ?? null, subscriptionItemId: account?.subscriptionItemId ?? null, plan: account?.plan === "pro" ? "pro" as const : "starter" as const, status: account?.status ?? "trial", trialEndsAt: paidTrialEndsAt(account, Date.now()), seats: Math.max(1, seatCount(await members(ctx, a.organizationId))) };
} });
// The webhook records the new plan from the seat price; this only audits who asked for it.
export const auditPlanChange = internalMutation({ args: { organizationId: v.id("organizations"), userId: v.id("users"), plan: v.union(v.literal("starter"), v.literal("pro")) }, handler: (ctx, a) => audit(ctx, a.organizationId, a.userId, "billing.plan_change_requested", a.plan) });
export const linkCustomer = internalMutation({ args: { organizationId: v.id("organizations"), customerId: v.string() }, handler: async (ctx, a) => {
  const account = await ensureAccount(ctx, a.organizationId);
  if (account.customerId && account.customerId !== a.customerId) throw new Error("Workspace already has a billing customer");
  const other = await ctx.db.query("billingAccounts").withIndex("by_customer", (q) => q.eq("customerId", a.customerId)).unique();
  if (other && other._id !== account._id) throw new Error("Billing customer belongs to another workspace");
  // The paid-plan trial starts with the first Checkout, however long the workspace was on Free.
  await ctx.db.patch(account._id, { customerId: a.customerId, ...(account.customerId ? {} : { trialEndsAt: trialEndsFrom(Date.now(), billingConfig()) }), updatedAt: Date.now() });
} });

const subscriptionArgs = v.object({ id: v.string(), customer: v.string(), status: v.string(), quantity: v.number(), itemId: v.optional(v.string()), price: v.optional(v.string()), currentPeriodEnd: v.optional(v.number()), organizationId: v.optional(v.string()), paymentMethod: v.boolean() });
// Signed Stripe events, applied at most once; subscription events older than the last applied
// one are recorded but ignored, so redelivery and reordering cannot roll state back.
export const applyStripeEvent = internalMutation({ args: { eventId: v.string(), type: v.string(), created: v.number(), checkout: v.optional(v.object({ organizationId: v.string(), customer: v.string(), subscription: v.optional(v.string()) })), subscription: v.optional(subscriptionArgs), customer: v.optional(v.object({ id: v.string(), paymentMethod: v.boolean() })), invoice: v.optional(v.object(invoiceFacts)), charge: v.optional(v.object(chargeEvent)) }, handler: async (ctx, a): Promise<string> => {
  if (await ctx.db.query("stripeEvents").withIndex("by_event", (q) => q.eq("eventId", a.eventId)).unique()) return "duplicate";
  const record = async (outcome: string) => { await ctx.db.insert("stripeEvents", { eventId: a.eventId, type: a.type.slice(0, 100), outcome, createdAt: Date.now() }); return outcome; };
  const byCustomer = (customer: string) => ctx.db.query("billingAccounts").withIndex("by_customer", (q) => q.eq("customerId", customer)).unique();
  // Two open Checkout tabs can both complete: the second subscription must not replace (or, when cancelled, end) the
  // first, so it is left alone and logged for the operator to cancel and refund.
  const other = async (account: Doc<"billingAccounts">, subscription: string) => {
    console.error(JSON.stringify({ event: "billing.duplicate_subscription", eventId: a.eventId, type: a.type, organizationId: account.organizationId, subscription, kept: account.subscriptionId }));
    return record("other subscription");
  };
  if (a.checkout) {
    const organizationId = ctx.db.normalizeId("organizations", a.checkout.organizationId);
    if (!organizationId || !await ctx.db.get(organizationId)) return record("unknown workspace");
    const account = await ensureAccount(ctx, organizationId);
    if (account.customerId && account.customerId !== a.checkout.customer) return record("customer mismatch");
    if (a.checkout.subscription && liveSubscription(account) && a.checkout.subscription !== account.subscriptionId) return other(account, a.checkout.subscription);
    await ctx.db.patch(account._id, { customerId: a.checkout.customer, ...(a.checkout.subscription ? { subscriptionId: a.checkout.subscription } : {}), updatedAt: Date.now() });
    // A completed subscription Checkout collected the card and created the subscription.
    if (a.checkout.subscription) { await recordPlanSelected(ctx, organizationId, "checkout"); await lifecycleEmail(ctx, "subscribed", { organizationId }); }
    return record("linked");
  }
  if (a.subscription) {
    const s = a.subscription;
    const account = await byCustomer(s.customer);
    if (!account) return record("unknown customer");
    if (s.organizationId && s.organizationId !== account.organizationId) return record("workspace mismatch");
    if (liveSubscription(account) && s.id !== account.subscriptionId) return other(account, s.id);
    if (account.lastEventCreated && a.created < account.lastEventCreated) return record("stale");
    // Stripe timestamps are whole seconds: a subscription is created "incomplete" and updated to "active"
    // within one, and a cancellation can share its second with a last update. An equal-time event cannot
    // be ordered, so it never moves this subscription back to its creation or out of "canceled".
    if (a.created === account.lastEventCreated && s.id === account.subscriptionId && (a.type === "customer.subscription.created" || account.status === "canceled")) return record("stale");
    const deleted = a.type === "customer.subscription.deleted", plan = planForPrice(s.price);
    // An unknown seat price keeps the recorded plan.
    await ctx.db.patch(account._id, { ...(plan ? { plan } : {}), subscriptionId: s.id, subscriptionItemId: s.itemId, status: deleted ? "canceled" : s.status, seats: s.quantity, currentPeriodEnd: s.currentPeriodEnd, pastDueSince: s.status === "past_due" ? account.pastDueSince ?? a.created : undefined, subscriptionPaymentMethod: s.paymentMethod, lastEventCreated: a.created, updatedAt: Date.now() });
    if (!deleted) await recordPlanSelected(ctx, account.organizationId, s.status, plan ?? (account.plan === "pro" ? "pro" : "starter"));
    return record(deleted ? "canceled" : s.status);
  }
  // customer.updated: a card added or made default in the Customer Portal. Its own clock, so it never makes a subscription event stale.
  if (a.customer) {
    const account = await byCustomer(a.customer.id);
    if (!account) return record("unknown customer");
    if (account.customerEventCreated && a.created < account.customerEventCreated) return record("stale");
    await ctx.db.patch(account._id, { customerPaymentMethod: a.customer.paymentMethod, customerEventCreated: a.created, updatedAt: Date.now() });
    return record(a.customer.paymentMethod ? "payment method" : "no payment method");
  }
  if (a.invoice) {
    const account = await byCustomer(a.invoice.customer);
    if (!account || (a.invoice.subscription && account.subscriptionId && a.invoice.subscription !== account.subscriptionId)) return record("unknown customer");
    // Past due and recovery come from customer.subscription.updated, which carries the ordering guard above.
    // Referral commissions accrue in their own job, so a referral bug can never fail this webhook.
    if (a.type === "invoice.paid" && referralConfig().enabled && a.invoice.id && a.invoice.subscription) await ctx.scheduler.runAfter(0, internal.referrals.accrue, { ...a.invoice, paidAt: a.invoice.paidAt ?? a.created });
    // "subscribed" includes trials; the first invoice with money in it is the first real payment.
    if (a.type === "invoice.paid" && (a.invoice.amountPaid ?? 0) > 0) await recordConversion(ctx, "first_paid", account.organizationId, { organizationId: account.organizationId });
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
  for (const account of accounts) await ctx.db.patch(account._id, { customerId: undefined, subscriptionId: undefined, plan: undefined, legacy: undefined, subscriptionItemId: undefined, currentPeriodEnd: undefined, pastDueSince: undefined, lastEventCreated: undefined, subscriptionPaymentMethod: undefined, customerPaymentMethod: undefined, customerEventCreated: undefined, status: "trial", seats: seatCount(await members(ctx, account.organizationId)), updatedAt: Date.now() });
  return accounts.length;
} });

// Launching plans: subscriptions from before Pro existed keep every feature while they stay on Starter.
// Run once right after deploying plans, with
// `npx convex run billing:grandfatherSubscriptions '{"confirm":"grandfather-pre-plan-subscriptions"}' --prod`.
export const grandfatherSubscriptions = internalMutation({ args: { confirm: v.literal("grandfather-pre-plan-subscriptions") }, handler: async (ctx): Promise<number> => {
  const accounts = (await ctx.db.query("billingAccounts").collect()).filter((a) => openSubscription(a) && a.plan !== "pro" && !a.legacy);
  for (const account of accounts) await ctx.db.patch(account._id, { legacy: true, updatedAt: Date.now() });
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
