import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import { createHash, createHmac, randomBytes } from "node:crypto";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// Phase 3 of the referral program: refunds and disputes claw commissions back, and referrers redeem
// their balance as credit on a workspace bill. Stripe is mocked through fetch; nothing calls the network.
const modules = import.meta.glob("../convex/**/*.ts");
const secret = "referral-credit-session-secret-at-least-32-chars", svc = "referral-credit-service", whsec = "whsec_referral_credit";
const env = { SESSION_SECRET: secret, SERVICE_SECRET: svc, APP_URL: "https://review.example.com", BILLING_ENABLED: "true", REFERRALS_ENABLED: "true", STRIPE_WEBHOOK_SECRET: whsec, STRIPE_SECRET_KEY: "rk_test_fixture" };
beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); vi.setSystemTime(Date.UTC(2026, 9, 14, 12)); Object.assign(process.env, env); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const key of [...Object.keys(env), "OPENREVIEW_OFFLINE"]) if (key !== "SESSION_SECRET" && key !== "SERVICE_SECRET") delete process.env[key]; });

type T = ReturnType<typeof convexTest>;
const jwt = (userId: string) => new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setSubject(userId).setIssuedAt().setExpirationTime("400d").sign(new TextEncoder().encode(secret));
async function signIn(t: T, id: number, login: string, referralCode?: string) {
  const userId = await t.mutation(api.identity.signIn, { secret: svc, avatar: "", provider: "github", providerUserId: String(id), login, emailVerified: false, sessionHash: createHash("sha256").update(randomBytes(32).toString("base64url")).digest("hex"), ...(referralCode ? { referralCode } : {}) });
  return { userId, token: await jwt(userId) };
}
type User = Awaited<ReturnType<typeof signIn>>;
const run = (t: T) => t.finishAllScheduledFunctions(() => vi.runAllTimersAsync());
const deliver = (t: T, event: Record<string, unknown>) => {
  const body = JSON.stringify(event), ts = Math.floor(Date.now() / 1000);
  return t.fetch("/stripe/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${ts},v1=${createHmac("sha256", whsec).update(`${ts}.${body}`).digest("hex")}` }, body });
};
let events = 0;
const event = (type: string, object: Record<string, unknown>) => ({ id: `evt_${++events}`, type, created: Math.floor(Date.now() / 1000), data: { object } });
const outcomes = (t: T) => t.run(async (ctx) => (await ctx.db.query("stripeEvents").collect()).map((e) => [e.type, e.outcome]));
const commission = async (t: T) => (await t.run((ctx) => ctx.db.query("referralCommissions").collect()))[0];
const redemptions = (t: T) => t.run((ctx) => ctx.db.query("referralRedemptions").collect());
const audits = async (t: T, prefix: string) => (await t.run((ctx) => ctx.db.query("auditEvents").collect())).filter((e) => e.action.startsWith(prefix)).map((e) => [e.action, e.organizationId, e.userId, e.target]);

const invoicePaid = (id: string) => event("invoice.paid", { id, customer: "cus_bob", parent: { subscription_details: { subscription: "sub_bob" } }, amount_paid: 12000, amount_overpaid: 0, total: 12000, total_excluding_tax: 10000, currency: "usd", created: Math.floor(Date.now() / 1000), status_transitions: { paid_at: Math.floor(Date.now() / 1000) } });
// Alice refers Bob; Bob's workspace pays invoice in_1 ($120 incl. tax → $20 commission), and Alice
// has a subscribed workspace of her own to credit. With `released`, the 30-day hold has passed.
async function setup(t: T, released = true) {
  const alice = await signIn(t, 1, "alice"), code = (await t.mutation(api.referrals.ensureCode, { token: alice.token }))!;
  const bob = await signIn(t, 2, "bob", code), bobCo = await t.mutation(api.users.createOrganization, { token: bob.token, name: "Bob Co" });
  const aliceCo = await t.mutation(api.users.createOrganization, { token: alice.token, name: "Alice Co" });
  await t.run(async (ctx) => {
    await ctx.db.insert("billingAccounts", { organizationId: bobCo, customerId: "cus_bob", subscriptionId: "sub_bob", status: "active", seats: 1, trialEndsAt: Date.now(), updatedAt: Date.now() });
    await ctx.db.insert("billingAccounts", { organizationId: aliceCo, customerId: "cus_alice", subscriptionId: "sub_alice", status: "active", seats: 1, trialEndsAt: Date.now(), updatedAt: Date.now() });
  });
  await deliver(t, invoicePaid("in_1"));
  await run(t);
  if (released) vi.setSystemTime(Date.now() + 30 * 86400000);
  return { alice, bob, bobCo, aliceCo };
}

// Stripe by method and path; every request is recorded with its query, body and idempotency key.
type Call = { method: string; path: string; query: URLSearchParams; body: URLSearchParams; key: string | null };
function mockStripe(routes: Record<string, (call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), call = { method: init?.method ?? "GET", path: url.pathname, query: url.searchParams, body: new URLSearchParams(String(init?.body ?? "")), key: new Headers(init?.headers).get("idempotency-key") };
    calls.push(call);
    return routes[`${call.method} ${call.path}`]?.(call) ?? Response.json({ error: { type: "unexpected_in_test" } }, { status: 418 });
  });
  return calls;
}
const list = (data: unknown[], has_more = false) => Response.json({ object: "list", data, has_more });
const charge = (refunded: number, disputed = false, customer = "cus_bob") => () => Response.json({ id: "ch_1", amount: 12000, amount_refunded: refunded, disputed, customer, payment_intent: "pi_1" });
// in_1 is on the second page, after an invoice of another customer.
const invoicePayments = (call: Call) => call.query.get("starting_after") === "inpay_0" ? list([{ id: "inpay_1", invoice: "in_1" }]) : list([{ id: "inpay_0", invoice: "in_other" }], true);

