import { assertEgress } from "./egress";
import type { Plan } from "./plans";
// Cloud billing (Stripe). Disabled unless BILLING_ENABLED=true, which is the self-host default.
// Plans (src/plans.ts): Free has a small monthly usage allowance per workspace and never expires, but only
// workspaces from before paid-only signups keep it (keepsFree); Starter and Pro are per-seat subscriptions that
// include model usage each month, metered in micro-dollars of inference cost (pricier models use it faster).
// Past it, an admin-set monthly cap allows extra usage, reported to Stripe as meter events. New workspaces start a
// 14-day Starter trial with no card (trialStartedAt); Checkout collects a card to keep reviews after it ends.

export type BillingConfig = { enabled: boolean; trialDays: number; freeUsageMicros: number; usagePerSeatMicros: number; proUsagePerSeatMicros: number; graceDays: number; starterFixesPerSeat: number; proFixesPerSeat: number; enterpriseMinContributors: number; enterpriseUsagePerContributorMicros: number; enterpriseNetDays: number; enterpriseGraceDays: number };
export const int = (value: string | undefined, fallback: number, min: number, max: number) => { const n = Number(value); return Number.isInteger(n) && n >= min && n <= max ? n : fallback; };
const usd = (value: string | undefined, fallback: number) => { const n = Number(value); return Math.round((value?.trim() && Number.isFinite(n) && n >= 0 && n <= 100_000 ? n : fallback) * 1e6); };
export function billingConfig(env: Record<string, string | undefined> = process.env): BillingConfig {
  return { enabled: env.BILLING_ENABLED === "true", trialDays: int(env.BILLING_TRIAL_DAYS, 14, 0, 365), freeUsageMicros: usd(env.BILLING_FREE_USAGE_USD, 3), usagePerSeatMicros: usd(env.BILLING_USAGE_PER_SEAT_USD, 6), proUsagePerSeatMicros: usd(env.BILLING_PRO_USAGE_PER_SEAT_USD, 12), graceDays: int(env.BILLING_GRACE_DAYS, 7, 0, 60), starterFixesPerSeat: int(env.BILLING_STARTER_FIXES_PER_SEAT, 5, 0, 10_000), proFixesPerSeat: int(env.BILLING_PRO_FIXES_PER_SEAT, 20, 0, 10_000),
    // Enterprise contract defaults; each contract row can override them (billingAccounts.contract).
    enterpriseMinContributors: int(env.BILLING_ENTERPRISE_MIN_CONTRIBUTORS, 25, 1, 100_000), enterpriseUsagePerContributorMicros: usd(env.BILLING_ENTERPRISE_USAGE_PER_CONTRIBUTOR_USD, 12), enterpriseNetDays: int(env.BILLING_ENTERPRISE_NET_DAYS, 30, 0, 365), enterpriseGraceDays: int(env.BILLING_ENTERPRISE_GRACE_DAYS, 30, 0, 365) };
}
/** The plan step and dashboard gate: BILLING_ENABLED (PR #167) plus a Stripe secret. Self-hosted installs omit both. */
export const billsWorkspaces = (env: Record<string, string | undefined> = process.env) => billingConfig(env).enabled && Boolean(env.STRIPE_SECRET_KEY);
// Billed seats: owners, admins and members; viewers are free.
export const seatCount = (members: { role: string }[]) => members.filter((m) => m.role !== "viewer").length;
export const periodKey = (now: number) => new Date(now).toISOString().slice(0, 7);
/** When the current usage period (UTC calendar month) resets. */
export const nextPeriodStart = (now: number) => { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };
export const usdText = (micros: number) => `$${(micros / 1e6).toFixed(2)}`;
export const resetText = (now: number) => new Date(nextPeriodStart(now)).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

