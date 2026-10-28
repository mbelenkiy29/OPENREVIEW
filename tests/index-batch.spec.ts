import { afterEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { Github } from "../src/github";

// One indexBatch invocation works through several 20-file batches (one manifest read) under a single claim, stops when the job is
// cancelled between batches, and queues exactly one continuation only when it runs out of time.
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
  const continuations = () => t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((f) => f.name.includes("indexBatch")));
  return { t, repo, jobId, blob, continuations };
}

test("one invocation indexes a 65-file manifest across batches without queuing continuations", async () => {
  const { t, repo, jobId, blob, continuations } = await setup(65);
  await t.action(internal.jobs.indexBatch, { jobId });
  // A continuation queued at each batch boundary would race this run's own claim on the job (write conflicts).
  expect(await continuations()).toHaveLength(0);
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

test("a run past its time budget hands off to one continuation that finishes the job", async () => {
  const { t, jobId, blob, continuations } = await setup(65, async (path) => { if (path === "src/f19.ts") vi.setSystemTime(Date.now() + 5 * 60000); });
  await t.action(internal.jobs.indexBatch, { jobId });
  expect(blob).toHaveBeenCalledTimes(20);
  const paused = await t.run((ctx) => ctx.db.get(jobId));
  expect(paused).toMatchObject({ status: "running", cursor: 20 });
  expect(paused?.batchLease).toBeUndefined();
  expect(await continuations()).toHaveLength(1);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(blob).toHaveBeenCalledTimes(65);
  expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({ status: "completed", processed: 65 });
});