test("a refund webhook re-reads the charge, pages through the invoices it paid and claws the commission back", async () => {
  const t = convexTest(schema, modules);
  const { alice } = await setup(t, false);
  expect(await commission(t)).toMatchObject({ invoiceId: "in_1", amount: 2000, reversed: 0 });
  let calls = mockStripe({ "GET /v1/charges/ch_1": charge(6000), "GET /v1/invoice_payments": invoicePayments });
  // The event's own amounts are never trusted: only the charge id is used.
  expect((await deliver(t, event("charge.refunded", { id: "ch_1", object: "charge", customer: "cus_bob", payment_intent: "pi_1", amount_refunded: 1 }))).status).toBe(200);
  await run(t);
  expect(await commission(t)).toMatchObject({ reversed: 1000, charges: [{ id: "ch_1", amount: 12000, refunded: 6000, fetchedAt: Date.now() }] });
  expect(calls.map((c) => [c.method, c.path, c.query.toString(), c.body.toString()])).toEqual([
    ["GET", "/v1/charges/ch_1", "", ""],
    ["GET", "/v1/invoice_payments", "payment%5Btype%5D=payment_intent&payment%5Bpayment_intent%5D=pi_1&status=paid&limit=100", ""],
    ["GET", "/v1/invoice_payments", "payment%5Btype%5D=payment_intent&payment%5Bpayment_intent%5D=pi_1&status=paid&limit=100&starting_after=inpay_0", ""],
  ]);
  expect(await t.query(api.referrals.overview, { token: alice.token })).toMatchObject({ onHold: 1000, activity: [{ what: "Commission · bob", amount: 1000, status: "on hold", reversed: 1000 }] });
  // A full refund later reverses all of it, also after the program is switched off (billing stays on).
  process.env.REFERRALS_ENABLED = "false";
  vi.advanceTimersByTime(1000);
  calls = mockStripe({ "GET /v1/charges/ch_1": charge(12000), "GET /v1/invoice_payments": invoicePayments });
  await deliver(t, event("charge.refunded", { id: "ch_1", object: "charge", customer: "cus_bob", payment_intent: "pi_1" }));
  await run(t);
  expect(await commission(t)).toMatchObject({ reversed: 2000 });
  // Charges of a workspace nobody referred, and refunds without a customer, schedule nothing.
  await deliver(t, event("charge.refunded", { id: "ch_2", object: "charge", customer: "cus_alice", payment_intent: "pi_2" }));
  await deliver(t, event("charge.refunded", { id: "ch_3", object: "charge", customer: null, payment_intent: "pi_3" }));
  // An odd shape is ignored, never rejected.
  expect((await deliver(t, event("charge.dispute.created", { id: "dp_9", object: "dispute", charge: 42, payment_intent: { nested: true } }))).status).toBe(200);
  await run(t);
  expect(calls).toHaveLength(3);
  expect(await outcomes(t)).toEqual([["invoice.paid", "invoice.paid"], ["charge.refunded", "referral check queued"], ["charge.refunded", "referral check queued"], ["charge.refunded", "ignored"], ["charge.refunded", "ignored"], ["charge.dispute.created", "ignored"]]);
});

