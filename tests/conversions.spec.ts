import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import { createHash, randomBytes } from "node:crypto";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { isInternal } from "../convex/conversions";
import { lifecycleEmail } from "../convex/lifecycleEmails";

// Server-side funnel milestones (convex/conversions.ts): one row per milestone however often the step
// repeats, sign-ups told apart from returning sign-ins, and internal accounts kept out of ad conversions.
const modules = import.meta.glob("../convex/**/*.ts");
const secret = "conversions-session-secret-at-least-32-characters", svc = "conversions-service";
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.UTC(2026, 9, 23, 12)); Object.assign(process.env, { SESSION_SECRET: secret, SERVICE_SECRET: svc, APP_URL: "https://review.example.com" }); });
afterEach(() => { vi.useRealTimers(); for (const key of ["ANALYTICS_INTERNAL_EMAIL_DOMAINS", "ANALYTICS_INTERNAL_GITHUB_LOGINS"]) delete process.env[key]; });

type T = ReturnType<typeof convexTest>;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const session = () => hash(randomBytes(32).toString("base64url"));
const jwt = (userId: string) => new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setSubject(userId).setExpirationTime("1h").sign(new TextEncoder().encode(secret));
const events = (t: T) => t.run((ctx) => ctx.db.query("conversionEvents").collect());
async function magicLink(t: T, email: string) {
  const raw = randomBytes(32).toString("base64url");
  await t.mutation(internal.identity.storeLoginToken, { email, tokenHash: hash(raw) });
  return hash(raw);
}
const consume = (t: T, tokenHash: string) => t.mutation(api.identity.consumeLoginToken, { secret: svc, tokenHash, sessionHash: session() });
const github = (t: T, id: string, login: string) => t.mutation(api.identity.signIn, { secret: svc, provider: "github", providerUserId: id, login, avatar: "", emailVerified: false, sessionHash: session() });

test("a used magic link that creates the account is one verified sign-up; returning sign-ins and replays add nothing", async () => {
  const t = convexTest(schema, modules);
  const first = await magicLink(t, "new@company.com");
  const userId = (await consume(t, first))!;
  expect(await consume(t, first), "the same link pressed again").toBeNull();
  vi.advanceTimersByTime(61_000);
  expect(await consume(t, await magicLink(t, "new@company.com"))).toBe(userId);
  expect((await events(t)).map((e) => [e.key, e.method, e.userId])).toEqual([[`signup_verified:${userId}`, "email", userId]]);
  expect((await t.run((ctx) => ctx.db.query("loginTokens").collect())).map((l) => l.createdUser)).toEqual([true, false]);
  expect(await t.run((ctx) => ctx.db.query("sessions").collect())).toHaveLength(2);
});

test("OAuth and legacy GitHub sign-ups are counted by method; linking another provider is not a sign-up", async () => {
  const t = convexTest(schema, modules);
  const alice = await github(t, "11", "alice");
  await github(t, "11", "alice");
  await t.mutation(api.identity.signIn, { secret: svc, provider: "google", providerUserId: "g-11", login: "alice", avatar: "", email: "alice@company.com", emailVerified: true, sessionHash: session(), linkToken: await jwt(alice) });
  await t.mutation(api.users.login, { secret: svc, githubId: 12, login: "legacy", avatar: "" });
  expect((await events(t)).map((e) => [e.name, e.method])).toEqual([["signup_verified", "github"], ["signup_verified", "github"]]);
});

test("a workspace's GitHub install, first repository, first review and subscription are recorded once each", async () => {
  const t = convexTest(schema, modules);
  const owner = await github(t, "21", "owner"), token = await jwt(owner);
  const organizationId = await t.mutation(api.users.createOrganization, { token, name: "Acme" });
  for (const installationId of [301, 301, 302]) await t.mutation(api.repositories.connect, { token, secret: svc, organizationId, installationId, account: "acme", accountId: 1, repositories: [] });
  await t.run(async (ctx) => {
    for (const kind of ["repository_connected", "repository_connected", "first_review_completed", "first_review_completed", "subscribed"] as const) await lifecycleEmail(ctx, kind, { organizationId });
  });
  const workspace = (await events(t)).filter((e) => e.organizationId === organizationId).map((e) => e.key).sort();
  expect(workspace).toEqual([`first_repository_connected:${organizationId}`, `first_review_completed:${organizationId}`, `github_app_installed:${organizationId}`, `subscribed:${organizationId}`]);
});

test("internal and test accounts are recognized from the lists, Resend's test domain and reserved TLDs", () => {
  const env = { ANALYTICS_INTERNAL_EMAIL_DOMAINS: "openreview.tech, @corp.example.org", ANALYTICS_INTERNAL_EMAILS: "qa@gmail.com", ANALYTICS_INTERNAL_GITHUB_LOGINS: "Staff-Bot" };
  const internal = (emails: string[], githubLogins: string[] = []) => isInternal({ emails, githubLogins }, env);
  expect(internal(["me@openreview.tech"])).toBe(true);
  expect(internal(["me@eu.openreview.tech"]), "subdomains").toBe(true);
  expect(internal(["x@corp.example.org"])).toBe(true);
  expect(internal(["QA@gmail.com"])).toBe(true);
  expect(internal([], ["staff-bot"])).toBe(true);
  expect(internal(["delivered@resend.dev"])).toBe(true);
  expect(internal(["a@shop.test"])).toBe(true);
  expect(internal(["someone@gmail.com", "x@notopenreview.tech"], ["alice"]), "a real user, whatever the address looks like").toBe(false);
  expect(isInternal({ emails: ["me@openreview.tech"], githubLogins: [] }, {}), "nothing is internal without the lists").toBe(false);
});

test("internal accounts get no analytics milestones, so their sign-ups never fire an ad conversion", async () => {
  const t = convexTest(schema, modules);
  process.env.ANALYTICS_INTERNAL_GITHUB_LOGINS = "staff";
  const staff = await github(t, "31", "staff"), customer = await github(t, "32", "customer");
  expect(await t.query(api.analyticsMilestones.pending, { token: await jwt(staff) })).toEqual([]);
  expect((await t.query(api.analyticsMilestones.pending, { token: await jwt(customer) })).map((m) => m.event)).toEqual(["signed_up"]);
  const userId = (await consume(t, await magicLink(t, "qa@shop.test"))) as Id<"users">;
  expect(await t.query(api.analyticsMilestones.pending, { token: await jwt(userId) })).toEqual([]);
});
