import { test } from "node:test";
import assert from "node:assert/strict";
import { entitled, entitlements, planForPrice, priceFor } from "../src/plans";
import { billingConfig, billingDecision, fixRunLimit } from "../src/billing";

test("only Pro unlocks the costly features (Starter also gets fix pull requests and its own model key), and self-hosted (billing off) unlocks everything", () => {
  for (const key of entitlements) {
    // SCIM and audit log export are Enterprise only; Pro (and a grandfathered Starter) has everything else.
    const enterpriseOnly = key === "auth.scim" || key === "audit.export";
    assert.equal(entitled("pro", key), !enterpriseOnly, key);
    assert.equal(entitled("enterprise", key), true, key);
    assert.equal(entitled("starter", key), key === "fix.pullRequests" || key === "model.ownKey", key);
    assert.equal(entitled("free", key), false, key);
    assert.equal(entitled("disabled", key), true, key);
    assert.equal(entitled("starter", key, true), !enterpriseOnly, "a grandfathered Starter subscription keeps what Pro has");
    assert.equal(entitled("free", key, true), false, "grandfathering ends when the subscription does");
  }
});

test("Stripe seat prices map to plans, monthly or annual; unknown prices map to nothing", () => {
  const env = { STRIPE_SEAT_PRICE_ID: "price_s", STRIPE_SEAT_ANNUAL_PRICE_ID: "price_sy", STRIPE_PRO_PRICE_ID: "price_p", STRIPE_PRO_ANNUAL_PRICE_ID: "price_py" };
  assert.deepEqual(["price_s", "price_sy", "price_p", "price_py", "price_other", undefined].map((p) => planForPrice(p, env)), ["starter", "starter", "pro", "pro", undefined, undefined]);
  // Enterprise prices are per contract, so no price ID ever maps to it.
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

test("the Enterprise pricing card needs billing on and a mailto or https contact link", async () => {
  const { enterpriseOffer } = await import("../src/plans");
  assert.equal(enterpriseOffer(true, {}), null);
  assert.equal(enterpriseOffer(false, { BILLING_ENTERPRISE_CONTACT_URL: "mailto:sales@example.com" }), null);
  for (const bad of ["javascript:alert(1)", "http://example.com", "sales@example.com", " "]) assert.equal(enterpriseOffer(true, { BILLING_ENTERPRISE_CONTACT_URL: bad }), null, bad);
  assert.deepEqual(enterpriseOffer(true, { BILLING_ENTERPRISE_CONTACT_URL: " mailto:sales@example.com " }), { contactUrl: "mailto:sales@example.com", priceLabel: "Per active contributor, billed annually" });
  assert.deepEqual(enterpriseOffer(true, { BILLING_ENTERPRISE_CONTACT_URL: "https://example.com/contact", BILLING_ENTERPRISE_PRICE_LABEL: "From $22 per active contributor" }), { contactUrl: "https://example.com/contact", priceLabel: "From $22 per active contributor" });
});
