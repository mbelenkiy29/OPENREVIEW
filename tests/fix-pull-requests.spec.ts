import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { Github } from "../src/github";
import { Gitea } from "../src/gitea";
import { defaults } from "../src/review-settings";

// "Open a fix PR" from the dashboard: who may start it, when it is refused, and that it opens the same
// fix pull request as "@openreview fix this in a new PR" for the signed-in user's GitHub account.
const modules = import.meta.glob("../convex/**/*.ts");
const secret = "fixpr-session-secret-at-least-32-characters", head = "h".repeat(40);
const content = "const a = 1;\nconst total = price * 100;\nexport { a };\n";
const patch = "@@ -1,2 +1,3 @@\n const a = 1;\n+const total = price * 100;\n export { a };";
beforeEach(() => { process.env.SESSION_SECRET = secret; process.env.SERVICE_SECRET = "fixpr-service"; });
afterEach(() => { vi.restoreAllMocks(); });
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
  vi.spyOn(scm, "tree").mockResolvedValue([{ path: "src/a.ts", sha: "blob1", type: "blob", mode: "100644" }] as never);
  vi.spyOn(scm, "blob").mockResolvedValue({ path: "src/a.ts", sha: "blob1", content });
  const openFix = vi.spyOn(scm, "openFixPullRequest").mockResolvedValue({ url: "https://github.com/alice/fixes/pull/4", reused: false });
  const audits = async () => (await t.run((ctx) => ctx.db.query("auditEvents").collect())).map((a) => a.action);
  return { t, token, userId, organizationId, repo, reviewId, findingId, canReply, openFix, audits };
}

test("a writer opens the fix pull request for their GitHub account, and it is audited", async () => {
  const { t, token, reviewId, findingId, openFix, canReply, audits } = await setup();
  expect(await t.query(api.fixPullRequests.availability, { token, reviewId })).toEqual({ github: true, enabled: true, permission: "unknown" });
  expect(await t.action(api.fixPullRequestJobs.open, { token, findingId })).toEqual({ url: "https://github.com/alice/fixes/pull/4", reused: false });
  expect(canReply).toHaveBeenCalledWith("alice/fixes", "alice");
  const [repository, number, fix] = openFix.mock.calls[0];
  expect([repository, number, fix.branch, fix.expectedHead, fix.path]).toEqual(["alice/fixes", 3, "openreview/fix-3-fp0123456789", head, "src/a.ts"]);
  expect(fix.content).toBe("const a = 1;\nconst total = Math.round(price * 100);\nexport { a };\n");
  expect(fix.body).toContain("Requested by @alice in the OpenReview dashboard");
  expect(await audits()).toEqual(expect.arrayContaining(["fix_pull_request.requested", "fix_pull_request.opened"]));
  // The token's permissions are recorded, so settings show what GitHub granted.
  expect(await t.query(api.fixPullRequests.availability, { token, reviewId })).toMatchObject({ permission: "write" });
});

test("without Contents write, OpenReview explains instead of trying, and records the permission", async () => {
  const { t, token, reviewId, findingId, openFix, audits } = await setup({ contents: "read", pull_requests: "write" });
  const result = await t.action(api.fixPullRequestJobs.open, { token, findingId });
  expect(result.note).toMatch(/Contents: Read and write/);
  expect(openFix).not.toHaveBeenCalled();
  expect(await audits()).toContain("fix_pull_request.skipped");
  expect(await t.query(api.fixPullRequests.availability, { token, reviewId })).toMatchObject({ permission: "read" });
});

test("viewers, disabled toggles, stale reviews, other providers and accounts without GitHub are refused", async () => {
  const { t, token, organizationId, repo, findingId, reviewId, openFix } = await setup();
  const open = (tok: string) => t.action(api.fixPullRequestJobs.open, { token: tok, findingId });
  // A viewer has no write access.
  const viewer = await t.mutation(api.users.login, { secret: "fixpr-service", githubId: 82, login: "victor", avatar: "" });
  await t.run((ctx) => ctx.db.insert("organizationMembers", { organizationId, userId: viewer, role: "viewer" }));
  await expect(open(await sign(viewer))).rejects.toThrow();
  // A member without a linked GitHub account cannot be checked on GitHub.
  const emailUser = await t.run((ctx) => ctx.db.insert("users", { login: "erin@example.com", avatar: "", createdAt: Date.now() }));
  await t.run((ctx) => ctx.db.insert("organizationMembers", { organizationId, userId: emailUser, role: "member" }));
  await expect(open(await sign(emailUser))).rejects.toThrow(/Sign in with GitHub/);
  // The repository toggle is off.
  const settings = (await t.run((ctx) => ctx.db.query("repositorySettings").withIndex("by_repo", (q) => q.eq("repositoryId", repo._id)).unique()))!;
  await t.run((ctx) => ctx.db.patch(settings._id, { settings: { ...defaults, fixPullRequests: false } }));
  await expect(open(token)).rejects.toThrow(/turned off/);
  expect(await t.query(api.fixPullRequests.availability, { token, reviewId })).toMatchObject({ enabled: false });
  await t.run((ctx) => ctx.db.patch(settings._id, { settings: { ...defaults, fixPullRequests: true } }));
  // A newer review replaced this one.
  const newer = await t.run((ctx) => ctx.db.insert("reviews", { organizationId, repositoryId: repo._id, prNumber: 3, headSha: "n".repeat(40), status: "completed", mode: "standard", attempts: 1, createdAt: Date.now(), updatedAt: Date.now() }));
  await expect(open(token)).rejects.toThrow(/latest completed review/);
  await t.run((ctx) => ctx.db.delete(newer));
  // Non-GitHub repositories use the comment command instead.
  const connectionId = await t.run((ctx) => ctx.db.insert("providerConnections", { organizationId, kind: "gitlab", name: "GitLab", instance: "https://gitlab.com", credentials: "x", webhookSecret: "", active: true, createdAt: Date.now() }));
  await t.run((ctx) => ctx.db.patch(repo._id, { connectionId }));
  await expect(open(token)).rejects.toThrow(/GitHub App repositories/);
  expect(openFix).not.toHaveBeenCalled();
});

test("Gitea explains that fix pull requests are not available instead of blaming GitHub permissions", async () => {
  const gitea = new Gitea("https://gitea.example.com", "token");
  expect(await gitea.openFixPullRequest("o/r", 1, { branch: "openreview/fix-1-abc", expectedHead: head, path: "a.ts", blobSha: "s", content: "", title: "t", body: "b", message: "m" })).toEqual({ skipped: "fix pull requests are not available for Gitea yet" });
});

test("fix pull requests are a Pro feature when billing is on", async () => {
  const { t, token, organizationId, findingId, openFix } = await setup();
  process.env.BILLING_ENABLED = "true";
  try {
    await expect(t.action(api.fixPullRequestJobs.open, { token, findingId })).rejects.toThrow(/Pro plan/);
    expect(openFix).not.toHaveBeenCalled();
    await t.run((ctx) => ctx.db.insert("billingAccounts", { organizationId, customerId: "cus_1", subscriptionId: "sub_1", plan: "pro", status: "active", seats: 1, trialEndsAt: Date.now(), updatedAt: Date.now() }));
    expect(await t.action(api.fixPullRequestJobs.open, { token, findingId })).toEqual({ url: "https://github.com/alice/fixes/pull/4", reused: false });
  } finally { delete process.env.BILLING_ENABLED; }
});
