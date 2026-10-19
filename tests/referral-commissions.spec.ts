import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import { createHash, createHmac, randomBytes } from "node:crypto";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// Phase 2 of the referral program: the Checkout coupon, codes added in Settings → Billing, and the
// commission ledger fed by invoice.paid. Stripe is mocked through fetch; nothing calls the network.
const modules = import.meta.glob("../convex/**/*.ts");
const secret = "referral-ledger-session-secret-at-least-32-chars", svc = "referral-ledger-service", whsec = "whsec_referral_fixture";
const env = { SESSION_SECRET: secret, SERVICE_SECRET: svc, APP_URL: "https://review.example.com", BILLING_ENABLED: "true", REFERRALS_ENABLED: "true", STRIPE_REFERRAL_COUPON_ID: "referral-20-3mo", STRIPE_WEBHOOK_SECRET: whsec, STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_SEAT_PRICE_ID: "price_seat" };
beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); vi.setSystemTime(Date.UTC(2026, 9, 14, 12)); Object.assign(process.env, env); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const key of [...Object.keys(env), "RESEND_API_KEY", "EMAIL_FROM"]) if (key !== "SESSION_SECRET" && key !== "SERVICE_SECRET") delete process.env[key]; });

type T = ReturnType<typeof convexTest>;
// Tokens without a session id, so they outlive the 7-day browser session across the tests' time jumps.
const jwt = (userId: string) => new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setSubject(userId).setIssuedAt().setExpirationTime("400d").sign(new TextEncoder().encode(secret));
async function signIn(t: T, id: number, login: string, referralCode?: string) {
  const sid = randomBytes(32).toString("base64url");
  const userId = await t.mutation(api.identity.signIn, { secret: svc, avatar: "", provider: "github", providerUserId: String(id), login, emailVerified: false, sessionHash: createHash("sha256").update(sid).digest("hex"), ...(referralCode ? { referralCode } : {}) });
  return { userId, token: await jwt(userId) };
}
type User = Awaited<ReturnType<typeof signIn>>;
const workspace = (t: T, user: User, name: string) => t.mutation(api.users.createOrganization, { token: user.token, name });
const join = async (t: T, owner: User, org: Id<"organizations">, user: User, login: string, role: "admin" | "member" | "viewer") => t.mutation(api.users.acceptInvitation, { token: user.token, invitationId: await t.mutation(api.users.invite, { token: owner.token, organizationId: org, githubLogin: login, role }) });
const memberOf = async (t: T, org: Id<"organizations">, userId: Id<"users">) => (await t.run((ctx) => ctx.db.query("organizationMembers").collect())).find((m) => m.organizationId === org && m.userId === userId)!._id;
const referralOf = async (t: T, userId: Id<"users">) => (await t.run((ctx) => ctx.db.query("referrals").collect())).find((r) => r.referredUserId === userId)!;
const commissions = (t: T) => t.run((ctx) => ctx.db.query("referralCommissions").collect());
const run = (t: T) => t.finishAllScheduledFunctions(() => vi.runAllTimersAsync());
// Alice refers Bob, who signs up through her link and creates his first workspace.
async function referred(t: T) {
  const alice = await signIn(t, 1, "alice"), code = (await t.mutation(api.referrals.ensureCode, { token: alice.token }))!;
  const bob = await signIn(t, 2, "bob", code), org = await workspace(t, bob, "Bob Co");
  return { alice, code, bob, org };
}
const linkStripe = (t: T, org: Id<"organizations">, status = "active") => t.run((ctx) => ctx.db.insert("billingAccounts", { organizationId: org, customerId: "cus_bob", subscriptionId: "sub_bob", subscriptionItemId: "si_bob", status, seats: 1, trialEndsAt: Date.now(), updatedAt: Date.now() }));