test("an older fetch of the same charge never overwrites a newer one", async () => {
  const t = convexTest(schema, modules);
  await setup(t, false);
  const facts = (refunded: number, fetchedAt: number) => ({ invoiceId: "in_1", charge: { id: "ch_1", amount: 12000, refunded, fetchedAt } });
  expect(await t.mutation(internal.referrals.applyChargeEvent, facts(12000, 2000))).toBe("applied");
  expect(await t.mutation(internal.referrals.applyChargeEvent, facts(0, 1000))).toBe("stale");
  expect(await t.mutation(internal.referrals.applyChargeEvent, facts(0, 2000))).toBe("stale");
  expect(await commission(t)).toMatchObject({ reversed: 2000, charges: [{ refunded: 12000, fetchedAt: 2000 }] });
  // A newer fetch wins even when it lowers the reversal (a refund that failed).
  expect(await t.mutation(internal.referrals.applyChargeEvent, facts(0, 3000))).toBe("applied");
  expect(await commission(t)).toMatchObject({ reversed: 0 });
  expect(await t.mutation(internal.referrals.applyChargeEvent, { ...facts(0, 4000), invoiceId: "in_unknown" })).toBe("no commission");
});

test("a refund still claws back after the referred workspace was deleted; with no commissions at all, nothing is queued", async () => {
  const fresh = convexTest(schema, modules), none = mockStripe({});
  await deliver(fresh, event("charge.dispute.created", { id: "dp_1", object: "dispute", charge: "ch_1" }));
  await deliver(fresh, event("charge.refunded", { id: "ch_1", object: "charge", customer: "cus_unknown" }));
  await run(fresh);
  expect(none).toEqual([]);
  expect(await outcomes(fresh)).toEqual([["charge.dispute.created", "ignored"], ["charge.refunded", "ignored"]]);
  const t = convexTest(schema, modules);
  await setup(t, false);
  // The purge drops the workspace's billing account, so its customer is unknown from then on.
  await t.run(async (ctx) => { for (const a of await ctx.db.query("billingAccounts").withIndex("by_customer", (q) => q.eq("customerId", "cus_bob")).collect()) await ctx.db.delete(a._id); });
  mockStripe({ "GET /v1/charges/ch_1": charge(12000), "GET /v1/invoice_payments": invoicePayments });
  await deliver(t, event("charge.refunded", { id: "ch_1", object: "charge", customer: "cus_bob", payment_intent: "pi_1" }));
  await run(t);
  expect((await outcomes(t)).at(-1)).toEqual(["charge.refunded", "referral check queued"]);
  expect(await commission(t)).toMatchObject({ reversed: 2000 });
});