/** An Enterprise contract's negotiated terms, set by an operator. Money is per contract, never hardcoded. */
export type BillingContract = {
  id: string; mode: "managed" | "ownKey"; startsAt: number; endsAt: number;
  committedContributors: number; minimumContributors: number;
  contributorPriceCents: number; includedUsagePerContributorUsd: number; overageMultiplier: number;
  netDays: number; graceDays: number; nonBillableAuthors: string[];
  stripe?: { productId?: string; commitPriceId?: string; contributorPriceId?: string; usagePriceId?: string; scheduleId?: string };
  notes?: string; remindersSent?: number[];
  supportTier?: string; retention?: { minDays?: number; maxDays?: number; auditDays?: number };
};
/** The bounds a workspace's review and transcript retention settings must stay in: 7 to 3,650 days unless its
 *  Enterprise contract says otherwise. With a contract maximum, "unlimited" is not allowed. */
export const retentionBounds = (contract?: Pick<BillingContract, "retention"> | null) => ({ min: contract?.retention?.minDays ?? 7, max: contract?.retention?.maxDays ?? 3650, unlimited: contract?.retention?.maxDays === undefined });
/** What an operator enters for a contract (convex/enterprise.ts); the rest of BillingContract is derived. */
export type ContractTerms = Pick<BillingContract, "mode" | "startsAt" | "committedContributors" | "contributorPriceCents" | "includedUsagePerContributorUsd" | "overageMultiplier" | "netDays" | "graceDays" | "nonBillableAuthors" | "notes" | "supportTier" | "retention"> & { usagePriceId?: string };
const whole = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;
/** Why contract terms are refused, or null when they can be saved. */
export function contractTermsError(t: ContractTerms, config: BillingConfig): string | null {
  const start = new Date(t.startsAt);
  if (!Number.isFinite(t.startsAt) || start.getUTCDate() !== 1 || t.startsAt % 86400000 !== 0) return "A contract starts on the first of a month (UTC)";
  if (!whole(t.committedContributors, config.enterpriseMinContributors, 100_000)) return `Committed contributors must be at least ${config.enterpriseMinContributors}`;
  if (!whole(t.contributorPriceCents, 1, 1_000_000)) return "Enter a monthly price per contributor between $0.01 and $10,000";
  if (!(t.includedUsagePerContributorUsd >= 0 && t.includedUsagePerContributorUsd <= 1000)) return "Included usage per contributor must be between $0 and $1,000";
  if (!(t.overageMultiplier >= 1 && t.overageMultiplier <= 5)) return "The overage multiplier must be between 1 and 5";
  if (!whole(t.netDays, 0, 365) || !whole(t.graceDays, 0, 365)) return "Net days and grace days must be whole numbers from 0 to 365";
  if (t.usagePriceId !== undefined && !/^price_[A-Za-z0-9]{1,250}$/.test(t.usagePriceId)) return "The custom overage price must be a Stripe price ID (price_…)";
  if (t.nonBillableAuthors.length > 100 || t.nonBillableAuthors.some((a) => !a.trim() || a.length > 100)) return "List at most 100 non-billable authors, each up to 100 characters";
  if ((t.notes?.length ?? 0) > 2000) return "Notes are limited to 2,000 characters";
  if ((t.supportTier?.length ?? 0) > 60) return "The support tier is limited to 60 characters";
  const r = t.retention, days = [r?.minDays, r?.maxDays, r?.auditDays].filter((n): n is number => n !== undefined);
  if (days.some((n) => !whole(n, 1, 3650)) || (r?.minDays !== undefined && r.maxDays !== undefined && r.minDays > r.maxDays)) return "Retention terms are whole days from 1 to 3,650, with the minimum no higher than the maximum";
  return null;
}
/** When a contract starting at `startsAt` ends: the same day a year later. */
export const contractEnd = (startsAt: number) => { const d = new Date(startsAt); return Date.UTC(d.getUTCFullYear() + 1, d.getUTCMonth(), 1); };
/** What the customer is invoiced before tax: the year's commitment up front, then contributors above it each month
 *  (and, on Managed, model usage past the included amount at cost times the multiplier). */
