import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { Github } from "../src/github";
import { HttpModel } from "../src/engine/model";
import type { ToolCall, ToolTurn } from "../src/engine/types";
import { defaults } from "../src/review-settings";
import { periodKey } from "../src/billing";

// Autofix: a completed review starts OpenReview's fix agent for its critical and high findings, for the
// pull request's author, within the plan's monthly fix pull requests.
const modules = import.meta.glob("../convex/**/*.ts");
const secret = "autofix-session-secret-at-least-32-characters", head = "h".repeat(40);
const content = "const a = 1;\nconst total = price * 100;\nexport { a };\n";
const patch = "@@ -1,2 +1,3 @@\n const a = 1;\n+const total = price * 100;\n export { a };";
beforeEach(() => { process.env.SESSION_SECRET = secret; process.env.SERVICE_SECRET = "autofix-service"; process.env.LLM_API_KEY = "fixture"; vi.useFakeTimers(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); delete process.env.BILLING_ENABLED; });

// One completed review of PR 5 (by bob) with high, critical, high, high and medium findings, each in its own file.
async function setup(settings: Partial<typeof defaults> = { fixPullRequests: true, autofix: true }) {
  const t = convexTest(schema, modules);
  const userId = await t.mutation(api.users.login, { secret: "autofix-service", githubId: 61, login: "alice", avatar: "" });
  const token = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setSubject(userId).setExpirationTime("1h").sign(new TextEncoder().encode(secret));
  const organizationId = await t.mutation(api.users.createOrganization, { token, name: "Autofix" });
  await t.mutation(api.repositories.connect, { token, secret: "autofix-service", organizationId, installationId: 61, account: "acme", accountId: 1, repositories: [{ id: 6101, fullName: "acme/pay", defaultBranch: "main" }] });
  const [repo] = await t.query(api.repositories.list, { token, organizationId });
  await t.run(async (ctx) => {
    await ctx.db.patch(repo._id, { enabled: true });
    const row = (await ctx.db.query("repositorySettings").withIndex("by_repo", (q) => q.eq("repositoryId", repo._id)).unique())!;
    await ctx.db.patch(row._id, { inherit: false, settings: { ...defaults, ...settings } });
  });
  await t.mutation(internal.pulls.observe, { repositoryId: repo._id, number: 5, title: "Totals", author: "bob", url: "https://github.com/acme/pay/pull/5", headSha: head, baseSha: "b".repeat(40), state: "open", observedAt: 1 });
  const severities = ["high", "critical", "high", "high", "medium"];
  const reviewId = await t.run((ctx) => ctx.db.insert("reviews", { organizationId, repositoryId: repo._id, prNumber: 5, headSha: head, status: "summarizing", mode: "standard", attempts: 1, createdAt: Date.now(), updatedAt: Date.now() }));
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["{}"])));
  await t.mutation(internal.reviews.save, { reviewId, storageId, summary: "Recorded.", resolved: [], usage: [], findings: severities.map((severity, i) => ({ title: `Totals become cents twice ${i}`, description: "The total is multiplied by 100 after conversion.", severity, confidence: 0.95, category: "correctness", filePath: `src/f${i}.ts`, startLine: 2, endLine: 2, commitSha: head, evidence: [{ filePath: `src/f${i}.ts`, startLine: 2, quote: "const total = price * 100;" }], impact: "Invoices are wrong.", suggestedFix: "Round once.", agent: "correctness", symbol: "total", fingerprint: `fp${i}`.padEnd(16, "0") })) });
  await t.run((ctx) => ctx.db.patch(reviewId, { status: "completed" }));
  const findingOf = (i: number) => t.run(async (ctx) => (await ctx.db.query("findings").collect()).find((f) => f.filePath === `src/f${i}.ts`)!);
  const scheduled = async (name: string) => (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((s) => s.name.includes(name));
  const subscribe = (plan: string) => t.run((ctx) => ctx.db.insert("billingAccounts", { organizationId, status: "active", seats: 1, trialEndsAt: 0, subscriptionId: "sub_1", plan, updatedAt: 0 }));
  return { t, organizationId, repo, reviewId, findingOf, scheduled, subscribe };
}

test("a completed review starts Autofix only with fix pull requests and Autofix on, on a plan that includes them", async () => {
  for (const settings of [{ fixPullRequests: true, autofix: false }, { fixPullRequests: false, autofix: true }]) {
    const s = await setup(settings);
    await s.t.mutation(internal.reviews.finished, { reviewId: s.reviewId });
    expect(await s.scheduled("autofix:start")).toHaveLength(0);
  }
  // Self-hosted (billing off): on; a failed review never starts it.
  let s = await setup();
  await s.t.mutation(internal.reviews.finished, { reviewId: s.reviewId, error: "boom" });
  expect(await s.scheduled("autofix:start")).toHaveLength(0);
  await s.t.mutation(internal.reviews.finished, { reviewId: s.reviewId });
  expect(await s.scheduled("autofix:start")).toHaveLength(1);
  // Cloud: no plan, no Autofix; Starter includes fix pull requests.
  s = await setup();
  process.env.BILLING_ENABLED = "true";
  await s.t.mutation(internal.reviews.finished, { reviewId: s.reviewId });
  expect(await s.scheduled("autofix:start")).toHaveLength(0);
  await s.subscribe("starter");
  await s.t.mutation(internal.reviews.finished, { reviewId: s.reviewId });
  expect(await s.scheduled("autofix:start")).toHaveLength(1);
});

