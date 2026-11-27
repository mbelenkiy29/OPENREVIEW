import { afterEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { Github } from "../src/github";

// Spend guard v1: admins set a budget and critical workflows; the daily check records spend and alerts once.
const modules = import.meta.glob("../convex/**/*.ts");
async function workspace(prefix: string) {
  process.env.SERVICE_SECRET = prefix + "-service";
  process.env.SESSION_SECRET = prefix + "-session-secret-at-least-32-characters";
  const t = convexTest(schema, modules);
  const sign = async (githubId: number) => { const id = await t.mutation(api.users.login, { secret: prefix + "-service", githubId, login: prefix + githubId, avatar: "" }); return { id, token: await new SignJWT({}).setSubject(id).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET)) }; };
  const admin = await sign(1), outsider = await sign(2);
  const organizationId = await t.mutation(api.users.createOrganization, { token: admin.token, name: prefix });
  await t.mutation(api.users.createOrganization, { token: outsider.token, name: prefix + "-other" });
  await t.mutation(api.repositories.connect, { token: admin.token, secret: prefix + "-service", organizationId, installationId: 10, account: "acme", accountId: 7, repositories: [{ id: 1, fullName: "acme/app", defaultBranch: "main" }] });
  const repositoryId = (await t.run((ctx) => ctx.db.query("repositories").withIndex("by_github", (q) => q.eq("githubId", 1)).unique()))!._id;
  await t.run((ctx) => ctx.db.patch(repositoryId, { enabled: true }));
  return { t, admin, outsider, organizationId, repositoryId };
}
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

test("saving a spend guard is admin-only, behind the flag, and validated", async () => {
  const { t, admin, outsider, organizationId, repositoryId } = await workspace("guard-save");
  const save = (token: string, extra: Record<string, unknown> = {}) => t.mutation(api.ciSpendGuards.save, { token, organizationId, monthlyBudget: 100, critical: [{ repositoryId, path: ".github/workflows/backup.yml" }], dailySummary: false, ...extra });
  await expect(save(admin.token)).rejects.toThrow(/not switched on/);
  vi.stubEnv("CI_COST_ENABLED", "true");
  await expect(save(outsider.token)).rejects.toThrow();
  await expect(save(admin.token, { monthlyBudget: -5 })).rejects.toThrow(/monthly budget/);
  await expect(save(admin.token, { critical: [{ repositoryId, path: "../../etc/passwd" }] })).rejects.toThrow(/not found/);
  await save(admin.token);
  await save(admin.token, { monthlyBudget: 200 });
  const rows = await t.run((ctx) => ctx.db.query("ciSpendGuards").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ monthlyBudget: 200, dailySummary: false });
  const form = await t.query(api.ciSpendGuards.guard, { token: admin.token, organizationId });
  expect(form.guard?.monthlyBudget).toBe(200);
  // A saved critical workflow stays on the form even with no audit listing it.
  expect(form.workflows).toEqual([expect.objectContaining({ repositoryId, path: ".github/workflows/backup.yml" })]);
});

