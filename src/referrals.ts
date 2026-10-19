import { billingConfig, int } from "./billing";
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
export const referralDisclosure = (login: string | null) => `${login ? `@${login}` : "The person who invited you"} will see your GitHub username (or “email sign-up”), when you sign up, and when your workspace is created and subscribes, not your workspace details.`;
