import { test } from "node:test";
import assert from "node:assert/strict";
import { entitled, entitlements, planForPrice, priceFor } from "../src/plans";
import { billingConfig, billingDecision, fixRunLimit } from "../src/billing";

test("only Pro unlocks the costly features (Starter also gets fix pull requests and its own model key), and self-hosted (billing off) unlocks everything", () => {
  for (const key of entitlements) {
    assert.equal(entitled("pro", key), true, key);
    assert.equal(entitled("starter", key), key === "fix.pullRequests" || key === "model.ownKey", key);
    assert.equal(entitled("free", key), false, key);
    assert.equal(entitled("disabled", key), true, key);
    assert.equal(entitled("starter", key, true), true, "a grandfathered Starter subscription keeps it");
    assert.equal(entitled("free", key, true), false, "grandfathering ends when the subscription does");
  }
});

test("Stripe seat prices map to plans, monthly or annual; unknown prices map to nothing", () => {
  const env = { STRIPE_SEAT_PRICE_ID: "price_s", STRIPE_SEAT_ANNUAL_PRICE_ID: "price_sy", STRIPE_PRO_PRICE_ID: "price_p", STRIPE_PRO_ANNUAL_PRICE_ID: "price_py" };
  assert.deepEqual(["price_s", "price_sy", "price_p", "price_py", "price_other", undefined].map((p) => planForPrice(p, env)), ["starter", "starter", "pro", "pro", undefined, undefined]);
  assert.equal(planForPrice("price_s", {}), undefined, "nothing configured matches nothing");
  assert.equal(priceFor("pro", env), "price_p");
  assert.throws(() => priceFor("pro", {}), /Configure STRIPE_PRO_PRICE_ID/);
  assert.throws(() => priceFor("starter", { STRIPE_SEAT_PRICE_ID: "bad id" }), /Configure STRIPE_SEAT_PRICE_ID/);
});

test("hosted fix runs: none on Free, 5 per Starter seat and 20 per Pro seat, pooled; unlimited with billing off", () => {
  const config = billingConfig({ BILLING_ENABLED: "true" }), now = Date.UTC(2026, 9, 14);
  const plan = (account: Parameters<typeof billingDecision>[0]) => billingDecision(account, 0, now, config);
  const free = plan({ status: "trial", seats: 3, trialEndsAt: now }), starter = plan({ status: "active", seats: 3, trialEndsAt: now, subscriptionId: "sub_1" }), pro = plan({ status: "active", seats: 3, trialEndsAt: now, subscriptionId: "sub_1", plan: "pro" });
  assert.deepEqual([free, starter, pro].map((d) => fixRunLimit(d, 3, config)), [0, 15, 60]);
  assert.equal(fixRunLimit(starter, 0, config), 5, "at least one seat");
  assert.equal(fixRunLimit(billingDecision({ status: "trial", seats: 3, trialEndsAt: now }, 0, now, billingConfig({})), 3, config), null);
});
