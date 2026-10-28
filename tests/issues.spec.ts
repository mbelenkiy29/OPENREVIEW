import { beforeEach, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");
const secret = "issues-session-secret-at-least-32-characters";
beforeEach(() => { process.env.SERVICE_SECRET = "issues-service"; process.env.SESSION_SECRET = secret; });
const sha = (c: string) => c.repeat(40);

async function setup() {
  const t = convexTest(schema, modules);
  const login = async (githubId: number, name: string) => {
    const id = (await t.mutation(api.users.login, { secret: "issues-service", githubId, login: name, avatar: "" })) as Id<"users">;
    return { id, token: await new SignJWT({}).setSubject(id).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode(secret)) };
  };
  const alice = await login(1, "alice"), bob = await login(2, "bob"), vera = await login(3, "vera"), mallory = await login(4, "mallory");
  const organizationId = await t.mutation(api.users.createOrganization, { token: alice.token, name: "Issues" });
  await t.mutation(api.repositories.connect, { token: alice.token, secret: "issues-service", organizationId, installationId: 91, account: "acme", accountId: 1, repositories: [{ id: 910, fullName: "acme/pay", defaultBranch: "main" }] });
  const [repo] = await t.query(api.repositories.list, { token: alice.token, organizationId });
  await t.run(async (ctx) => {
    await ctx.db.patch(repo._id, { enabled: true });
    await ctx.db.insert("organizationMembers", { organizationId, userId: bob.id, role: "member" });
    await ctx.db.insert("organizationMembers", { organizationId, userId: vera.id, role: "viewer" });
  });
  await t.mutation(api.users.createOrganization, { token: mallory.token, name: "Elsewhere" });
  const finding = (fingerprint: string, head: string, category = "security") => ({ title: `SQL built by concatenation ${fingerprint}`, description: "User input reaches the query string.", severity: "high", confidence: 0.9, category, agent: "security-checks", filePath: "db.ts", startLine: 4, endLine: 4, commitSha: head, evidence: [{ filePath: "db.ts", startLine: 4, quote: "query('select ' + id)" }], impact: "Injection.", suggestedFix: "Use parameters.", symbol: "sql-concatenation", fingerprint });
  const review = async (pr: number, head: string, findings: ReturnType<typeof finding>[], resolved: string[] = []) => {
    await t.mutation(internal.pulls.observe, { repositoryId: repo._id, number: pr, title: "Change", author: "dev", url: `https://github.com/acme/pay/pull/${pr}`, headSha: head, baseSha: sha("0"), state: "open", observedAt: Date.now() + pr });
    const reviewId = await t.run((ctx) => ctx.db.insert("reviews", { organizationId, repositoryId: repo._id, prNumber: pr, headSha: head, status: "summarizing", mode: "standard", attempts: 1, createdAt: Date.now(), updatedAt: Date.now() }));
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["{}"])));
    await t.mutation(internal.reviews.save, { reviewId, storageId, summary: "Recorded.", findings, resolved, usage: [] });
    await t.run((ctx) => ctx.db.patch(reviewId, { status: "completed" }));
    return reviewId;
  };
  const issues = () => t.run((ctx) => ctx.db.query("issues").collect());
  const events = async (issueId: Id<"issues">) => (await t.run((ctx) => ctx.db.query("issueEvents").withIndex("by_issue", (q) => q.eq("issueId", issueId)).collect())).map((e) => e.kind);
  const findingOn = (pr: number, fingerprint: string) => t.run((ctx) => ctx.db.query("findings").withIndex("by_fingerprint", (q) => q.eq("repositoryId", repo._id).eq("prNumber", pr).eq("fingerprint", fingerprint)).unique());
  return { t, alice, bob, vera, mallory, organizationId, repo, finding, review, issues, events, findingOn };
}

