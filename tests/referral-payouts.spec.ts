import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import { createHash, randomBytes } from "node:crypto";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";

// Phase 4 of the referral program: cash payouts to a Stripe Connect account (Accounts v2, recipient).
// Stripe is mocked through fetch; nothing calls the network.
const modules = import.meta.glob("../convex/**/*.ts");
const secret = "referral-payout-session-secret-at-least-32-chars", svc = "referral-payout-service";
const env = { SESSION_SECRET: secret, SERVICE_SECRET: svc, APP_URL: "https://review.example.com", BILLING_ENABLED: "true", REFERRALS_ENABLED: "true", REFERRAL_PAYOUTS_ENABLED: "true", STRIPE_SECRET_KEY: "rk_test_fixture" };
beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); vi.setSystemTime(Date.UTC(2026, 9, 14, 12)); Object.assign(process.env, env); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const key of Object.keys(env)) if (key !== "SESSION_SECRET" && key !== "SERVICE_SECRET") delete process.env[key]; });

type T = ReturnType<typeof convexTest>;
const jwt = (userId: string, sid?: string) => new SignJWT(sid ? { sid } : {}).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setSubject(userId).setIssuedAt().setExpirationTime("7d").sign(new TextEncoder().encode(secret));
// A browser sign-in (a session row, created now) and, for the same user, a token without a session like an API key's.
async function signIn(t: T, id: number, login: string, email?: string) {
  const sid = randomBytes(32).toString("base64url");
  const userId = await t.mutation(api.identity.signIn, { secret: svc, avatar: "", provider: "github", providerUserId: String(id), login, emailVerified: Boolean(email), ...(email ? { email } : {}), sessionHash: createHash("sha256").update(sid).digest("hex") });
  return { userId, token: await jwt(userId, sid), apiToken: await jwt(userId) };
}
type User = Awaited<ReturnType<typeof signIn>>;
const run = (t: T) => t.finishAllScheduledFunctions(() => vi.runAllTimersAsync());
// Alice referred Bob, and a $600 commission from Bob's workspace is past its hold.
async function setup(t: T) {
  const alice = await signIn(t, 1, "alice", "alice@example.com"), bob = await signIn(t, 2, "bob");
  const bobCo = await t.mutation(api.users.createOrganization, { token: bob.token, name: "Bob Co" });
  await t.run(async (ctx) => {
    const referralId = await ctx.db.insert("referrals", { referrerId: alice.userId, referredUserId: bob.userId, referredOrganizationId: bobCo, source: "link", status: "active", attributedAt: 1, updatedAt: 1 });
    await ctx.db.insert("referralCommissions", { referralId, referrerId: alice.userId, referredOrganizationId: bobCo, invoiceId: "in_1", subscriptionId: "sub_1", currency: "usd", base: 300000, rateBps: 2000, amount: 60000, reversed: 0, status: "accrued", invoiceCreated: 1, paidAt: 1, availableAt: 1, createdAt: 1, updatedAt: 1 });
  });
  return { alice, bob };
}
const linkAccount = (t: T, user: User, transfers: "active" | "pending" = "active") => t.run((ctx) => ctx.db.insert("referralPayoutAccounts", { userId: user.userId, accountId: "acct_1Alice", country: "US", transfers, ...(transfers === "active" ? { onboardedAt: Date.now() } : {}), createdAt: Date.now(), updatedAt: Date.now() }));
const payoutAccounts = (t: T) => t.run((ctx) => ctx.db.query("referralPayoutAccounts").collect());
const redemptions = (t: T) => t.run((ctx) => ctx.db.query("referralRedemptions").collect());
const overview = async (t: T, user: User) => { const o = await t.query(api.referrals.overview, { token: user.token }); if (!o.enabled) throw new Error("off"); return o; };

