import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { STRIPE_API_VERSION, StripeError, billingConfig, billingDecision, billsWorkspaces, checkoutTrialEnd, contractEnd, contractPreview, contractTermsError, contributorMeterEvent, fixRunLimit, formEncode, reviewsLeft, nextPeriodStart, openSubscription, ownKeyOnlyReason, periodKey, seatCount, stripe, stripeGet, stripeKey, stripeV2, trialEndedReason, trialEndsFrom, verifyStripeSignature } from "../src/billing";

const config = billingConfig({ BILLING_ENABLED: "true", BILLING_FREE_USAGE_USD: "3", BILLING_USAGE_PER_SEAT_USD: "10", BILLING_GRACE_DAYS: "7" });
const now = Date.UTC(2026, 9, 14), day = 86400000, usd = 1e6;

test("billing configuration defaults to disabled and validates numbers", () => {
  assert.deepEqual(billingConfig({}), { enabled: false, trialDays: 14, freeUsageMicros: 3 * usd, usagePerSeatMicros: 6 * usd, proUsagePerSeatMicros: 12 * usd, graceDays: 7, starterFixesPerSeat: 5, proFixesPerSeat: 20, enterpriseMinContributors: 25, enterpriseUsagePerContributorMicros: 12 * usd, enterpriseNetDays: 30, enterpriseGraceDays: 30 });
  assert.deepEqual([billingConfig({ BILLING_ENTERPRISE_MIN_CONTRIBUTORS: "40", BILLING_ENTERPRISE_USAGE_PER_CONTRIBUTOR_USD: "x", BILLING_ENTERPRISE_NET_DAYS: "45", BILLING_ENTERPRISE_GRACE_DAYS: "-3" })].map((c) => [c.enterpriseMinContributors, c.enterpriseUsagePerContributorMicros, c.enterpriseNetDays, c.enterpriseGraceDays]), [[40, 12 * usd, 45, 30]], "enterprise defaults are overridable and bad values fall back");
  assert.deepEqual([billingConfig({ BILLING_STARTER_FIXES_PER_SEAT: "8", BILLING_PRO_FIXES_PER_SEAT: "x" })].map((c) => [c.starterFixesPerSeat, c.proFixesPerSeat]), [[8, 20]]);
  assert.equal(billingConfig({ BILLING_ENABLED: "yes" }).enabled, false);
  assert.equal(billingConfig({ BILLING_TRIAL_DAYS: "-1", BILLING_USAGE_PER_SEAT_USD: "abc" }).trialDays, 14);
  assert.equal(billingConfig({ BILLING_USAGE_PER_SEAT_USD: "abc" }).usagePerSeatMicros, 6 * usd);
  assert.equal(billingConfig({ BILLING_USAGE_PER_SEAT_USD: "0.25" }).usagePerSeatMicros, 250_000);
  assert.equal(billingConfig({ BILLING_FREE_USAGE_USD: "" }).freeUsageMicros, 3 * usd, "empty is the default, not $0");
  assert.equal(billingConfig({ BILLING_TRIAL_USAGE_USD: "50" }).freeUsageMicros, 3 * usd, "the old trial allowance does not become a monthly Free allowance");
  assert.equal(periodKey(now), "2026-10");
  assert.equal(nextPeriodStart(now), Date.UTC(2026, 10, 1));
  assert.equal(nextPeriodStart(Date.UTC(2026, 11, 31, 23)), Date.UTC(2027, 0, 1));
});

test("seats count owners, admins and members; viewers are free", () => {
  assert.equal(seatCount([{ role: "owner" }, { role: "admin" }, { role: "member" }, { role: "viewer" }, { role: "viewer" }]), 3);
  assert.equal(seatCount([]), 0);
});

