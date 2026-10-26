import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { HttpModel } from "../src/engine/model";
import type { ToolCall, ToolRequest, ToolTurn } from "../src/engine/types";
import { Github } from "../src/github";
import { Gitea } from "../src/gitea";
import { defaults } from "../src/review-settings";

// "Fix with OpenReview" from the dashboard: who may start it, when it is refused, and that OpenReview's fix
// agent runs in the background and opens a pull request for the signed-in user's GitHub account.
const modules = import.meta.glob("../convex/**/*.ts");
const secret = "fixpr-session-secret-at-least-32-characters", head = "h".repeat(40);
const content = "const a = 1;\nconst total = price * 100;\nexport { a };\n";
const patch = "@@ -1,2 +1,3 @@\n const a = 1;\n+const total = price * 100;\n export { a };";
beforeEach(() => { process.env.SESSION_SECRET = secret; process.env.SERVICE_SECRET = "fixpr-service"; process.env.LLM_API_KEY = "fixture"; vi.useFakeTimers(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const sign = (userId: string) => new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setSubject(userId).setExpirationTime("1h").sign(new TextEncoder().encode(secret));

async function setup(permissions: Record<string, string> = { contents: "write", pull_requests: "write" }) {
  const t = convexTest(schema, modules);
  const userId = await t.mutation(api.users.login, { secret: "fixpr-service", githubId: 81, login: "alice", avatar: "" });
  const token = await sign(userId);
  const organizationId = await t.mutation(api.users.createOrganization, { token, name: "Fixes" });
  await t.mutation(api.repositories.connect, { token, secret: "fixpr-service", organizationId, installationId: 81, account: "alice", accountId: 1, repositories: [{ id: 8181, fullName: "alice/fixes", defaultBranch: "main" }] });
  const [repo] = await t.query(api.repositories.list, { token, organizationId });
  await t.run(async (ctx) => {
    await ctx.db.patch(repo._id, { enabled: true });
    const settings = (await ctx.db.query("repositorySettings").withIndex("by_repo", (q) => q.eq("repositoryId", repo._id)).unique())!;
    await ctx.db.patch(settings._id, { inherit: false, settings: { ...defaults, fixPullRequests: true } });
  });
  const { reviewId, findingId } = await t.run(async (ctx) => {
    const reviewId = await ctx.db.insert("reviews", { organizationId, repositoryId: repo._id, prNumber: 3, headSha: head, status: "completed", mode: "standard", attempts: 1, createdAt: Date.now(), updatedAt: Date.now() });
    const findingId = await ctx.db.insert("findings", { organizationId, repositoryId: repo._id, reviewId, prNumber: 3, title: "Totals become cents twice", description: "The total is multiplied by 100 after conversion.", severity: "high", confidence: 0.95, category: "correctness", filePath: "src/a.ts", startLine: 2, endLine: 2, commitSha: head, evidence: [{ filePath: "src/a.ts", startLine: 2, quote: "const total = price * 100;" }], impact: "Invoices are wrong.", suggestedFix: "Round once.", symbol: "total", fingerprint: "fp0123456789abcdef", agent: "correctness", status: "open", createdAt: Date.now(), updatedAt: Date.now(), suggestion: { startLine: 2, endLine: 2, original: "const total = price * 100;", replacement: "const total = Math.round(price * 100);" } });
    return { reviewId, findingId };
  });
  const scm = new Github("fixture", undefined, undefined, permissions);
  vi.spyOn(Github, "installation").mockResolvedValue(scm);
  vi.spyOn(scm, "request").mockImplementation(async (endpoint: string) => { if (endpoint === "/user/81") return { login: "alice" } as never; throw new Error("unexpected " + endpoint); });
  const canReply = vi.spyOn(scm, "canReply").mockResolvedValue(true);
  vi.spyOn(scm, "pullRequest").mockResolvedValue({ number: 3, title: "Totals", body: "", draft: false, state: "open", html_url: "https://github.com/alice/fixes/pull/3", user: { login: "bob" }, head: { sha: head, ref: "feature/totals" }, base: { sha: "b".repeat(40), ref: "main" }, diff: [{ path: "src/a.ts", patch, status: "modified" }], comments: [], reviews: [], commits: [], checks: [], omitted: [] } as never);
  vi.spyOn(scm, "tree").mockResolvedValue([{ path: "src/a.ts", sha: "blob1", type: "blob", mode: "100755" }] as never);
  vi.spyOn(scm, "blob").mockResolvedValue({ path: "src/a.ts", sha: "blob1", content });
  const openFix = vi.spyOn(scm, "openFixPullRequest").mockResolvedValue({ url: "https://github.com/alice/fixes/pull/4", reused: false });
  const audits = async () => (await t.run((ctx) => ctx.db.query("auditEvents").collect())).map((a) => a.action);
  // The fix agent's model: each turn returns the next scripted tool calls.
  const agent = (turns: ToolCall[][]) => vi.spyOn(HttpModel.prototype, "runTools").mockImplementation(async (_request: ToolRequest): Promise<ToolTurn> => {
    const calls = turns.shift() ?? [];
    return { content: calls.length ? "" : "Done.", toolCalls: calls, stopReason: calls.length ? "tool_use" : "end_turn", usage: { task: "fix", provider: "fixture", model: "fixture", inputTokens: 10, outputTokens: 5, latencyMs: 1, estimatedCost: 0.001, cached: false }, message: { role: "assistant", content: "", toolCalls: calls } };
  });
  const rounds = () => agent([
    [{ id: "e", name: "edit_file", input: { path: "src/a.ts", oldText: "const total = price * 100;", newText: "const total = Math.round(price * 100);" } }],
    [{ id: "f", name: "finish", input: { summary: "Round the converted total once." } }],
  ]);
  const start = async (tok = token) => t.mutation(api.fixPullRequests.start, { token: tok, findingId });
  const settle = () => t.finishAllScheduledFunctions(() => vi.runAllTimersAsync());
  const status = (requestId: Awaited<ReturnType<typeof start>>) => t.query(api.bridge.status, { token, requestId });
  return { t, token, userId, organizationId, repo, reviewId, findingId, canReply, openFix, audits, agent, rounds, start, settle, status };
}

test("a writer starts OpenReview's fix agent; it opens the fix pull request for their GitHub account, and it is audited", async () => {
  const { t, token, reviewId, start, settle, status, rounds, openFix, canReply, audits } = await setup();
  expect(await t.query(api.fixPullRequests.availability, { token, reviewId })).toEqual({ github: true, enabled: true, entitled: true, permission: "unknown" });
  const model = rounds();
  const requestId = await start();
  expect(await status(requestId)).toMatchObject({ status: "queued" });
  await settle();
  expect(await status(requestId)).toMatchObject({ status: "opened", pullRequestUrl: "https://github.com/alice/fixes/pull/4" });
  expect(canReply).toHaveBeenCalledWith("alice/fixes", "alice");
  // The agent works at the reviewed head, and its edit is the only change committed.
  expect(model.mock.calls[0][0].messages[0]).toMatchObject({ role: "user", content: expect.stringContaining("Totals become cents twice") });
  const [repository, number, fix] = openFix.mock.calls[0];
  expect([repository, number, fix.branch, fix.expectedHead]).toEqual(["alice/fixes", 3, "openreview/fix-3-fp0123456789", head]);
  expect(fix.files).toEqual([{ path: "src/a.ts", content: "const a = 1;\nconst total = Math.round(price * 100);\nexport { a };\n", mode: "100755" }]);
  expect(fix.body).toContain("Requested by @alice");
  expect(fix.body).toContain("Round the converted total once.");
  expect(fix.body).toContain("No tests were run by OpenReview");
  expect(await audits()).toEqual(expect.arrayContaining(["fix_pull_request.requested", "fix_pull_request.opened"]));
  expect((await t.run((ctx) => ctx.db.query("usageEvents").collect())).some((u) => u.kind === "fix")).toBe(true);
  // The token's permissions are recorded, so settings show what GitHub granted.
  expect(await t.query(api.fixPullRequests.availability, { token, reviewId })).toMatchObject({ permission: "write" });
});

test("without Contents write, or when the agent changes nothing or stops early, no pull request is opened and the run explains", async () => {
  let s = await setup({ contents: "read", pull_requests: "write" });
  let model = s.rounds();
  let requestId = await s.start();
  await s.settle();
  expect(await s.status(requestId)).toMatchObject({ status: "failed", error: expect.stringMatching(/Contents: Read and write/) });
  expect(model).not.toHaveBeenCalled();
  expect(s.openFix).not.toHaveBeenCalled();
  expect(await s.audits()).toContain("fix_pull_request.skipped");
  expect(await s.t.query(api.fixPullRequests.availability, { token: s.token, reviewId: s.reviewId })).toMatchObject({ permission: "read" });

  s = await setup();
  s.agent([[{ id: "f", name: "finish", input: { summary: "The total is already rounded upstream." } }]]);
  requestId = await s.start();
  await s.settle();
  expect(await s.status(requestId)).toMatchObject({ status: "failed", error: expect.stringContaining("made no changes: The total is already rounded upstream.") });
  vi.mocked(HttpModel.prototype.runTools).mockRestore();
  model = s.agent(Array.from({ length: 40 }, () => [{ id: "r", name: "read_file", input: { path: "src/a.ts" } }]));
  requestId = await s.start();
  await s.settle();
  expect(await s.status(requestId)).toMatchObject({ status: "failed", error: expect.stringMatching(/stopped early/) });
  expect(s.openFix).not.toHaveBeenCalled();
});

test("viewers, disabled toggles, stale reviews, duplicate runs, other providers and accounts without GitHub are refused", async () => {
  const { t, token, organizationId, repo, reviewId, start, openFix } = await setup();
  // A viewer has no write access.
  const viewer = await t.mutation(api.users.login, { secret: "fixpr-service", githubId: 82, login: "victor", avatar: "" });
  await t.run((ctx) => ctx.db.insert("organizationMembers", { organizationId, userId: viewer, role: "viewer" }));
  await expect(start(await sign(viewer))).rejects.toThrow();
  // A member without a linked GitHub account cannot be checked on GitHub.
  const emailUser = await t.run((ctx) => ctx.db.insert("users", { login: "erin@example.com", avatar: "", createdAt: Date.now() }));
  await t.run((ctx) => ctx.db.insert("organizationMembers", { organizationId, userId: emailUser, role: "member" }));
  await expect(start(await sign(emailUser))).rejects.toThrow(/Sign in with GitHub/);
  // The repository toggle is off.
  const settings = (await t.run((ctx) => ctx.db.query("repositorySettings").withIndex("by_repo", (q) => q.eq("repositoryId", repo._id)).unique()))!;
  await t.run((ctx) => ctx.db.patch(settings._id, { settings: { ...defaults, fixPullRequests: false } }));
  await expect(start()).rejects.toThrow(/turned off/);
  expect(await t.query(api.fixPullRequests.availability, { token, reviewId })).toMatchObject({ enabled: false });
  await t.run((ctx) => ctx.db.patch(settings._id, { settings: { ...defaults, fixPullRequests: true } }));
  // A newer review replaced this one.
  const newer = await t.run((ctx) => ctx.db.insert("reviews", { organizationId, repositoryId: repo._id, prNumber: 3, headSha: "n".repeat(40), status: "completed", mode: "standard", attempts: 1, createdAt: Date.now(), updatedAt: Date.now() }));
  await expect(start()).rejects.toThrow(/latest completed review/);
  await t.run((ctx) => ctx.db.delete(newer));
  // A second click while the first run is queued does not start (or count) another.
  await start();
  await expect(start()).rejects.toThrow(/already fixing this finding/);
  // Non-GitHub repositories use the comment command instead.
  const connectionId = await t.run((ctx) => ctx.db.insert("providerConnections", { organizationId, kind: "gitlab", name: "GitLab", instance: "https://gitlab.com", credentials: "x", webhookSecret: "", active: true, createdAt: Date.now() }));
  await t.run((ctx) => ctx.db.patch(repo._id, { connectionId }));
  await expect(start()).rejects.toThrow(/GitHub App repositories/);
  expect(openFix).not.toHaveBeenCalled();
});

test("Gitea explains that fix pull requests are not available instead of blaming GitHub permissions", async () => {
  const gitea = new Gitea("https://gitea.example.com", "token");
  expect(await gitea.openFixPullRequest("o/r", 1, { branch: "openreview/fix-1-abc", expectedHead: head, files: [{ path: "a.ts", content: "", mode: "100644" }], title: "t", body: "b", message: "m" })).toEqual({ skipped: "fix pull requests are not available for Gitea yet" });
});

test("agent fixes are on Starter and Pro, counted each month, and a run that fails before the agent gives its fix back", async () => {
  const { t, token, organizationId, reviewId, start, settle, status, rounds, openFix, canReply } = await setup();
  process.env.BILLING_ENABLED = "true";
  try {
    // Free: copy prompts and your own agents only.
    expect(await t.query(api.fixPullRequests.availability, { token, reviewId })).toMatchObject({ enabled: true, entitled: false });
    await expect(start()).rejects.toThrow(/Starter and Pro/);
    // Starter with one seat: 5 agent fixes a month.
    await t.run((ctx) => ctx.db.insert("billingAccounts", { organizationId, customerId: "cus_1", subscriptionId: "sub_1", plan: "starter", status: "active", seats: 1, trialEndsAt: Date.now(), updatedAt: Date.now() }));
    const period = new Date().toISOString().slice(0, 7);
    await t.run((ctx) => ctx.db.insert("billingUsage", { organizationId, period, reviews: 0, blocked: 0, fixes: 4 }));
    const fixes = async () => (await t.run((ctx) => ctx.db.query("billingUsage").collect()))[0].fixes;
    rounds();
    const requestId = await start();
    expect(await fixes()).toBe(5);
    await settle();
    expect(await status(requestId)).toMatchObject({ status: "opened" });
    await expect(start()).rejects.toThrow(/used its 5 agent fixes/);
    expect(openFix).toHaveBeenCalledTimes(1);
    // A run stopped before any model call (the requester lost write access on GitHub) gives its fix back.
    await t.run(async (ctx) => { const usage = (await ctx.db.query("billingUsage").collect())[0]; await ctx.db.patch(usage._id, { fixes: 4 }); });
    canReply.mockResolvedValue(false);
    const refused = await start();
    expect(await fixes()).toBe(5);
    await settle();
    expect(await status(refused)).toMatchObject({ status: "failed", error: expect.stringMatching(/needs write access/) });
    expect(await fixes()).toBe(4);
  } finally { delete process.env.BILLING_ENABLED; }
});