test("one issue per problem across pull requests: numbered, resolved by a fixing commit, reopened when it returns", async () => {
  const s = await setup();
  await s.review(1, sha("1"), [s.finding("fp1", sha("1")), s.finding("fp2", sha("1"), "correctness")]);
  await s.review(2, sha("2"), [s.finding("fp1", sha("2"))]);
  // Re-reviewing the same pull request does not add another occurrence or event.
  await s.review(2, sha("3"), [s.finding("fp1", sha("3"))]);
  const [first, second] = (await s.issues()).sort((a, b) => a.number - b.number);
  expect([first.number, first.fingerprint, first.status, second.number]).toEqual([1, "fp1", "open", 2]);
  expect(await s.events(first._id)).toEqual(["created", "seen"]);
  const detail = await s.t.query(api.issues.get, { token: s.alice.token, organizationId: s.organizationId, number: 1 });
  expect(detail.occurrences.map((o) => o.prNumber)).toEqual([2, 1]);
  expect([detail.finding.prNumber, detail.canWrite, detail.members.map((m) => m.login).sort()]).toEqual([2, true, ["alice", "bob"]]);
  // A fix on the latest occurrence's pull request resolves it; reporting it again reopens it.
  await s.review(2, sha("4"), [], ["fp1"]);
  expect((await s.t.run((ctx) => ctx.db.get(first._id)))?.status).toBe("resolved");
  await s.review(3, sha("5"), [s.finding("fp1", sha("5"))]);
  expect((await s.t.run((ctx) => ctx.db.get(first._id)))?.status).toBe("open");
  expect(await s.events(first._id)).toEqual(["created", "seen", "resolved_by_commit", "reopened"]);
  // The inbox lists active issues by default, newest first, and filters.
  const inbox = await s.t.query(api.issues.list, { token: s.alice.token, organizationId: s.organizationId });
  expect(inbox.page.map((i) => [i.number, i.prNumber, i.prState])).toEqual([[1, 3, "open"], [2, 1, "open"]]);
  expect((await s.t.query(api.issues.list, { token: s.alice.token, organizationId: s.organizationId, category: "security" })).page.map((i) => i.number)).toEqual([1]);
});

test("feedback and issue decisions stay in sync; won't-fix is not reopened by a new report", async () => {
  const s = await setup();
  await s.review(1, sha("1"), [s.finding("fp1", sha("1"))]);
  await s.review(2, sha("2"), [s.finding("fp1", sha("2"))]);
  const [issue] = await s.issues();
  // Feedback on one occurrence waits for the other; the second closes the issue.
  await s.t.mutation(api.dashboard.feedback, { token: s.alice.token, findingId: (await s.findingOn(1, "fp1"))!._id, value: "resolved", comment: "" });
  expect((await s.t.run((ctx) => ctx.db.get(issue._id)))?.status).toBe("open");
  await s.t.mutation(api.dashboard.feedback, { token: s.alice.token, findingId: (await s.findingOn(2, "fp1"))!._id, value: "resolved", comment: "" });
  expect((await s.t.run((ctx) => ctx.db.get(issue._id)))?.status).toBe("resolved");
  // Setting the issue to won't fix applies to every open occurrence too.
  await s.t.mutation(api.issues.setStatus, { token: s.bob.token, issueId: issue._id, status: "in_progress" });
  await s.review(3, sha("3"), [s.finding("fp1", sha("3"))]);
  await s.t.mutation(api.issues.setStatus, { token: s.bob.token, issueId: issue._id, status: "wont_fix", comment: "Internal tool only." });
  expect([(await s.findingOn(3, "fp1"))?.status, (await s.t.run((ctx) => ctx.db.get(issue._id)))?.status]).toEqual(["wont_fix", "wont_fix"]);
  await s.review(4, sha("4"), [s.finding("fp1", sha("4"))]);
  expect((await s.t.run((ctx) => ctx.db.get(issue._id)))?.status).toBe("wont_fix");
  await expect(s.t.mutation(api.issues.setStatus, { token: s.bob.token, issueId: issue._id, status: "done" })).rejects.toThrow("Invalid status");
  expect(await s.events(issue._id)).toContain("status");
});

