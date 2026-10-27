import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { Github } from "../src/github";
import { HttpModel } from "../src/engine/model";
import { defaults } from "../src/review-settings";

const modules = import.meta.glob("../convex/**/*.ts");
const secret = "autofix-session-secret-at-least-32-characters", head = "h".repeat(40);
const content = "const a = 1;\nconst total = price * 100;\nexport { a };\n";
const patch = "@@ -1,2 +1,3 @@\n const a = 1;\n+const total = price * 100;\n export { a };";
beforeEach(() => { process.env.SESSION_SECRET = secret; process.env.SERVICE_SECRET = "autofix-service"; });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); delete process.env.BILLING_ENABLED; });

// One completed review with critical, high and medium findings, each in its own file.
async function setup(settings: Partial<typeof defaults> = { fixPullRequests: true, autofix: true }) {
  const t = convexTest(schema, modules);
  const userId = await t.mutation(api.users.login, { secret: "autofix-service", githubId: 61, login: "alice", avatar: "" });
  const token = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setSubject(userId).setExpirationTime("1h").sign(new TextEncoder().encode(secret));
  const organizationId = await t.mutation(api.users.createOrganization, { token, name: "Autofix" });
  await t.mutation(api.repositories.connect, { token, secret: "autofix-service", organizationId, installationId: 61, account: "acme", accountId: 1, repositories: [{ id: 6101, fullName: "acme/pay", defaultBranch: "main" }] });
  const [repo] = await t.query(api.repositories.list, { token, organizationId });
  await t.mutation(api.repositories.configure, { token, repositoryId: repo._id, enabled: true, settings: { ...defaults, ...settings } });
  const severities = ["high", "critical", "high", "high", "medium"];
  const reviewId = await t.run((ctx) => ctx.db.insert("reviews", { organizationId, repositoryId: repo._id, prNumber: 5, headSha: head, status: "summarizing", mode: "standard", attempts: 1, createdAt: Date.now(), updatedAt: Date.now() }));
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["{}"])));
  await t.mutation(internal.reviews.save, { reviewId, storageId, summary: "Recorded.", resolved: [], usage: [], findings: severities.map((severity, i) => ({ title: `Totals become cents twice ${i}`, description: "The total is multiplied by 100 after conversion.", severity, confidence: 0.95, category: "correctness", filePath: `src/f${i}.ts`, startLine: 2, endLine: 2, commitSha: head, evidence: [{ filePath: `src/f${i}.ts`, startLine: 2, quote: "const total = price * 100;" }], impact: "Invoices are wrong.", suggestedFix: "Round once.", agent: "correctness", symbol: "total", fingerprint: `fp${i}`.padEnd(16, "0"), suggestion: { startLine: 2, endLine: 2, original: "const total = price * 100;", replacement: "const total = Math.round(price * 100);" } })) });
  await t.run((ctx) => ctx.db.patch(reviewId, { status: "completed" }));
  const scm = new Github("fixture", undefined, undefined, { contents: "write", pull_requests: "write" });
  vi.spyOn(Github, "installation").mockResolvedValue(scm);
  const canReply = vi.spyOn(scm, "canReply").mockResolvedValue(true);
  const pullRequest = vi.spyOn(scm, "pullRequest").mockResolvedValue({ number: 5, title: "Totals", body: "", draft: false, state: "open", html_url: "https://github.com/acme/pay/pull/5", user: { login: "bob" }, head: { sha: head, ref: "feature/totals" }, base: { sha: "b".repeat(40), ref: "main" }, diff: severities.map((_, i) => ({ path: `src/f${i}.ts`, patch, status: "modified" })), comments: [], reviews: [], commits: [], checks: [], omitted: [] } as never);
  vi.spyOn(scm, "tree").mockResolvedValue(severities.map((_, i) => ({ path: `src/f${i}.ts`, sha: `blob${i}`, type: "blob", mode: "100644" })) as never);
  vi.spyOn(scm, "blob").mockImplementation(async (_repo, path, sha) => ({ path, sha, content }));
  const openFix = vi.spyOn(scm, "openFixPullRequest").mockImplementation(async (_repo, _n, fix) => ({ url: `https://github.com/acme/pay/pull/${100 + Number(fix.path.match(/\d/)![0])}`, reused: false }));
  const model = vi.spyOn(HttpModel.prototype, "generate");
  const scheduled = async () => (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((s) => s.name.includes("autofixJobs")).length;
  return { t, organizationId, repo, reviewId, scm, canReply, pullRequest, openFix, model, scheduled };
}

