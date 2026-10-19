import test from "node:test";
import assert from "node:assert/strict";
import { REFERRAL_CODE_LENGTH, REFERRAL_CODE_WINDOW_DAYS, REFERRAL_CURRENCY, REFERRAL_MIN_CREDIT_CENTS, REFERRAL_MIN_PAYOUT_CENTS, REFERRAL_PAYOUT_COUNTRIES, REFERRAL_PAYOUT_REVIEW_CENTS, addMonthsUTC, commissionAmount, commissionBase, conversionEmail, couponMonthsNeeded, formatMoney, generateReferralCode, normalizeReferralCode, referralCodeAlphabet, referralConfig, referralDisclosure, referralFact } from "../src/referrals";

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
