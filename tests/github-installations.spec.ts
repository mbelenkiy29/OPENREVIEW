import { expect, test } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";

// GitHub App lifecycle after the first install: reinstall, suspension, repositories added on GitHub
// and permission changes, all through the shared repository path.
const modules = import.meta.glob("../convex/**/*.ts");
async function workspace(prefix: string) {
  process.env.SERVICE_SECRET = prefix + "-service";
  process.env.SESSION_SECRET = prefix + "-session-secret-at-least-32-characters";
  const t = convexTest(schema, modules);
  const sign = async (githubId: number) => { const id = await t.mutation(api.users.login, { secret: prefix + "-service", githubId, login: prefix + githubId, avatar: "" }); return { id, token: await new SignJWT({}).setSubject(id).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET)) }; };
  const admin = await sign(1), rival = await sign(2);
  const organizationId = await t.mutation(api.users.createOrganization, { token: admin.token, name: prefix });
  const rivalOrg = await t.mutation(api.users.createOrganization, { token: rival.token, name: prefix + "-rival" });
  const connect = (installationId: number, repositories: { id: number; fullName: string; defaultBranch: string; group?: { externalId: string; name: string } }[], extra: Record<string, unknown> = {}) =>
    t.mutation(api.repositories.connect, { token: admin.token, secret: prefix + "-service", organizationId, installationId, account: "acme", accountId: 7, repositories, ...extra });
  const repo = async (githubId: number) => (await t.run((ctx) => ctx.db.query("repositories").withIndex("by_github", (q) => q.eq("githubId", githubId)).unique()))!;
  const installation = async (installationId: number) => (await t.run((ctx) => ctx.db.query("githubInstallations").withIndex("by_installation", (q) => q.eq("installationId", installationId)).unique()))!;
  const audits = async () => (await t.run((ctx) => ctx.db.query("auditEvents").collect())).map((a) => a.action);
  return { t, admin, rival, organizationId, rivalOrg, connect, repo, installation, audits };
}
const event = (installationId: number, action: string, repositories: { id: number; fullName: string; defaultBranch?: string }[] = [], permissions?: Record<string, string>) => ({ installationId, action, repositories, ...(permissions ? { permissions } : {}) });

test("uninstall then reinstall: repositories follow the new installation id and the ones that were on come back on", async () => {
  const { t, organizationId, connect, repo, installation, audits } = await workspace("reinstall");
  await connect(10, [{ id: 1, fullName: "acme/on", defaultBranch: "main" }, { id: 2, fullName: "acme/off", defaultBranch: "main" }]);
  const first = (await repo(1))._id;
  await t.run((ctx) => ctx.db.patch(first, { enabled: true, indexStatus: "ready", indexedSha: "abc" }));
  await t.mutation(internal.webhooks.installationEvent, event(10, "deleted"));
  expect([(await repo(1)).enabled, (await repo(1)).disabledBy]).toEqual([false, "uninstall"]);
  expect([(await repo(2)).enabled, (await repo(2)).disabledBy]).toEqual([false, undefined]);
  expect((await installation(10)).active).toBe(false);
  // Reinstall: GitHub issues a new installation id for the same repositories.
  await connect(11, [{ id: 1, fullName: "acme/on", defaultBranch: "trunk" }, { id: 2, fullName: "acme/off", defaultBranch: "main" }], { permissions: { contents: "write", pull_requests: "write" } });
  const on = await repo(1), off = await repo(2);
  expect([on.installationId, on.enabled, on.disabledBy, on.defaultBranch, on.indexStatus]).toEqual([11, true, undefined, "trunk", "queued"]);
  expect([off.installationId, off.enabled]).toEqual([11, false]);
  expect((await installation(11)).permissions).toEqual({ contents: "write", pull_requests: "write" });
  expect(await audits()).toEqual(expect.arrayContaining(["github.installation_deleted", "github.installation_linked", "repository.restored"]));
  expect(await t.run((ctx) => ctx.db.query("repositories").collect())).toHaveLength(2);
  expect((await t.run((ctx) => ctx.db.query("repositorySettings").collect())).filter((s) => s.organizationId === organizationId)).toHaveLength(2);
});