test("a refund seen before its invoice's commission exists is looked at again", async () => {
  const t = convexTest(schema, modules);
  await setup(t, false);
  mockStripe({ "GET /v1/charges/ch_1": charge(12000), "GET /v1/invoice_payments": () => list([{ id: "inpay_2", invoice: "in_2" }]) });
  expect(await t.action(internal.referralJobs.resolveChargeEvent, { chargeId: "ch_1", kind: "refund", customer: "cus_bob" })).toBe("retrying");
  // invoice.paid for in_2 arrives late; the retry a minute later reverses its new commission.
  await deliver(t, invoicePaid("in_2"));
  await run(t);
  expect((await t.run((ctx) => ctx.db.query("referralCommissions").collect())).map((c) => [c.invoiceId, c.reversed])).toEqual([["in_1", 0], ["in_2", 2000]]);
  // After the last retry it gives up.
  mockStripe({ "GET /v1/charges/ch_1": charge(12000), "GET /v1/invoice_payments": () => list([{ id: "inpay_3", invoice: "in_3" }]) });
  expect(await t.action(internal.referralJobs.resolveChargeEvent, { chargeId: "ch_1", kind: "refund", customer: "cus_bob", attempt: 4 })).toBe("no commission");
});

test("a dispute without a payment intent resolves through the charge: open reverses, won restores", async () => {
  const t = convexTest(schema, modules);
  await setup(t, false);
  let status = "needs_response";
  const calls = mockStripe({ "GET /v1/charges/ch_1": charge(0, true), "GET /v1/disputes": () => list([{ id: "dp_1", charge: "ch_1", status, amount: 12000 }]), "GET /v1/invoice_payments": invoicePayments });
  // Disputes name their charge in `charge` (sometimes expanded) and carry no customer.
  await deliver(t, event("charge.dispute.created", { id: "dp_1", object: "dispute", charge: "ch_1", payment_intent: null, status: "needs_response", amount: 12000 }));
  await run(t);
  expect(await commission(t)).toMatchObject({ reversed: 2000, charges: [{ id: "ch_1", dispute: { id: "dp_1", status: "needs_response", amount: 12000 } }] });
  expect(calls.find((c) => c.path === "/v1/disputes")?.query.toString()).toBe("charge=ch_1&limit=1");
  expect(calls.find((c) => c.path === "/v1/invoice_payments")?.query.get("payment[payment_intent]")).toBe("pi_1");
  status = "won";
  vi.advanceTimersByTime(1000);
  await deliver(t, event("charge.dispute.closed", { id: "dp_1", object: "dispute", charge: { id: "ch_1", object: "charge" }, payment_intent: "pi_1", status: "won" }));
  await run(t);
  expect(await commission(t)).toMatchObject({ reversed: 0, charges: [{ dispute: { status: "won" } }] });
  expect((await outcomes(t)).filter(([type]) => type.startsWith("charge.dispute")).map(([, outcome]) => outcome)).toEqual(["referral check queued", "referral check queued"]);
  // A dispute of a workspace nobody referred stops after reading its charge.
  const other = mockStripe({ "GET /v1/charges/ch_1": charge(0, true, "cus_alice") });
  expect(await t.action(internal.referralJobs.resolveChargeEvent, { chargeId: "ch_1", kind: "dispute" })).toBe("no referral");
  expect(other.map((c) => c.path)).toEqual(["/v1/charges/ch_1"]);
});

test("a failed Stripe read is retried a few times, then logged", async () => {
  const t = convexTest(schema, modules);
  await setup(t, false);
  let failures = 1;
  mockStripe({ "GET /v1/charges/ch_1": () => failures-- > 0 ? Response.json({ error: { type: "api_error" } }, { status: 500 }) : charge(12000)(), "GET /v1/invoice_payments": invoicePayments });
  await deliver(t, event("charge.refunded", { id: "ch_1", object: "charge", customer: "cus_bob", payment_intent: "pi_1" }));
  await run(t);
  expect(await commission(t)).toMatchObject({ reversed: 2000 });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  failures = 99;
  await t.action(internal.referralJobs.resolveChargeEvent, { chargeId: "ch_1", kind: "refund", attempt: 3 });
  await expect(t.action(internal.referralJobs.resolveChargeEvent, { chargeId: "ch_1", kind: "refund", attempt: 4 })).rejects.toThrow(/500/);
  expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({ event: "referral.charge_unresolved", kind: "refund", reason: "Stripe request failed (500 api_error)" });
});

