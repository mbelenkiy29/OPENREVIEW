import { afterEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { indexWaitDelay, indexWaitMinutes } from "../convex/reviews";
import { reviewSemanticHits } from "../convex/semanticSearch";

// The first review of a new repository waits for its first index: one polling chain, indexing started
// only when idle, and a clear failure after the time limit instead of waiting forever.
const modules = import.meta.glob("../convex/**/*.ts");
afterEach(() => { vi.useRealTimers(); });
async function setup() {
  vi.useFakeTimers();
  process.env.SERVICE_SECRET = "wait-service"; process.env.SESSION_SECRET = "wait-session-secret-at-least-32-characters";
  const t = convexTest(schema, modules);
  const id = await t.mutation(api.users.login, { secret: "wait-service", githubId: 1, login: "w1", avatar: "" });
  const token = await new SignJWT({}).setSubject(id).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET));
  const organizationId = await t.mutation(api.users.createOrganization, { token, name: "Wait" });
  await t.mutation(api.repositories.connect, { token, secret: "wait-service", organizationId, installationId: 61, account: "acme", accountId: 1, repositories: [{ id: 601, fullName: "acme/new", defaultBranch: "main" }] });
  const repo = (await t.run((ctx) => ctx.db.query("repositories").first()))!;
  await t.run((ctx) => ctx.db.patch(repo._id, { enabled: true }));
  const reviewId = await t.run((ctx) => ctx.db.insert("reviews", { organizationId, repositoryId: repo._id, prNumber: 1, headSha: "a".repeat(40), status: "queued", mode: "standard", attempts: 0, createdAt: Date.now(), updatedAt: Date.now() }));
  const pendingReviewChecks = async () => (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((f) => f.name.includes("review") && f.state.kind === "pending").length;
  return { t, repo, reviewId, pendingReviewChecks };
}

test("a review of an unindexed repository starts indexing once and keeps a single check scheduled", async () => {
  const { t, repo, reviewId, pendingReviewChecks } = await setup();
  expect(await t.mutation(internal.reviews.awaitIndex, { reviewId })).toBe("waiting");
  const queued = (await t.run((ctx) => ctx.db.get(repo._id)))!;
  expect([queued.indexStatus, Boolean(queued.indexScheduledId)]).toEqual(["queued", true]);
  const review = (await t.run((ctx) => ctx.db.get(reviewId)))!;
  expect([review.indexWaitSince, review.retryAt! - review.indexWaitSince!]).toEqual([expect.any(Number), 3000]);
  expect(await pendingReviewChecks()).toBe(1);
  // A second runner (for example the recovery sweep) neither schedules another check nor another index.
  expect(await t.mutation(internal.reviews.awaitIndex, { reviewId })).toBe("waiting");
  expect(await pendingReviewChecks()).toBe(1);
  expect((await t.run((ctx) => ctx.db.get(repo._id)))!.indexScheduledId).toEqual(queued.indexScheduledId);
  // The recovery sweep skips a review whose check is pending, even when it looks stale.
  await t.run((ctx) => ctx.db.patch(reviewId, { updatedAt: Date.now() - 20 * 60000 }));
  await t.mutation(internal.recovery.sweep, {});
  expect(await pendingReviewChecks()).toBe(1);
  expect((await t.run((ctx) => ctx.db.get(reviewId)))!.status).toBe("queued");
});

test("the wait backs off, ends with a clear message after the limit, and stops when indexing failed", async () => {
  expect([indexWaitDelay(0), indexWaitDelay(2 * 60000), indexWaitDelay(20 * 60000)]).toEqual([3000, 10000, 30000]);
  const { t, repo, reviewId } = await setup();
  await t.mutation(internal.reviews.awaitIndex, { reviewId });
  // The check that runs later is the scheduled one; once the limit passes it reports expiry and clears itself.
  await t.run(async (ctx) => { const r = (await ctx.db.get(reviewId))!; if (r.retryScheduledId) await ctx.scheduler.cancel(r.retryScheduledId); });
  vi.setSystemTime(Date.now() + indexWaitMinutes * 60000 + 1000);
  expect(await t.mutation(internal.reviews.awaitIndex, { reviewId })).toBe("expired");
  const cleared = (await t.run((ctx) => ctx.db.get(reviewId)))!;
  expect([cleared.retryScheduledId, cleared.indexWaitSince]).toEqual([undefined, undefined]);
  await t.mutation(internal.reviews.finished, { reviewId, error: "expired" });
  expect((await t.run((ctx) => ctx.db.get(reviewId)))!.status).toBe("failed");
  // Indexing failure ends the wait right away.
  const second = await t.run((ctx) => ctx.db.insert("reviews", { organizationId: repo.organizationId, repositoryId: repo._id, prNumber: 2, headSha: "b".repeat(40), status: "queued", mode: "standard", attempts: 0, createdAt: Date.now(), updatedAt: Date.now() }));
  await t.run((ctx) => ctx.db.patch(repo._id, { indexStatus: "failed" }));
  expect(await t.mutation(internal.reviews.awaitIndex, { reviewId: second })).toBe("failed");
  // Once indexed there is nothing to wait for.
  await t.run((ctx) => ctx.db.patch(repo._id, { indexStatus: "ready", indexedSha: "c".repeat(40) }));
  expect(await t.mutation(internal.reviews.awaitIndex, { reviewId: second })).toBe("done");
});

test("a failing embedding endpoint degrades review context instead of failing the review", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const failed = await reviewSemanticHits({} as never, "repo" as never, "diff", 24, async () => { throw new Error(`Embedding provider HTTP 401 for key sk-proj-${"x".repeat(40)}`); });
  expect(failed.hits).toEqual([]);
  expect(failed.note).toMatch(/Semantic code search was unavailable/);
  expect(errors.mock.calls.flat().join(" ")).not.toContain("x".repeat(40));
  const ok = await reviewSemanticHits({} as never, "repo" as never, "diff", 24, async () => [{ path: "a.ts", startLine: 1, endLine: 2, score: 1 }]);
  expect(ok).toEqual({ hits: [{ path: "a.ts", startLine: 1, endLine: 2, score: 1 }] });
});
