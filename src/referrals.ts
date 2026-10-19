import { StripeError, billingConfig, int } from "./billing";
// Referral program (cloud only). Off unless REFERRALS_ENABLED=true and billing is on, so self-hosted
// installs are unaffected. Every signed-in user gets a personal code; people who sign up through it
// are attributed to the referrer, and their first workspace is bound to the referral.
// Shared by the web app and Convex: no I/O here.
export type ReferralConfig = { enabled: boolean; payoutsEnabled: boolean; couponId: string | null; discountLabel: string | null; rateBps: number; months: number; holdDays: number };
export function referralConfig(env: Record<string, string | undefined> = process.env): ReferralConfig {
  const enabled = env.REFERRALS_ENABLED === "true" && billingConfig(env).enabled, coupon = env.STRIPE_REFERRAL_COUPON_ID, label = env.REFERRAL_DISCOUNT_LABEL?.trim();
  return { enabled, payoutsEnabled: enabled && env.REFERRAL_PAYOUTS_ENABLED === "true", couponId: coupon && /^[A-Za-z0-9_-]{1,200}$/.test(coupon) ? coupon : null, discountLabel: label ? label.slice(0, 200) : null, rateBps: int(env.REFERRAL_RATE_BPS, 2000, 1, 5000), months: int(env.REFERRAL_MONTHS, 12, 1, 60), holdDays: int(env.REFERRAL_HOLD_DAYS, 30, 0, 365) };
}
// Fixed program terms (cents): only the settings above are operator-tunable.
export const REFERRAL_CURRENCY = "usd", REFERRAL_MIN_CREDIT_CENTS = 1000, REFERRAL_MIN_PAYOUT_CENTS = 5000, REFERRAL_PAYOUT_REVIEW_CENTS = 50000, REFERRAL_CODE_WINDOW_DAYS = 30;
// shortcut: payouts go to US Connect accounts only; add a country list when expanding beyond the US.
export const REFERRAL_PAYOUT_COUNTRIES = ["US"];
/** A Stripe-hosted page to send the browser to (Connect onboarding, the Express dashboard), or null
 *  for anything that is not https on a stripe.com host. */
export function stripeHostedUrl(url: unknown): string | null {
  try { const u = new URL(String(url)); return u.protocol === "https:" && !u.port && !u.username && !u.password && (u.hostname === "stripe.com" || u.hostname.endsWith(".stripe.com")) ? u.href : null; } catch { return null; }
}

// Codes: 8 symbols from an alphabet without 0/O, 1/I/L or U, so they survive being read aloud or
// retyped. 30 symbols and rejection of bytes ≥ 240 (8 × 30) keep every symbol equally likely.
export const referralCodeAlphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const REFERRAL_CODE_LENGTH = 8;
const codePattern = /^[2-9A-HJKMNP-TV-Z]{8}$/;
export function generateReferralCode(bytes: Uint8Array): string {
  let code = "";
  for (const b of bytes) { if (b >= 240) continue; code += referralCodeAlphabet[b % referralCodeAlphabet.length]; if (code.length === REFERRAL_CODE_LENGTH) return code; }
  throw new Error("Not enough random bytes for a referral code");
}
/** A typed or linked code in canonical form ("abcd-2345 " → "ABCD2345"), or null when it cannot be one. */
export function normalizeReferralCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 64) return null;
  const code = input.trim().toUpperCase().replace(/[\s-]/g, "");
  return codePattern.test(code) ? code : null;
}

/** The invitation line on the referral page and the sign-in screens. */
export const referralInvite = (login: string | null, discount: string | null) => `${login ? `@${login} invited you` : "You were invited"} to OpenReview${discount ? `, and your workspace gets ${discount}` : ""}.`;
/** What a referrer learns about the people who use their link, shown before anyone signs up. */
export const referralDisclosure = (login: string | null) => `${login ? `@${login}` : "The person who invited you"} will see your GitHub username (or “email sign-up”), when you sign up, when your workspace is created and subscribes, and what they earn from its payments, but no other workspace details.`;

// Commission math (cents). The base is the cash Stripe collected for an invoice, excluding tax pro
// rata: credits and overpayments reduce it, and it never exceeds the invoice's pre-tax total.
export function commissionBase({ amountPaid, amountOverpaid, total, totalExcludingTax }: { amountPaid: number; amountOverpaid?: number; total: number; totalExcludingTax?: number | null }) {
  const cash = Math.max(0, amountPaid - (amountOverpaid ?? 0)), excl = totalExcludingTax ?? total;
  return total > 0 && cash > 0 ? Math.min(excl, Math.floor(cash * excl / total)) : 0;
}
export const commissionAmount = (base: number, rateBps: number) => Math.floor(base * rateBps / 10000);
/** The same time `months` later in UTC, clamped to the last day of a shorter month (31 Jan + 1 → 28 Feb). */
export function addMonthsUTC(ms: number, months: number) {
  const from = new Date(ms), to = new Date(ms);
  to.setUTCDate(1); to.setUTCMonth(from.getUTCMonth() + months);
  to.setUTCDate(Math.min(from.getUTCDate(), new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() + 1, 0)).getUTCDate()));
  return to.getTime();
}
/** Coupon duration_in_months that discounts at least `paidMonths` monthly invoices. The coupon clock
 *  starts with the subscription, so a carried trial uses up coupon time (months counted as 28 days). */
