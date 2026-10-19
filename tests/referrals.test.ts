import test from "node:test";
import assert from "node:assert/strict";
import { StripeError } from "../src/billing";
import { OfflineError } from "../src/egress";
import { REFERRAL_CODE_LENGTH, REFERRAL_CODE_WINDOW_DAYS, REFERRAL_CURRENCY, REFERRAL_MIN_CREDIT_CENTS, REFERRAL_MIN_PAYOUT_CENTS, REFERRAL_PAYOUT_COUNTRIES, REFERRAL_PAYOUT_REVIEW_CENTS, addMonthsUTC, classifyStripeFailure, commissionAmount, commissionAvailable, commissionBase, conversionEmail, couponMonthsNeeded, formatMoney, generateReferralCode, normalizeReferralCode, parseMoneyInput, referralBalances, referralCodeAlphabet, referralConfig, referralDisclosure, referralFact, reversalTarget, stripeHostedUrl } from "../src/referrals";

const on = { BILLING_ENABLED: "true", REFERRALS_ENABLED: "true" };
test("referrals are off unless both REFERRALS_ENABLED and billing are on; defaults and clamping", () => {
  assert.deepEqual(referralConfig({}), { enabled: false, payoutsEnabled: false, couponId: null, discountLabel: null, rateBps: 2000, months: 12, holdDays: 30 });
  assert.equal(referralConfig({ REFERRALS_ENABLED: "true" }).enabled, false, "self-hosted installs without billing stay off");
  assert.equal(referralConfig({ BILLING_ENABLED: "true" }).enabled, false);
  assert.equal(referralConfig(on).enabled, true);
  assert.equal(referralConfig({ ...on, REFERRAL_PAYOUTS_ENABLED: "true" }).payoutsEnabled, true);
  assert.equal(referralConfig({ REFERRAL_PAYOUTS_ENABLED: "true" }).payoutsEnabled, false, "payouts need the program on");
  assert.deepEqual(referralConfig({ ...on, REFERRAL_RATE_BPS: "1500", REFERRAL_MONTHS: "6", REFERRAL_HOLD_DAYS: "0" }), { ...referralConfig(on), rateBps: 1500, months: 6, holdDays: 0 });
  for (const [key, value] of [["REFERRAL_RATE_BPS", "5001"], ["REFERRAL_RATE_BPS", "0"], ["REFERRAL_RATE_BPS", "12.5"], ["REFERRAL_MONTHS", "61"], ["REFERRAL_HOLD_DAYS", "-1"], ["REFERRAL_HOLD_DAYS", "abc"]])
    assert.deepEqual(referralConfig({ ...on, [key]: value }), referralConfig(on), `${key}=${value} falls back to the default`);
  assert.equal(referralConfig({ STRIPE_REFERRAL_COUPON_ID: "referral-20-3mo" }).couponId, "referral-20-3mo");
  assert.equal(referralConfig({ STRIPE_REFERRAL_COUPON_ID: "bad coupon/../x" }).couponId, null);
  assert.equal(referralConfig({ REFERRAL_DISCOUNT_LABEL: "  20% off the first 3 paid months " }).discountLabel, "20% off the first 3 paid months");
  assert.equal(referralConfig({ REFERRAL_DISCOUNT_LABEL: "x".repeat(300) }).discountLabel?.length, 200);
  assert.equal(referralConfig({ REFERRAL_DISCOUNT_LABEL: "   " }).discountLabel, null);
});

test("fixed program terms", () => {
  assert.deepEqual([REFERRAL_CURRENCY, REFERRAL_MIN_CREDIT_CENTS, REFERRAL_MIN_PAYOUT_CENTS, REFERRAL_PAYOUT_REVIEW_CENTS, REFERRAL_CODE_WINDOW_DAYS, REFERRAL_PAYOUT_COUNTRIES], ["usd", 1000, 5000, 50000, 30, ["US"]]);
});

test("codes use 30 unambiguous symbols, drawn without bias, and normalize from typed input", () => {
  assert.equal(referralCodeAlphabet.length, 30);
  assert.equal(new Set(referralCodeAlphabet).size, 30);
  assert.doesNotMatch(referralCodeAlphabet, /[01ILOU]/);
  assert.equal(generateReferralCode(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])), "23456789");
  // Bytes ≥ 240 are skipped; 239 maps to the last symbol (239 % 30 = 29).
  assert.equal(generateReferralCode(new Uint8Array([240, 255, 239, 30, 31, 32, 33, 34, 35, 36])), "Z2345678");
  assert.throws(() => generateReferralCode(new Uint8Array([250, 1, 2])), /Not enough random bytes/);
  const random = generateReferralCode(crypto.getRandomValues(new Uint8Array(32)));
  assert.equal(random.length, REFERRAL_CODE_LENGTH);
  assert.equal(normalizeReferralCode(random), random, "every generated code is canonical");
  assert.equal(normalizeReferralCode(" abcd-2345 "), "ABCD2345");
  assert.equal(normalizeReferralCode("ab cd 23 45"), "ABCD2345");
  for (const bad of ["ABCD234", "ABCD23456", "ABCD234O", "ABCD2341", "ABCDI345", "ABCD/345", "", "-".repeat(70) + "ABCD2345", null, undefined, 12345678, ["ABCD2345"]])
    assert.equal(normalizeReferralCode(bad), null, String(bad));
});