test("usage decisions: Free, included Starter and Pro usage, extra usage cap, past-due grace, and lapsed subscriptions", () => {
  const trial = { status: "trial", seats: 0, trialEndsAt: now + 5 * day };
  assert.equal(billingDecision(trial, 999 * usd, now, billingConfig({})).allowed, true, "disabled billing never blocks");
  assert.deepEqual(billingDecision(trial, 2 * usd, now, config), { allowed: true, plan: "free", limit: 3 * usd, used: 2 * usd, capMicros: 0, overage: false });
  assert.equal(billingDecision(trial, 2 * usd, now, config, usd).allowed, true, "a request that exactly uses the rest fits");
  assert.match(billingDecision(trial, 2 * usd, now, config, usd + 1).reason!, /Free plan's \$3\.00 of usage for this month\. Usage resets on November 1/);
  assert.match(billingDecision(trial, 3 * usd, now, config).reason!, /Free plan's/, "the enqueue pre-check stops at the limit");
  assert.equal(billingDecision({ ...trial, trialEndsAt: now - 90 * day }, 0, now, config).allowed, true, "Free never expires");
  const team = { status: "active", seats: 4, trialEndsAt: now - day, subscriptionId: "sub_1" };
  assert.deepEqual(billingDecision(team, 39 * usd, now, config), { allowed: true, plan: "starter", limit: 40 * usd, used: 39 * usd, capMicros: 0, overage: false });
  assert.match(billingDecision(team, 40 * usd, now, config).reason!, /used its included usage for this month\. Usage resets on November 1; a workspace admin can turn on extra usage/);
  const capped = { ...team, spendCapUsd: 5 };
  assert.deepEqual(billingDecision(capped, 40 * usd, now, config, usd), { allowed: true, plan: "starter", limit: 40 * usd, used: 40 * usd, capMicros: 5 * usd, overage: true });
  assert.equal(billingDecision(capped, 39 * usd, now, config, usd).overage, false, "within the included usage is not overage");
  assert.match(billingDecision(capped, 44 * usd, now, config, usd + 1).reason!, /extra usage cap of \$5\.00 this month\. Usage resets on November 1/);
  assert.equal(billingDecision({ ...team, status: "past_due", pastDueSince: now - 6 * day }, 0, now, config).allowed, true, "within grace");
  assert.match(billingDecision({ ...team, status: "past_due", pastDueSince: now - 7 * day }, 0, now, config).reason!, /grace period has ended/);
  assert.equal(billingDecision({ ...team, status: "canceled" }, 0, now, config).plan, "free", "a lapsed subscription falls back to Free");
  const pro = { ...team, plan: "pro" };
  assert.deepEqual(billingDecision(pro, 0, now, config), { allowed: true, plan: "pro", limit: 4 * 12 * usd, used: 0, capMicros: 0, overage: false }, "Pro includes its own usage per seat");
  assert.equal(billingDecision({ ...team, plan: "unknown" }, 0, now, config).plan, "starter", "an unrecorded plan on a subscription is Starter");
  assert.equal(billingDecision({ ...team, seats: 0 }, 9, now, config).limit, 10 * usd, "at least one seat");
  // Stripe does not bill usage recorded during a trial, so a trial's cap never allows overage.
  const trialing = { ...capped, status: "trialing" };
  assert.deepEqual(billingDecision(trialing, 39 * usd, now, config, usd), { allowed: true, plan: "starter", limit: 40 * usd, used: 39 * usd, capMicros: 0, overage: false });
  assert.match(billingDecision(trialing, 40 * usd, now, config, usd).reason!, /extra usage can start once the trial ends/);
});

test("a no-card Starter trial is entitled until it ends, then pauses; paid and Enterprise rows are unchanged", () => {
  assert.equal(billsWorkspaces({}), false);
  assert.equal(billsWorkspaces({ BILLING_ENABLED: "true" }), false, "no Stripe secret means the plan step is skipped");
  assert.equal(billsWorkspaces({ BILLING_ENABLED: "true", STRIPE_SECRET_KEY: "" }), false);
  assert.equal(billsWorkspaces({ BILLING_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_x" }), true);
  const cardless = { status: "trial", seats: 2, trialEndsAt: now + 5 * day, trialStartedAt: now - 9 * day, plan: "starter" };
  assert.deepEqual(billingDecision(cardless, 0, now, config), { allowed: true, plan: "starter", limit: 20 * usd, used: 0, capMicros: 0, overage: false });
  assert.equal(billingDecision({ ...cardless, trialEndsAt: now - 1 }, 0, now, config).allowed, false);
  assert.equal(billingDecision({ ...cardless, trialEndsAt: now - 1 }, 0, now, config).reason, trialEndedReason);
  assert.equal(billingDecision({ ...cardless, trialEndsAt: now - 1 }, 0, now, config).plan, "starter", "expired trial does not delete the plan");
  const paying = { status: "active", seats: 2, trialEndsAt: now - 20 * day, trialStartedAt: now - 30 * day, subscriptionId: "sub_1", plan: "starter" };
  assert.deepEqual(billingDecision(paying, 0, now, config), { allowed: true, plan: "starter", limit: 20 * usd, used: 0, capMicros: 0, overage: false });
  const stripeTrial = { status: "trialing", seats: 2, trialEndsAt: now + 5 * day, trialStartedAt: now, subscriptionId: "sub_1", plan: "starter" };
  assert.equal(billingDecision(stripeTrial, 0, now, config).allowed, true);
  assert.equal(billingDecision(stripeTrial, 0, now, config).plan, "starter");
});

test("fix run limits follow the usage decision's plan and the billed seats", () => {
  const team = { status: "active", seats: 4, trialEndsAt: now - day, subscriptionId: "sub_1" };
  assert.equal(fixRunLimit(billingDecision(team, 0, now, config), 4, config), 20);
  assert.equal(fixRunLimit(billingDecision({ ...team, plan: "pro" }, 0, now, config), 4, config), 80);
  assert.equal(fixRunLimit(billingDecision({ ...team, plan: "pro" }, 0, now, config), 1, config), 20);
  assert.equal(fixRunLimit(billingDecision({ ...team, status: "canceled" }, 0, now, config), 4, config), 0, "a lapsed subscription is Free");
  assert.equal(fixRunLimit(billingDecision(team, 0, now, billingConfig({})), 4, config), null, "billing off is unlimited");
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

test("reviews left: the workspace's own average after five reviews, else a typical standard review; none without a limit", () => {
  assert.equal(reviewsLeft(null, 0, []), null);
  assert.equal(reviewsLeft(3_000_000, 1_050_000, []), 30, "($3 - $1.05) / $0.065");
  // Two calls each for five reviews at $0.10 per review: (3 - 1) / 0.10.
  const calls = Array.from({ length: 10 }, (_, i) => ({ reviewId: `r${i % 5}`, estimatedCost: 0.05 }));
  assert.equal(reviewsLeft(3_000_000, 1_000_000, calls), 20);
  assert.equal(reviewsLeft(3_000_000, 1_000_000, calls.filter((c) => c.reviewId !== "r4")), 30, "four reviews are too few to trust");
  assert.equal(reviewsLeft(3_000_000, 4_000_000, calls), 0, "never negative past the limit");
});

const contract = { id: "c1", mode: "managed" as const, startsAt: 0, endsAt: now + 365 * day, committedContributors: 25, minimumContributors: 25, contributorPriceCents: 2200, includedUsagePerContributorUsd: 12, overageMultiplier: 1.15, netDays: 30, graceDays: 30, nonBillableAuthors: [] };
const enterprise = { status: "active", seats: 3, trialEndsAt: 0, subscriptionId: "sub_e", plan: "enterprise", contract };
test("an Enterprise contract's included usage follows the higher of committed and active contributors", () => {
  const decide = (active: number, used = 0, request = 0, account: typeof enterprise & { spendCapUsd?: number } = enterprise) => billingDecision(account, used, now, config, request, undefined, active);
  assert.deepEqual([decide(0), decide(10), decide(40)].map((d) => [d.plan, d.limit, d.units]), [["enterprise", 300 * usd, 25], ["enterprise", 300 * usd, 25], ["enterprise", 480 * usd, 40]]);
  assert.equal(decide(0, 300 * usd).allowed, false, "past the included usage with no cap");
  assert.deepEqual([decide(0, 300 * usd, usd, { ...enterprise, spendCapUsd: 50 })].map((d) => [d.allowed, d.overage]), [[true, true]], "the cap and overage work as on seat plans");
  assert.equal(fixRunLimit(decide(40), 3, config), 40 * config.proFixesPerSeat, "fix runs follow billed contributors, not seats");
  assert.equal(billingDecision({ ...enterprise, contract: undefined }, 0, now, config).plan, "starter", "no contract never means unlimited");
  assert.equal(billingDecision(enterprise, 0, now, billingConfig({}), 5, undefined, 0).allowed, true, "billing off allows everything");
  assert.equal(billingDecision({ ...enterprise, trialStartedAt: now - 20 * day, trialEndsAt: now - day }, 0, now, config, 0, undefined, 25).plan, "enterprise", "a leftover no-card trial does not override Enterprise");
  assert.equal(billingDecision({ ...enterprise, trialStartedAt: now - 20 * day, trialEndsAt: now - day }, 0, now, config, 0, undefined, 25).allowed, true);
});
test("an own-key contract meters nothing and Enterprise past due uses the contract's grace days", () => {
  const ownKey = { ...enterprise, spendCapUsd: 100, contract: { ...contract, mode: "ownKey" as const } };
  assert.deepEqual([billingDecision(ownKey, 0, now, config)].map((d) => [d.allowed, d.limit, d.capMicros]), [[true, 0, 0]], "reviews may start");
  assert.deepEqual([billingDecision(ownKey, 0, now, config, 10_000)].map((d) => [d.allowed, d.reason]), [[false, ownKeyOnlyReason]], "a call on the operator's model is refused");
  const pastDue = (days: number) => billingDecision({ ...enterprise, status: "past_due", pastDueSince: now - days * day }, 0, now, config).allowed;
  assert.deepEqual([pastDue(8), pastDue(29), pastDue(30)], [true, true, false], "30 contract days, not the 7 of seat plans");
});
test("the contributor meter event bills only above the commitment, with one identifier per month inside that month", () => {
  const event = contributorMeterEvent("org1", "2026-10", 31, 25);
  assert.deepEqual(event, { identifier: "contributors:org1:2026-10", timestamp: Date.UTC(2026, 10, 1) / 1000 - 1, value: 6 });
  assert.equal(periodKey(event.timestamp * 1000), "2026-10");
  assert.equal(contributorMeterEvent("org1", "2026-10", 20, 25).value, 0);
  assert.equal(contributorMeterEvent("org1", "2026-12", 1, 0).timestamp, Date.UTC(2027, 0, 1) / 1000 - 1);
});

test("contract terms are checked before anything is saved, and the preview is the year's commitment up front", () => {
  const terms = { mode: "managed" as const, startsAt: Date.UTC(2026, 10, 1), committedContributors: 30, contributorPriceCents: 2200, includedUsagePerContributorUsd: 12, overageMultiplier: 1.15, netDays: 30, graceDays: 30, nonBillableAuthors: ["release-bot"] };
  assert.equal(contractTermsError(terms, config), null);
  const refused = (change: Partial<typeof terms> & { usagePriceId?: string }) => contractTermsError({ ...terms, ...change }, config) !== null;
  assert.deepEqual([{ startsAt: Date.UTC(2026, 10, 2) }, { startsAt: Date.UTC(2026, 10, 1, 5) }, { committedContributors: 24 }, { committedContributors: 30.5 }, { contributorPriceCents: 0 }, { overageMultiplier: 0.9 }, { netDays: 400 }, { usagePriceId: "prod_1" }, { nonBillableAuthors: [""] }].map(refused), Array(9).fill(true));
  assert.equal(contractEnd(Date.UTC(2026, 10, 1)), Date.UTC(2027, 10, 1));
  assert.deepEqual(contractPreview(terms), { firstInvoiceCents: 30 * 2200 * 12, perExtraContributorCents: 2200, includedUsageUsd: 360 });
  assert.equal(contractPreview({ ...terms, mode: "ownKey" }).includedUsageUsd, 0);
});
