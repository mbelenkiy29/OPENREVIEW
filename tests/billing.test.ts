import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { STRIPE_API_VERSION, StripeError, billingConfig, billingDecision, checkoutTrialEnd, formEncode, nextPeriodStart, openSubscription, periodKey, seatCount, stripe, stripeGet, stripeKey, stripeV2, trialEndsFrom, verifyStripeSignature } from "../src/billing";

const config = billingConfig({ BILLING_ENABLED: "true", BILLING_TRIAL_USAGE_USD: "3", BILLING_USAGE_PER_SEAT_USD: "10", BILLING_GRACE_DAYS: "7" });
const now = Date.UTC(2026, 9, 14), day = 86400000, usd = 1e6;

test("billing configuration defaults to disabled and validates numbers", () => {
  assert.deepEqual(billingConfig({}), { enabled: false, trialDays: 14, trialUsageMicros: 5 * usd, usagePerSeatMicros: 6 * usd, graceDays: 7 });
  assert.equal(billingConfig({ BILLING_ENABLED: "yes" }).enabled, false);
  assert.equal(billingConfig({ BILLING_TRIAL_DAYS: "-1", BILLING_USAGE_PER_SEAT_USD: "abc" }).trialDays, 14);
  assert.equal(billingConfig({ BILLING_USAGE_PER_SEAT_USD: "abc" }).usagePerSeatMicros, 6 * usd);
  assert.equal(billingConfig({ BILLING_USAGE_PER_SEAT_USD: "0.25" }).usagePerSeatMicros, 250_000);
  assert.equal(billingConfig({ BILLING_TRIAL_USAGE_USD: "" }).trialUsageMicros, 5 * usd, "empty is the default, not $0");
  assert.equal(periodKey(now), "2026-10");
  assert.equal(nextPeriodStart(now), Date.UTC(2026, 10, 1));
  assert.equal(nextPeriodStart(Date.UTC(2026, 11, 31, 23)), Date.UTC(2027, 0, 1));
});

test("seats count owners, admins and members; viewers are free", () => {
  assert.equal(seatCount([{ role: "owner" }, { role: "admin" }, { role: "member" }, { role: "viewer" }, { role: "viewer" }]), 3);
  assert.equal(seatCount([]), 0);
});

