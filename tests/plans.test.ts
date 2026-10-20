import { test } from "node:test";
import assert from "node:assert/strict";
import { entitled, entitlements, planForPrice, priceFor } from "../src/plans";

test("only Pro unlocks the costly features, and self-hosted (billing off) unlocks everything", () => {
  for (const key of entitlements) {
    assert.equal(entitled("pro", key), true, key);
    assert.equal(entitled("starter", key), false, key);
    assert.equal(entitled("free", key), false, key);
    assert.equal(entitled("disabled", key), true, key);
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