// Stripe: Checkout requests are recorded; `sessions` decides each Checkout response in turn.
function mockStripe(sessions: ((body: URLSearchParams) => Response)[] = []) {
  const calls: { url: string; body: URLSearchParams }[] = [];
  let customers = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), body = new URLSearchParams(String(init?.body ?? ""));
    calls.push({ url, body });
    if (url.endsWith("/v1/customers")) return Response.json({ id: `cus_new${++customers}` });
    if (url.endsWith("/v1/checkout/sessions")) return (sessions.shift() ?? (() => Response.json({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" })))(body);
    return new Response("unexpected", { status: 500 });
  });
  return { calls, checkouts: () => calls.filter((c) => c.url.endsWith("/v1/checkout/sessions")).map((c) => c.body) };
}
const checkout = (t: T, user: User, organizationId: Id<"organizations">) => t.action(api.billingJobs.checkout, { token: user.token, organizationId });

// Signed webhooks; invoice amounts in cents and times in Stripe's seconds.
const deliver = (t: T, event: Record<string, unknown>) => {
  const body = JSON.stringify(event), ts = Math.floor(Date.now() / 1000);
  return t.fetch("/stripe/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${ts},v1=${createHmac("sha256", whsec).update(`${ts}.${body}`).digest("hex")}` }, body });
};
const seconds = (ms: number) => Math.floor(ms / 1000);
let events = 0;
function paid(invoice: string, created: number, object: Record<string, unknown> = {}) {
  return { id: `evt_${++events}`, type: "invoice.paid", created: seconds(Date.now()), data: { object: { id: invoice, customer: "cus_bob", parent: { subscription_details: { subscription: "sub_bob" } }, amount_paid: 12000, amount_overpaid: 0, total: 12000, total_excluding_tax: 10000, currency: "usd", created: seconds(created), status_transitions: { paid_at: seconds(Date.now()) }, ...object } } };
}

test("Checkout adds the coupon only for a referred workspace that has not paid, and never payment method types", async () => {
  const t = convexTest(schema, modules);
  const { alice, bob, org } = await referred(t), referralId = (await referralOf(t, bob.userId))._id;
  const stripe = mockStripe();
  await checkout(t, bob, org);
  const [discounted] = stripe.checkouts();
  expect(discounted.get("discounts[0][coupon]")).toBe("referral-20-3mo");
  expect(discounted.get("subscription_data[metadata][referralId]")).toBe(referralId);
  expect(discounted.get("subscription_data[metadata][organizationId]")).toBe(org);
  for (const key of ["payment_method_types[0]", "allow_promotion_codes"]) expect(discounted.has(key)).toBe(false);
  expect(discounted.get("payment_method_collection")).toBe("always");
  // A workspace nobody referred: the same request as with the program off, byte for byte.
  const own = await workspace(t, alice, "Alice Co");
  await checkout(t, alice, own);
  process.env.REFERRALS_ENABLED = "false";
  await checkout(t, alice, own);
  const [, on, off] = stripe.checkouts();
  expect(on.toString()).toBe(off.toString());
  expect([...on.keys()]).toEqual(["mode", "customer", "client_reference_id", "payment_method_collection", "integration_identifier", "allow_promotion_codes", "line_items[0][price]", "line_items[0][quantity]", "subscription_data[metadata][organizationId]", "subscription_data[trial_end]", "success_url", "cancel_url"]);
  // The program off, or the workspace's first payment made: no coupon.
  await checkout(t, bob, org);
  expect(stripe.checkouts().at(-1)!.has("discounts[0][coupon]")).toBe(false);
  process.env.REFERRALS_ENABLED = "true";
  await t.run((ctx) => ctx.db.patch(referralId, { status: "active", firstPaidAt: Date.now() }));
  await checkout(t, bob, org);
  expect(stripe.checkouts().at(-1)!.has("discounts[0][coupon]")).toBe(false);
  // No coupon configured: nothing is added.
  await t.run((ctx) => ctx.db.patch(referralId, { status: "pending", firstPaidAt: undefined }));
  delete process.env.STRIPE_REFERRAL_COUPON_ID;
  await checkout(t, bob, org);
  expect(stripe.checkouts().at(-1)!.has("discounts[0][coupon]")).toBe(false);
  expect(stripe.checkouts().at(-1)!.has("subscription_data[metadata][referralId]")).toBe(false);
  // The referrer is or was a member of the workspace: no coupon (accrual would void the referral).
  process.env.STRIPE_REFERRAL_COUPON_ID = "referral-20-3mo";
  await checkout(t, bob, org);
  expect(stripe.checkouts().at(-1)!.get("discounts[0][coupon]")).toBe("referral-20-3mo");
  await join(t, bob, org, alice, "alice", "member");
  await checkout(t, bob, org);
  expect(stripe.checkouts().at(-1)!.has("discounts[0][coupon]")).toBe(false);
});

test("a coupon Stripe no longer accepts never blocks Checkout: one retry without it, other errors are not retried", async () => {
  const t = convexTest(schema, modules);
  const { bob, org } = await referred(t), referralId = (await referralOf(t, bob.userId))._id;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const missing = () => Response.json({ error: { type: "invalid_request_error", code: "resource_missing", param: "discounts[0][coupon]" } }, { status: 400 });
  const stripe = mockStripe([missing]);
  expect(await checkout(t, bob, org)).toBe("https://checkout.stripe.com/c/pay/cs_1");
  const [first, retry] = stripe.checkouts();
  expect(stripe.checkouts()).toHaveLength(2);
  expect(first.get("discounts[0][coupon]")).toBe("referral-20-3mo");
  expect(retry.has("discounts[0][coupon]")).toBe(false);
  expect(retry.get("subscription_data[metadata][referralId]")).toBe(referralId);
  expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{ event: "referral.coupon_unavailable", code: "resource_missing", param: "discounts[0][coupon]" }]);
  // An expired coupon also falls back; anything else fails Checkout as before, without a retry.
  mockStripe([() => Response.json({ error: { type: "invalid_request_error", code: "coupon_expired" } }, { status: 400 })]);
  expect(await checkout(t, bob, org)).toBe("https://checkout.stripe.com/c/pay/cs_1");
  const failing = mockStripe([() => Response.json({ error: { type: "invalid_request_error", code: "parameter_invalid_integer" } }, { status: 400 }), missing]);
  await expect(checkout(t, bob, org)).rejects.toThrow(/400 invalid_request_error parameter_invalid_integer/);
  expect(failing.checkouts()).toHaveLength(1);
});