export const contractPreview = (t: Pick<ContractTerms, "mode" | "committedContributors" | "contributorPriceCents" | "includedUsagePerContributorUsd">) => ({
  firstInvoiceCents: t.committedContributors * t.contributorPriceCents * 12, perExtraContributorCents: t.contributorPriceCents,
  includedUsageUsd: t.mode === "ownKey" ? 0 : t.committedContributors * t.includedUsagePerContributorUsd });
export type BillingAccount = { status: string; seats: number; trialEndsAt: number; trialStartedAt?: number; pastDueSince?: number; subscriptionId?: string; spendCapUsd?: number; plan?: string; contract?: BillingContract; contractGroupId?: string };
// limit, used and capMicros are micro-dollars; overage is true when this request runs past the included usage.
// units is the billed contributors of an Enterprise contract (the higher of committed and active); absent on seat plans.
export type BillingDecision = { allowed: boolean; plan: "disabled" | Plan; limit: number | null; used: number; capMicros: number; overage: boolean; reason?: string; units?: number };
export const ownKeyOnlyReason = "This workspace's contract uses its own model key. Save one in Organization Settings → Model.";
const paying = new Set(["active", "trialing", "past_due"]);
/** Free is only for workspaces created before plans were required or that started on Free; every newer one pays per seat. */
export const keepsFree = (organization: { planRequired?: boolean; plan?: string } | null | undefined) => !organization?.planRequired || organization.plan === "free";
export const paidPlanReason = "This workspace has no paid plan. A workspace admin can choose Starter or Pro in Organization Settings → Billing & Usage.";
export const trialEndedReason = "This workspace's trial ended. Add a payment method in Organization Settings → Billing & Usage to resume reviews.";
export const trialUsedReason = "This workspace already used its trial. Add a payment method in Organization Settings → Billing & Usage.";
export const freeTakenReason = (workspace: string) => `Free is one workspace per owner, and an owner of this workspace already has "${workspace}" on Free. A workspace admin can choose Starter or Pro in Organization Settings → Billing & Usage, or use "${workspace}" for free reviews.`;
/** used includes in-flight reservations; request is the next call's reservation (0 for the pre-check at enqueue).
 * blocked is why this workspace gets no Free allowance (convex/billing.ts): it does not keep Free, or its owner's Free workspace is another one.
 * activeContributors is this month's billable count (convex/contributors.ts); only an Enterprise contract uses it. */