export const couponMonthsNeeded = (paidMonths: number, trialDays: number) => paidMonths - 1 + Math.ceil((trialDays + 1) / 28);
export const formatMoney = (cents: number, currency = REFERRAL_CURRENCY) => new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
/** The billing "Referral" fact: who invited the workspace and whether the discount applies at Checkout. */
export const referralFact = (r: { invitedBy: string | null; discount: boolean }, discountLabel: string | null) => `Invited by ${r.invitedBy ? `@${r.invitedBy}` : "another OpenReview user"}${r.discount ? ` · ${discountLabel ?? "the referral discount"} applies at checkout` : ""}`;
/** Sent once, when a referred workspace first pays. `name` is a GitHub username or null (never an email's local part). */
export function conversionEmail(p: { name: string | null; rateBps: number; months: number; holdDays: number; url: string }) {
  const who = p.name ? `@${p.name}` : "Someone you referred";
  return { subject: `${who} subscribed to OpenReview`, text: `${who} just subscribed to OpenReview through your referral.\n\nYou earn ${p.rateBps / 100}% of what their workspace pays, excluding tax, for ${p.months} months from its first payment. Each commission becomes available ${p.holdDays} days after the payment.\n\nSee your referrals: ${p.url}` };
}

// Clawback and redemption (Phase 3). A commission is reversed in proportion to the cash its invoice
// lost: refunds, and disputes that are open or lost. Won, warning_closed and prevented disputes keep it.
export type ChargeFacts = { id: string; amount: number; refunded: number; dispute?: { id: string; status: string; amount: number }; fetchedAt: number };
const disputeKept = new Set(["won", "warning_closed", "prevented"]);
export function reversalTarget(amount: number, charges: Pick<ChargeFacts, "amount" | "refunded" | "dispute">[]) {
  const paid = charges.reduce((sum, c) => sum + c.amount, 0);
  const lost = charges.reduce((sum, c) => sum + Math.min(c.amount, c.refunded + (c.dispute && !disputeKept.has(c.dispute.status) ? c.dispute.amount : 0)), 0);
  return paid > 0 ? amount - Math.floor(amount * (paid - lost) / paid) : 0;
}
type Commission = { currency: string; amount: number; reversed: number; status: string; availableAt: number };
type Redemption = { currency: string; amount: number; status: string };
// shortcut: no Stripe re-verification (verifyDue) before a commission is released; the hold alone gates it.
export const commissionAvailable =(c: Commission, now: number) => c.status === "accrued" && c.availableAt <= now;
/** Per currency: available = released commissions (net of clawbacks) minus redemptions that are not
 *  failed. A clawback after a redemption makes it negative; later commissions pay that back first. */
export function referralBalances(commissions: Commission[], redemptions: Redemption[], now: number) {
  const out: Record<string, { available: number; onHold: number; redeemed: number }> = {}, of = (currency: string) => out[currency] ??= { available: 0, onHold: 0, redeemed: 0 };
  for (const c of commissions) if (c.status === "accrued") { const b = of(c.currency); if (commissionAvailable(c, now)) b.available += c.amount - c.reversed; else b.onHold += c.amount - c.reversed; }
  for (const r of redemptions) if (r.status !== "failed") { const b = of(r.currency); b.redeemed += r.amount; b.available -= r.amount; }
  return out;
}
/** "25", "$25.50" or "1,000" → cents; null for anything else. */
export function parseMoneyInput(input: unknown): number | null {
  const m = typeof input === "string" ? /^\$?(\d{1,7})(?:\.(\d{1,2}))?$/.exec(input.trim().replace(/,/g, "")) : null;
  return m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0")) : null;
}
/** How a failed Stripe write is retried. transient: retry with the same idempotency key (no answer,
 *  429, 409 key-in-use or lock, offline, config). indeterminate (5xx): the object may exist, so never
 *  post again, only look it up. definite (other 4xx): nothing was created. */
export function classifyStripeFailure(error: unknown): "transient" | "indeterminate" | "definite" {
  if (!(error instanceof StripeError) || error.status === 0 || error.status === 429 || error.status === 409) return "transient";
  return error.status >= 500 ? "indeterminate" : "definite";
}
