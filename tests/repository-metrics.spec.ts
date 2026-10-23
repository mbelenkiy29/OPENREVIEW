import { expect, test } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// Repositories table, Avg. Time to Merge: the mean first-seen → merge time per repository in the window.
const modules = import.meta.glob("../convex/**/*.ts");
test("merge times average merges in the window, per visible repository, for members only", async () => {
  process.env.SERVICE_SECRET = "metrics-service";
  process.env.SESSION_SECRET = "metrics-session-secret-at-least-32-characters";
  const t = convexTest(schema, modules);
  const sign = async (githubId: number) => { const id = await t.mutation(api.users.login, { secret: "metrics-service", githubId, login: "m" + githubId, avatar: "" }); return new SignJWT({}).setSubject(id).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET)); };
  const token = await sign(1), outsider = await sign(2);
  const organizationId = await t.mutation(api.users.createOrganization, { token, name: "metrics" });
  await t.mutation(api.repositories.connect, { token, secret: "metrics-service", organizationId, installationId: 5, account: "acme", accountId: 5, repositories: [{ id: 1, fullName: "acme/a", defaultBranch: "main" }, { id: 2, fullName: "acme/b", defaultBranch: "main" }] });
  const [a, b] = await t.run((ctx) => ctx.db.query("repositories").collect());
  const now = Date.now(), hour = 3600000;
  await t.run(async (ctx) => {
    const pr = (repositoryId: typeof a._id, number: number, openedAt: number, mergedAt?: number) => ctx.db.insert("pullRequests", { organizationId, repositoryId, number, title: "t", author: "x", url: "u", headSha: "h", baseSha: "b", state: mergedAt ? "merged" : "open", updatedAt: now, openedAt, mergedAt });
    await pr(a._id, 1, now - 5 * hour, now - 3 * hour);
    await pr(a._id, 2, now - 6 * hour, now - 2 * hour);
    await pr(a._id, 3, now - 40 * 24 * hour, now - 20 * 24 * hour); // merged before the window
    await pr(b._id, 4, now - hour); // still open
  });
  const since = now - 7 * 24 * hour;
  expect(await t.query(api.repositoryMetrics.mergeTimes, { token, organizationId, since })).toEqual({ [a._id]: 3 * hour });
  await expect(t.query(api.repositoryMetrics.mergeTimes, { token, organizationId, since: now - 60 * 24 * hour })).rejects.toThrow(/30 days/);
  await expect(t.query(api.repositoryMetrics.mergeTimes, { token: outsider, organizationId, since })).rejects.toThrow();
});