test("an inactive installation row is reactivated by a verified link", async () => {
  const { t, connect, installation, audits } = await workspace("reactivate");
  await connect(20, [{ id: 21, fullName: "acme/app", defaultBranch: "main" }]);
  const row = (await installation(20))._id;
  await t.run((ctx) => ctx.db.patch(row, { active: false }));
  await connect(20, [{ id: 21, fullName: "acme/app", defaultBranch: "main" }], { accountType: "Organization" });
  expect(await installation(20)).toMatchObject({ active: true, accountType: "Organization" });
  expect(await audits()).toContain("github.installation_reactivated");
});

test("suspend then unsuspend re-enables only repositories the suspension turned off", async () => {
  const { t, connect, repo } = await workspace("suspend");
  await connect(30, [{ id: 31, fullName: "acme/on", defaultBranch: "main" }, { id: 32, fullName: "acme/off", defaultBranch: "main" }]);
  const on = (await repo(31))._id;
  await t.run((ctx) => ctx.db.patch(on, { enabled: true, indexStatus: "ready", indexedSha: "abc" }));
  await t.mutation(internal.webhooks.installationEvent, event(30, "suspend"));
  expect([(await repo(31)).enabled, (await repo(31)).disabledBy, (await repo(32)).disabledBy]).toEqual([false, "suspend", undefined]);
  await t.mutation(internal.webhooks.installationEvent, event(30, "unsuspend"));
  expect([(await repo(31)).enabled, (await repo(31)).disabledBy, (await repo(31)).indexStatus]).toEqual([true, undefined, "queued"]);
  expect((await repo(32)).enabled).toBe(false);
});

test("repositories added on GitHub get settings, a team and their real branch; removed and re-added ones come back", async () => {
  const { t, organizationId, connect, repo } = await workspace("added");
  await connect(40, [{ id: 41, fullName: "acme/first", defaultBranch: "main", group: { externalId: "7", name: "acme" } }]);
  const team = (await repo(41)).teamId;
  await t.mutation(internal.webhooks.installationEvent, { installationId: 40, action: "added", repositories: [{ id: 42, fullName: "acme/legacy", defaultBranch: "master", group: { externalId: "7", name: "acme" } }] });
  const added = await repo(42);
  expect([added.defaultBranch, added.teamId, added.enabled]).toEqual(["master", team, false]);
  expect(await t.run((ctx) => ctx.db.query("repositorySettings").withIndex("by_repo", (q) => q.eq("repositoryId", added._id)).unique())).toMatchObject({ inherit: true, organizationId });
  // A payload without a branch never overwrites the stored one.
  await t.mutation(internal.webhooks.installationEvent, event(40, "added", [{ id: 42, fullName: "acme/legacy" }]));
  expect((await repo(42)).defaultBranch).toBe("master");
  // Access removed on GitHub, then given back: a repository that was on is restored.
  await t.run((ctx) => ctx.db.patch(added._id, { enabled: true, indexStatus: "ready", indexedSha: "abc" }));
  await t.mutation(internal.webhooks.installationEvent, event(40, "removed", [{ id: 42, fullName: "acme/legacy" }]));
  expect([(await repo(42)).enabled, (await repo(42)).disabledBy]).toEqual([false, "uninstall"]);
  await t.mutation(internal.webhooks.installationEvent, event(40, "added", [{ id: 42, fullName: "acme/legacy" }]));
  expect([(await repo(42)).enabled, (await repo(42)).disabledBy]).toEqual([true, undefined]);
});

test("a repository of another workspace is refused, and permission changes are recorded", async () => {
  const { t, rival, rivalOrg, connect, repo, installation } = await workspace("isolation");
  await connect(50, [{ id: 51, fullName: "acme/app", defaultBranch: "main" }]);
  await expect(t.mutation(api.repositories.connect, { token: rival.token, secret: "isolation-service", organizationId: rivalOrg, installationId: 52, account: "rival", accountId: 8, repositories: [{ id: 51, fullName: "acme/app", defaultBranch: "main" }] })).rejects.toThrow(/another workspace/);
  await t.mutation(internal.webhooks.installationEvent, event(52, "added", [{ id: 51, fullName: "acme/app" }]));
  expect((await repo(51)).installationId).toBe(50);
  await t.mutation(internal.webhooks.installationEvent, event(50, "new_permissions_accepted", [], { contents: "write", checks: "write" }));
  expect(await installation(50)).toMatchObject({ permissions: { contents: "write", checks: "write" } });
  expect((await installation(50)).permissionsCheckedAt).toBeGreaterThan(0);
});