// Stripe by method and path; every request is recorded with its query, raw body and idempotency key.
type Call = { method: string; path: string; query: URLSearchParams; body: string; key: string | null };
function mockStripe(routes: Record<string, (call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), call = { method: init?.method ?? "GET", path: url.pathname, query: url.searchParams, body: String(init?.body ?? ""), key: new Headers(init?.headers).get("idempotency-key") };
    calls.push(call);
    return routes[`${call.method} ${call.path}`]?.(call) ?? Response.json({ error: { type: "unexpected_in_test" } }, { status: 418 });
  });
  return calls;
}
const json = (call: Call) => JSON.parse(call.body), form = (call: Call) => Object.fromEntries(new URLSearchParams(call.body));
const list = (data: unknown[]) => Response.json({ object: "list", data, has_more: false });
const account = (transfers: string, deadline: string | null = null) => Response.json({ id: "acct_1Alice", object: "v2.core.account", configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { status: transfers } } } } }, requirements: { summary: { minimum_deadline: deadline && { status: deadline } } } });
const onboardingUrl = "https://connect.stripe.com/setup/e/acct_1Alice/abc", link = () => Response.json({ object: "v2.core.account_link", url: onboardingUrl });
const back = "https://review.example.com/dashboard/account/referrals?payouts=";
const signInAgain = { ok: false, error: "Sign in again to continue.", signIn: "/login?next=/dashboard/account/referrals&reauth=1" };
const start = (t: T, token: string, country = "US") => t.action(api.referralJobs.startPayoutSetup, { token, country });

test("payout setup creates the Connect account once, with the exact v2 body and a key from the request, then links to onboarding", async () => {
  const t = convexTest(schema, modules);
  const { alice, bob } = await setup(t);
  let calls = mockStripe({ "POST /v2/core/accounts": () => account("pending", "currently_due"), "POST /v2/core/account_links": link });
  expect(await start(t, alice.token, "us")).toEqual({ ok: true, url: onboardingUrl });
  const hash8 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 8);
  expect(calls.map((c) => [c.method, c.path, c.key])).toEqual([["POST", "/v2/core/accounts", `referral-account:${alice.userId}:US:${hash8("alice@example.com")}`], ["POST", "/v2/core/account_links", null]]);
  expect(json(calls[0])).toEqual({ contact_email: "alice@example.com", identity: { country: "us" }, dashboard: "express", defaults: { responsibilities: { fees_collector: "application", losses_collector: "application" } }, configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } }, metadata: { userId: alice.userId }, include: ["configuration.recipient", "identity", "requirements"] });
  expect(json(calls[1])).toEqual({ account: "acct_1Alice", use_case: { type: "account_onboarding", account_onboarding: { configurations: ["recipient"], refresh_url: `${back}refresh`, return_url: `${back}return` } } });
  const [saved] = await payoutAccounts(t);
  expect(saved).toMatchObject({ userId: alice.userId, accountId: "acct_1Alice", country: "US", transfers: "pending", requirements: "currently_due", createdAt: Date.now() });
  expect(saved.onboardedAt).toBeUndefined();
  expect((await overview(t, alice)).payouts).toEqual({ state: "incomplete", countries: ["US"], minPayout: 5000, reviewAbove: 50000 });
  // Continue setup reuses the account.
  calls = mockStripe({ "POST /v2/core/account_links": link });
  expect(await start(t, alice.token, "")).toEqual({ ok: true, url: onboardingUrl });
  expect(calls.map((c) => c.path)).toEqual(["/v2/core/account_links"]);
  expect(json(calls[0]).use_case.type).toBe("account_onboarding");
  // Without a verified email, contact_email is left out (Stripe asks for it), and the key hashes the empty string.
  calls = mockStripe({ "POST /v2/core/accounts": () => Response.json({ id: "acct_1Bob" }), "POST /v2/core/account_links": link });
  await start(t, bob.token);
  expect(json(calls[0])).not.toHaveProperty("contact_email");
  expect(calls[0].key).toBe(`referral-account:${bob.userId}:US:${hash8("")}`);
  expect((await payoutAccounts(t)).map((a) => [a.accountId, a.transfers])).toEqual([["acct_1Alice", "pending"], ["acct_1Bob", "unknown"]]);
});