test("Checkout moves an unpaid referral only for the owner of a never-paid workspace created after the sign-up", async () => {
  const t = convexTest(schema, modules);
  const { alice, code, bob, org } = await referred(t);
  const dave = await signIn(t, 4, "dave"), older = await workspace(t, dave, "Dave Old");
  vi.advanceTimersByTime(60_000);
  // Carol signs up through Alice's link but never creates a workspace of her own.
  const carol = await signIn(t, 3, "carol", code);
  vi.advanceTimersByTime(60_000);
  const newer = await workspace(t, dave, "Dave New");
  await join(t, dave, newer, carol, "carol", "admin");
  await join(t, dave, older, carol, "carol", "admin");
  const stripe = mockStripe(), coupon = () => stripe.checkouts().at(-1)!.get("discounts[0][coupon]");
  // An admin who is not the owner brings nothing.
  await checkout(t, carol, newer);
  expect(coupon()).toBeNull();
  expect(await referralOf(t, carol.userId)).toMatchObject({ status: "signed_up" });
  expect((await referralOf(t, carol.userId)).referredOrganizationId).toBeUndefined();
  // As owner, a workspace created before her sign-up still does not take the referral; a newer one does.
  for (const w of [older, newer]) await t.mutation(api.team.update, { token: dave.token, memberId: await memberOf(t, w, carol.userId), role: "owner", remove: false });
  await checkout(t, carol, older);
  expect(coupon()).toBeNull();
  await checkout(t, carol, newer);
  expect(coupon()).toBe("referral-20-3mo");
  expect(await referralOf(t, carol.userId)).toMatchObject({ status: "pending", referredOrganizationId: newer, boundAt: Date.now() });
  // Until its first payment, Bob's referral follows the workspace he subscribes from; the one it left keeps nothing.
  const second = await workspace(t, bob, "Bob Two");
  await checkout(t, bob, second);
  expect(coupon()).toBe("referral-20-3mo");
  expect((await referralOf(t, bob.userId)).referredOrganizationId).toBe(second);
  expect((await t.query(api.billing.status, { token: bob.token, organizationId: org })).referral).toMatchObject({ referred: true, discount: true });
  // A workspace that already carries a referral never takes another person's.
  await join(t, carol, newer, bob, "bob", "admin");
  await checkout(t, bob, newer);
  expect((await referralOf(t, bob.userId)).referredOrganizationId).toBe(second);
  // Never-paid only: a workspace with a subscription linked does not take it.
  const third = await workspace(t, bob, "Bob Three");
  await t.run((ctx) => ctx.db.insert("billingAccounts", { organizationId: third, customerId: "cus_3", subscriptionId: "sub_3", status: "canceled", seats: 1, trialEndsAt: Date.now(), updatedAt: Date.now() }));
  await checkout(t, bob, third);
  expect(coupon()).toBeNull();
  // After the first payment the referral stays put.
  const bobReferral = (await referralOf(t, bob.userId))._id;
  await t.run((ctx) => ctx.db.patch(bobReferral, { status: "active", firstPaidAt: Date.now() }));
  await checkout(t, bob, org);
  expect(coupon()).toBeNull();
  expect((await referralOf(t, bob.userId)).referredOrganizationId).toBe(second);
  // Nor once the workspace it is on has subscribed, though a trial's $0 invoices set no first payment.
  await t.run(async (ctx) => { await ctx.db.patch(bobReferral, { status: "pending", firstPaidAt: undefined }); await ctx.db.patch((await ctx.db.query("billingAccounts").withIndex("by_org", (q) => q.eq("organizationId", second)).unique())!._id, { subscriptionId: "sub_two", status: "trialing" }); });
  await checkout(t, bob, org);
  expect(coupon()).toBeNull();
  expect((await referralOf(t, bob.userId)).referredOrganizationId).toBe(second);
  expect((await t.run((ctx) => ctx.db.query("referrals").collect())).filter((r) => r.referrerId === alice.userId)).toHaveLength(2);
});

