import { afterEach, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";

// Funnel steps past sign-up (convex/conversions.ts): the first real payment, paywall hits and members asking to upgrade.
const modules = import.meta.glob("../convex/**/*.ts");
afterEach(() => { delete process.env.BILLING_ENABLED; });

async function setup() {
  process.env.SERVICE_SECRET = "conv-service";
  process.env.SESSION_SECRET = "conv-session-secret-at-least-32-characters";
  const t = convexTest(schema, modules);
  const sign = (id: string) => new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(id).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET));
  const owner = await t.mutation(api.users.login, { secret: "conv-service", githubId: -501, login: "conv-owner", avatar: "" });
  const token = await sign(owner);
  const organizationId = await t.mutation(api.users.createOrganization, { token, name: "Funnel" });
  const keys = async () => (await t.run((ctx) => ctx.db.query("conversionEvents").collect())).map((e) => e.key).filter((k) => /^(first_paid|paywall|upgrade_requested|checkout_started):/.test(k));
  return { t, sign, token, organizationId, keys };
}

test("first_paid: the first invoice with money in it, once; a $0 trial invoice is not a payment", async () => {
  const s = await setup();
  await s.t.run((ctx) => ctx.db.insert("billingAccounts", { organizationId: s.organizationId, customerId: "cus_f", subscriptionId: "sub_f", plan: "starter", status: "trialing", seats: 1, trialEndsAt: Date.now(), updatedAt: Date.now() }));
  const paid = (id: string, amountPaid: number) => s.t.mutation(internal.billing.applyStripeEvent, { eventId: id, type: "invoice.paid", created: 1, invoice: { customer: "cus_f", subscription: "sub_f", amountPaid } });
  await paid("evt_trial", 0);
  expect(await s.keys()).toEqual([]);
  await paid("evt_first", 1200);
  await paid("evt_second", 1200);
  expect(await s.keys()).toEqual([`first_paid:${s.organizationId}`]);
});

test("paywall and upgrade requests: a fix PR asked for on Free counts once; a member asks the admins at most once a day", async () => {
  const s = await setup();
  process.env.BILLING_ENABLED = "true";
  const member = await s.t.mutation(api.users.login, { secret: "conv-service", githubId: -502, login: "conv-member", avatar: "" });
  await s.t.run((ctx) => ctx.db.insert("organizationMembers", { organizationId: s.organizationId, userId: member, role: "member" }));
  const memberToken = await s.sign(member);
  await s.t.mutation(api.notifications.requestUpgrade, { token: memberToken, organizationId: s.organizationId });
  await expect(s.t.mutation(api.notifications.requestUpgrade, { token: memberToken, organizationId: s.organizationId })).rejects.toThrow(/Rate limit/);
  // A finding to ask a fix PR for, as "@openreview fix this in a new PR" would.
  await s.t.mutation(api.repositories.connect, { token: s.token, secret: "conv-service", organizationId: s.organizationId, installationId: -501, account: "conv", accountId: -501, repositories: [{ id: -501, fullName: "conv/repo", defaultBranch: "main" }] });
  const [{ _id: repositoryId }] = await s.t.query(api.repositories.list, { token: s.token, organizationId: s.organizationId });
  const findingId = await s.t.run(async (ctx) => {
    const reviewId = await ctx.db.insert("reviews", { organizationId: s.organizationId, repositoryId, prNumber: 1, headSha: "a".repeat(40), status: "completed", mode: "standard", attempts: 1, createdAt: Date.now(), updatedAt: Date.now() });
    return ctx.db.insert("findings", { organizationId: s.organizationId, repositoryId, reviewId, prNumber: 1, title: "t", description: "d", severity: "high", confidence: 0.9, category: "correctness", filePath: "a.ts", startLine: 1, endLine: 1, commitSha: "a".repeat(40), evidence: [], impact: "i", suggestedFix: "f", symbol: "s", fingerprint: "fp", agent: "correctness", status: "open", createdAt: Date.now(), updatedAt: Date.now() });
  });
  for (let i = 0; i < 2; i++) expect(await s.t.mutation(internal.fixPullRequests.startFromComment, { findingId, author: "carol", prNumber: 1 })).toMatch(/Starter and Pro/);
  expect((await s.keys()).sort()).toEqual([`paywall:fix.pullRequests:${s.organizationId}`, `upgrade_requested:${s.organizationId}`]);
});
