import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { STRIPE_API_VERSION, StripeError, billingConfig, billingDecision, checkoutTrialEnd, formEncode, openSubscription, periodKey, seatCount, stripe, stripeGet, stripeKey, trialEndsFrom, verifyStripeSignature } from "../src/billing";

const config = billingConfig({ BILLING_ENABLED: "true", BILLING_TRIAL_REVIEWS: "3", BILLING_REVIEWS_PER_SEAT: "10", BILLING_GRACE_DAYS: "7" });
const now = Date.UTC(2026, 9, 14), day = 86400000;

test("billing configuration defaults to disabled and validates numbers", () => {
  assert.deepEqual(billingConfig({}), { enabled: false, trialDays: 14, trialReviews: 200, reviewsPerSeat: 500, graceDays: 7 });
  assert.equal(billingConfig({ BILLING_ENABLED: "yes" }).enabled, false);
  assert.equal(billingConfig({ BILLING_TRIAL_DAYS: "-1", BILLING_REVIEWS_PER_SEAT: "abc" }).trialDays, 14);
  assert.equal(periodKey(now), "2026-10");
});

test("seats count owners, admins and members; viewers are free", () => {
  assert.equal(seatCount([{ role: "owner" }, { role: "admin" }, { role: "member" }, { role: "viewer" }, { role: "viewer" }]), 3);
  assert.equal(seatCount([]), 0);
});

test("quota decisions: trial, Starter fair-use limit, past-due grace, and lapsed subscriptions", () => {
  const trial = { status: "trial", seats: 0, trialEndsAt: now + 5 * day };
  assert.equal(billingDecision(trial, 999, now, billingConfig({})).allowed, true, "disabled billing never blocks");
  assert.deepEqual(billingDecision(trial, 2, now, config), { allowed: true, plan: "trial", limit: 3, used: 2 });
  assert.match(billingDecision(trial, 3, now, config).reason!, /trial includes 3 reviews/);
  assert.match(billingDecision({ ...trial, trialEndsAt: now }, 0, now, config).reason!, /free trial has ended/);
  const team = { status: "active", seats: 4, trialEndsAt: now - day, subscriptionId: "sub_1" };
  assert.deepEqual(billingDecision(team, 39, now, config), { allowed: true, plan: "starter", limit: 40, used: 39 });
  assert.match(billingDecision(team, 40, now, config).reason!, /fair-use limit of 40 reviews this month \(10 per seat\)/);
  assert.equal(billingDecision({ ...team, status: "past_due", pastDueSince: now - 6 * day }, 0, now, config).allowed, true, "within grace");
  assert.match(billingDecision({ ...team, status: "past_due", pastDueSince: now - 7 * day }, 0, now, config).reason!, /grace period has ended/);
  assert.match(billingDecision({ ...team, status: "canceled" }, 0, now, config).reason!, /free trial has ended/);
  assert.equal(billingDecision({ ...team, status: "canceled", trialEndsAt: now + day }, 0, now, config).plan, "trial", "a lapsed subscription falls back to any remaining trial");
  assert.equal(billingDecision({ ...team, seats: 0 }, 9, now, config).limit, 10, "at least one seat");
});

test("a subscription is open until Stripe ends it", () => {
  assert.equal(openSubscription(null), false);
  assert.equal(openSubscription({ status: "trial" }), false);
  for (const status of ["active", "trialing", "past_due", "unpaid", "paused", "incomplete"]) assert.equal(openSubscription({ subscriptionId: "sub_1", status }), true, status);
  for (const status of ["canceled", "incomplete_expired"]) assert.equal(openSubscription({ subscriptionId: "sub_1", status }), false, status);
});

test("the trial clock starts on first use, and Checkout only carries a trial that ends 48+ hours out", () => {
  assert.equal(trialEndsFrom(now, config), now + 14 * day);
  assert.equal(trialEndsFrom(now, billingConfig({ BILLING_TRIAL_DAYS: "30" })), now + 30 * day);
  assert.equal(checkoutTrialEnd(now + 10 * day, now), Math.floor((now + 10 * day) / 1000));
  assert.equal(checkoutTrialEnd(now + 49 * 3600000, now), Math.floor((now + 49 * 3600000) / 1000));
  assert.equal(checkoutTrialEnd(now + 48 * 3600000, now), undefined, "Stripe rejects trial_end under 48 hours; charge now instead");
  assert.equal(checkoutTrialEnd(now - day, now), undefined);
});

