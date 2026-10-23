import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import { createHash, randomBytes } from "node:crypto";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { bindReferralOnWorkspace, everMember, isMember, recordReferralSignup, verifiedEmail } from "../convex/referralLedger";

const modules = import.meta.glob("../convex/**/*.ts");
const secret = "referral-session-secret-at-least-32-characters", svc = "referral-service";
beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); vi.setSystemTime(Date.UTC(2026, 9, 14, 12)); Object.assign(process.env, { SESSION_SECRET: secret, SERVICE_SECRET: svc, APP_URL: "https://review.example.com", BILLING_ENABLED: "true", REFERRALS_ENABLED: "true" }); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const key of ["BILLING_ENABLED", "REFERRALS_ENABLED", "RESEND_API_KEY", "EMAIL_FROM"]) delete process.env[key]; });

type T = ReturnType<typeof convexTest>;
type Profile = { provider: "github" | "gitlab" | "google"; providerUserId: string; login: string; email?: string; emailVerified: boolean };
const session = () => { const sid = randomBytes(32).toString("base64url"); return { sid, hash: createHash("sha256").update(sid).digest("hex") }; };
const jwt = (userId: string, sid: string) => new SignJWT({ sid }).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setSubject(userId).setIssuedAt().setExpirationTime("7d").sign(new TextEncoder().encode(secret));
async function signIn(t: T, profile: Profile, extra: { referralCode?: string; linkToken?: string } = {}) {
  const s = session(), userId = await t.mutation(api.identity.signIn, { secret: svc, avatar: "", ...profile, sessionHash: s.hash, ...extra });
  return { userId, token: await jwt(userId, s.sid) };
}
const github = (id: number, login: string): Profile => ({ provider: "github", providerUserId: String(id), login, emailVerified: false });
const google = (id: string, email: string): Profile => ({ provider: "google", providerUserId: id, login: email.split("@")[0], email, emailVerified: true });
const referrals = (t: T) => t.run((ctx) => ctx.db.query("referrals").collect());
const referralOf = async (t: T, userId: Id<"users">) => (await referrals(t)).filter((r) => r.referredUserId === userId);
const dashed = (code: string) => ` ${code.slice(0, 4).toLowerCase()}-${code.slice(4)} `;

test("every user gets one code, created on first use; the link preview shows GitHub usernames only", async () => {
  const t = convexTest(schema, modules);
  const alice = await signIn(t, github(1, "alice")), gina = await signIn(t, google("g-gina", "gina.private@example.com"));
  const code = (await t.mutation(api.referrals.ensureCode, { token: alice.token }))!;
  expect(code).toMatch(/^[2-9A-HJKMNP-TV-Z]{8}$/);
  expect(await t.mutation(api.referrals.ensureCode, { token: alice.token })).toBe(code);
  expect(await t.run((ctx) => ctx.db.query("referralCodes").collect())).toHaveLength(1);
  expect(await t.query(api.referrals.preview, { secret: svc, code })).toEqual({ login: "alice" });
  expect(await t.query(api.referrals.preview, { secret: svc, code: dashed(code) })).toEqual({ login: "alice" });
  // Google and email logins are an address's local part: never shown to strangers.
  const ginaCode = (await t.mutation(api.referrals.ensureCode, { token: gina.token }))!;
  expect(ginaCode).not.toBe(code);
  expect(await t.query(api.referrals.preview, { secret: svc, code: ginaCode })).toEqual({ login: null });
  for (const unknown of ["not-a-code", "", code === "ZZZZZZZZ" ? "YYYYYYYY" : "ZZZZZZZZ"]) expect(await t.query(api.referrals.preview, { secret: svc, code: unknown })).toBeNull();
  // Only the web server may look codes up.
  await expect(t.query(api.referrals.preview, { secret: "wrong", code })).rejects.toThrow(/Unauthorized/);
  expect(await t.query(api.referrals.overview, { token: alice.token })).toEqual({ enabled: true, code, login: "alice", notified: false, signedUp: 0, subscribed: 0, pending: 0, currency: "usd", available: 0, onHold: 0, redeemed: 0, rateBps: 2000, months: 12, holdDays: 30, minCredit: 1000, people: [], activity: [], workspaces: [], payouts: null });
  expect((await t.query(api.referrals.overview, { token: gina.token }) as { login: string | null }).login).toBeNull();
  await expect(t.mutation(api.referrals.ensureCode, { token: "not-a-token" })).rejects.toThrow();
});