test("the daily check records month-to-date spend, flags a stopped critical workflow, and alerts once", async () => {
  vi.stubEnv("CI_COST_ENABLED", "true");
  const { t, admin, organizationId, repositoryId } = await workspace("guard-check");
  await t.mutation(api.ciSpendGuards.save, { token: admin.token, organizationId, monthlyBudget: 1, critical: [{ repositoryId, path: ".github/workflows/backup.yml" }], dailySummary: false });
  await t.run((ctx) => ctx.db.insert("notificationPreferences", { organizationId, userId: admin.id, email: "admin@example.com", emailVerifiedAt: Date.now(), reviewCompleted: "off", highSeverity: "off", updatedAt: Date.now() }));
  const github = new Github("token", undefined, undefined, { contents: "read", pull_requests: "write", issues: "read", checks: "read", actions: "read" });
  vi.spyOn(Github, "installation").mockResolvedValue(github);
  const now = Date.parse("2026-11-27T13:00:00Z"), at = (iso: string) => iso;
  const history = vi.spyOn(github, "actionsHistory").mockResolvedValue({
    repository: "acme/app", private: true, defaultBranch: "main", days: 27, from: "2026-11-01T00:00:00.000Z", to: "2026-11-27T13:00:00.000Z",
    runs: [{ id: 1, workflowId: 5, name: "Backup", path: ".github/workflows/backup.yml", event: "schedule", branch: "main", headSha: "a", status: "completed", conclusion: "success", createdAt: at("2026-11-20T03:00:00Z"), startedAt: at("2026-11-20T03:00:00Z"), updatedAt: at("2026-11-20T03:40:00Z") }],
    jobs: { 1: [{ runId: 1, name: "backup", conclusion: "success", startedAt: "2026-11-20T03:00:00Z", completedAt: "2026-11-20T03:40:00Z", labels: ["macos-15"] }] },
    workflows: [{ id: 5, name: "Backup", path: ".github/workflows/backup.yml", content: "on:\n  schedule:\n    - cron: '0 3 * * *'\n" }],
  });
  const guardId = (await t.run((ctx) => ctx.db.query("ciSpendGuards").first()))!._id;
  const first = await t.action(internal.ciSpendGuardJobs.check, { guardId, now });
  expect(history.mock.calls[0][1]).toMatchObject({ since: Date.parse("2026-11-01T00:00:00Z") });
  const row = await t.run((ctx) => ctx.db.get(guardId));
  expect(row?.lastCheck).toMatchObject({ period: "2026-11", total: 2.48, problems: [{ name: "Backup", problem: "last ran 7 days ago" }] });
  // $2.48 of a $1 budget: the 100% step and the critical warning, each to the verified admin once.
  expect(Object.keys(first).sort()).toEqual([`ci.budget.100:${organizationId}:2026-11:email:${admin.id}`, `ci.critical:${organizationId}:2026-11-27:email:${admin.id}`].sort());
  const second = await t.action(internal.ciSpendGuardJobs.check, { guardId, now });
  expect(Object.values(second).every((outcome) => outcome === "duplicate")).toBe(true);

  // A watched repository is checked even with reviews switched off. A history cut short is a lower bound and says so.
  await t.run((ctx) => ctx.db.patch(repositoryId, { enabled: false }));
  history.mockResolvedValueOnce({ ...(await history.mock.results[0].value), from: "2026-11-20T00:00:00.000Z", truncated: ["Stopped listing runs before 2026-11-20 to stay within the GitHub rate limit or time limit."] });
  await t.action(internal.ciSpendGuardJobs.check, { guardId, now });
  const partial = await t.run((ctx) => ctx.db.get(guardId));
  expect(partial?.lastCheck?.repositories[0]).toMatchObject({ partial: true });
  expect(partial?.lastCheck?.notes?.join("\n")).toMatch(/only part of the month could be read/);
  // A retry goes only to people who are still admins.
  const member = await t.run((ctx) => ctx.db.query("organizationMembers").withIndex("by_org", (q) => q.eq("organizationId", organizationId)).filter((q) => q.eq(q.field("userId"), admin.id)).first());
  await t.run((ctx) => ctx.db.patch(member!._id, { role: "member" }));
  expect(await t.action(internal.ciSpendGuardJobs.redeliver, { guardId, organizationId, attempt: 2, sends: [{ key: "ci.retry:test", channel: "email", to: "admin@example.com", userId: admin.id, subject: "s", text: "t" }] })).toEqual({});
  // The flag switched off stops queued checks.
  vi.stubEnv("CI_COST_ENABLED", "");
  expect(await t.action(internal.ciSpendGuardJobs.check, { guardId, now })).toEqual({});
  expect(history).toHaveBeenCalledTimes(3);
});
