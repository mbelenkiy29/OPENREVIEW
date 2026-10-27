import { test } from "node:test";
import assert from "node:assert/strict";
import { entitled, entitlementKeys, featureNames, planCatalog, tierFor, tierForPrice, tiers, type EntitlementKey } from "../src/plans";
import { accountTiers, billingConfig, billingDecision } from "../src/billing";

// The feature matrix in docs/roadmap/pricing-tiers.md, row by row.
const matrix: Record<EntitlementKey, string[]> = {
  "engine.deep": ["trial", "pro", "business"], "context.requirements": ["trial", "pro", "business"], "fix.pullRequests": ["trial", "pro", "business"], "review.reproTests": ["trial", "pro", "business"],
  "memory.conventions": ["trial", "pro", "business"], "api.access": ["trial", "pro", "business"], "analytics.history": ["trial", "pro", "business"],
  "auth.sso": ["business"], "auth.scim": ["business"], "audit.export": ["business"], "billing.caps": ["business"],
};
test("every matrix row maps to the right tiers, and disabled billing grants everything", () => {
  assert.deepEqual([...entitlementKeys].sort(), Object.keys(matrix).sort());
  for (const key of entitlementKeys) {
    for (const tier of tiers) assert.equal(entitled(tier, key, true), matrix[key].includes(tier), `${tier} ${key}`);
    assert.equal(entitled(null, key, true), false, "no plan, no features");
    assert.equal(entitled(null, key, false), true, "self-hosted is never gated");
    assert.ok(featureNames[key]);
  }
  assert.equal(tierFor("fix.pullRequests"), "pro");
  assert.equal(tierFor("auth.sso"), "business");
  assert.deepEqual(tiers.map((t) => planCatalog[t].reviewsPerSeat), [200, 500, 1500, 3000]);
  // @ts-expect-error unknown keys are a type error
  entitled("pro", "fix.everything", true);
});

test("prices map to tiers only when configured", () => {
  const env = { STRIPE_SEAT_PRICE_ID: "price_starter", STRIPE_PRO_PRICE_ID: "price_pro" };
  assert.equal(tierForPrice("price_starter", env), "starter");
  assert.equal(tierForPrice("price_pro", env), "pro");
  assert.equal(tierForPrice("price_other", env), undefined);
  assert.equal(tierForPrice("", {}), undefined, "an unset price never matches an empty one");
});

test("fair use follows the tier; a lapsed subscription and the trial give the right features", () => {
  const config = billingConfig({ BILLING_ENABLED: "true", BILLING_REVIEWS_PER_SEAT: "10", BILLING_PRO_REVIEWS_PER_SEAT: "30" }), now = Date.UTC(2026, 9, 27), day = 86400000;
  assert.equal(config.businessReviewsPerSeat, 3000);
  const team = { status: "active", seats: 2, trialEndsAt: now - day, subscriptionId: "sub_1" };
  assert.deepEqual(billingDecision(team, 0, now, config), { allowed: true, plan: "starter", limit: 20, used: 0 }, "no tier means Starter");
  assert.deepEqual(billingDecision({ ...team, tier: "pro" }, 59, now, config), { allowed: true, plan: "pro", limit: 60, used: 59 });
  assert.match(billingDecision({ ...team, tier: "pro" }, 60, now, config).reason!, /limit of 60 reviews this month \(30 per seat\)/);
  assert.deepEqual(accountTiers(team, now), ["starter"]);
  assert.deepEqual(accountTiers({ ...team, tier: "pro" }, now), ["pro"]);
  assert.deepEqual(accountTiers({ ...team, status: "trialing" }, now), ["starter", "trial"], "a Stripe trial tries Pro features");
  assert.deepEqual(accountTiers({ status: "trial", seats: 0, trialEndsAt: now + day }, now), ["trial"]);
  assert.deepEqual(accountTiers({ ...team, status: "canceled" }, now), [], "cancelled after the trial: no features");
  assert.deepEqual(accountTiers({ ...team, status: "canceled", trialEndsAt: now + day }, now), ["trial"], "falls back to any remaining trial");
});