test("a completed review starts Autofix only with fix pull requests and Autofix on, on a plan that includes them", async () => {
  // Scheduled jobs stay queued here, so they never run against another test's fake GitHub.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let s = await setup({ fixPullRequests: true, autofix: false });
  await s.t.mutation(internal.reviews.finished, { reviewId: s.reviewId });
  expect(await s.scheduled()).toBe(0);
  s = await setup({ fixPullRequests: false, autofix: true });
  await s.t.mutation(internal.reviews.finished, { reviewId: s.reviewId });
  expect(await s.scheduled()).toBe(0);
  // Self-hosted (billing off): on.
  s = await setup();
  await s.t.mutation(internal.reviews.finished, { reviewId: s.reviewId, error: "boom" });
  expect(await s.scheduled()).toBe(0);
  await s.t.mutation(internal.reviews.finished, { reviewId: s.reviewId });
  expect(await s.scheduled()).toBe(1);
  // Starter: off. Pro: on.
  s = await setup();
  const organizationId = s.organizationId;
  await s.t.run((ctx) => ctx.db.insert("billingAccounts", { organizationId, status: "active", seats: 1, trialEndsAt: 0, subscriptionId: "sub_1", tier: "starter", updatedAt: 0 }));
  process.env.BILLING_ENABLED = "true";
  await s.t.mutation(internal.reviews.finished, { reviewId: s.reviewId });
  expect(await s.scheduled()).toBe(0);
  await s.t.run(async (ctx) => { const account = (await ctx.db.query("billingAccounts").collect())[0]; await ctx.db.patch(account._id, { tier: "pro" }); });
  await s.t.mutation(internal.reviews.finished, { reviewId: s.reviewId });
  expect(await s.scheduled()).toBe(1);
});

test("Autofix opens at most three fix pull requests, critical first, for the PR author, and never twice for an issue", async () => {
  const s = await setup();
  const opened = await s.t.action(internal.autofixJobs.run, { reviewId: s.reviewId });
  expect(opened).toEqual(["https://github.com/acme/pay/pull/101", "https://github.com/acme/pay/pull/100", "https://github.com/acme/pay/pull/102"]);
  expect(s.model).not.toHaveBeenCalled();
  expect(s.canReply).toHaveBeenCalledWith("acme/pay", "bob");
  const [, , fix] = s.openFix.mock.calls[0];
  expect(fix).toMatchObject({ branch: "openreview/fix-5-fp1000000000", expectedHead: head, path: "src/f1.ts", content: "const a = 1;\nconst total = Math.round(price * 100);\nexport { a };\n" });
  expect(fix.body).toMatch(/^Opened automatically by OpenReview Autofix \(repository setting\) for the finding in `src\/f1\.ts:2`/);
  const issues = await s.t.run((ctx) => ctx.db.query("issues").collect());
  expect(issues.filter((i) => i.fixPullRequestUrl).map((i) => i.fingerprint).sort()).toEqual(["fp0000000000000", "fp1000000000000", "fp2000000000000"].map((f) => f.padEnd(16, "0")));
  expect((await s.t.run((ctx) => ctx.db.query("auditEvents").collect())).filter((e) => e.action === "fix_pull_request.autofix")).toHaveLength(3);
  // The next run takes the remaining high finding only; the medium one is never fixed automatically.
  expect(await s.t.action(internal.autofixJobs.run, { reviewId: s.reviewId })).toEqual(["https://github.com/acme/pay/pull/103"]);
  expect(await s.t.action(internal.autofixJobs.run, { reviewId: s.reviewId })).toEqual([]);
  expect(s.openFix).toHaveBeenCalledTimes(4);
});

test("Autofix stops when the pull request moved, the App cannot write contents, or the author lost write access", async () => {
  let s = await setup();
  s.pullRequest.mockResolvedValue({ ...(await s.pullRequest.getMockImplementation()!("acme/pay", 5)), head: { sha: "z".repeat(40), ref: "feature/totals" } } as never);
  expect(await s.t.action(internal.autofixJobs.run, { reviewId: s.reviewId })).toEqual([]);
  s = await setup();
  (s.scm as unknown as { permissions: Record<string, string> }).permissions = { contents: "read" };
  expect(await s.t.action(internal.autofixJobs.run, { reviewId: s.reviewId })).toEqual([]);
  expect(s.openFix).not.toHaveBeenCalled();
  s = await setup();
  s.canReply.mockResolvedValue(false);
  expect(await s.t.action(internal.autofixJobs.run, { reviewId: s.reviewId })).toEqual([]);
  expect((await s.t.run((ctx) => ctx.db.query("auditEvents").collect())).filter((e) => e.action === "fix_pull_request.autofix_skipped")).toHaveLength(3);
});
