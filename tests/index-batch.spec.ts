import { afterEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { Github } from "../src/github";

// One indexBatch invocation works through several 20-file batches (one manifest read) and still stops when the job is cancelled between batches.
const modules = import.meta.glob("../convex/**/*.ts");
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
async function setup(count: number, onBlob: (path: string) => Promise<void> = async () => {}) {
  vi.useFakeTimers(); vi.stubEnv("EMBEDDING_MODEL", "");
  process.env.SERVICE_SECRET = "batch-service"; process.env.SESSION_SECRET = "batch-session-secret-at-least-32-characters";
  const t = convexTest(schema, modules);
  const id = await t.mutation(api.users.login, { secret: "batch-service", githubId: 1, login: "b1", avatar: "" });
  const token = await new SignJWT({}).setSubject(id).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET));
  const organizationId = await t.mutation(api.users.createOrganization, { token, name: "Batch" });
  await t.mutation(api.repositories.connect, { token, secret: "batch-service", organizationId, installationId: 71, account: "acme", accountId: 1, repositories: [{ id: 701, fullName: "acme/big", defaultBranch: "main" }] });
  const repo = (await t.run((ctx) => ctx.db.query("repositories").first()))!;
  await t.run((ctx) => ctx.db.patch(repo._id, { enabled: true }));
  const files = Array.from({ length: count }, (_, i) => ({ path: `src/f${i}.ts`, sha: `sha-${i}`, content: `export const v${i}=${i};` }));
  const native = new Github("fixture"), blob = vi.spyOn(native, "blob").mockImplementation(async (_r, path) => { await onBlob(path); return files.find((f) => f.path === path)!; });
  vi.spyOn(Github, "installation").mockResolvedValue(native);
  const jobId = (await t.mutation(internal.repositories.indexing, { repositoryId: repo._id, sha: "head", total: count, knowledgePaths: [] }))!;
  await t.run(async (ctx) => ctx.db.patch(jobId, { manifestStorageId: await ctx.storage.store(new Blob([JSON.stringify({ sha: "head", gitignore: "", changedPaths: [], entries: files.map(({ path, sha }) => ({ path, sha })) })])) }));
  return { t, repo, jobId, blob };
}

test("one invocation indexes a 65-file manifest across batches; queued continuations are no-ops", async () => {
  const { t, repo, jobId, blob } = await setup(65);
  await t.action(internal.jobs.indexBatch, { jobId });
  expect(blob).toHaveBeenCalledTimes(65);
  expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({ status: "completed", processed: 65 });
  expect(await t.run((ctx) => ctx.db.get(repo._id))).toMatchObject({ indexedSha: "head", indexStatus: "ready" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(blob).toHaveBeenCalledTimes(65);
  expect(await t.run((ctx) => ctx.db.query("repositoryFiles").collect())).toHaveLength(65);
});

test("a job cancelled during a batch stops before the next batch", async () => {
  let cancel = async () => {};
  const { t, jobId, blob } = await setup(65, async (path) => { if (path === "src/f19.ts") await cancel(); });
  cancel = () => t.run(async (ctx) => { await ctx.db.patch(jobId, { status: "cancelled" }); });
  await t.action(internal.jobs.indexBatch, { jobId });
  expect(blob).toHaveBeenCalledTimes(20);
  expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({ status: "cancelled" });
});