const request = (t: T, user: User, organizationId: Id<"organizations">, amount: number) => t.mutation(api.referrals.requestCredit, { token: user.token, organizationId, amount });
const creditStripe = (post: (call: Call) => Response | Promise<Response> = () => Response.json({ id: "cbtxn_1", object: "customer_balance_transaction" }), found: (call: Call) => Response = () => list([])) => mockStripe({ "GET /v1/customers/cus_alice/balance_transactions": found, "GET /v1/customers/cus_alice": () => Response.json({ id: "cus_alice", currency: "usd" }), "POST /v1/customers/cus_alice/balance_transactions": post });
const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST");

test("credit requests: admins of a workspace with a Stripe customer, within the available balance and above the minimum", async () => {
  const t = convexTest(schema, modules);
  const { alice, bob, bobCo, aliceCo } = await setup(t, false);
  const mia = await signIn(t, 3, "mia");
  await t.mutation(api.users.acceptInvitation, { token: mia.token, invitationId: await t.mutation(api.users.invite, { token: alice.token, organizationId: aliceCo, githubLogin: "mia", role: "member" }) });
  const bare = await t.mutation(api.users.createOrganization, { token: alice.token, name: "Alice Bare" });
  await expect(request(t, mia, aliceCo, 1000)).rejects.toThrow(/Forbidden/);
  await expect(request(t, alice, bobCo, 1000)).rejects.toThrow(/Forbidden/);
  // Still on hold: nothing to redeem.
  expect(await request(t, alice, aliceCo, 1000)).toEqual({ ok: false, error: "You have no earnings available to redeem yet." });
  vi.setSystemTime(Date.now() + 30 * 86400000);
  expect(await request(t, alice, aliceCo, 999)).toEqual({ ok: false, error: "The smallest credit is $10.00." });
  expect(await request(t, alice, aliceCo, 1500.5)).toEqual({ ok: false, error: "The smallest credit is $10.00." });
  expect(await request(t, alice, aliceCo, 2001)).toEqual({ ok: false, error: "You have $20.00 available." });
  expect(await request(t, alice, bare, 1000)).toEqual({ ok: false, error: "This workspace has no Stripe billing account yet. Subscribe in Settings → Billing first." });
  expect(await redemptions(t)).toEqual([]);
  // The overview offers only workspaces Alice administers that have a customer; Bob gets none of hers.
  expect(await t.query(api.referrals.overview, { token: alice.token })).toMatchObject({ available: 2000, redeemed: 0, onHold: 0, workspaces: [{ organizationId: aliceCo, name: "Alice Co" }] });
  expect(await t.query(api.referrals.overview, { token: bob.token })).toMatchObject({ workspaces: [{ organizationId: bobCo, name: "Bob Co" }] });
  // Ten attempts an hour, rejected ones included: four since the clock moved on, five here, the tenth still checked, the eleventh refused.
  for (let i = 0; i < 5; i++) await request(t, alice, aliceCo, 1);
  expect(await request(t, alice, aliceCo, 1)).toEqual({ ok: false, error: "The smallest credit is $10.00." });
  expect(await request(t, alice, aliceCo, 1000)).toEqual({ ok: false, error: "Too many credit requests. Try again in an hour." });
  process.env.REFERRALS_ENABLED = "false";
  expect(await request(t, alice, aliceCo, 1000)).toEqual({ ok: false, error: "This deployment doesn’t run the referral program." });
});

test("past 5000 redemption rows nothing more can be redeemed, since newer rows would go uncounted", async () => {
  const t = convexTest(schema, modules);
  const { alice, aliceCo } = await setup(t);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const row = { userId: alice.userId, kind: "credit" as const, amount: 1000, currency: "usd", customerId: "cus_alice", status: "failed" as const, idempotencyKey: "k", keyIssuedAt: 1, attempts: 0, createdAt: 1, updatedAt: 1 };
  await t.run(async (ctx) => { for (let i = 0; i < 4999; i++) await ctx.db.insert("referralRedemptions", row); });
  // One under the limit, $20 is still available; at the limit, nothing is.
  expect(await request(t, alice, aliceCo, 2000)).toEqual({ ok: true });
  expect(await request(t, alice, aliceCo, 1000)).toEqual({ ok: false, error: "You have no earnings available to redeem yet." });
  expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({ event: "referral.ledger_full", userId: alice.userId });
  const review = await t.run((ctx) => ctx.db.insert("referralRedemptions", { ...row, kind: "payout", amount: 5000, customerId: undefined, accountId: "acct_1Alice", status: "review" }));
  await expect(t.mutation(internal.referralOps.approveRedemption, { redemptionId: review })).rejects.toThrow(/5000 or more redemptions/);
});

