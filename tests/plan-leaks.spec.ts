import { afterEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import { z } from "zod";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { Github } from "../src/github";
import { HttpModel } from "../src/engine/model";
import { defaults } from "../src/review-settings";
import { upgradeNote } from "../src/plans";
import type { ModelRequest, ToolTurn } from "../src/engine/types";

// Paid value that used to leak to Free: the agentic engines (deep reviews are Pro) and the workspace's own model key,
// whose calls skip the usage meter (Starter and Pro).
const modules = import.meta.glob("../convex/**/*.ts");
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); delete process.env.BILLING_ENABLED; });
const usage = (task: string) => ({ task, provider: "fixture", model: "fixture", inputTokens: 1, outputTokens: 1, latencyMs: 0, estimatedCost: 0, cached: false });

async function setup() {
  process.env.SERVICE_SECRET = "leaks-service";
  process.env.SESSION_SECRET = "leaks-session-secret-at-least-32-characters";
  process.env.LLM_API_KEY = "fixture";
  const t = convexTest(schema, modules);
  const userId = await t.mutation(api.users.login, { secret: "leaks-service", githubId: -401, login: "leaks-fixture", avatar: "" });
  const token = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(userId).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET));
  const organizationId = await t.mutation(api.users.createOrganization, { token, name: "Leaks" });
  await t.mutation(api.repositories.connect, { token, secret: "leaks-service", organizationId, installationId: -401, accountId: -401, account: "test", repositories: [{ id: -401, fullName: "test/leaks", defaultBranch: "main" }] });
  const [repo] = await t.query(api.repositories.list, { token, organizationId });
  await t.mutation(api.repositories.configure, { token, repositoryId: repo._id, enabled: true, settings: { ...defaults, reviewEngine: "agentic" } });
  await t.run((ctx) => ctx.db.patch(repo._id, { indexStatus: "ready", indexedSha: "a".repeat(40) }));
  // A Free review may already have created the workspace's billing account; subscribing updates it.
  const subscribe = (plan: "starter" | "pro") => t.run(async (ctx) => {
    const row = { organizationId, customerId: "cus_l", subscriptionId: "sub_l", plan, status: "active", seats: 1, trialEndsAt: Date.now(), updatedAt: Date.now() };
    const account = await ctx.db.query("billingAccounts").withIndex("by_org", (q) => q.eq("organizationId", organizationId)).unique();
    if (account) await ctx.db.patch(account._id, row); else await ctx.db.insert("billingAccounts", row);
  });
  return { t, token, userId, organizationId, repo, subscribe };
}

async function review(s: Awaited<ReturnType<typeof setup>>, number: number) {
  vi.useFakeTimers();
  const scm = new Github("test-only-token");
  vi.spyOn(Github, "installation").mockResolvedValue(scm);
  vi.spyOn(scm, "tree").mockResolvedValue([{ path: "total.ts", sha: "t", type: "blob", size: 40 }]);
  vi.spyOn(scm, "blob").mockImplementation(async (_r, path, sha) => ({ path, sha, content: "export const total = (c: number) => c / 100;" }));
  vi.spyOn(scm, "pullRequest").mockResolvedValue({ number, title: "Totals", body: "", draft: false, state: "open", html_url: `https://github.com/test/leaks/pull/${number}`, user: { login: "author" }, head: { sha: String(number).repeat(40).slice(0, 40), ref: "feature" }, base: { sha: "a".repeat(40), ref: "main" }, diff: [{ path: "total.ts", status: "modified", patch: "@@ -1 +1 @@\n-export const total = (c: number) => c;\n+export const total = (c: number) => c / 100;" }], comments: [], reviews: [], commits: [], checks: [] } as never);
  const publish = vi.spyOn(scm, "publish").mockResolvedValue({ id: 5, reused: false, comments: [] });
  vi.spyOn(HttpModel.prototype, "generate").mockImplementation(async function <T>(request: ModelRequest, validator: z.ZodType<T>) {
    const value = request.task.startsWith("review:") || request.task === "verify" ? { findings: [], decisions: [] } : request.task === "diagram" ? { diagram: null } : { summary: "Totals divide by 100.", reviewScore: { value: 4, reason: "No verified findings." } };
    return { value: validator.parse(value), usage: usage(request.task) };
  });
  const runTools = vi.spyOn(HttpModel.prototype, "runTools").mockImplementation(async (): Promise<ToolTurn> => ({ content: "No findings.", toolCalls: [], stopReason: "end_turn", usage: usage("agent"), message: { role: "assistant", content: "No findings.", toolCalls: [] } }));
  const reviewId = (await s.t.mutation(internal.reviews.enqueue, { repositoryId: s.repo._id, prNumber: number, headSha: String(number).repeat(40).slice(0, 40) }))!;
  await s.t.action(internal.jobs.review, { reviewId });
  return { runTools, published: JSON.stringify(publish.mock.calls) };
}

test("review.deep: on Free a repository set to the agentic engine runs the standard pipeline with a note; Pro runs agentic", async () => {
  const s = await setup();
  process.env.BILLING_ENABLED = "true";
  const free = await review(s, 1);
  expect(free.runTools).not.toHaveBeenCalled();
  expect(free.published).toContain(upgradeNote["review.deep"]);
  // Wanting a deep review on Free is a paywall hit for the operator funnel, once per workspace.
  expect((await s.t.run((ctx) => ctx.db.query("conversionEvents").collect())).map((e) => e.key).filter((k) => k.startsWith("paywall:"))).toEqual([`paywall:review.deep:${s.organizationId}`]);
  vi.restoreAllMocks();
  await s.subscribe("pro");
  const pro = await review(s, 2);
  expect(pro.runTools).toHaveBeenCalled();
  expect(pro.published).not.toContain(upgradeNote["review.deep"]);
});

test("model.ownKey: Free can't save a key and a saved one is not used; Starter and billing off use it", async () => {
  const s = await setup();
  await s.t.run((ctx) => ctx.db.insert("modelKeys", { organizationId: s.organizationId, provider: "anthropic", credentials: "sealed", updatedBy: s.userId, updatedAt: Date.now() }));
  const used = async () => Boolean(await s.t.query(internal.modelKeys.forWorkspace, { organizationId: s.organizationId }));
  expect(await used()).toBe(true);
  process.env.BILLING_ENABLED = "true";
  expect(await used()).toBe(false);
  // Refused before the key is ever sent to the provider.
  const fetch = vi.spyOn(globalThis, "fetch");
  await expect(s.t.action(api.modelKeyJobs.save, { token: s.token, organizationId: s.organizationId, provider: "anthropic", key: "sk-ant-test" })).rejects.toThrow(/own model key is on the Starter and Pro plans/);
  expect(fetch).not.toHaveBeenCalled();
  expect((await s.t.query(api.scopes.modelChoice, { token: s.token, organizationId: s.organizationId })).ownKey).toBe(false);
  await s.subscribe("starter");
  expect(await used()).toBe(true);
});
