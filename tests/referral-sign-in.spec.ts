import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import { createHash, randomBytes } from "node:crypto";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// The web half of referral attribution: the sign-in routes must carry ?referral= to Convex. Next's
// request scope (cookies, headers) is faked and backend() runs against convex-test.
const holder = vi.hoisted(() => ({ t: undefined as unknown, jar: new Map<string, string>() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => holder.jar.has(name) ? { value: holder.jar.get(name) } : undefined, set: (name: string, value: string) => { holder.jar.set(name, value); }, delete: (name: string) => { holder.jar.delete(name); } }), headers: async () => new Headers({ "user-agent": "vitest" }) }));
vi.mock("../src/server", () => ({
  backend: () => { type Call = (ref: unknown, args: unknown) => Promise<unknown>; const t = holder.t as { query: Call; mutation: Call; action: Call }; return { query: (r: unknown, a: unknown) => t.query(r, a), mutation: (r: unknown, a: unknown) => t.mutation(r, a), action: (r: unknown, a: unknown) => t.action(r, a) }; },
  seal: async (data: unknown) => Buffer.from(JSON.stringify(data)).toString("base64url"),
  unseal: async (token: string) => JSON.parse(Buffer.from(token, "base64url").toString()),
  signSession: async () => "session-jwt",
  cookieOptions: { httpOnly: true, secure: false, sameSite: "lax", path: "/" },
  origin: () => "https://review.example.com",
}));
import { beginOAuth, finishOAuth } from "../src/oauth-flow";
import { POST as requestMagicLink } from "../app/api/auth/email/route";

const modules = import.meta.glob("../convex/**/*.ts");
const base = "https://review.example.com", svc = "referral-routes-service";
const env = { SESSION_SECRET: "referral-routes-secret-at-least-32-characters", SERVICE_SECRET: svc, APP_URL: base, BILLING_ENABLED: "true", REFERRALS_ENABLED: "true", REFERRAL_PAYOUTS_ENABLED: "true", RESEND_API_KEY: "re_test", EMAIL_FROM: "OpenReview <login@example.com>" };
beforeEach(() => { Object.assign(process.env, env); holder.jar.clear(); });
afterEach(() => { vi.restoreAllMocks(); for (const key of Object.keys(env)) delete process.env[key]; });

async function setup() {
  const t = convexTest(schema, modules); holder.t = t;
  const alice = await t.mutation(api.users.login, { secret: svc, githubId: 7001, login: "alice", avatar: "" });
  await t.run((ctx) => ctx.db.insert("referralCodes", { userId: alice, code: "ABCD2345", createdAt: Date.now() }));
  return { t, alice };
}
const sealed = () => JSON.parse(Buffer.from(holder.jar.get("openreview_oauth_state")!, "base64url").toString());
const begin = async (query: string) => { let state = ""; await beginOAuth(new Request(`${base}/api/auth/login?${query}`), "github", (s) => { state = s; return "https://github.com/login/oauth/authorize"; }); return state; };
const finish = (state: string) => finishOAuth(new Request(`${base}/api/auth/callback?code=c1&state=${state}`), "github", async () => ({ providerUserId: "7002", login: "newbie", avatar: "", emailVerified: false }));

test("OAuth sign-up carries the referral code from the sign-in link to the new account", async () => {
  const { t, alice } = await setup();
  // A typed code is kept in canonical form; linking an account to a signed-in user never carries one.
  await begin("referral=abcd-2345&link=1");
  expect(sealed().referral).toBeUndefined();
  // A failed callback sends the visitor back with the code, so a retry still counts.
  await begin("referral=abcd-2345");
  expect(sealed().referral).toBe("ABCD2345");
  expect((await finish("wrong-state")).headers.get("location")).toBe(`${base}/login?error=signin&referral=ABCD2345`);
  const state = await begin("referral=abcd-2345");
  expect((await finish(state)).headers.get("location")).toBe(`${base}/dashboard`);
  const referrals = await t.run((ctx) => ctx.db.query("referrals").collect());
  expect(referrals).toHaveLength(1);
  expect(referrals[0]).toMatchObject({ referrerId: alice, source: "link", status: "signed_up" });
});

test("a magic-link request stores the referral code on the login token and keeps it on the redirect", async () => {
  const { t } = await setup();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "email_1" }), { status: 200, headers: { "content-type": "application/json" } }));
  const form = new FormData();
  form.set("email", "new@example.com"); form.set("from", "signup"); form.set("referral", "abcd-2345");
  const response = await requestMagicLink(new Request(`${base}/api/auth/email`, { method: "POST", headers: { origin: base }, body: form }));
  expect(response.headers.get("location")).toBe(`${base}/signup?email=sent&referral=ABCD2345`);
  expect((await t.run((ctx) => ctx.db.query("loginTokens").collect())).map((token) => token.referralCode)).toEqual(["ABCD2345"]);
});

test("a refused or cancelled account link returns to the page it started from, never to plain sign-in", async () => {
  const { t } = await setup();
  // Carol signed in with Google 20 minutes ago, past the 15 minutes that linking needs while payouts are on.
  const sid = randomBytes(32).toString("base64url");
  const carol = await t.mutation(api.identity.signIn, { secret: svc, provider: "google", providerUserId: "g-carol", login: "carol", avatar: "", emailVerified: false, sessionHash: createHash("sha256").update(sid).digest("hex") });
  await t.run(async (ctx) => { for (const s of await ctx.db.query("sessions").collect()) await ctx.db.patch(s._id, { createdAt: Date.now() - 20 * 60000 }); });
  holder.jar.set("openreview_session", await new SignJWT({ sid }).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setSubject(carol).setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(env.SESSION_SECRET)));
  const users = async () => (await t.run((ctx) => ctx.db.query("users").collect())).length, before = await users();
  expect((await finish(await begin("link=1&next=/dashboard/account"))).headers.get("location")).toBe(`${base}/dashboard/account`);
  expect(JSON.parse(holder.jar.get("openreview_toast")!)).toMatchObject({ tone: "error" });
  const state = await begin("link=1&next=/dashboard/account");
  expect((await finishOAuth(new Request(`${base}/api/auth/callback?error=access_denied&state=${state}`), "github", async () => { throw new Error("unused"); })).headers.get("location")).toBe(`${base}/dashboard/account`);
  expect(await users()).toBe(before);
});

test("a new sign-in drops the previous user's GitHub setup token; a GitHub sign-in sets its own afterwards", async () => {
  await setup();
  holder.jar.set("openreview_github_setup", "previous-users-token");
  await finish(await begin(""));
  expect(holder.jar.has("openreview_github_setup")).toBe(false);
  holder.jar.set("openreview_github_setup", "previous-users-token");
  const state = await begin("");
  await finishOAuth(new Request(`${base}/api/auth/callback?code=c1&state=${state}`), "github", async () => ({ providerUserId: "7002", login: "newbie", avatar: "", emailVerified: false }), async () => { holder.jar.set("openreview_github_setup", "fresh-token"); });
  expect(holder.jar.get("openreview_github_setup")).toBe("fresh-token");
});
