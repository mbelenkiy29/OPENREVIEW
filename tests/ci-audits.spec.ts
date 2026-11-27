import { afterEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { Github } from "../src/github";

// Organization Settings → CI Cost: admins request a CI audit of a GitHub App repository, members see the latest one.
const modules = import.meta.glob("../convex/**/*.ts");
async function workspace(prefix: string) {
  process.env.SERVICE_SECRET = prefix + "-service";
  process.env.SESSION_SECRET = prefix + "-session-secret-at-least-32-characters";
  const t = convexTest(schema, modules);
  const sign = async (githubId: number) => { const id = await t.mutation(api.users.login, { secret: prefix + "-service", githubId, login: prefix + githubId, avatar: "" }); return { id, token: await new SignJWT({}).setSubject(id).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET)) }; };
  const admin = await sign(1), outsider = await sign(2);
  const organizationId = await t.mutation(api.users.createOrganization, { token: admin.token, name: prefix });
  await t.mutation(api.repositories.connect, { token: admin.token, secret: prefix + "-service", organizationId, installationId: 10, account: "acme", accountId: 7, repositories: [{ id: 1, fullName: "acme/app", defaultBranch: "main" }] });
  const repositoryId = (await t.run((ctx) => ctx.db.query("repositories").withIndex("by_github", (q) => q.eq("githubId", 1)).unique()))!._id;
  return { t, admin, outsider, organizationId, repositoryId };
}
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

test("requests are refused while the CI cost report is switched off", async () => {
  const { t, admin, repositoryId } = await workspace("ci-off");
  await expect(t.mutation(api.ciAudits.request, { token: admin.token, repositoryId })).rejects.toThrow(/not switched on/);
});

test("an admin's request is queued, audited, rate-limited per repository and listed for the workspace", async () => {
  vi.stubEnv("CI_COST_ENABLED", "true");
  const { t, admin, outsider, organizationId, repositoryId } = await workspace("ci-on");
  await expect(t.mutation(api.ciAudits.request, { token: outsider.token, repositoryId })).rejects.toThrow();
  const auditId = await t.mutation(api.ciAudits.request, { token: admin.token, repositoryId });
  await expect(t.mutation(api.ciAudits.request, { token: admin.token, repositoryId })).rejects.toThrow(/last ten minutes/);
  expect((await t.run((ctx) => ctx.db.query("auditEvents").collect())).map((e) => e.action)).toContain("ci.audit.requested");
  const [row] = await t.query(api.ciAudits.list, { token: admin.token, organizationId });
  expect(row).toMatchObject({ fullName: "acme/app", latest: { _id: auditId, status: "queued" } });
  await expect(t.query(api.ciAudits.list, { token: outsider.token, organizationId })).rejects.toThrow();
});

test("the job fails with the reason when the installation lacks Actions: Read, and old audits are pruned", async () => {
  vi.stubEnv("CI_COST_ENABLED", "true");
  const { t, admin, organizationId, repositoryId } = await workspace("ci-job");
  vi.spyOn(Github, "installation").mockResolvedValue(new Github("token", undefined, undefined, { contents: "read", pull_requests: "write", issues: "read", checks: "read" }));
  const auditId = await t.mutation(api.ciAudits.request, { token: admin.token, repositoryId });
  await t.action(internal.ciAuditJobs.run, { auditId });
  expect(await t.run((ctx) => ctx.db.get(auditId))).toMatchObject({ status: "failed", error: expect.stringMatching(/Actions: Read/) });
  // Seven finished audits leave the latest five.
  for (let i = 0; i < 7; i++) {
    const id = await t.run((ctx) => ctx.db.insert("ciAudits", { organizationId, repositoryId, status: "queued", createdAt: Date.now() + i, updatedAt: Date.now() }));
    await t.mutation(internal.ciAudits.progress, { auditId: id, status: "done", report: "{}" });
  }
  expect(await t.run((ctx) => ctx.db.query("ciAudits").withIndex("by_repo", (q) => q.eq("repositoryId", repositoryId)).collect())).toHaveLength(5);
});

test("with Actions: Read the job stores the audit report", async () => {
  vi.stubEnv("CI_COST_ENABLED", "true");
  const { t, admin, organizationId, repositoryId } = await workspace("ci-done");
  const github = new Github("token", undefined, undefined, { contents: "read", pull_requests: "write", issues: "read", checks: "read", actions: "read" });
  vi.spyOn(Github, "installation").mockResolvedValue(github);
  vi.spyOn(github, "actionsHistory").mockResolvedValue({ repository: "acme/app", private: true, defaultBranch: "main", days: 30, from: "2026-10-28T00:00:00.000Z", to: "2026-11-27T00:00:00.000Z", runs: [], jobs: {}, workflows: [] });
  const auditId = await t.mutation(api.ciAudits.request, { token: admin.token, repositoryId });
  await t.action(internal.ciAuditJobs.run, { auditId });
  const [row] = await t.query(api.ciAudits.list, { token: admin.token, organizationId });
  expect(row.latest?.status).toBe("done");
  expect(JSON.parse(row.latest!.report!)).toMatchObject({ repository: "acme/app", runs: 0 });
});