test("a referral added with a code moves back to that workspace after a Checkout abandoned elsewhere", async () => {
  const t = convexTest(schema, modules);
  const { code } = await referred(t);
  const frank = await signIn(t, 10, "frank"), frankCo = await workspace(t, frank, "Frank Co"), older = await workspace(t, frank, "Frank Old");
  vi.advanceTimersByTime(60_000);
  expect(await t.mutation(api.referrals.applyCode, { token: frank.token, organizationId: frankCo, code })).toEqual({ ok: true });
  // Frank opens Checkout from a newer workspace, abandons it, and subscribes from the one he added the code to.
  const stripe = mockStripe(), coupon = () => stripe.checkouts().at(-1)!.get("discounts[0][coupon]"), newer = await workspace(t, frank, "Frank Two");
  await checkout(t, frank, newer);
  expect((await referralOf(t, frank.userId)).referredOrganizationId).toBe(newer);
  await checkout(t, frank, frankCo);
  expect(coupon()).toBe("referral-20-3mo");
  expect((await referralOf(t, frank.userId)).referredOrganizationId).toBe(frankCo);
  expect((await t.query(api.billing.status, { token: frank.token, organizationId: frankCo })).referral).toMatchObject({ referred: true, discount: true, canApply: false });
  // Another workspace created before the code was added still doesn't take it.
  await checkout(t, frank, older);
  expect(coupon()).toBeNull();
  expect((await referralOf(t, frank.userId)).referredOrganizationId).toBe(frankCo);
});

test("billing status shows the referral to owners and admins only, and offers the code form while one can be added", async () => {
  const t = convexTest(schema, modules);
  const { alice, bob, org } = await referred(t);
  const vera = await signIn(t, 5, "vera"), mia = await signIn(t, 6, "mia"), ann = await signIn(t, 7, "ann");
  await join(t, bob, org, vera, "vera", "viewer");
  await join(t, bob, org, mia, "mia", "member");
  await join(t, bob, org, ann, "ann", "admin");
  const status = (user: User, organizationId: Id<"organizations">) => t.query(api.billing.status, { token: user.token, organizationId });
  expect((await status(bob, org)).referral).toEqual({ referred: true, invitedBy: "alice", discount: true, canApply: false });
  expect((await status(ann, org)).referral).toEqual({ referred: true, invitedBy: "alice", discount: true, canApply: false });
  for (const user of [vera, mia]) expect((await status(user, org)).referral).toBeNull();
  const own = await workspace(t, alice, "Alice Co");
  expect((await status(alice, own)).referral).toEqual({ referred: false, invitedBy: null, discount: false, canApply: true });
  vi.advanceTimersByTime(31 * 86400000);
  expect((await status(alice, own)).referral).toMatchObject({ canApply: false });
  process.env.REFERRALS_ENABLED = "false";
  expect((await status(bob, org)).referral).toBeNull();
  process.env.BILLING_ENABLED = "false";
  expect(await status(bob, org)).toEqual({ enabled: false });
});