test("assigning, commenting and access: writers only, members with access only, nothing across workspaces", async () => {
  const s = await setup();
  await s.review(1, sha("1"), [s.finding("fp1", sha("1"))]);
  const [issue] = await s.issues();
  await s.t.mutation(api.issues.assign, { token: s.alice.token, issueId: issue._id, assigneeId: s.bob.id });
  expect((await s.t.query(api.issues.list, { token: s.bob.token, organizationId: s.organizationId, assignee: "me" })).page.map((i) => [i.number, i.assignee])).toEqual([[1, "bob"]]);
  expect((await s.t.query(api.issues.list, { token: s.bob.token, organizationId: s.organizationId, assignee: "none" })).page).toEqual([]);
  await expect(s.t.mutation(api.issues.assign, { token: s.alice.token, issueId: issue._id, assigneeId: s.vera.id })).rejects.toThrow(/write access/);
  await expect(s.t.mutation(api.issues.assign, { token: s.alice.token, issueId: issue._id, assigneeId: s.mallory.id })).rejects.toThrow(/write access/);
  await s.t.mutation(api.issues.comment, { token: s.bob.token, issueId: issue._id, body: "  Looking at it.  " });
  const detail = await s.t.query(api.issues.get, { token: s.vera.token, organizationId: s.organizationId, number: 1 });
  expect([detail.canWrite, detail.events.at(-1)?.detail, detail.events.at(-1)?.actor]).toEqual([false, "Looking at it.", "bob"]);
  await expect(s.t.mutation(api.issues.comment, { token: s.vera.token, issueId: issue._id, body: "hi" })).rejects.toThrow(/Viewers/);
  await expect(s.t.mutation(api.issues.comment, { token: s.bob.token, issueId: issue._id, body: " " })).rejects.toThrow(/1 to 5,000/);
  await expect(s.t.query(api.issues.get, { token: s.mallory.token, organizationId: s.organizationId, number: 1 })).rejects.toThrow();
  await expect(s.t.query(api.issues.list, { token: s.mallory.token, organizationId: s.organizationId })).rejects.toThrow();
  await expect(s.t.mutation(api.issues.setStatus, { token: s.mallory.token, issueId: issue._id, status: "resolved" })).rejects.toThrow();
});

test("closed pull requests resolve their issues, merged ones keep them open and marked merged", async () => {
  const s = await setup();
  await s.review(1, sha("1"), [s.finding("fp1", sha("1"))]);
  await s.review(2, sha("2"), [s.finding("fp2", sha("2"))]);
  await s.t.mutation(internal.webhooks.lifecycle, { repositoryId: s.repo._id, action: "closed", prNumber: 1, state: "closed" });
  await s.t.mutation(internal.webhooks.lifecycle, { repositoryId: s.repo._id, action: "closed", prNumber: 2, state: "closed", merged: true });
  const byFingerprint = Object.fromEntries((await s.issues()).map((i) => [i.fingerprint, i]));
  expect([byFingerprint.fp1.status, byFingerprint.fp1.mergedAt]).toEqual(["resolved", undefined]);
  expect([byFingerprint.fp2.status, typeof byFingerprint.fp2.mergedAt]).toEqual(["open", "number"]);
  expect(await s.events(byFingerprint.fp1._id)).toEqual(["created", "pr_closed"]);
  expect(await s.events(byFingerprint.fp2._id)).toEqual(["created", "pr_merged"]);
});

test("fix pull requests are recorded once, the backfill is idempotent, and retention leaves no orphan issues", async () => {
  const s = await setup();
  const first = await s.review(1, sha("1"), [s.finding("fp1", sha("1"))]);
  const finding = (await s.findingOn(1, "fp1"))!;
  for (let i = 0; i < 2; i++) await s.t.mutation(internal.issues.recordFixPullRequest, { findingId: finding._id, url: "https://github.com/acme/pay/pull/9", automatic: true });
  const [issue] = await s.issues();
  expect([issue.fixPullRequestUrl, (await s.events(issue._id)).filter((k) => k === "fix_pr").length]).toEqual(["https://github.com/acme/pay/pull/9", 1]);
  // Findings from before issues existed: unlink them, then backfill twice.
  await s.t.run(async (ctx) => { for (const table of ["issues", "issueEvents"] as const) for (const row of await ctx.db.query(table).collect()) await ctx.db.delete(row._id); for (const f of await ctx.db.query("findings").collect()) await ctx.db.patch(f._id, { issueId: undefined }); });
  expect(await s.t.mutation(internal.issues.backfill, {})).toBe(1);
  expect(await s.t.mutation(internal.issues.backfill, {})).toBe(0);
  expect((await s.issues()).length).toBe(1);
  // Review retention removes the only occurrence: the issue and its events go too.
  await s.t.run(async (ctx) => {
    const { findingRemoved } = await import("../convex/issueLifecycle");
    for (const f of await ctx.db.query("findings").withIndex("by_review", (q) => q.eq("reviewId", first)).collect()) { await ctx.db.delete(f._id); await findingRemoved(ctx, f); }
  });
  expect([(await s.issues()).length, (await s.t.run((ctx) => ctx.db.query("issueEvents").collect())).length]).toEqual([0, 0]);
});