test("a credit looks Stripe up, then posts a negative balance transaction with its stored key, once", async () => {
  const t = convexTest(schema, modules);
  const { alice, aliceCo } = await setup(t);
  const calls = creditStripe();
  expect(await request(t, alice, aliceCo, 1500)).toEqual({ ok: true });
  const [pending] = await redemptions(t);
  expect(pending).toMatchObject({ userId: alice.userId, kind: "credit", amount: 1500, currency: "usd", creditOrganizationId: aliceCo, customerId: "cus_alice", status: "processing", idempotencyKey: `referral-credit:${pending._id}:1`, keyIssuedAt: Date.now(), attempts: 0 });
  // Requested money is spoken for at once.
  expect(await t.query(api.referrals.overview, { token: alice.token })).toMatchObject({ available: 500, redeemed: 1500 });
  expect(await request(t, alice, aliceCo, 1000)).toEqual({ ok: false, error: "You have $5.00 available." });
  await run(t);
  const [done] = await redemptions(t);
  expect(done).toMatchObject({ status: "completed", stripeId: "cbtxn_1", completedAt: Date.now(), attempts: 0 });
  expect(done.leaseId).toBeUndefined();
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/customers/cus_alice/balance_transactions", "GET /v1/customers/cus_alice", "POST /v1/customers/cus_alice/balance_transactions"]);
  expect(calls[0].query.toString()).toBe(`created%5Bgte%5D=${Math.floor(done.createdAt / 1000) - 300}&limit=100`);
  const [post] = posts(calls);
  expect(Object.fromEntries(post.body)).toEqual({ amount: "-1500", currency: "usd", description: "OpenReview referral credit", "metadata[referralRedemptionId]": done._id });
  expect(post.key).toBe(`referral-credit:${done._id}:1`);
  expect(await audits(t, "referral.credit")).toEqual([["referral.credit_requested", aliceCo, alice.userId, done._id], ["referral.credit_applied", aliceCo, undefined, done._id]]);
  expect(await t.query(api.billing.status, { token: alice.token, organizationId: aliceCo })).toMatchObject({ referralCredit: 1500 });
  expect(await t.query(api.referrals.overview, { token: alice.token })).toMatchObject({ available: 500, redeemed: 1500, activity: [{ what: "Credit to Alice Co", amount: -1500, status: "completed" }, { what: "Commission · bob", amount: 2000, status: "available" }] });
  // The cron finds nothing left to do.
  expect(await t.action(internal.referralJobs.reconcileRedemptions, {})).toBe(0);
  expect(posts(calls)).toHaveLength(1);
  // A full refund after redeeming leaves the balance negative.
  mockStripe({ "GET /v1/charges/ch_1": charge(12000), "GET /v1/invoice_payments": invoicePayments });
  await deliver(t, event("charge.refunded", { id: "ch_1", object: "charge", customer: "cus_bob", payment_intent: "pi_1" }));
  await run(t);
  expect(await t.query(api.referrals.overview, { token: alice.token })).toMatchObject({ available: -1500, redeemed: 1500 });
});