const secret = "whsec_fixture", payload = '{"id":"evt_1"}';
const header = (body: string, t: number, key = secret) => `t=${t},v1=${createHmac("sha256", key).update(`${t}.${body}`).digest("hex")}`;
test("Stripe signatures: exact payload, any listed v1 signature, five-minute tolerance", async () => {
  const t = Math.floor(now / 1000);
  assert.equal(await verifyStripeSignature(payload, header(payload, t), secret, now), true);
  assert.equal(await verifyStripeSignature(payload, `t=${t},v1=${"0".repeat(64)},${header(payload, t).split(",")[1]}`, secret, now), true, "secret rotation sends two signatures");
  assert.equal(await verifyStripeSignature(payload + " ", header(payload, t), secret, now), false);
  assert.equal(await verifyStripeSignature(payload, header(payload, t, "whsec_other"), secret, now), false);
  assert.equal(await verifyStripeSignature(payload, header(payload, t - 301), secret, now), false, "replayed after tolerance");
  assert.equal(await verifyStripeSignature(payload, `v1=${"a".repeat(64)}`, secret, now), false);
  assert.equal(await verifyStripeSignature(payload, header(payload, t).replace("v1=", "v0="), secret, now), false);
  assert.equal(await verifyStripeSignature(payload, header(payload, t), undefined, now), false);
});

test("Stripe client: test-mode (restricted or secret) keys by default, pinned API version, nested form encoding, idempotency keys", async () => {
  assert.throws(() => stripeKey({}), /Configure STRIPE_SECRET_KEY/);
  assert.equal(stripeKey({ STRIPE_SECRET_KEY: "sk_test_123" }), "sk_test_123");
  assert.equal(stripeKey({ STRIPE_SECRET_KEY: "rk_test_123" }), "rk_test_123");
  assert.throws(() => stripeKey({ STRIPE_SECRET_KEY: "sk_live_123" }), /test-mode key/);
  assert.throws(() => stripeKey({ STRIPE_SECRET_KEY: "rk_live_123" }), /test-mode key/);
  assert.throws(() => stripeKey({ STRIPE_SECRET_KEY: "pk_test_123" }), /test-mode key/, "publishable keys are not server keys");
  assert.equal(stripeKey({ STRIPE_SECRET_KEY: "sk_live_123", BILLING_ALLOW_LIVE: "true" }), "sk_live_123");
  assert.equal(stripeKey({ STRIPE_SECRET_KEY: "rk_live_123", BILLING_ALLOW_LIVE: "true" }), "rk_live_123");
  assert.deepEqual(formEncode({ mode: "subscription", line_items: [{ price: "price_1", quantity: 3 }], metadata: { organizationId: "org 1" }, skip: undefined }), ["mode=subscription", "line_items%5B0%5D%5Bprice%5D=price_1", "line_items%5B0%5D%5Bquantity%5D=3", "metadata%5BorganizationId%5D=org%201"]);
  let seen: { url: string; init?: RequestInit } | undefined;
  const ok = (async (url: string | URL | Request, init?: RequestInit) => { seen = { url: String(url), init }; return Response.json({ id: "cus_1" }); }) as typeof fetch;
  assert.deepEqual(await stripe("/v1/customers", { metadata: { organizationId: "o" } }, "sk_test_1", ok, "customer:o"), { id: "cus_1" });
  assert.equal(seen?.url, "https://api.stripe.com/v1/customers");
  assert.equal(new Headers(seen?.init?.headers).get("idempotency-key"), "customer:o");
  assert.equal(new Headers(seen?.init?.headers).get("authorization"), "Bearer sk_test_1");
  assert.equal(new Headers(seen?.init?.headers).get("stripe-version"), STRIPE_API_VERSION);
  await assert.rejects(stripe("/v1/customers", {}, "sk_test_1", (async () => Response.json({ error: { type: "card_error" } }, { status: 402 })) as typeof fetch), /402 card_error/);
  // Errors carry Stripe's status, type, code and param, never the response body.
  await assert.rejects(stripe("/v1/checkout/sessions", {}, "sk_test_1", (async () => Response.json({ error: { type: "invalid_request_error", code: "resource_missing", param: "discounts[0][coupon]", message: "No such coupon: 'secret-coupon'" } }, { status: 400 })) as typeof fetch), (error: unknown) => error instanceof StripeError && error.status === 400 && error.type === "invalid_request_error" && error.code === "resource_missing" && error.param === "discounts[0][coupon]" && error.message === "Stripe request failed (400 invalid_request_error resource_missing)");
  await assert.rejects(stripe("/v1/customers", {}, "sk_test_1", (async () => new Response("<html>bad gateway</html>", { status: 502 })) as typeof fetch), (error: unknown) => error instanceof StripeError && error.message === "Stripe request failed (502)");
  await assert.rejects(stripe("https://evil.example", {}, "sk_test_1", ok), /Invalid Stripe API path/);
  // No answer at all (network failure, timeout): status 0, so callers retry with the same key.
  await assert.rejects(stripe("/v1/customers", {}, "sk_test_1", (async () => { throw new TypeError("fetch failed"); }) as typeof fetch), (error: unknown) => error instanceof StripeError && error.status === 0 && error.message === "Stripe request failed (0)");
  await assert.rejects(stripe("/v1/customers", {}, "sk_test_1", (async () => Response.json({ error: { type: "api_error" } }, { status: 500, headers: { "stripe-should-retry": "false" } })) as typeof fetch), (error: unknown) => error instanceof StripeError && error.status === 500 && error.shouldRetry === false);
  await assert.rejects(stripe("/v1/customers", {}, "sk_test_1", (async () => Response.json({ error: { type: "invalid_request_error", code: "lock_timeout" } }, { status: 429, headers: { "stripe-should-retry": "true" } })) as typeof fetch), (error: unknown) => error instanceof StripeError && error.code === "lock_timeout" && error.shouldRetry === true);
});