test("the disclosure names the referrer only when they have a GitHub username", () => {
  assert.match(referralDisclosure("alice"), /^@alice will see your GitHub username/);
  assert.match(referralDisclosure(null), /^The person who invited you will see/);
  assert.match(referralDisclosure(null), /when you sign up, when your workspace is created and subscribes, and what they earn from its payments, but no other workspace details\.$/);
});

test("commission base: cash collected excluding tax pro rata, never above the pre-tax total", () => {
  assert.equal(commissionBase({ amountPaid: 10000, total: 10000, totalExcludingTax: 10000 }), 10000, "no tax");
  assert.equal(commissionBase({ amountPaid: 12000, total: 12000, totalExcludingTax: 10000 }), 10000, "20% tax is excluded");
  assert.equal(commissionBase({ amountPaid: 7000, total: 12000, totalExcludingTax: 10000 }), 5833, "credit-reduced cash keeps the same tax share, floored");
  assert.equal(commissionBase({ amountPaid: 15000, amountOverpaid: 3000, total: 12000, totalExcludingTax: 10000 }), 10000, "an overpayment is not revenue");
  assert.equal(commissionBase({ amountPaid: 50000, total: 12000, totalExcludingTax: 10000 }), 10000, "capped at the pre-tax total");
  assert.equal(commissionBase({ amountPaid: 10000, total: 10000, totalExcludingTax: null }), 10000, "a null total_excluding_tax falls back to the total");
  for (const zero of [{ amountPaid: 0, total: 10000 }, { amountPaid: 10000, total: 0 }, { amountPaid: 3000, amountOverpaid: 3000, total: 3000 }, { amountPaid: 10000, total: -500 }]) assert.equal(commissionBase(zero), 0, JSON.stringify(zero));
  assert.equal(commissionAmount(10000, 2000), 2000);
  assert.equal(commissionAmount(5833, 2000), 1166, "floored to the cent");
  assert.equal(commissionAmount(9, 2000), 1);
  assert.equal(commissionAmount(4, 2000), 0);
});

test("months are added in UTC and clamp to the end of shorter months", () => {
  const jan31 = Date.UTC(2026, 0, 31, 15, 30);
  assert.equal(addMonthsUTC(jan31, 1), Date.UTC(2026, 1, 28, 15, 30));
  assert.equal(addMonthsUTC(Date.UTC(2028, 0, 31), 1), Date.UTC(2028, 1, 29), "leap year");
  assert.equal(addMonthsUTC(jan31, 2), Date.UTC(2026, 2, 31, 15, 30));
  assert.equal(addMonthsUTC(jan31, 12), Date.UTC(2027, 0, 31, 15, 30));
  assert.equal(addMonthsUTC(Date.UTC(2026, 9, 14, 12), 12), Date.UTC(2027, 9, 14, 12));
  assert.equal(addMonthsUTC(Date.UTC(2026, 7, 31), 13), Date.UTC(2027, 8, 30));
});

test("coupon months cover the paid months a carried trial would otherwise use up", () => {
  for (const trialDays of [0, 7, 14, 27]) assert.equal(couponMonthsNeeded(3, trialDays), 3, `${trialDays}-day trial`);
  assert.equal(couponMonthsNeeded(3, 28), 4);
  assert.equal(couponMonthsNeeded(3, 30), 4);
  assert.equal(couponMonthsNeeded(3, 60), 5);
  assert.equal(couponMonthsNeeded(1, 0), 1);
});

test("money, the billing fact and the conversion email", () => {
  assert.equal(formatMoney(123456), "$1,234.56");
  assert.equal(formatMoney(0, "usd"), "$0.00");
  assert.equal(referralFact({ invitedBy: "alice", discount: true }, "20% off the first 3 paid months"), "Invited by @alice · 20% off the first 3 paid months applies at checkout");
  assert.equal(referralFact({ invitedBy: null, discount: false }, null), "Invited by another OpenReview user");
  assert.equal(referralFact({ invitedBy: null, discount: true }, null), "Invited by another OpenReview user · the referral discount applies at checkout");
  const email = conversionEmail({ name: "bob", rateBps: 2000, months: 12, holdDays: 30, url: "https://review.example.com/dashboard/settings/referrals" });
  assert.equal(email.subject, "@bob subscribed to OpenReview");
  assert.match(email.text, /20% of what their workspace pays, excluding tax, for 12 months/);
  assert.match(email.text, /available 30 days after the payment/);
  assert.match(email.text, /https:\/\/review\.example\.com\/dashboard\/settings\/referrals$/);
  assert.equal(conversionEmail({ name: null, rateBps: 1250, months: 6, holdDays: 0, url: "u" }).subject, "Someone you referred subscribed to OpenReview");
  assert.match(conversionEmail({ name: null, rateBps: 1250, months: 6, holdDays: 0, url: "u" }).text, /12\.5%/);
});