test("two runs at once: the second gets 409 while the first posts, and the credit completes with one object", async () => {
  const t = convexTest(schema, modules);
  const { alice, aliceCo } = await setup(t);
  let finishFirst!: () => void, posted!: () => void;
  const firstPosting = new Promise<void>((resolve) => { posted = resolve; });
  const calls = creditStripe(() => posts(calls).length === 1 ? new Promise((resolve) => { finishFirst = () => resolve(Response.json({ id: "cbtxn_1" })); posted(); }) : Response.json({ error: { type: "idempotency_error", code: "idempotency_key_in_use" } }, { status: 409 }));
  await request(t, alice, aliceCo, 2000);
  const [{ _id: redemptionId }] = await redemptions(t);
  const first = t.action(internal.referralJobs.processRedemption, { redemptionId });
  await firstPosting;
  // While the first run holds its lease, another run skips the row, and an operator can't settle it.
  expect(await t.action(internal.referralJobs.processRedemption, { redemptionId })).toBe("skipped");
  await expect(t.mutation(internal.referralOps.resolveStuck, { redemptionId, outcome: "failed" })).rejects.toThrow(/A run is processing/);
  // The first run hangs past its 5-minute lease: the next run looks up, finds nothing yet, and posts.
  vi.setSystemTime(Date.now() + 6 * 60000);
  expect(await t.action(internal.referralJobs.processRedemption, { redemptionId })).toBe("retry");
  expect((await redemptions(t))[0]).toMatchObject({ status: "processing", attempts: 1, error: "Stripe request failed (409 idempotency_error idempotency_key_in_use)" });
  finishFirst();
  expect(await first).toBe("completed");
  expect((await redemptions(t))[0]).toMatchObject({ status: "completed", stripeId: "cbtxn_1" });
  expect(posts(calls).map((c) => c.key)).toEqual([`referral-credit:${redemptionId}:1`, `referral-credit:${redemptionId}:1`]);
});

test("after a 5xx the credit is never posted again; a later lookup finds it on a second page and completes it", async () => {
  const t = convexTest(schema, modules);
  const { alice, aliceCo } = await setup(t);
  let created = false;
  const unrelated = Array.from({ length: 100 }, (_, i) => ({ id: `cbtxn_other${i}`, metadata: {} }));
  const calls = creditStripe(() => Response.json({ error: { type: "api_error" } }, { status: 500 }), (call) => !created ? list([]) : call.query.get("starting_after") ? list([{ id: "cbtxn_late", metadata: { referralRedemptionId: redemptionId } }]) : list(unrelated, true));
  await request(t, alice, aliceCo, 2000);
  const [{ _id: redemptionId }] = await redemptions(t);
  await run(t);
  expect((await redemptions(t))[0]).toMatchObject({ status: "processing", attempts: 1, indeterminateAt: Date.now() });
  // Later runs only look it up, and after a day the row is reported for an operator.
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.setSystemTime(Date.now() + 25 * 3600000);
  expect(await t.action(internal.referralJobs.reconcileRedemptions, {})).toBe(1);
  expect(posts(calls)).toHaveLength(1);
  expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{ event: "referral.redemption_stuck", redemptionId, kind: "credit", attempts: 1, indeterminate: true }]);
  expect((await redemptions(t))[0]).toMatchObject({ status: "processing", attempts: 1 });
  await expect(t.mutation(internal.referralOps.resolveStuck, { redemptionId, outcome: "completed" })).rejects.toThrow(/stripeId/);
  // Stripe created it after all: the lookup pages past 100 other transactions and completes the row.
  created = true;
  await t.action(internal.referralJobs.reconcileRedemptions, {});
  expect((await redemptions(t))[0]).toMatchObject({ status: "completed", stripeId: "cbtxn_late" });
  expect(posts(calls)).toHaveLength(1);
  expect(calls.filter((c) => c.query.get("starting_after") === "cbtxn_other99")).toHaveLength(1);
  await expect(t.mutation(internal.referralOps.resolveStuck, { redemptionId, outcome: "failed" })).rejects.toThrow(/already completed/);
});