test("only accounts this sign-in creates are attributed, through OAuth and magic links", async () => {
  const t = convexTest(schema, modules);
  const alice = await signIn(t, github(1, "alice")), code = (await t.mutation(api.referrals.ensureCode, { token: alice.token }))!;
  const gina = await signIn(t, google("g-gina", "gina@example.com")), ginaCode = (await t.mutation(api.referrals.ensureCode, { token: gina.token }))!;
  const carol = await signIn(t, github(3, "carol"));
  // A new Google user through Alice's link (typed loosely): one signed-up referral.
  const bob = await signIn(t, google("g-bob", "bob@example.com"), { referralCode: dashed(code) });
  expect(await referralOf(t, bob.userId)).toMatchObject([{ referrerId: alice.userId, source: "link", status: "signed_up", attributedAt: Date.now() }]);
  // Returning users never are, even with another code: Bob again, and Carol who signed up without one.
  await signIn(t, google("g-bob", "bob@example.com"), { referralCode: ginaCode });
  await signIn(t, github(3, "carol"), { referralCode: code });
  // Linking a new provider to a signed-in account, or joining an account through a verified email.
  await signIn(t, { provider: "gitlab", providerUserId: "gl-carol", login: "carol", emailVerified: false }, { referralCode: code, linkToken: carol.token });
  const joined = await signIn(t, { provider: "gitlab", providerUserId: "gl-gina", login: "gina", email: "gina@example.com", emailVerified: true }, { referralCode: code });
  expect(joined.userId).toBe(gina.userId);
  // Malformed and unknown codes are ignored; sign-in still works.
  const dan = await signIn(t, github(4, "dan"), { referralCode: "nope" }), erin = await signIn(t, github(5, "erin"), { referralCode: "Z".repeat(8) === code ? "Y".repeat(8) : "Z".repeat(8) });
  for (const user of [carol, gina, dan, erin]) expect(await referralOf(t, user.userId)).toEqual([]);
  expect(await referralOf(t, bob.userId)).toHaveLength(1);
  // Magic links: the code is stored on the token in canonical form and counts when the link creates the user.
  process.env.RESEND_API_KEY = "re_fixture"; process.env.EMAIL_FROM = "OpenReview <noreply@example.com>";
  const mails: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_u: string | URL | Request, init?: RequestInit) => { mails.push(JSON.parse(String(init?.body)).text); return Response.json({ id: "m" + mails.length }); });
  const consume = async () => t.mutation(api.identity.consumeLoginToken, { secret: svc, tokenHash: createHash("sha256").update(/token=([A-Za-z0-9_-]+)/.exec(mails.at(-1)!)![1]).digest("hex"), sessionHash: session().hash });
  await t.action(api.identityJobs.requestMagicLink, { secret: svc, email: "Frank@Example.com", referralCode: dashed(code) });
  expect((await t.run((ctx) => ctx.db.query("loginTokens").collect())).map((l) => l.referralCode)).toEqual([code]);
  const frank = (await consume())!;
  expect(await referralOf(t, frank)).toMatchObject([{ referrerId: alice.userId, status: "signed_up" }]);
  await t.action(api.identityJobs.requestMagicLink, { secret: svc, email: "frank@example.com", referralCode: ginaCode });
  expect(await consume()).toBe(frank);
  expect(await referralOf(t, frank)).toMatchObject([{ referrerId: alice.userId }]);
  // The referrer sees GitHub usernames, and a numbered label for everyone else, newest first.
  const hank = await signIn(t, github(8, "hank"), { referralCode: code });
  const overview = await t.query(api.referrals.overview, { token: alice.token }) as { people: { name: string; label: string }[]; signedUp: number; pending: number };
  expect(overview.people.map((p) => [p.name, p.label])).toEqual([["hank", "signed up"], ["Email sign-up #2", "signed up"], ["Email sign-up #1", "signed up"]]);
  expect([overview.signedUp, overview.pending]).toEqual([3, 3]);
  expect(JSON.stringify(overview)).not.toMatch(/bob|frank/i);
  expect((await referralOf(t, hank.userId))[0].referrerId).toBe(alice.userId);
});