test("clawback: refunds and open or lost disputes reverse the commission pro rata; won, warning_closed and prevented keep it", () => {
  const charge = (refunded: number, dispute?: { status: string; amount: number }) => ({ amount: 12000, refunded, ...(dispute ? { dispute: { id: "dp_1", ...dispute } } : {}) });
  assert.equal(reversalTarget(2000, []), 0, "no charge known yet");
  assert.equal(reversalTarget(2000, [charge(0)]), 0);
  assert.equal(reversalTarget(2000, [charge(6000)]), 1000, "half refunded");
  assert.equal(reversalTarget(2000, [charge(12000)]), 2000, "fully refunded");
  assert.equal(reversalTarget(2000, [charge(1)]), 1, "rounds the kept share down");
  for (const status of ["needs_response", "under_review", "warning_needs_response", "lost"]) assert.equal(reversalTarget(2000, [charge(0, { status, amount: 12000 })]), 2000, status);
  for (const status of ["won", "warning_closed", "prevented"]) assert.equal(reversalTarget(2000, [charge(0, { status, amount: 12000 })]), 0, status);
  assert.equal(reversalTarget(2000, [charge(0, { status: "lost", amount: 3000 })]), 500, "a partial dispute.amount");
  assert.equal(reversalTarget(2000, [charge(6000, { status: "lost", amount: 12000 })]), 2000, "a charge never loses more than it paid");
  assert.equal(reversalTarget(2000, [charge(12000), { amount: 12000, refunded: 0 }]), 1000, "two charges, one refunded");
});

test("balances per currency: released commissions net of clawbacks, minus redemptions that did not fail, and can go negative", () => {
  const now = 1_000_000, c = (amount: number, reversed: number, availableAt: number, status = "accrued", currency = "usd") => ({ currency, amount, reversed, status, availableAt });
  assert.equal(commissionAvailable(c(1, 0, now), now), true);
  assert.equal(commissionAvailable(c(1, 0, now + 1), now), false);
  assert.equal(commissionAvailable(c(1, 0, now, "void"), now), false);
  assert.deepEqual(referralBalances([], [], now), {});
  const commissions = [c(2000, 0, now - 1), c(2000, 500, now), c(3000, 0, now + 1), c(9000, 0, now - 1, "void"), c(700, 0, now - 1, "accrued", "eur")];
  const redemptions = [{ currency: "usd", amount: 1000, status: "completed" }, { currency: "usd", amount: 500, status: "processing" }, { currency: "usd", amount: 200, status: "review" }, { currency: "usd", amount: 9999, status: "failed" }];
  assert.deepEqual(referralBalances(commissions, redemptions, now), { usd: { available: 1800, onHold: 3000, redeemed: 1700 }, eur: { available: 700, onHold: 0, redeemed: 0 } });
  // A full refund after redeeming: the balance goes negative.
  assert.deepEqual(referralBalances([c(2000, 2000, now - 1)], [{ currency: "usd", amount: 2000, status: "completed" }], now), { usd: { available: -2000, onHold: 0, redeemed: 2000 } });
});

test("money input parses dollars and cents, nothing else", () => {
  for (const [input, cents] of [["25", 2500], ["$25.5", 2550], [" 25.05 ", 2505], ["1,000", 100000], ["1,234,567.89", 123456789], ["0", 0]] as const) assert.equal(parseMoneyInput(input), cents, input);
  for (const bad of ["", "abc", "-5", "1.234", "25.", "1e3", "12345678", "12,345,678", "10,50", "50,00", "1,0,0", ",100", null, 25]) assert.equal(parseMoneyInput(bad), null, String(bad));
});

test("Stripe failures are classified for retries", () => {
  for (const e of [new StripeError(0), new StripeError(429, "invalid_request_error", "lock_timeout"), new StripeError(409, "idempotency_error", "idempotency_key_in_use"), new OfflineError("billing", "Stripe billing"), new Error("Configure STRIPE_SECRET_KEY"), "boom"]) assert.equal(classifyStripeFailure(e), "transient", String(e));
  for (const status of [500, 502, 503]) assert.equal(classifyStripeFailure(new StripeError(status)), "indeterminate", String(status));
  for (const e of [new StripeError(400, "invalid_request_error", "resource_missing"), new StripeError(402, "card_error"), new StripeError(403), new StripeError(404)]) assert.equal(classifyStripeFailure(e), "definite", e.message);
});

test("payout redirects go only to Stripe-hosted https pages", () => {
  for (const url of ["https://connect.stripe.com/setup/e/acct_1/abc", "https://connect.stripe.com/express/acct_1/xyz", "https://dashboard.stripe.com/b/acct_1"]) assert.equal(stripeHostedUrl(url), url);
  for (const url of ["http://connect.stripe.com/setup", "https://connect.stripe.com.evil.example/x", "https://evilstripe.com/x", "https://connect.stripe.com:8443/x", "https://user@connect.stripe.com/x", "javascript:alert(1)", "/dashboard", "", null, 42]) assert.equal(stripeHostedUrl(url), null, String(url));
});