export function billingDecision(account: BillingAccount, used: number, now: number, config: BillingConfig, request = 0, blocked?: string, activeContributors = 0): BillingDecision {
  if (!config.enabled) return { allowed: true, plan: "disabled", limit: null, used, capMicros: 0, overage: false };
  const over = (room: number) => (request ? used + request > room : used >= room);
  if (account.subscriptionId && paying.has(account.status)) {
    // A subscription without a recorded plan predates Pro, so it is Starter.
    // Enterprise needs its contract; a row without one bills as Starter rather than as unlimited.
    const contract = account.plan === "enterprise" ? account.contract : undefined;
    const plan = contract ? "enterprise" as const : account.plan === "pro" ? "pro" as const : "starter" as const;
    const units = contract ? Math.max(contract.committedContributors, activeContributors) : undefined, graceDays = contract ? contract.graceDays : config.graceDays;
    // Stripe does not bill metered usage recorded during a trial, so extra usage starts with the paid period.
    const trialing = account.status === "trialing";
    const ownKey = contract?.mode === "ownKey";
    const limit = contract ? (ownKey ? 0 : Math.round(units! * contract.includedUsagePerContributorUsd * 1e6)) : Math.max(1, account.seats) * (plan === "pro" ? config.proUsagePerSeatMicros : config.usagePerSeatMicros);
    const capMicros = trialing || ownKey ? 0 : Math.round((account.spendCapUsd ?? 0) * 1e6), base = { plan, limit, used, capMicros, ...(units === undefined ? {} : { units }) };
    if (account.status === "past_due" && (account.pastDueSince ?? now) + graceDays * 86400000 <= now) return { ...base, allowed: false, overage: false, reason: "Payment is past due and the grace period has ended. Update the payment method in Organization Settings → Billing & Usage." };
    // An own-key contract meters nothing: its reviews run on the saved key, and a call that would fall back to the operator's model is refused.
    if (ownKey) return request ? { ...base, allowed: false, overage: false, reason: ownKeyOnlyReason } : { ...base, allowed: true, overage: false };
    if (!over(limit)) return { ...base, allowed: true, overage: false };
    if (capMicros && !over(limit + capMicros)) return { ...base, allowed: true, overage: true };
    return { ...base, allowed: false, overage: false, reason: capMicros
      ? `This workspace reached its extra usage cap of ${usdText(capMicros)} this month. Usage resets on ${resetText(now)}; a workspace admin can raise the cap in Organization Settings → Billing & Usage.`
      : trialing ? `This workspace used its included usage for this month. Usage resets on ${resetText(now)}; extra usage can start once the trial ends.`
      : `This workspace used its included usage for this month. Usage resets on ${resetText(now)}; a workspace admin can turn on extra usage in Organization Settings → Billing & Usage.` };
  }
  // No-card Starter trial: trialStartedAt is set once on the server (startTrial). Reviews run as Starter until
  // trialEndsAt; after that they pause until a live subscription exists. Paid and Enterprise rows never reach here.
  if (account.trialStartedAt) {
    const plan = account.plan === "pro" ? "pro" as const : "starter" as const;
    const limit = Math.max(1, account.seats) * (plan === "pro" ? config.proUsagePerSeatMicros : config.usagePerSeatMicros);
    const base = { plan, limit, used, capMicros: 0, overage: false as const };
    if (now < account.trialEndsAt) {
      if (!over(limit)) return { ...base, allowed: true };
      return { ...base, allowed: false, reason: `This workspace used its included usage for this month. Usage resets on ${resetText(now)}; extra usage can start once the trial ends.` };
    }
    return { ...base, allowed: false, reason: trialEndedReason };
  }
  // Free: no subscription (or a lapsed one). The allowance resets each month and has no extra usage.
  const base = { plan: "free" as const, limit: config.freeUsageMicros, used, capMicros: 0, overage: false };
  if (blocked) return { ...base, limit: 0, allowed: false, reason: blocked };
  if (over(config.freeUsageMicros)) return { ...base, allowed: false, reason: `This workspace used the Free plan's ${usdText(config.freeUsageMicros)} of usage for this month. Usage resets on ${resetText(now)}; a workspace admin can upgrade in Organization Settings → Billing & Usage.` };
  return { ...base, allowed: true };
}

/** About how many more reviews the included usage covers: the workspace's own average over its recent reviews (at least
 * five, from per-call usage rows), else $0.065, a typical standard review. null when there is no limit. */
export function reviewsLeft(limitMicros: number | null, usedMicros: number, calls: { reviewId?: string; estimatedCost: number }[]) {
  if (limitMicros === null) return null;
  const reviews = new Set(calls.flatMap((c) => c.reviewId ? [c.reviewId] : [])).size;
  const average = reviews >= 5 ? calls.reduce((sum, c) => sum + c.estimatedCost, 0) / reviews * 1e6 : 65_000;
  return Math.max(0, Math.floor((limitMicros - usedMicros) / Math.max(1, average)));
}
/** Hosted agent fix runs a workspace gets each month, pooled across seats; null is unlimited (billing off). */
export function fixRunLimit(decision: BillingDecision, seats: number, config: BillingConfig): number | null {
  if (decision.plan === "disabled") return null;
  if (decision.plan === "free") return 0;
  return Math.max(1, decision.units ?? seats) * (decision.plan === "starter" ? config.starterFixesPerSeat : config.proFixesPerSeat);
}

/** The Stripe meter event for an Enterprise month's contributors above the commitment (zero is still reported, so the
 *  invoice line shows 0). The identifier is fixed per workspace and month, so a retry is never billed twice, and the
 *  timestamp is the month's last second, so Stripe counts it in the month it closes. */
export function contributorMeterEvent(organizationId: string, period: string, active: number, committed: number) {
  return { identifier: `contributors:${organizationId}:${period}`, timestamp: nextPeriodStart(Date.parse(`${period}-01T00:00:00Z`)) / 1000 - 1, value: Math.max(0, active - committed) };
}