test("payout steps refuse other countries, sign-ins older than 15 minutes, API keys, and everything with the switch off", async () => {
  const t = convexTest(schema, modules);
  const { alice } = await setup(t);
  let calls = mockStripe({});
  expect(await start(t, alice.token, "CA")).toEqual({ ok: false, error: "Cash payouts are available only to bank accounts in the United States for now." });
  expect(await start(t, alice.apiToken)).toEqual(signInAgain);
  expect(await t.action(api.referralJobs.payoutDashboardLink, { token: alice.apiToken })).toEqual(signInAgain);
  vi.setSystemTime(Date.now() + 15 * 60000);
  expect(await start(t, alice.token)).toEqual(signInAgain);
  await linkAccount(t, alice);
  expect(await t.mutation(api.referrals.requestPayout, { token: alice.token, amount: 5000 })).toEqual(signInAgain);
  expect(await t.action(api.referralJobs.payoutDashboardLink, { token: alice.token })).toEqual(signInAgain);
  expect(calls).toEqual([]);
  expect(await redemptions(t)).toEqual([]);
  // A 409 from account creation (an earlier request still running, or sent with other details) gets a clear message.
  const fresh = await signIn(t, 3, "carol");
  calls = mockStripe({ "POST /v2/core/accounts": () => Response.json({ error: { type: "idempotency_error", code: "idempotency_key_reused" } }, { status: 409 }) });
  expect(await start(t, fresh.token)).toEqual({ ok: false, error: "Stripe is still working on an earlier payout setup request. Wait a minute, then try again." });
  expect(calls).toHaveLength(1);
  process.env.REFERRAL_PAYOUTS_ENABLED = "false";
  calls = mockStripe({});
  const off = { ok: false, error: "This deployment doesn’t offer cash payouts." };
  // Signed-in callers only, even with the switch off.
  await expect(start(t, "not-a-session")).rejects.toThrow();
  await expect(t.action(api.referralJobs.refreshMyPayoutAccount, { token: "not-a-session" })).rejects.toThrow();
  expect(await start(t, fresh.token)).toEqual(off);
  expect(await t.action(api.referralJobs.payoutDashboardLink, { token: fresh.token })).toEqual(off);
  expect(await t.mutation(api.referrals.requestPayout, { token: fresh.token, amount: 5000 })).toEqual(off);
  expect(await t.action(api.referralJobs.refreshMyPayoutAccount, { token: alice.token })).toBeNull();
  expect((await overview(t, alice)).payouts).toBeNull();
  expect(calls).toEqual([]);
});

test("linking another provider needs a recent sign-in, so an older session can't add a way to sign in fresh", async () => {
  const t = convexTest(schema, modules);
  const { alice } = await setup(t);
  await linkAccount(t, alice);
  const calls = mockStripe({ "POST /v1/accounts/acct_1Alice/login_links": () => Response.json({ url: "https://connect.stripe.com/express/acct_1Alice/xyz" }) });
  const link = async (token: string, provider: "github" | "gitlab", providerUserId: string) => {
    const sid = randomBytes(32).toString("base64url");
    expect(await t.mutation(api.identity.signIn, { secret: svc, avatar: "", provider, providerUserId, login: "someone", emailVerified: false, sessionHash: createHash("sha256").update(sid).digest("hex"), linkToken: token })).toBe(alice.userId);
    return jwt(alice.userId, sid);
  };
  // Someone holding Alice's 16-minute-old session (or her API key) tries to link their own GitHub account, to sign in with it later.
  vi.setSystemTime(Date.now() + 16 * 60000);
  for (const token of [alice.token, alice.apiToken]) await expect(link(token, "github", "99")).rejects.toThrow(/Sign in again to link another account/);
  // Signing in with that GitHub account is someone else, with nothing to cash out.
  const mallory = await signIn(t, 99, "mallory");
  expect(mallory.userId).not.toBe(alice.userId);
  expect(await t.action(api.referralJobs.payoutDashboardLink, { token: mallory.token })).toEqual({ ok: false, error: "Finish setting up payouts with Stripe first." });
  expect(calls).toEqual([]);
  // A link made right after a real sign-in works, and its session keeps that sign-in's time.
  const again = await signIn(t, 1, "alice", "alice@example.com");
  vi.setSystemTime(Date.now() + 10 * 60000);
  const linked = await link(again.token, "gitlab", "77");
  expect(await t.action(api.referralJobs.payoutDashboardLink, { token: linked })).toMatchObject({ ok: true });
  vi.setSystemTime(Date.now() + 6 * 60000);
  expect(await t.action(api.referralJobs.payoutDashboardLink, { token: linked })).toEqual(signInAgain);
  // With payouts off, a fresh sign-in unlocks nothing, so linking works from any valid session as before.
  process.env.REFERRAL_PAYOUTS_ENABLED = "false";
  expect(await link(again.token, "github", "55")).toBeTruthy();
});