test("Autofix starts at most three fix agent runs, critical first, for the PR author, skipping issues that have a fix PR", async () => {
  const s = await setup();
  const fixedAlready = await s.findingOf(0);
  await s.t.mutation(internal.issues.recordFixPullRequest, { findingId: fixedAlready._id, url: "https://github.com/acme/pay/pull/90", automatic: false });
  expect(await s.t.mutation(internal.autofix.start, { reviewId: s.reviewId })).toBe(3);
  const runs = (await s.scheduled("fixPullRequestJobs:run")).map((r) => r.args[0] as { findingId: string; author: string; automatic: boolean });
  expect(runs.map((r) => [r.findingId, r.author, r.automatic])).toEqual([(await s.findingOf(1))._id, (await s.findingOf(2))._id, (await s.findingOf(3))._id].map((id) => [id, "bob", true]));
  expect((await s.t.run((ctx) => ctx.db.query("auditEvents").collect())).filter((e) => e.action === "fix_pull_request.autofix")).toHaveLength(3);
});

test("Autofix stops at the plan's monthly fix pull requests", async () => {
  const s = await setup();
  process.env.BILLING_ENABLED = "true";
  await s.subscribe("starter");
  // Starter allows 5 agent fixes per seat; 4 are used.
  const organizationId = s.organizationId;
  await s.t.run((ctx) => ctx.db.insert("billingUsage", { organizationId, period: periodKey(Date.now()), reviews: 0, blocked: 0, fixes: 4 }));
  expect(await s.t.mutation(internal.autofix.start, { reviewId: s.reviewId })).toBe(1);
  const audits = (await s.t.run((ctx) => ctx.db.query("auditEvents").collect())).map((e) => e.action);
  expect([audits.filter((a) => a === "fix_pull_request.autofix").length, audits.filter((a) => a === "fix_pull_request.autofix_skipped").length]).toEqual([1, 1]);
});

test("an Autofix run opens the agent's fix pull request for the author and records it on the issue", async () => {
  const s = await setup();
  const finding = await s.findingOf(1);
  const scm = new Github("fixture", undefined, undefined, { contents: "write", pull_requests: "write" });
  vi.spyOn(Github, "installation").mockResolvedValue(scm);
  const canReply = vi.spyOn(scm, "canReply").mockResolvedValue(true);
  vi.spyOn(scm, "pullRequest").mockResolvedValue({ number: 5, title: "Totals", body: "", draft: false, state: "open", html_url: "https://github.com/acme/pay/pull/5", user: { login: "bob" }, head: { sha: head, ref: "feature/totals" }, base: { sha: "b".repeat(40), ref: "main" }, diff: [{ path: "src/f1.ts", patch, status: "modified" }], comments: [], reviews: [], commits: [], checks: [], omitted: [] } as never);
  vi.spyOn(scm, "tree").mockResolvedValue([{ path: "src/f1.ts", sha: "blob1", type: "blob", mode: "100644" }] as never);
  vi.spyOn(scm, "blob").mockResolvedValue({ path: "src/f1.ts", sha: "blob1", content });
  const openFix = vi.spyOn(scm, "openFixPullRequest").mockResolvedValue({ url: "https://github.com/acme/pay/pull/6", reused: false });
  const turns: ToolCall[][] = [[{ id: "e", name: "edit_file", input: { path: "src/f1.ts", oldText: "const total = price * 100;", newText: "const total = Math.round(price * 100);" } }], [{ id: "f", name: "finish", input: { summary: "Round the converted total once." } }]];
  vi.spyOn(HttpModel.prototype, "runTools").mockImplementation(async (): Promise<ToolTurn> => {
    const calls = turns.shift() ?? [];
    return { content: calls.length ? "" : "Done.", toolCalls: calls, stopReason: calls.length ? "tool_use" : "end_turn", usage: { task: "fix", provider: "fixture", model: "fixture", inputTokens: 10, outputTokens: 5, latencyMs: 1, estimatedCost: 0.001, cached: false }, message: { role: "assistant", content: "", toolCalls: calls } } as ToolTurn;
  });
  await s.t.action(internal.fixPullRequestJobs.run, { findingId: finding._id, author: "bob", automatic: true });
  expect(canReply).toHaveBeenCalledWith("acme/pay", "bob");
  const [, number, fix] = openFix.mock.calls[0];
  expect([number, fix.branch, fix.files.map((f) => f.path)]).toEqual([5, "openreview/fix-5-fp1000000000", ["src/f1.ts"]]);
  expect(fix.body).toMatch(/^Opened automatically by OpenReview Autofix \(repository setting\) for the finding in `src\/f1\.ts:2`/);
  const issue = (await s.t.run((ctx) => ctx.db.get(finding.issueId!)))!;
  expect(issue.fixPullRequestUrl).toBe("https://github.com/acme/pay/pull/6");
  expect((await s.t.run((ctx) => ctx.db.query("issueEvents").withIndex("by_issue", (q) => q.eq("issueId", issue._id)).collect())).at(-1)?.detail).toBe("Autofix opened a fix pull request: https://github.com/acme/pay/pull/6");
});