/** The 80% / 100% usage alert email; `used` is settled usage and `now` falls in the alert's period. */
export function usageAlertEmail(workspace: string, threshold: number, d: BillingDecision, overageMicros: number, now: number, billingUrl?: string) {
  const reset = resetText(now), pause = threshold >= 100 ? `are paused until ${reset}` : "pause when it runs out";
  const next = d.plan === "free" ? `Reviews ${pause}. A workspace admin can upgrade to Starter or Pro in Organization Settings → Billing & Usage for more usage.`
    : d.capMicros ? `Extra usage is on: ${usdText(Math.max(0, d.capMicros - overageMicros))} of the ${usdText(d.capMicros)} monthly cap is left. A workspace admin can change the cap in Organization Settings → Billing & Usage.`
    : `Extra usage is off, so reviews ${pause}. A workspace admin can turn on extra usage in Organization Settings → Billing & Usage.`;
  return {
    subject: `${workspace} used ${threshold >= 100 ? "all" : `${threshold}%`} of this month's included OpenReview usage`,
    text: `${workspace} has used ${usdText(d.used)} of its ${usdText(d.limit ?? 0)} of included model usage this month. Usage resets on ${reset}.\n\n${next}${billingUrl ? `\n\n${billingUrl}` : ""}`,
  };
}

/** A linked Stripe subscription that has not ended yet, so Stripe can still charge for it. */
export const openSubscription = (account: { subscriptionId?: string; status: string } | null | undefined) => Boolean(account?.subscriptionId) && !["canceled", "incomplete_expired"].includes(account!.status);
/** A subscription in good standing: Checkout refuses a second one, and the webhook keeps it over another. */
export const liveSubscription = (account: { subscriptionId?: string | null; status: string }) => Boolean(account.subscriptionId) && ["active", "trialing", "past_due"].includes(account.status);
/** When a trial that has not started yet would end if it started now. */
export const trialEndsFrom = (now: number, config: BillingConfig) => now + config.trialDays * 86400000;
/** Checkout carries the remaining app trial into the subscription; Stripe needs it 48+ hours out. */
export function checkoutTrialEnd(trialEndsAt: number, now: number): number | undefined {
  return trialEndsAt - now >= 49 * 3600000 ? Math.floor(trialEndsAt / 1000) : undefined;
}