test("usage decisions: trial, included Starter usage, extra usage cap, past-due grace, and lapsed subscriptions", () => {
  const trial = { status: "trial", seats: 0, trialEndsAt: now + 5 * day };
  assert.equal(billingDecision(trial, 999 * usd, now, billingConfig({})).allowed, true, "disabled billing never blocks");
  assert.deepEqual(billingDecision(trial, 2 * usd, now, config), { allowed: true, plan: "trial", limit: 3 * usd, used: 2 * usd, capMicros: 0, overage: false });
  assert.equal(billingDecision(trial, 2 * usd, now, config, usd).allowed, true, "a request that exactly uses the rest fits");
  assert.match(billingDecision(trial, 2 * usd, now, config, usd + 1).reason!, /trial's included usage is used up/);
  assert.match(billingDecision(trial, 3 * usd, now, config).reason!, /trial's included usage is used up/, "the enqueue pre-check stops at the limit");
  assert.match(billingDecision({ ...trial, trialEndsAt: now }, 0, now, config).reason!, /free trial has ended/);
  const team = { status: "active", seats: 4, trialEndsAt: now - day, subscriptionId: "sub_1" };
  assert.deepEqual(billingDecision(team, 39 * usd, now, config), { allowed: true, plan: "starter", limit: 40 * usd, used: 39 * usd, capMicros: 0, overage: false });
  assert.match(billingDecision(team, 40 * usd, now, config).reason!, /used its included usage for this month\. Usage resets on November 1; a workspace admin can turn on extra usage/);
  const capped = { ...team, spendCapUsd: 5 };
  assert.deepEqual(billingDecision(capped, 40 * usd, now, config, usd), { allowed: true, plan: "starter", limit: 40 * usd, used: 40 * usd, capMicros: 5 * usd, overage: true });
  assert.equal(billingDecision(capped, 39 * usd, now, config, usd).overage, false, "within the included usage is not overage");
  assert.match(billingDecision(capped, 44 * usd, now, config, usd + 1).reason!, /extra usage cap of \$5\.00 this month\. Usage resets on November 1/);
  assert.equal(billingDecision({ ...team, status: "past_due", pastDueSince: now - 6 * day }, 0, now, config).allowed, true, "within grace");
  assert.match(billingDecision({ ...team, status: "past_due", pastDueSince: now - 7 * day }, 0, now, config).reason!, /grace period has ended/);
  assert.match(billingDecision({ ...team, status: "canceled" }, 0, now, config).reason!, /free trial has ended/);
  assert.equal(billingDecision({ ...team, status: "canceled", trialEndsAt: now + day }, 0, now, config).plan, "trial", "a lapsed subscription falls back to any remaining trial");
  assert.equal(billingDecision({ ...team, seats: 0 }, 9, now, config).limit, 10 * usd, "at least one seat");
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

test("Stripe v2 requests send JSON, index include[] in the query, and only reach Connect accounts and account links", async () => {
  let seen: { url: string; init?: RequestInit } | undefined;
  const ok = (async (url: string | URL | Request, init?: RequestInit) => { seen = { url: String(url), init }; return Response.json({ id: "acct_1Abc" }); }) as typeof fetch;
  const body = { identity: { country: "us" }, configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } }, include: ["configuration.recipient", "requirements"] };
  assert.deepEqual(await stripeV2("POST", "/v2/core/accounts", "rk_test_1", { body, idempotencyKey: "referral-account:u:US:abcd1234" }, ok), { id: "acct_1Abc" });
  assert.equal(seen?.url, "https://api.stripe.com/v2/core/accounts");
  assert.equal(seen?.init?.method, "POST");
  assert.equal(seen?.init?.redirect, "error");
  assert.deepEqual(JSON.parse(String(seen?.init?.body)), body);
  let headers = new Headers(seen?.init?.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("idempotency-key"), "referral-account:u:US:abcd1234");
  assert.equal(headers.get("stripe-version"), STRIPE_API_VERSION);
  assert.equal(headers.get("authorization"), "Bearer rk_test_1");
  await stripeV2("GET", "/v2/core/accounts/acct_1Abc", "rk_test_1", { query: { include: ["configuration.recipient", "requirements"] } }, ok);
  assert.equal(seen?.url, "https://api.stripe.com/v2/core/accounts/acct_1Abc?include%5B0%5D=configuration.recipient&include%5B1%5D=requirements");
  assert.equal(seen?.init?.body, undefined);
  headers = new Headers(seen?.init?.headers);
  assert.equal(headers.get("content-type"), null);
  assert.equal(headers.get("idempotency-key"), null);
  await stripeV2("POST", "/v2/core/account_links", "rk_test_1", { body: { account: "acct_1Abc" } }, ok);
  assert.equal(seen?.url, "https://api.stripe.com/v2/core/account_links");
  await assert.rejects(stripeV2("POST", "/v2/core/accounts", "rk_test_1", { body: {} }, (async () => Response.json({ error: { type: "idempotency_error", code: "idempotency_key_reused", message: "secret detail" } }, { status: 409 })) as typeof fetch), (error: unknown) => error instanceof StripeError && error.status === 409 && error.type === "idempotency_error" && error.message === "Stripe request failed (409 idempotency_error idempotency_key_reused)");
  for (const path of ["/v2/core/events", "/v2/core/accounts/acct_1/persons", "/v2/core/accounts/../x", "/v2/core/accounts/acct_1?include[0]=x", "/v1/transfers", "https://evil.example/v2/core/accounts"]) await assert.rejects(stripeV2("GET", path, "rk_test_1", {}, ok), /Invalid Stripe API path/, path);
});

test("the pinned API version is dahlia: account links still take configurations", () => {
  // 2026-09-30.endive drops account_links use_case configurations; update startPayoutSetup when this changes.
  assert.equal(STRIPE_API_VERSION, "2026-08-26.dahlia");
});