test("the referred person's first workspace carries the referral; later and already-referred workspaces do not", async () => {
  const t = convexTest(schema, modules);
  const alice = await signIn(t, github(1, "alice")), code = (await t.mutation(api.referrals.ensureCode, { token: alice.token }))!;
  const bob = await signIn(t, github(2, "bob"), { referralCode: code }), carol = await signIn(t, github(3, "carol"), { referralCode: code });
  const first = await t.mutation(api.users.createOrganization, { token: bob.token, name: "Bob Co" });
  vi.advanceTimersByTime(60_000);
  await t.mutation(api.users.createOrganization, { token: bob.token, name: "Second" });
  expect(await referralOf(t, bob.userId)).toMatchObject([{ status: "pending", referredOrganizationId: first, boundAt: Date.UTC(2026, 9, 14, 12) }]);
  // One referral per workspace: Carol's cannot bind to Bob's workspace.
  await t.run((ctx) => bindReferralOnWorkspace(ctx, carol.userId, first));
  expect(await referralOf(t, carol.userId)).toMatchObject([{ status: "signed_up" }]);
  expect((await referralOf(t, carol.userId))[0].referredOrganizationId).toBeUndefined();
  // Workspaces created by people nobody referred are untouched.
  await t.mutation(api.users.createOrganization, { token: alice.token, name: "Alice Co" });
  expect(await referrals(t)).toHaveLength(2);
  // Self-referral is refused.
  await t.run((ctx) => recordReferralSignup(ctx, alice.userId, code));
  expect(await referralOf(t, alice.userId)).toEqual([]);
  expect(await t.query(api.referrals.overview, { token: alice.token })).toMatchObject({ signedUp: 2, pending: 2, subscribed: 0 });
  expect((await t.query(api.referrals.overview, { token: alice.token }) as { people: { label: string }[] }).people.map((p) => p.label)).toEqual(["signed up", "workspace created"]);
  // Operators void a referral: it stops counting, and the workspace's audit log records it once.
  const referralId = (await referralOf(t, bob.userId))[0]._id;
  await t.mutation(internal.referralOps.voidReferral, { referralId, reason: "same person" });
  await t.mutation(internal.referralOps.voidReferral, { referralId, reason: "again" });
  expect(await t.run((ctx) => ctx.db.get(referralId))).toMatchObject({ status: "void", voidReason: "same person", voidedAt: Date.now() });
  expect((await t.run((ctx) => ctx.db.query("auditEvents").collect())).filter((e) => e.action === "referral.voided").map((e) => [e.organizationId, e.target])).toEqual([[first, referralId]]);
  expect(await t.query(api.referrals.overview, { token: alice.token })).toMatchObject({ signedUp: 1, pending: 1 });
});