test("referral codes added in Settings → Billing follow the anti-abuse rules, and every attempt counts against the limit", async () => {
  const t = convexTest(schema, modules);
  const { alice, code } = await referred(t);
  const frank = await signIn(t, 10, "frank"), frankCode = (await t.mutation(api.referrals.ensureCode, { token: frank.token }))!;
  const gina = await signIn(t, 11, "gina", frankCode), ginaCode = (await t.mutation(api.referrals.ensureCode, { token: gina.token }))!;
  const hank = await signIn(t, 12, "hank"), hankCode = (await t.mutation(api.referrals.ensureCode, { token: hank.token }))!;
  const frankCo = await workspace(t, frank, "Frank Co"), paidCo = await workspace(t, frank, "Frank Paid"), oldCo = await workspace(t, frank, "Frank Old");
  await t.run((ctx) => ctx.db.insert("billingAccounts", { organizationId: paidCo, customerId: "cus_paid", subscriptionId: "sub_paid", status: "canceled", seats: 1, trialEndsAt: Date.now(), updatedAt: Date.now() }));
  await join(t, frank, frankCo, alice, "alice", "member");
  const apply = (user: User, organizationId: Id<"organizations">, value: string) => t.mutation(api.referrals.applyCode, { token: user.token, organizationId, code: value });
  const errors = [];
  for (const [org, value] of [[frankCo, "nope"], [frankCo, frankCode], [frankCo, ginaCode], [frankCo, code], [paidCo, hankCode]] as const) errors.push(await apply(frank, org, value));
  expect(errors).toEqual([
    { ok: false, error: "That referral code doesn’t exist. Check it and try again." },
    { ok: false, error: "You can’t use your own referral code." },
    { ok: false, error: "You referred the code’s owner, so you can’t use their code." },
    { ok: false, error: "The code’s owner is or was a member of this workspace." },
    { ok: false, error: "A referral code can’t be added to a workspace that has subscribed." },
  ]);
  // Five rejected attempts used up the hour, even for a good code.
  expect(await apply(frank, frankCo, hankCode)).toEqual({ ok: false, error: "Too many referral code attempts. Try again in an hour." });
  expect((await t.run((ctx) => ctx.db.query("rateLimits").collect())).find((r) => r.key === `referral-apply:${frank.userId}`)?.count).toBe(5);
  vi.advanceTimersByTime(3600_000);
  expect(await apply(frank, frankCo, hankCode)).toEqual({ ok: true });
  const applied = await referralOf(t, frank.userId);
  expect(applied).toMatchObject({ referrerId: hank.userId, referredOrganizationId: frankCo, source: "code", status: "pending", attributedAt: Date.now(), boundAt: Date.now() });
  expect((await t.run((ctx) => ctx.db.query("auditEvents").collect())).filter((e) => e.action === "referral.code_applied").map((e) => [e.organizationId, e.userId, e.target])).toEqual([[frankCo, frank.userId, applied._id]]);
  expect(await apply(frank, frankCo, code)).toEqual({ ok: false, error: "This workspace already has a referral." });
  expect(await apply(frank, paidCo, code)).toMatchObject({ ok: false, error: "A referral code can’t be added to a workspace that has subscribed." });
  // Someone already referred: another referrer's code, or their own referrer's once it is bound elsewhere.
  const ivy = await signIn(t, 13, "ivy", code), ivyCo = await workspace(t, ivy, "Ivy Co"), ivyTwo = await workspace(t, ivy, "Ivy Two");
  expect((await referralOf(t, ivy.userId)).referredOrganizationId).toBe(ivyCo);
  expect(await apply(ivy, ivyTwo, hankCode)).toEqual({ ok: false, error: "Your account was already referred by someone else." });
  expect(await apply(ivy, ivyTwo, code)).toEqual({ ok: false, error: "Your account’s referral can’t be added to this workspace." });
  // An admin whose own referral is still unbound brings it, from the same referrer only.
  const jane = await signIn(t, 14, "jane", code), kim = await signIn(t, 15, "kim"), kimCo = await workspace(t, kim, "Kim Co");
  await join(t, kim, kimCo, jane, "jane", "admin");
  expect(await apply(jane, kimCo, code)).toEqual({ ok: true });
  expect(await referralOf(t, jane.userId)).toMatchObject({ referrerId: alice.userId, referredOrganizationId: kimCo, source: "link", status: "pending" });
  // Members cannot add codes; workspaces older than the window cannot take one.
  const lee = await signIn(t, 16, "lee");
  await join(t, kim, kimCo, lee, "lee", "member");
  await expect(apply(lee, kimCo, hankCode)).rejects.toThrow(/Forbidden/);
  vi.advanceTimersByTime(31 * 86400000);
  expect(await apply(frank, oldCo, code)).toEqual({ ok: false, error: "A referral code can be added only in a workspace’s first 30 days." });
  process.env.REFERRALS_ENABLED = "false";
  expect(await apply(kim, kimCo, hankCode)).toMatchObject({ ok: false });
});