test("the account status is re-read from Stripe: onboardedAt is set once, and a restricted account gets an update link", async () => {
  const t = convexTest(schema, modules);
  const { alice, bob } = await setup(t);
  mockStripe({ "POST /v2/core/accounts": () => account("pending", "currently_due"), "POST /v2/core/account_links": link });
  await start(t, alice.token);
  let status = () => account("active");
  const calls = mockStripe({ "GET /v2/core/accounts/acct_1Alice": () => status(), "POST /v2/core/account_links": link });
  // At most one read a minute: the account was saved just now.
  expect(await t.action(api.referralJobs.refreshMyPayoutAccount, { token: alice.token })).toBe("pending");
  expect(calls).toEqual([]);
  vi.advanceTimersByTime(60000);
  expect(await t.action(api.referralJobs.refreshMyPayoutAccount, { token: alice.token })).toBe("active");
  expect(calls[0].query.toString()).toBe("include%5B0%5D=configuration.recipient&include%5B1%5D=requirements");
  const onboardedAt = Date.now();
  let [row] = await payoutAccounts(t);
  expect(row).toMatchObject({ transfers: "active", onboardedAt, updatedAt: onboardedAt });
  expect(row.requirements).toBeUndefined();
  expect((await overview(t, alice)).payouts?.state).toBe("active");
  vi.advanceTimersByTime(60000);
  status = () => account("restricted", "past_due");
  expect(await t.action(internal.referralJobs.refreshPayoutAccount, { accountId: "acct_1Alice" })).toBe("restricted");
  [row] = await payoutAccounts(t);
  expect(row).toMatchObject({ transfers: "restricted", requirements: "past_due", onboardedAt });
  expect((await overview(t, alice)).payouts?.state).toBe("restricted");
  expect(await start(t, alice.token)).toEqual({ ok: true, url: onboardingUrl });
  expect(json(calls.at(-1)!)).toEqual({ account: "acct_1Alice", use_case: { type: "account_update", account_update: { configurations: ["recipient"], refresh_url: `${back}refresh`, return_url: `${back}return` } } });
  // Active again, or an unexpected shape: onboardedAt never moves.
  vi.advanceTimersByTime(60000);
  status = () => account("active");
  await t.action(api.referralJobs.refreshMyPayoutAccount, { token: alice.token });
  vi.advanceTimersByTime(60000);
  status = () => Response.json({ id: "acct_1Alice", configuration: null, requirements: null });
  expect(await t.action(api.referralJobs.refreshMyPayoutAccount, { token: alice.token })).toBe("unknown");
  expect((await payoutAccounts(t))[0]).toMatchObject({ transfers: "unknown", onboardedAt });
  // Someone without a payout account: nothing is read.
  const before = calls.length;
  expect(await t.action(api.referralJobs.refreshMyPayoutAccount, { token: bob.token })).toBeNull();
  expect(calls).toHaveLength(before);
});

const request = (t: T, user: User, amount: number) => t.mutation(api.referrals.requestPayout, { token: user.token, amount });
const transferStripe = (post: (call: Call) => Response = () => Response.json({ id: "tr_1", object: "transfer" }), found: () => Response = () => list([]), transfers = "active") => mockStripe({ "GET /v1/transfers": found, "GET /v2/core/accounts/acct_1Alice": () => account(transfers), "POST /v1/transfers": post });
const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST");