test("membership checks see current members and people who joined and left; verified email falls back to notification addresses", async () => {
  const t = convexTest(schema, modules);
  const owner = await signIn(t, github(1, "owner")), mia = await signIn(t, github(2, "mia")), stranger = await signIn(t, github(3, "stranger"));
  const org = await t.mutation(api.users.createOrganization, { token: owner.token, name: "Acme" });
  const invitationId = await t.mutation(api.users.invite, { token: owner.token, organizationId: org, githubLogin: "mia", role: "member" });
  await t.mutation(api.users.acceptInvitation, { token: mia.token, invitationId });
  const check = (userId: Id<"users">) => t.run(async (ctx) => [await isMember(ctx, org, userId), await everMember(ctx, org, userId)]);
  expect(await check(mia.userId)).toEqual([true, true]);
  const memberId = (await t.run((ctx) => ctx.db.query("organizationMembers").collect())).find((m) => m.userId === mia.userId)!._id;
  await t.mutation(api.team.update, { token: owner.token, memberId, role: "member", remove: true });
  expect(await check(mia.userId)).toEqual([false, true]);
  expect(await check(owner.userId)).toEqual([true, true]);
  expect(await check(stranger.userId)).toEqual([false, false]);
  // The creator hands the workspace to a new owner and leaves: still a past member.
  const nina = await signIn(t, github(4, "nina")), ninaInvite = await t.mutation(api.users.invite, { token: owner.token, organizationId: org, githubLogin: "nina", role: "member" });
  await t.mutation(api.users.acceptInvitation, { token: nina.token, invitationId: ninaInvite });
  const members = await t.run((ctx) => ctx.db.query("organizationMembers").collect());
  await t.mutation(api.team.update, { token: owner.token, memberId: members.find((m) => m.userId === nina.userId)!._id, role: "owner", remove: false });
  await t.mutation(api.team.update, { token: nina.token, memberId: members.find((m) => m.userId === owner.userId)!._id, role: "owner", remove: true });
  expect(await check(owner.userId)).toEqual([false, true]);
  const gina = await signIn(t, google("g-gina", "gina@example.com"));
  expect(await t.run((ctx) => verifiedEmail(ctx, gina.userId))).toBe("gina@example.com");
  expect(await t.run((ctx) => verifiedEmail(ctx, mia.userId))).toBeNull();
  await t.run((ctx) => ctx.db.insert("notificationPreferences", { organizationId: org, userId: mia.userId, email: "mia@example.com", emailVerifiedAt: 1, reviewCompleted: "mine", highSeverity: "mine", updatedAt: 1 }));
  expect(await t.run((ctx) => verifiedEmail(ctx, mia.userId))).toBe("mia@example.com");
});

test("the program is inert unless REFERRALS_ENABLED and billing are both on", async () => {
  const t = convexTest(schema, modules);
  const alice = await signIn(t, github(1, "alice")), code = (await t.mutation(api.referrals.ensureCode, { token: alice.token }))!;
  const bob = await signIn(t, github(2, "bob"), { referralCode: code });
  for (const [i, off] of [{ REFERRALS_ENABLED: "false" }, { BILLING_ENABLED: "false" }].entries()) {
    Object.assign(process.env, { BILLING_ENABLED: "true", REFERRALS_ENABLED: "true" }, off);
    const carol = await signIn(t, github(10 + i, "carol" + i), { referralCode: code });
    expect(await referralOf(t, carol.userId)).toEqual([]);
    expect(await t.mutation(api.referrals.ensureCode, { token: carol.token })).toBeNull();
    expect(await t.query(api.referrals.overview, { token: alice.token })).toEqual({ enabled: false });
    expect(await t.query(api.referrals.preview, { secret: svc, code })).toBeNull();
    // Bob's earlier referral does not bind while the program is off.
    await t.mutation(api.users.createOrganization, { token: bob.token, name: "Bob Co" });
    expect(await referralOf(t, bob.userId)).toMatchObject([{ status: "signed_up" }]);
  }
  // Magic links store no code while it is off.
  process.env.RESEND_API_KEY = "re_fixture"; process.env.EMAIL_FROM = "OpenReview <noreply@example.com>";
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ id: "m1" }));
  await t.action(api.identityJobs.requestMagicLink, { secret: svc, email: "frank@example.com", referralCode: code });
  expect((await t.run((ctx) => ctx.db.query("loginTokens").collect()))[0].referralCode).toBeUndefined();
  expect(await t.run((ctx) => ctx.db.query("referralCodes").collect())).toHaveLength(1);
});