test("a definite 4xx fails the credit once a lookup confirms nothing exists, and the balance is released", async () => {
  const t = convexTest(schema, modules);
  const { alice, aliceCo } = await setup(t);
  const calls = creditStripe(() => Response.json({ error: { type: "invalid_request_error", code: "parameter_invalid_integer", message: "secret detail" } }, { status: 400 }));
  await request(t, alice, aliceCo, 2000);
  expect(await t.query(api.referrals.overview, { token: alice.token })).toMatchObject({ available: 0 });
  await run(t);
  const [failed] = await redemptions(t);
  expect(failed).toMatchObject({ status: "failed", error: "Stripe didn’t accept the credit, so the amount is back in your balance." });
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/customers/cus_alice/balance_transactions", "GET /v1/customers/cus_alice", "POST /v1/customers/cus_alice/balance_transactions", "GET /v1/customers/cus_alice/balance_transactions"]);
  expect(await t.query(api.referrals.overview, { token: alice.token })).toMatchObject({ available: 2000, redeemed: 0, activity: [{ what: "Credit to Alice Co", status: "failed", error: failed.error }, { what: "Commission · bob" }] });
  expect(await audits(t, "referral.credit")).toEqual([["referral.credit_requested", aliceCo, alice.userId, failed._id], ["referral.credit_failed", aliceCo, undefined, failed._id]]);
});

test("offline, a credit waits in processing without counting an attempt, and completes once egress is back", async () => {
  const t = convexTest(schema, modules);
  const { alice, aliceCo } = await setup(t);
  const calls = creditStripe();
  process.env.OPENREVIEW_OFFLINE = "true";
  await request(t, alice, aliceCo, 2000);
  await run(t);
  expect((await redemptions(t))[0]).toMatchObject({ status: "processing", attempts: 0, error: expect.stringMatching(/offline mode/) });
  expect(await t.action(internal.referralJobs.reconcileRedemptions, {})).toBe(0);
  expect(calls).toEqual([]);
  delete process.env.OPENREVIEW_OFFLINE;
  expect(await t.action(internal.referralJobs.reconcileRedemptions, {})).toBe(1);
  expect((await redemptions(t))[0]).toMatchObject({ status: "completed", stripeId: "cbtxn_1", attempts: 0 });
  expect(posts(calls)).toHaveLength(1);
});

test("a workspace billed in another currency, or whose Stripe customer was deleted, fails before anything is posted", async () => {
  const t = convexTest(schema, modules);
  const { alice, aliceCo } = await setup(t);
  let customer: Record<string, unknown> = { id: "cus_alice", currency: "eur" }, transactions = () => list([]);
  const calls = mockStripe({ "GET /v1/customers/cus_alice/balance_transactions": () => transactions(), "GET /v1/customers/cus_alice": () => Response.json(customer) });
  await request(t, alice, aliceCo, 1000);
  await run(t);
  customer = { id: "cus_alice", deleted: true };
  await request(t, alice, aliceCo, 1000);
  await run(t);
  // Stripe may answer the lookup itself with 404 for a deleted customer (or one from the other Stripe mode).
  transactions = () => Response.json({ error: { type: "invalid_request_error", code: "resource_missing" } }, { status: 404 });
  await request(t, alice, aliceCo, 1000);
  await run(t);
  const gone = "This workspace’s Stripe customer no longer exists, so it can’t take credit.";
  expect((await redemptions(t)).map((r) => [r.status, r.error])).toEqual([["failed", "This workspace is billed in EUR; referral credit is in USD."], ["failed", gone], ["failed", gone]]);
  expect(posts(calls)).toEqual([]);
  expect(await t.query(api.referrals.overview, { token: alice.token })).toMatchObject({ available: 2000 });
  // Operators settle stuck rows by hand; a failure returns the amount.
  await t.run((ctx) => ctx.db.insert("referralRedemptions", { userId: alice.userId, kind: "credit", amount: 500, currency: "usd", creditOrganizationId: aliceCo, status: "processing", idempotencyKey: "referral-credit:x:1", keyIssuedAt: 1, attempts: 3, createdAt: 1, updatedAt: 1 }));
  const stuck = (await redemptions(t)).find((r) => r.status === "processing")!;
  expect(await t.query(api.referrals.overview, { token: alice.token })).toMatchObject({ available: 1500 });
  await t.mutation(internal.referralOps.resolveStuck, { redemptionId: stuck._id, outcome: "failed" });
  expect(await t.query(api.referrals.overview, { token: alice.token })).toMatchObject({ available: 2000 });
  expect((await audits(t, "referral.redemption")).map(([action, org]) => [action, org])).toEqual([["referral.redemption_failed", aliceCo]]);
});
