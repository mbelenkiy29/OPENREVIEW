import test from "node:test";
import assert from "node:assert/strict";
import { REFERRAL_CODE_LENGTH, REFERRAL_CODE_WINDOW_DAYS, REFERRAL_CURRENCY, REFERRAL_MIN_CREDIT_CENTS, REFERRAL_MIN_PAYOUT_CENTS, REFERRAL_PAYOUT_COUNTRIES, REFERRAL_PAYOUT_REVIEW_CENTS, generateReferralCode, normalizeReferralCode, referralCodeAlphabet, referralConfig, referralDisclosure } from "../src/referrals";

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
  assert.match(referralDisclosure(null), /when you sign up, and when your workspace is created and subscribes, not your workspace details\.$/);
});