test("cash-out requests need an active account and the minimum; above $500 they wait for review, then are approved or rejected", async () => {
  const t = convexTest(schema, modules);
  const { alice } = await setup(t);
  const calls = transferStripe();
  expect(await request(t, alice, 5000)).toEqual({ ok: false, error: "Finish setting up payouts with Stripe first." });
  const accountId = await linkAccount(t, alice, "pending");
  expect(await request(t, alice, 5000)).toEqual({ ok: false, error: "Finish setting up payouts with Stripe first." });
  await t.run((ctx) => ctx.db.patch(accountId, { transfers: "active" }));
  expect(await request(t, alice, 4999)).toEqual({ ok: false, error: "The smallest cash-out is $50.00." });
  expect(await request(t, alice, 5000.5)).toEqual({ ok: false, error: "The smallest cash-out is $50.00." });
  expect(await request(t, alice, 60001)).toEqual({ ok: false, error: "You have $600.00 available." });
  expect(await redemptions(t)).toEqual([]);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  expect(await request(t, alice, 55000)).toEqual({ ok: true, review: true });
  const [held] = await redemptions(t);
  expect(held).toMatchObject({ userId: alice.userId, kind: "payout", amount: 55000, currency: "usd", accountId: "acct_1Alice", status: "review", idempotencyKey: `referral-transfer:${held._id}:1`, attempts: 0 });
  expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({ event: "referral.payout_review", redemptionId: held._id, amount: 55000 });
  expect(await overview(t, alice)).toMatchObject({ available: 5000, redeemed: 55000, activity: [{ what: "Cash out with Stripe", amount: -55000, status: "review" }, { status: "available" }] });
  await run(t);
  expect(calls).toEqual([]);
  expect(await request(t, alice, 5001)).toEqual({ ok: false, error: "You have $50.00 available." });
  // Rejected: the amount is back, and Alice sees the reason.
  await t.mutation(internal.referralOps.rejectRedemption, { redemptionId: held._id, reason: "Contact support about this cash-out." });
  expect(await overview(t, alice)).toMatchObject({ available: 60000, redeemed: 0, activity: [{ status: "failed", error: "Contact support about this cash-out." }, {}] });
  await expect(t.mutation(internal.referralOps.approveRedemption, { redemptionId: held._id })).rejects.toThrow(/failed, not in review/);
  // Approved: transferred right away.
  await request(t, alice, 55000);
  const second = (await redemptions(t)).find((r) => r.status === "review")!;
  await t.mutation(internal.referralOps.approveRedemption, { redemptionId: second._id });
  await run(t);
  expect((await redemptions(t)).find((r) => r._id === second._id)).toMatchObject({ status: "completed", stripeId: "tr_1" });
  expect(posts(calls).map((c) => [c.path, c.key, form(c).amount])).toEqual([["/v1/transfers", `referral-transfer:${second._id}:1`, "55000"]]);
  await expect(t.mutation(internal.referralOps.rejectRedemption, { redemptionId: second._id, reason: "x" })).rejects.toThrow(/completed, not in review/);
  // Ten attempts an hour, rejected ones included: eight so far, the tenth still checked, the eleventh refused.
  for (let i = 0; i < 2; i++) expect(await request(t, alice, 1)).toEqual({ ok: false, error: "The smallest cash-out is $50.00." });
  expect(await request(t, alice, 5000)).toEqual({ ok: false, error: "Too many cash-out requests. Try again in an hour." });
});

test("the review counts 30 days of cash-outs, so a split one still waits, and approving re-checks the balance", async () => {
  const t = convexTest(schema, modules);
  const { alice } = await setup(t);
  await linkAccount(t, alice);
  transferStripe();
  vi.spyOn(console, "log").mockImplementation(() => {});
  expect(await request(t, alice, 30000)).toEqual({ ok: true, review: false });
  await run(t);
  expect(await request(t, alice, 30000)).toEqual({ ok: true, review: true });
  // A refund during the review takes half the commission back: approving would pay out money Alice no longer has.
  const held = (await redemptions(t)).find((r) => r.status === "review")!;
  const reverse = (reversed: number) => t.run(async (ctx) => { const [c] = await ctx.db.query("referralCommissions").collect(); await ctx.db.patch(c._id, { reversed }); });
  await reverse(30000);
  await expect(t.mutation(internal.referralOps.approveRedemption, { redemptionId: held._id })).rejects.toThrow(/30000 cents short/);
  await t.mutation(internal.referralOps.rejectRedemption, { redemptionId: held._id, reason: "Refunded" });
  // 30 days later the first cash-out no longer counts.
  await reverse(0);
  vi.setSystemTime(Date.now() + 30 * 86400000 + 1);
  const later = await signIn(t, 1, "alice", "alice@example.com");
  expect(await request(t, later, 30000)).toEqual({ ok: true, review: false });
});