test("Stripe GETs put the query in the URL and send no body", async () => {
  let seen: { url: string; init?: RequestInit } | undefined;
  const ok = (async (url: string | URL | Request, init?: RequestInit) => { seen = { url: String(url), init }; return Response.json({ data: [], has_more: false }); }) as typeof fetch;
  assert.deepEqual(await stripeGet("/v1/invoice_payments", { payment: { type: "payment_intent", payment_intent: "pi_1" }, status: "paid", limit: 100, starting_after: undefined }, "rk_test_1", ok), { data: [], has_more: false });
  assert.equal(seen?.url, "https://api.stripe.com/v1/invoice_payments?payment%5Btype%5D=payment_intent&payment%5Bpayment_intent%5D=pi_1&status=paid&limit=100");
  assert.equal(seen?.init?.method, "GET");
  assert.equal(seen?.init?.body, undefined);
  assert.equal(seen?.init?.redirect, "error");
  const headers = new Headers(seen?.init?.headers);
  assert.equal(headers.get("content-type"), null);
  assert.equal(headers.get("idempotency-key"), null);
  assert.equal(headers.get("stripe-version"), STRIPE_API_VERSION);
  assert.equal(headers.get("authorization"), "Bearer rk_test_1");
  await stripeGet("/v1/customers/cus_A1/balance_transactions", { created: { gte: 1760000000 } }, "rk_test_1", ok);
  assert.equal(seen?.url, "https://api.stripe.com/v1/customers/cus_A1/balance_transactions?created%5Bgte%5D=1760000000");
  await stripeGet("/v1/charges/ch_3Abc", {}, "rk_test_1", ok);
  assert.equal(seen?.url, "https://api.stripe.com/v1/charges/ch_3Abc");
  await assert.rejects(stripeGet("/v1/charges/ch_1", {}, "rk_test_1", (async () => Response.json({ error: { type: "invalid_request_error", code: "resource_missing" } }, { status: 404 })) as typeof fetch), /404 invalid_request_error resource_missing/);
  for (const path of ["/v1/charges/../x", "/v1/charges/ch_1?expand[]=x", "https://evil.example/v1/charges"]) await assert.rejects(stripeGet(path, {}, "rk_test_1", ok), /Invalid Stripe API path/, path);
});