test("commissions accrue in a scheduled job, so a failure there never touches billing", async () => {
  const t = convexTest(schema, modules);
  const { alice, bob, org } = await referred(t);
  const accountId = await linkStripe(t, org, "past_due");
  // Duplicate membership rows make the job's member check throw.
  for (let i = 0; i < 2; i++) await t.run((ctx) => ctx.db.insert("organizationMembers", { organizationId: org, userId: alice.userId, role: "member" }));
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect((await deliver(t, paid("in_1", Date.now()))).status).toBe(200);
  expect(await t.run((ctx) => ctx.db.get(accountId))).toMatchObject({ status: "active" });
  expect((await t.run((ctx) => ctx.db.get(accountId)))?.pastDueSince).toBeUndefined();
  const jobs = async () => (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((j) => j.name.includes("referrals:accrue"));
  expect((await jobs()).map((j) => j.state.kind)).toEqual(["pending"]);
  expect(await commissions(t)).toEqual([]);
  await run(t);
  expect((await jobs()).map((j) => j.state.kind)).toEqual(["failed"]);
  expect(await t.run((ctx) => ctx.db.get(accountId))).toMatchObject({ status: "active" });
  expect(await commissions(t)).toEqual([]);
  expect((await t.run((ctx) => ctx.db.query("stripeEvents").collect())).map((e) => e.outcome)).toEqual(["invoice.paid"]);
  // Fixed, the next invoice accrues.
  await t.run(async (ctx) => { for (const m of await ctx.db.query("organizationMembers").collect()) if (m.userId === alice.userId) await ctx.db.delete(m._id); });
  await deliver(t, paid("in_2", Date.now()));
  await run(t);
  expect(await commissions(t)).toMatchObject([{ invoiceId: "in_2", referrerId: alice.userId, referredOrganizationId: org, subscriptionId: "sub_bob" }]);
  expect((await referralOf(t, bob.userId)).status).toBe("active");
});

test("each paid subscription invoice earns 20% of its pre-tax cash once; others are skipped", async () => {
  const t = convexTest(schema, modules);
  const { alice, bob, org } = await referred(t);
  await linkStripe(t, org);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const jobs = async () => (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((j) => j.name.includes("referrals:accrue")).length;
  // Old payloads (no invoice id) and invoices without a subscription still apply to billing, and schedule nothing.
  expect((await deliver(t, { id: "evt_old", type: "invoice.paid", created: seconds(Date.now()), data: { object: { customer: "cus_bob", subscription: "sub_bob" } } })).status).toBe(200);
  expect((await deliver(t, paid("in_manual", Date.now(), { parent: null }))).status).toBe(200);
  // An unexpected amount shape is ignored, not rejected.
  expect((await deliver(t, paid("in_odd", Date.now(), { total: "12000", status_transitions: "soon" }))).status).toBe(200);
  expect(await jobs()).toBe(1);
  await run(t);
  // The trial's $0 invoice and another currency earn nothing.
  await deliver(t, paid("in_trial", Date.now(), { amount_paid: 0, total: 0, total_excluding_tax: 0 }));
  await deliver(t, paid("in_eur", Date.now(), { currency: "eur" }));
  await run(t);
  expect(await commissions(t)).toEqual([]);
  expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({ event: "referral.currency_skipped", currency: "eur" });
  const created = Date.UTC(2026, 9, 14, 11), paidAt = Date.UTC(2026, 9, 14, 12);
  await deliver(t, paid("in_1", created));
  await deliver(t, { ...paid("in_1", created), id: "evt_redelivered" });
  await run(t);
  expect(await commissions(t)).toEqual([expect.objectContaining({ invoiceId: "in_1", referrerId: alice.userId, currency: "usd", base: 10000, rateBps: 2000, amount: 2000, reversed: 0, status: "accrued", invoiceCreated: created, paidAt, availableAt: paidAt + 30 * 86400000 })]);
  expect(await referralOf(t, bob.userId)).toMatchObject({ status: "active", firstPaidAt: paidAt, windowStart: created, commissionEndsAt: Date.UTC(2027, 9, 14, 11) });
  expect(await t.query(api.referrals.overview, { token: alice.token })).toMatchObject({ subscribed: 1, available: 0, onHold: 2000, currency: "usd", people: [{ name: "bob", earned: 2000, commissionEndsAt: Date.UTC(2027, 9, 14, 11) }] });
  // Once the hold passes it no longer counts as on hold.
  vi.setSystemTime(paidAt + 30 * 86400000);
  expect(await t.query(api.referrals.overview, { token: alice.token })).toMatchObject({ available: 2000, onHold: 0 });
  // Operators void one commission; it stops counting and the workspace's audit log records it once.
  const [commission] = await commissions(t);
  await t.mutation(internal.referralOps.voidCommission, { commissionId: commission._id, reason: "credit note" });
  await t.mutation(internal.referralOps.voidCommission, { commissionId: commission._id, reason: "again" });
  expect((await commissions(t))[0]).toMatchObject({ status: "void", voidReason: "credit note" });
  expect((await t.run((ctx) => ctx.db.query("auditEvents").collect())).filter((e) => e.action === "referral.commission_voided").map((e) => [e.organizationId, e.target])).toEqual([[org, commission._id]]);
  expect(await t.query(api.referrals.overview, { token: alice.token })).toMatchObject({ available: 0, onHold: 0 });
});

test("an invoice paid entirely from the customer balance earns nothing but counts as paid, so Checkout gives no coupon again", async () => {
  const t = convexTest(schema, modules);
  const { bob, org } = await referred(t);
  const accountId = await linkStripe(t, org), created = Date.UTC(2026, 9, 14, 11), paidAt = Date.now();
  await deliver(t, paid("in_credit", created, { amount_paid: 0, total: 9600, total_excluding_tax: 9600 }));
  await run(t);
  expect(await commissions(t)).toEqual([]);
  expect(await referralOf(t, bob.userId)).toMatchObject({ status: "active", firstPaidAt: paidAt, windowStart: created });
  // Bob cancels and subscribes again: no second round of the coupon.
  await t.run((ctx) => ctx.db.patch(accountId, { status: "canceled" }));
  const stripe = mockStripe();
  await checkout(t, bob, org);
  expect(stripe.checkouts()[0].get("discounts[0][coupon]")).toBeNull();
});

test("the 12-month window starts at the earliest paid invoice and ends the referral after it", async () => {
  const t = convexTest(schema, modules);
  const { bob, org } = await referred(t);
  await linkStripe(t, org);
  // Month 2's invoice is processed first; month 1's arrives late and moves the window back.
  vi.setSystemTime(Date.UTC(2026, 10, 14, 12));
  await deliver(t, paid("in_m2", Date.UTC(2026, 10, 14)));
  await run(t);
  expect(await referralOf(t, bob.userId)).toMatchObject({ status: "active", windowStart: Date.UTC(2026, 10, 14), commissionEndsAt: Date.UTC(2027, 10, 14) });
  await deliver(t, paid("in_m1", Date.UTC(2026, 9, 14)));
  await run(t);
  expect(await referralOf(t, bob.userId)).toMatchObject({ status: "active", firstPaidAt: Date.UTC(2026, 10, 14, 12), windowStart: Date.UTC(2026, 9, 14), commissionEndsAt: Date.UTC(2027, 9, 14) });
  // The last invoice inside the window earns; the first one on or after its end ends the referral.
  vi.setSystemTime(Date.UTC(2027, 9, 14, 12));
  await deliver(t, paid("in_m12", Date.UTC(2027, 8, 14)));
  await deliver(t, paid("in_m13", Date.UTC(2027, 9, 14)));
  await run(t);
  expect((await commissions(t)).map((c) => c.invoiceId).sort()).toEqual(["in_m1", "in_m12", "in_m2"]);
  expect((await referralOf(t, bob.userId)).status).toBe("ended");
  await deliver(t, paid("in_m14", Date.UTC(2027, 10, 14)));
  await run(t);
  expect(await commissions(t)).toHaveLength(3);
});

test("a referrer who is or was a member of the workspace voids the referral and its commissions on hold", async () => {
  const t = convexTest(schema, modules);
  const { alice, bob, org } = await referred(t);
  await linkStripe(t, org);
  await deliver(t, paid("in_1", Date.now()));
  await run(t);
  const referral = await referralOf(t, bob.userId);
  const released = await t.run((ctx) => ctx.db.insert("referralCommissions", { referralId: referral._id, referrerId: alice.userId, referredOrganizationId: org, invoiceId: "in_0", subscriptionId: "sub_bob", currency: "usd", base: 5000, rateBps: 2000, amount: 1000, reversed: 0, status: "accrued", invoiceCreated: 1, paidAt: 1, availableAt: 2, createdAt: 1, updatedAt: 1 }));
  // Alice joins Bob's workspace and leaves again before the next invoice.
  await join(t, bob, org, alice, "alice", "member");
  await t.mutation(api.team.update, { token: bob.token, memberId: await memberOf(t, org, alice.userId), role: "member", remove: true });
  vi.advanceTimersByTime(86400000);
  await deliver(t, paid("in_2", Date.now()));
  await run(t);
  expect(await referralOf(t, bob.userId)).toMatchObject({ status: "void", voidReason: "referrer is or was a member of the workspace", voidedAt: Date.now() });
  expect((await commissions(t)).map((c) => [c.invoiceId, c.status])).toEqual([["in_1", "void"], ["in_0", "accrued"]]);
  expect((await commissions(t)).find((c) => c._id === released)?.status).toBe("accrued");
  // Void referrals earn nothing more and get no coupon.
  await deliver(t, paid("in_3", Date.now()));
  await run(t);
  expect(await commissions(t)).toHaveLength(2);
  const stripe = mockStripe();
  await t.run(async (ctx) => { for (const a of await ctx.db.query("billingAccounts").collect()) await ctx.db.patch(a._id, { subscriptionId: undefined, status: "canceled" }); });
  await checkout(t, bob, org);
  expect(stripe.checkouts().at(-1)!.has("discounts[0][coupon]")).toBe(false);
});

test("the referrer gets exactly one email when a workspace they referred first pays, naming GitHub users only", async () => {
  const t = convexTest(schema, modules);
  const { alice, bob, org } = await referred(t);
  await linkStripe(t, org);
  Object.assign(process.env, { RESEND_API_KEY: "re_fixture", EMAIL_FROM: "OpenReview <noreply@example.com>" });
  const mails: { to: string[]; subject: string; text: string }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => { mails.push(JSON.parse(String(init?.body))); return Response.json({ id: `m${mails.length}` }); });
  // Alice signed in with GitHub, so her address comes from a verified notification email.
  await t.run((ctx) => ctx.db.insert("notificationPreferences", { organizationId: org, userId: alice.userId, email: "alice@example.com", emailVerifiedAt: 1, reviewCompleted: "mine", highSeverity: "mine", updatedAt: 1 }));
  expect(await t.query(api.referrals.overview, { token: alice.token })).toMatchObject({ notified: true });
  await deliver(t, paid("in_1", Date.now()));
  await run(t);
  await deliver(t, paid("in_2", Date.now()));
  await run(t);
  expect(mails).toHaveLength(1);
  expect(mails[0]).toMatchObject({ to: ["alice@example.com"], subject: "@bob subscribed to OpenReview" });
  expect(mails[0].text).toMatch(/https:\/\/review\.example\.com\/dashboard\/settings\/referrals/);
  const referral = await referralOf(t, bob.userId);
  expect(referral.noticeSentAt).toBe(Date.now());
  expect(await t.action(internal.referralJobs.sendConversionNotice, { referralId: referral._id })).toBe("skipped");
  expect(mails).toHaveLength(1);
});