test("a cash-out looks the transfer up, re-reads the account, then posts one transfer with its group and stored key", async () => {
  const t = convexTest(schema, modules);
  const { alice } = await setup(t);
  await linkAccount(t, alice);
  let calls = transferStripe();
  expect(await request(t, alice, 10000)).toEqual({ ok: true, review: false });
  await run(t);
  const [done] = await redemptions(t);
  expect(done).toMatchObject({ kind: "payout", status: "completed", stripeId: "tr_1", completedAt: Date.now(), attempts: 0 });
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/transfers", "GET /v2/core/accounts/acct_1Alice", "POST /v1/transfers"]);
  expect(calls[0].query.toString()).toBe(`transfer_group=referral-redemption-${done._id}&limit=1`);
  expect(form(calls[2])).toEqual({ amount: "10000", currency: "usd", destination: "acct_1Alice", transfer_group: `referral-redemption-${done._id}`, description: "OpenReview referral payout", "metadata[referralRedemptionId]": done._id });
  expect(calls[2].key).toBe(`referral-transfer:${done._id}:1`);
  expect(await overview(t, alice)).toMatchObject({ available: 50000, redeemed: 10000, activity: [{ what: "Cash out with Stripe", amount: -10000, status: "completed" }, {}] });
  // A transfer that already exists (a crashed run made it) completes the row without another post.
  calls = transferStripe(undefined, () => list([{ id: "tr_2", object: "transfer" }]));
  await request(t, alice, 10000);
  await run(t);
  expect((await redemptions(t))[1]).toMatchObject({ status: "completed", stripeId: "tr_2" });
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/transfers"]);
  // Stripe restricted the account since the page last read it: nothing is posted, and the amount is back.
  calls = transferStripe(undefined, undefined, "restricted");
  await request(t, alice, 10000);
  await run(t);
  expect((await redemptions(t))[2]).toMatchObject({ status: "failed", error: "Stripe can’t pay your account until its setup is complete (Continue setup under Personal Settings → Referrals), so the amount is back in your balance." });
  expect(posts(calls)).toEqual([]);
  expect((await payoutAccounts(t))[0].transfers).toBe("restricted");
  expect(await overview(t, alice)).toMatchObject({ available: 40000, payouts: { state: "restricted" } });
});

test("balance_insufficient: once the lookup finds no transfer, the next try uses a new key", async () => {
  const t = convexTest(schema, modules);
  const { alice } = await setup(t);
  await linkAccount(t, alice);
  let funded = false;
  const calls = transferStripe(() => funded ? Response.json({ id: "tr_1" }) : Response.json({ error: { type: "invalid_request_error", code: "balance_insufficient" } }, { status: 400 }));
  await request(t, alice, 10000);
  await run(t);
  const [waiting] = await redemptions(t);
  expect(waiting).toMatchObject({ status: "processing", attempts: 1, idempotencyKey: `referral-transfer:${waiting._id}:2`, keyIssuedAt: Date.now(), error: "Stripe request failed (400 invalid_request_error balance_insufficient)" });
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/transfers", "GET /v2/core/accounts/acct_1Alice", "POST /v1/transfers", "GET /v1/transfers"]);
  expect(await overview(t, alice)).toMatchObject({ available: 50000 });
  // After a top-up the cron posts again, with the new key.
  funded = true;
  vi.advanceTimersByTime(15 * 60000);
  expect(await t.action(internal.referralJobs.reconcileRedemptions, {})).toBe(1);
  expect((await redemptions(t))[0]).toMatchObject({ status: "completed", stripeId: "tr_1", idempotencyKey: `referral-transfer:${waiting._id}:2` });
  expect(posts(calls).map((c) => c.key)).toEqual([`referral-transfer:${waiting._id}:1`, `referral-transfer:${waiting._id}:2`]);
});

