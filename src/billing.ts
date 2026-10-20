import { assertEgress } from "./egress";
import type { Plan } from "./plans";
// Cloud billing (Stripe). Disabled unless BILLING_ENABLED=true, which is the self-host default.
// Plans (src/plans.ts): Free has a small monthly usage allowance per workspace and never expires;
// Starter and Pro are per-seat subscriptions that include model usage each month, metered in micro-dollars
// of inference cost (pricier models use it faster). Past it, an admin-set monthly cap allows extra usage,
// reported to Stripe as meter events. Paid plans start with a trial at Checkout (trialDays).
export type BillingConfig = { enabled: boolean; trialDays: number; freeUsageMicros: number; usagePerSeatMicros: number; proUsagePerSeatMicros: number; graceDays: number };
export const int = (value: string | undefined, fallback: number, min: number, max: number) => { const n = Number(value); return Number.isInteger(n) && n >= min && n <= max ? n : fallback; };
const usd = (value: string | undefined, fallback: number) => { const n = Number(value); return Math.round((value?.trim() && Number.isFinite(n) && n >= 0 && n <= 100_000 ? n : fallback) * 1e6); };
export function billingConfig(env: Record<string, string | undefined> = process.env): BillingConfig {
  // BILLING_TRIAL_USAGE_USD is the older name of the free allowance.
  return { enabled: env.BILLING_ENABLED === "true", trialDays: int(env.BILLING_TRIAL_DAYS, 14, 0, 365), freeUsageMicros: usd(env.BILLING_FREE_USAGE_USD?.trim() ? env.BILLING_FREE_USAGE_USD : env.BILLING_TRIAL_USAGE_USD, 3), usagePerSeatMicros: usd(env.BILLING_USAGE_PER_SEAT_USD, 6), proUsagePerSeatMicros: usd(env.BILLING_PRO_USAGE_PER_SEAT_USD, 12), graceDays: int(env.BILLING_GRACE_DAYS, 7, 0, 60) };
}
// Billed seats: owners, admins and members; viewers are free.
export const seatCount = (members: { role: string }[]) => members.filter((m) => m.role !== "viewer").length;
export const periodKey = (now: number) => new Date(now).toISOString().slice(0, 7);
/** When the current usage period (UTC calendar month) resets. */
export const nextPeriodStart = (now: number) => { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };
export const usdText = (micros: number) => `$${(micros / 1e6).toFixed(2)}`;
const resetText = (now: number) => new Date(nextPeriodStart(now)).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

export type BillingAccount = { status: string; seats: number; trialEndsAt: number; pastDueSince?: number; subscriptionId?: string; spendCapUsd?: number; plan?: string };
// limit, used and capMicros are micro-dollars; overage is true when this request runs past the included usage.
export type BillingDecision = { allowed: boolean; plan: "disabled" | Plan; limit: number | null; used: number; capMicros: number; overage: boolean; reason?: string };
const paying = new Set(["active", "trialing", "past_due"]);
/** used includes in-flight reservations; request is the next call's reservation (0 for the pre-check at enqueue). */
export function billingDecision(account: BillingAccount, used: number, now: number, config: BillingConfig, request = 0): BillingDecision {
  if (!config.enabled) return { allowed: true, plan: "disabled", limit: null, used, capMicros: 0, overage: false };
  const over = (room: number) => (request ? used + request > room : used >= room);
  if (account.subscriptionId && paying.has(account.status)) {
    // A subscription without a recorded plan predates Pro, so it is Starter.
    const plan = account.plan === "pro" ? "pro" as const : "starter" as const;
    const limit = Math.max(1, account.seats) * (plan === "pro" ? config.proUsagePerSeatMicros : config.usagePerSeatMicros), capMicros = Math.round((account.spendCapUsd ?? 0) * 1e6), base = { plan, limit, used, capMicros };
    if (account.status === "past_due" && (account.pastDueSince ?? now) + config.graceDays * 86400000 <= now) return { ...base, allowed: false, overage: false, reason: "Payment is past due and the grace period has ended. Update the payment method in Settings → Billing." };
    if (!over(limit)) return { ...base, allowed: true, overage: false };
    if (capMicros && !over(limit + capMicros)) return { ...base, allowed: true, overage: true };
    return { ...base, allowed: false, overage: false, reason: capMicros
      ? `This workspace reached its extra usage cap of ${usdText(capMicros)} this month. Usage resets on ${resetText(now)}; a workspace admin can raise the cap in Settings → Billing.`
      : `This workspace used its included usage for this month. Usage resets on ${resetText(now)}; a workspace admin can turn on extra usage in Settings → Billing.` };
  }
  // Free: no subscription (or a lapsed one). The allowance resets each month and has no extra usage.
  const base = { plan: "free" as const, limit: config.freeUsageMicros, used, capMicros: 0, overage: false };
  if (over(config.freeUsageMicros)) return { ...base, allowed: false, reason: `This workspace used the Free plan's ${usdText(config.freeUsageMicros)} of usage for this month. Usage resets on ${resetText(now)}; a workspace admin can upgrade in Settings → Billing.` };
  return { ...base, allowed: true };
}

/** A linked Stripe subscription that has not ended yet, so Stripe can still charge for it. */
export const openSubscription = (account: { subscriptionId?: string; status: string } | null | undefined) => Boolean(account?.subscriptionId) && !["canceled", "incomplete_expired"].includes(account!.status);
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