// Stripe webhook signatures: "t=<unix>,v1=<hex>[,v1=...]" over `${t}.${payload}` (HMAC-SHA256).
const encoder = new TextEncoder();
export async function verifyStripeSignature(payload: string, header: string | null, secret: string | undefined, now = Date.now(), toleranceSeconds = 300) {
  if (!secret || !header || header.length > 2000) return false;
  const parts = header.split(",").map((p) => p.split("=", 2) as [string, string]);
  const t = parts.find(([k]) => k === "t")?.[1];
  const signatures = parts.filter(([k, v]) => k === "v1" && /^[a-f0-9]{64}$/.test(v ?? "")).map(([, v]) => v);
  if (!t || !/^\d{1,12}$/.test(t) || !signatures.length || Math.abs(now / 1000 - Number(t)) > toleranceSeconds) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${t}.${payload}`)));
  return signatures.some((signature) => { const provided = signature.match(/../g)!.map((b) => parseInt(b, 16)); let d = 0; for (let i = 0; i < mac.length; i++) d |= mac[i] ^ provided[i]; return d === 0; });
}

// Minimal Stripe REST client (form-encoded), pinned to one API version; webhook endpoints should
// use the same version. Prefer a restricted key (rk_…). Live keys need BILLING_ALLOW_LIVE=true.
// Upgrading to 2026-09-30.endive or later: v2 account links no longer take `configurations`, so drop
// them from the use_case in convex/referralJobs.ts (startPayoutSetup) in the same change.
export const STRIPE_API_VERSION = "2026-08-26.dahlia";
export function stripeKey(env: Record<string, string | undefined> = process.env) {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Configure STRIPE_SECRET_KEY");
  if (!/^[rs]k_test_/.test(key) && !(/^[rs]k_live_/.test(key) && env.BILLING_ALLOW_LIVE === "true")) throw new Error("Use a Stripe test-mode key (rk_test_… or sk_test_…), or set BILLING_ALLOW_LIVE=true for live mode");
  return key;
}
export function formEncode(params: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(params).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) return [];
    if (Array.isArray(v)) return v.flatMap((item, i) => typeof item === "object" ? formEncode(item as Record<string, unknown>, `${key}[${i}]`) : [`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`]);
    if (typeof v === "object") return formEncode(v as Record<string, unknown>, key);
    return [`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`];
  });
}
/** A Stripe API error: the HTTP status (0 when the request never got an answer) and Stripe's error
 *  type, code and param, never the response body. shouldRetry is Stripe's Stripe-Should-Retry header. */
export class StripeError extends Error {
  constructor(readonly status: number, readonly type?: string, readonly code?: string, readonly param?: string, readonly shouldRetry?: boolean) { super(`Stripe request failed (${status}${type ? ` ${type}` : ""}${code ? ` ${code}` : ""})`); this.name = "StripeError"; }
}
const v1Path = /^\/v1\/[a-z_/]+[a-zA-Z0-9_/]*$/, v2Path = /^\/v2\/core\/(accounts|account_links)(\/acct_[A-Za-z0-9]{1,64})?$/;
async function request<T>(method: "GET" | "POST", path: string, allowed: RegExp, query: Record<string, unknown>, body: { type: string; text: string } | undefined, key: string, fetchImpl: typeof fetch, idempotencyKey?: string): Promise<T> {
  assertEgress("billing", "Stripe billing");
  if (!allowed.test(path)) throw new Error("Invalid Stripe API path");
  const search = formEncode(query).join("&");
  let response: Response;
  try { response = await fetchImpl("https://api.stripe.com" + path + (search ? `?${search}` : ""), { method, redirect: "error", headers: { authorization: `Bearer ${key}`, "stripe-version": STRIPE_API_VERSION, ...(body ? { "content-type": body.type } : {}), ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) }, ...(body ? { body: body.text } : {}), signal: AbortSignal.timeout(20000) }); }
  catch { throw new StripeError(0); } // network failure or timeout: the request may or may not have reached Stripe
  // v1 and v2 errors share the {error:{type,code,param}} shape.
  const data = (await response.json().catch(() => null)) as T & { error?: { type?: string; code?: string; param?: string } } | null, retry = response.headers.get("stripe-should-retry");
  if (!response.ok || !data) throw new StripeError(response.status, data?.error?.type, data?.error?.code, data?.error?.param, retry === null ? undefined : retry === "true");
  return data;
}
export const stripe = <T>(path: string, params: Record<string, unknown>, key: string, fetchImpl: typeof fetch = fetch, idempotencyKey?: string) => request<T>("POST", path, v1Path, {}, { type: "application/x-www-form-urlencoded", text: formEncode(params).join("&") }, key, fetchImpl, idempotencyKey);
/** A Stripe GET: `query` is form-encoded into the URL (nested keys like created[gte] work). */
export const stripeGet = <T>(path: string, query: Record<string, unknown>, key: string, fetchImpl: typeof fetch = fetch) => request<T>("GET", path, v1Path, query, undefined, key, fetchImpl);
/** A Stripe v2 request (Connect accounts and account links only): a JSON body, and a query whose
 *  arrays are indexed (include[0]=…), as v2 requires. */
export const stripeV2 = <T>(method: "GET" | "POST", path: string, key: string, { body, query = {}, idempotencyKey }: { body?: Record<string, unknown>; query?: Record<string, unknown>; idempotencyKey?: string } = {}, fetchImpl: typeof fetch = fetch) => request<T>(method, path, v2Path, query, body ? { type: "application/json", text: JSON.stringify(body) } : undefined, key, fetchImpl, idempotencyKey);