test("with payouts switched off, a cash-out pauses without a transfer, isn't reported as stuck, and resumes when switched back on", async () => {
  const t = convexTest(schema, modules);
  const { alice } = await setup(t);
  await linkAccount(t, alice);
  const calls = transferStripe();
  await request(t, alice, 10000);
  process.env.REFERRAL_PAYOUTS_ENABLED = "false";
  await run(t);
  const [paused] = await redemptions(t);
  expect(paused).toMatchObject({ status: "processing", pausedAt: Date.now(), attempts: 0 });
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/transfers"]);
  // Days later the cron still leaves it alone, without calling Stripe or reporting it as stuck; it only counts it.
  const log = vi.spyOn(console, "error").mockImplementation(() => {}), info = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.setSystemTime(Date.now() + 4 * 86400000);
  expect(await t.action(internal.referralJobs.reconcileRedemptions, {})).toBe(0);
  expect(info.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{ event: "referral.redemptions_paused", count: 1 }]);
  expect(calls).toHaveLength(1);
  expect((await redemptions(t))[0]).toMatchObject({ status: "processing", pausedAt: paused.pausedAt });
  process.env.REFERRAL_PAYOUTS_ENABLED = "true";
  await t.action(internal.referralJobs.reconcileRedemptions, {});
  expect((await redemptions(t))[0]).toMatchObject({ status: "completed", stripeId: "tr_1" });
  expect(posts(calls).map((c) => c.key)).toEqual([`referral-transfer:${paused._id}:1`]);
  expect(log).not.toHaveBeenCalled();
});

test("a paused cash-out isn't sent once refunds or disputes have left the balance below zero", async () => {
  const t = convexTest(schema, modules);
  const { alice } = await setup(t);
  await linkAccount(t, alice);
  const calls = transferStripe();
  expect(await request(t, alice, 40000)).toEqual({ ok: true, review: false });
  process.env.REFERRAL_PAYOUTS_ENABLED = "false";
  await run(t);
  // While it waits, Bob's invoice is refunded: Alice is $400 short.
  await t.run(async (ctx) => { const [c] = await ctx.db.query("referralCommissions").collect(); await ctx.db.patch(c._id, { reversed: 60000 }); });
  expect(await overview(t, alice)).toMatchObject({ available: -40000 });
  process.env.REFERRAL_PAYOUTS_ENABLED = "true";
  await t.action(internal.referralJobs.reconcileRedemptions, {});
  expect((await redemptions(t))[0]).toMatchObject({ status: "failed", error: "Refunds or disputes since you asked for this cash-out left your balance below zero, so it wasn’t sent." });
  expect(posts(calls)).toEqual([]);
  expect(await overview(t, alice)).toMatchObject({ available: 0, redeemed: 0 });
});

test("while payouts are off, paused cash-outs don't crowd credits out of the reconcile batch", async () => {
  const t = convexTest(schema, modules);
  const { alice } = await setup(t);
  process.env.REFERRAL_PAYOUTS_ENABLED = "false";
  const row = { userId: alice.userId, amount: 5000, currency: "usd", status: "processing" as const, idempotencyKey: "k", keyIssuedAt: 1, attempts: 0, createdAt: 1, updatedAt: 1 };
  const creditId = await t.run(async (ctx) => { for (let i = 0; i < 100; i++) await ctx.db.insert("referralRedemptions", { ...row, kind: "payout", accountId: "acct_1Alice", pausedAt: 1 }); return ctx.db.insert("referralRedemptions", { ...row, kind: "credit", customerId: "cus_1", updatedAt: 2 }); });
  expect(await t.query(internal.referrals.stuckRedemptions, {})).toEqual({ rows: [expect.objectContaining({ _id: creditId, kind: "credit" })], paused: 100 });
});

test("the Stripe dashboard opens with a login link once the account has onboarded", async () => {
  const t = convexTest(schema, modules);
  const { alice } = await setup(t);
  const calls = mockStripe({ "POST /v1/accounts/acct_1Alice/login_links": () => Response.json({ object: "login_link", url: "https://connect.stripe.com/express/acct_1Alice/xyz" }) });
  expect(await t.action(api.referralJobs.payoutDashboardLink, { token: alice.token })).toEqual({ ok: false, error: "Finish setting up payouts with Stripe first." });
  await linkAccount(t, alice);
  expect(await t.action(api.referralJobs.payoutDashboardLink, { token: alice.token })).toEqual({ ok: true, url: "https://connect.stripe.com/express/acct_1Alice/xyz" });
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v1/accounts/acct_1Alice/login_links"]);
});
