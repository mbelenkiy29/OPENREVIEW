import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id, TableNames } from "../convex/_generated/dataModel";
import { purgePlan, sharedTables } from "../convex/dataControls";

const modules = import.meta.glob("../convex/**/*.ts");
beforeEach(() => { process.env.SERVICE_SECRET = "data-service"; process.env.SESSION_SECRET = "data-session-secret-at-least-32-characters"; vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); vi.setSystemTime(Date.UTC(2026, 9, 14, 12)); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); delete process.env.WORKSPACE_DELETION_GRACE_DAYS; });
type Tables = Record<string, { indexes: { indexDescriptor: string; fields: string[] }[] }>;
const tables = (schema as unknown as { tables: Tables }).tables;

test("every table is either purged with a workspace or explicitly shared, through an index that exists", () => {
  const planned = new Set(purgePlan.map((s) => s.table)), shared = new Set(Object.keys(sharedTables));
  const unaccounted = Object.keys(tables).filter((t) => !planned.has(t as TableNames) && !shared.has(t));
  expect(unaccounted).toEqual([]);
  expect([...planned].filter((t) => shared.has(t))).toEqual([]);
  expect(purgePlan.at(-1)).toEqual({ table: "organizations", via: "self" });
  expect(purgePlan.at(-2)?.table).toBe("auditEvents");
  const indexFirst = (table: string, index: string) => tables[table].indexes.find((i) => i.indexDescriptor === index)?.fields[0];
  for (const step of purgePlan) {
    if (step.via === "org") expect(indexFirst(step.table, step.index), step.table).toBe("organizationId");
    if (step.via === "repo") expect(indexFirst(step.table, step.index), step.table).toBe("repositoryId");
    if (step.via === "child") { expect(indexFirst(step.table, step.index), step.table).toBe(step.field); expect(indexFirst(step.parent.table, step.parent.index), step.parent.table).toBe("organizationId"); }
  }
  // Children are purged before their parents are.
  const position = (t: string) => purgePlan.findIndex((s) => s.table === t);
  for (const step of purgePlan) if (step.via === "child") expect(position(step.table)).toBeLessThan(position(step.parent.table));
  expect(position("indexJobs")).toBeLessThan(position("repositories"));
});

async function workspace(t: ReturnType<typeof convexTest>, githubId: number, name: string) {
  const userId = await t.mutation(api.users.login, { secret: "data-service", githubId, login: "u" + githubId, avatar: "" });
  const token = await new SignJWT({}).setSubject(userId).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setIssuedAt().setExpirationTime("30d").sign(new TextEncoder().encode(process.env.SESSION_SECRET));
  const organizationId = await t.mutation(api.users.createOrganization, { token, name });
  await t.mutation(api.repositories.connect, { token, secret: "data-service", organizationId, installationId: githubId, account: name.toLowerCase(), accountId: githubId, repositories: [{ id: githubId * 10, fullName: `${name.toLowerCase()}/app`, defaultBranch: "main" }] });
  const [repo] = await t.query(api.repositories.list, { token, organizationId });
  // Representative rows for every access path: org index, per repository, repository children,
  // children of workspace rows, scanned tables, stored files and a large table that needs several chunks.
  const seeded = await t.run(async (ctx) => {
    const file = (text: string) => ctx.storage.store(new Blob([text]));
    const storage = [await file("source"), await file("review result"), await file("agent state")];
    const now = Date.now();
    await ctx.db.insert("repositoryFiles", { organizationId, repositoryId: repo._id, path: "a.ts", sha: "s", storageId: storage[0], language: "typescript", updatedAt: now });
    for (let i = 0; i < 230; i++) await ctx.db.insert("codeChunks", { organizationId, repositoryId: repo._id, filePath: `f${i}.ts`, startLine: 1, content: "x" });
    const jobId = await ctx.db.insert("indexJobs", { organizationId, repositoryId: repo._id, sha: "a".repeat(40), status: "done", attempts: 1, processed: 1, total: 1, changed: 1, createdAt: now, updatedAt: now });
    await ctx.db.insert("indexSkippedFiles", { jobId, path: "big.bin" });
    const reviewId = await ctx.db.insert("reviews", { organizationId, repositoryId: repo._id, prNumber: 1, headSha: "b".repeat(40), status: "completed", mode: "standard", attempts: 1, resultStorageId: storage[1], agentStateStorageId: storage[2], createdAt: now, updatedAt: now });
    const snapshot = { title: "t", description: "d", severity: "high", confidence: 0.9, category: "correctness", filePath: "a.ts", startLine: 1, endLine: 1, evidence: [], impact: "i", suggestedFix: "s", agent: "correctness", symbol: "x", fingerprint: "fp", commitSha: "b".repeat(40) };
    const findingId = await ctx.db.insert("findings", { organizationId, repositoryId: repo._id, reviewId, prNumber: 1, ...snapshot, status: "open", createdAt: now, updatedAt: now });
    await ctx.db.insert("reviewFindings", { reviewId, findingId, snapshot });
    const threadId = await ctx.db.insert("chatThreads", { organizationId, userId, repositoryIds: [repo._id], title: "q", createdAt: now, updatedAt: now });
    await ctx.db.insert("chatMessages", { organizationId, threadId, userId, role: "user", content: "hello", repositoryIds: [repo._id], status: "done", createdAt: now, updatedAt: now });
    const teamId = await ctx.db.insert("teams", { organizationId, name: "T", createdAt: now });
    await ctx.db.insert("teamMembers", { organizationId, teamId, userId, role: "member" });
    const grantId = await ctx.db.insert("oauthGrants", { organizationId, userId, clientId: "c", clientName: "c", scopes: ["read"], resource: "r", revoked: false, createdAt: now });
    await ctx.db.insert("oauthTokens", { hash: "h" + githubId, grantId, kind: "access", expiresAt: now + 1000 });
    await ctx.db.insert("oauthCodes", { hash: "c" + githubId, clientId: "c", clientName: "c", redirectUri: "r", codeChallenge: "x", resource: "r", scopes: ["read"], organizationId, userId, expiresAt: now, used: false });
    await ctx.db.insert("notificationDeliveries", { organizationId, key: "k" + githubId, channel: "email", status: "sent", createdAt: now, updatedAt: now });
    await ctx.db.insert("apiKeys", { organizationId, userId, hash: "k" + githubId, name: "k", prefix: "or_", createdAt: now, revoked: false });
    await ctx.db.insert("customRules", { organizationId, title: "r", instructions: "i", category: "rules", severity: "low", globs: [], enabled: true, createdAt: now });
    await ctx.db.insert("usageEvents", { organizationId, repositoryId: repo._id, kind: "review", inputTokens: 1, outputTokens: 1, estimatedCost: 0, durationMs: 1, createdAt: now });
    return { storage, reviewId, threadId };
  });
  return { userId, token, organizationId, repo, ...seeded };
}
// Rows that belong to a workspace, found the slow way (full scans), to check the purge independently.
// Deletion receipts are kept on purpose.
async function owned(t: ReturnType<typeof convexTest>, organizationId: Id<"organizations">, repositoryId: Id<"repositories">) {
  return t.run(async (ctx) => {
    const counts: Record<string, number> = {};
    for (const name of Object.keys(tables).filter((n) => n !== "workspaceDeletions")) {
      const rows = await ctx.db.query(name as TableNames).collect() as Record<string, unknown>[];
      const mine = rows.filter((r) => r.organizationId === organizationId || r.repositoryId === repositoryId || r._id === organizationId);
      if (mine.length) counts[name] = mine.length;
    }
    return counts;
  });
}

test("workspace deletion: owner-only with a grace period, cancellable, then a resumable purge that leaves other workspaces intact", async () => {
  const t = convexTest(schema, modules);
  const acme = await workspace(t, 501, "Acme"), rival = await workspace(t, 502, "Rival");
  const adminId = await t.mutation(api.users.login, { secret: "data-service", githubId: 503, login: "admin503", avatar: "" });
  await t.run((ctx) => ctx.db.insert("organizationMembers", { organizationId: acme.organizationId, userId: adminId, role: "admin" }));
  const admin = await new SignJWT({}).setSubject(adminId).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setExpirationTime("30d").sign(new TextEncoder().encode(process.env.SESSION_SECRET));
  const rivalBefore = await owned(t, rival.organizationId, rival.repo._id);
  // A referral that bound Acme belongs to its referrer (Rival's owner): it keeps only Acme's id.
  const referralId = await t.run((ctx) => ctx.db.insert("referrals", { referrerId: rival.userId, referredUserId: acme.userId, referredOrganizationId: acme.organizationId, source: "link", status: "pending", attributedAt: Date.now(), boundAt: Date.now(), updatedAt: Date.now() }));
  const commissionId = await t.run((ctx) => ctx.db.insert("referralCommissions", { referralId, referrerId: rival.userId, referredOrganizationId: acme.organizationId, invoiceId: "in_1", subscriptionId: "sub_1", currency: "usd", base: 10000, rateBps: 2000, amount: 2000, reversed: 0, status: "accrued", invoiceCreated: Date.now(), paidAt: Date.now(), availableAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() }));
  const payoutAccountId = await t.run((ctx) => ctx.db.insert("referralPayoutAccounts", { userId: acme.userId, accountId: "acct_1Acme", country: "US", transfers: "active", onboardedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() }));
  const redemptionId = await t.run((ctx) => ctx.db.insert("referralRedemptions", { userId: acme.userId, kind: "credit", amount: 1000, currency: "usd", creditOrganizationId: acme.organizationId, status: "completed", stripeId: "cbtxn_1", idempotencyKey: "referral-credit:r:1", keyIssuedAt: Date.now(), attempts: 0, createdAt: Date.now(), updatedAt: Date.now(), completedAt: Date.now() }));
  // Only the owner, and only with the exact name.
  await expect(t.mutation(api.dataControls.requestDeletion, { token: admin, organizationId: acme.organizationId, confirmName: "Acme" })).rejects.toThrow(/Only the workspace owner/);
  await expect(t.mutation(api.dataControls.requestDeletion, { token: acme.token, organizationId: acme.organizationId, confirmName: "acme" })).rejects.toThrow(/exactly/);
  // Cancelled during the grace period: nothing is deleted.
  await t.mutation(api.dataControls.requestDeletion, { token: acme.token, organizationId: acme.organizationId, confirmName: "Acme" });
  expect((await t.query(api.dataControls.settings, { token: acme.token, organizationId: acme.organizationId })).deletion?.status).toBe("scheduled");
  await expect(t.mutation(api.dataControls.cancelDeletion, { token: admin, organizationId: acme.organizationId })).rejects.toThrow(/owner/);
  await t.mutation(api.dataControls.cancelDeletion, { token: acme.token, organizationId: acme.organizationId });
  await t.finishAllScheduledFunctions(() => vi.runAllTimersAsync());
  expect(await t.run((ctx) => ctx.db.get(acme.organizationId))).not.toBeNull();
  // Requested again; after 7 days the purge starts and runs in chunks until done.
  await t.mutation(api.dataControls.requestDeletion, { token: acme.token, organizationId: acme.organizationId, confirmName: "Acme" });
  vi.setSystemTime(Date.UTC(2026, 9, 21, 12, 1));
  await t.finishAllScheduledFunctions(() => vi.runAllTimersAsync());
  const receipt = (await t.run((ctx) => ctx.db.query("workspaceDeletions").collect())).find((d) => d.status === "done")!;
  expect(receipt.counts).toMatchObject({ codeChunks: 230, reviews: 1, findings: 1, reviewFindings: 1, chatMessages: 1, oauthTokens: 1, indexSkippedFiles: 1, organizations: 1 });
  expect(await owned(t, acme.organizationId, acme.repo._id)).toEqual({});
  expect(await t.run((ctx) => ctx.db.get(referralId))).toMatchObject({ referredOrganizationId: acme.organizationId, status: "pending" });
  expect(await t.run((ctx) => ctx.db.get(commissionId))).toMatchObject({ referredOrganizationId: acme.organizationId, status: "accrued", amount: 2000 });
  expect(await t.run((ctx) => ctx.db.get(redemptionId))).toMatchObject({ creditOrganizationId: acme.organizationId, status: "completed", amount: 1000 });
  expect(await t.run((ctx) => ctx.db.get(payoutAccountId))).toMatchObject({ userId: acme.userId, accountId: "acct_1Acme" });
  // Voiding them afterwards does not recreate Acme's audit log.
  await t.mutation(internal.referralOps.voidReferral, { referralId, reason: "abuse" });
  await t.mutation(internal.referralOps.voidCommission, { commissionId, reason: "abuse" });
  expect(await owned(t, acme.organizationId, acme.repo._id)).toEqual({});
  expect(await t.run(async (ctx) => Promise.all(acme.storage.map((id) => ctx.storage.get(id))))).toEqual([null, null, null]);
  // Rows reached through parents are gone too (reviewFindings, chat messages, tokens, skipped files).
  expect(await t.run(async (ctx) => [(await ctx.db.query("reviewFindings").collect()).length, (await ctx.db.query("chatMessages").collect()).length, (await ctx.db.query("oauthTokens").collect()).length, (await ctx.db.query("indexSkippedFiles").collect()).length])).toEqual([1, 1, 1, 1]);
  // The other workspace is untouched, files included; the owner's account remains.
  expect(await owned(t, rival.organizationId, rival.repo._id)).toEqual(rivalBefore);
  expect(await t.run(async (ctx) => (await Promise.all(rival.storage.map((id) => ctx.storage.get(id)))).every(Boolean))).toBe(true);
  expect(await t.run((ctx) => ctx.db.get(acme.userId))).not.toBeNull();
  // Re-running a finished purge does nothing.
  await t.mutation(internal.dataControls.purge, { deletionId: receipt._id });
  expect(await owned(t, rival.organizationId, rival.repo._id)).toEqual(rivalBefore);
});

test("a workspace with a subscription that has not ended cannot be deleted, even if it subscribes during the grace period", async () => {
  const t = convexTest(schema, modules);
  const acme = await workspace(t, 531, "Acme");
  const accountId = await t.run((ctx) => ctx.db.insert("billingAccounts", { organizationId: acme.organizationId, customerId: "cus_1", subscriptionId: "sub_1", status: "active", seats: 1, trialEndsAt: Date.now(), updatedAt: Date.now() }));
  const request = () => t.mutation(api.dataControls.requestDeletion, { token: acme.token, organizationId: acme.organizationId, confirmName: "Acme" });
  // Active, and still active while a cancellation waits for the period end.
  await expect(request()).rejects.toThrow(/Cancel it in Settings → Billing → Manage billing/);
  await t.run((ctx) => ctx.db.patch(accountId, { status: "past_due" }));
  await expect(request()).rejects.toThrow(/subscription/);
  // Once Stripe has ended it, deletion can be scheduled.
  await t.run((ctx) => ctx.db.patch(accountId, { status: "canceled" }));
  await request();
  // Subscribing again during the grace period cancels the deletion when the purge would start.
  await t.run((ctx) => ctx.db.patch(accountId, { subscriptionId: "sub_2", status: "active" }));
  vi.setSystemTime(Date.UTC(2026, 9, 21, 12, 1));
  await t.finishAllScheduledFunctions(() => vi.runAllTimersAsync());
  expect((await t.run((ctx) => ctx.db.query("workspaceDeletions").collect())).map((d) => d.status)).toEqual(["cancelled"]);
  expect(await t.run((ctx) => ctx.db.get(acme.organizationId))).not.toBeNull();
  expect(await t.run((ctx) => ctx.db.get(accountId))).toMatchObject({ subscriptionId: "sub_2", status: "active" });
  expect((await t.run((ctx) => ctx.db.query("auditEvents").collect())).some((a) => a.action === "workspace.deletion_blocked")).toBe(true);
});

test("the purge resumes after an interruption: each chunk is a separate transaction and repeated chunks are harmless", async () => {
  process.env.WORKSPACE_DELETION_GRACE_DAYS = "0";
  const t = convexTest(schema, modules);
  const acme = await workspace(t, 511, "Acme"), rival = await workspace(t, 512, "Rival");
  const rivalBefore = await owned(t, rival.organizationId, rival.repo._id);
  await t.mutation(api.dataControls.requestDeletion, { token: acme.token, organizationId: acme.organizationId, confirmName: "Acme" });
  const [deletion] = await t.run((ctx) => ctx.db.query("workspaceDeletions").collect());
  await t.mutation(internal.dataControls.startPurge, { deletionId: deletion._id });
  // Drive the chunks by hand, running some twice (a duplicate schedule after a crash).
  for (let i = 0; i < 400; i++) {
    const d = (await t.run((ctx) => ctx.db.get(deletion._id)))!;
    if (d.status === "done") break;
    await t.mutation(internal.dataControls.purge, { deletionId: deletion._id });
    if (i % 7 === 0) await t.mutation(internal.dataControls.purge, { deletionId: deletion._id });
  }
  expect((await t.run((ctx) => ctx.db.get(deletion._id)))?.status).toBe("done");
  expect(await owned(t, acme.organizationId, acme.repo._id)).toEqual({});
  expect(await owned(t, rival.organizationId, rival.repo._id)).toEqual(rivalBefore);
});

test("the purge reaches every repository's rows, paging repositories across chunks", async () => {
  process.env.WORKSPACE_DELETION_GRACE_DAYS = "0";
  const t = convexTest(schema, modules);
  const acme = await workspace(t, 521, "Acme");
  // 60 repositories span several repository pages, each with stored source.
  await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob(["source"]));
    for (let i = 0; i < 60; i++) {
      const repositoryId = await ctx.db.insert("repositories", { organizationId: acme.organizationId, fullName: `acme/r${i}`, defaultBranch: "main", enabled: true, indexStatus: "ready", createdAt: Date.now() });
      await ctx.db.insert("repositoryFiles", { organizationId: acme.organizationId, repositoryId, path: "a.ts", sha: "s", storageId, language: "typescript", updatedAt: Date.now() });
    }
  });
  await t.mutation(api.dataControls.requestDeletion, { token: acme.token, organizationId: acme.organizationId, confirmName: "Acme" });
  await t.finishAllScheduledFunctions(() => vi.runAllTimersAsync());
  expect((await t.run((ctx) => ctx.db.query("workspaceDeletions").collect()))[0]).toMatchObject({ status: "done", counts: { repositoryFiles: 61, repositories: 61 } });
  expect(await t.run((ctx) => ctx.db.query("repositoryFiles").collect())).toEqual([]);
});

test("a workspace with many index runs across many repositories purges to completion, under the 4,096 queries per transaction", async () => {
  process.env.WORKSPACE_DELETION_GRACE_DAYS = "0";
  const t = convexTest({ schema, modules, transactionLimits: true });
  const acme = await workspace(t, 541, "Acme");
  // 50 repositories × 100 index runs: walking every repository's runs for skipped files took 5,000+ queries.
  await t.run(async (ctx) => {
    const now = Date.now();
    for (let r = 0; r < 50; r++) {
      const repositoryId = r ? await ctx.db.insert("repositories", { organizationId: acme.organizationId, fullName: `acme/r${r}`, defaultBranch: "main", enabled: true, indexStatus: "indexed", createdAt: now }) : acme.repo._id;
      for (let j = 0; j < 100; j++) { const jobId = await ctx.db.insert("indexJobs", { organizationId: acme.organizationId, repositoryId, sha: "a".repeat(40), status: "done", attempts: 1, processed: 1, total: 1, changed: 1, createdAt: now, updatedAt: now }); if (j % 25 === 0) await ctx.db.insert("indexSkippedFiles", { jobId, path: "big.bin" }); }
    }
  });
  await t.mutation(api.dataControls.requestDeletion, { token: acme.token, organizationId: acme.organizationId, confirmName: "Acme" });
  const [deletion] = await t.run((ctx) => ctx.db.query("workspaceDeletions").collect());
  await t.mutation(internal.dataControls.startPurge, { deletionId: deletion._id });
  for (let i = 0; i < 1000 && (await t.run((ctx) => ctx.db.get(deletion._id)))?.status !== "done"; i++) await t.mutation(internal.dataControls.purge, { deletionId: deletion._id });
  expect((await t.run((ctx) => ctx.db.get(deletion._id)))).toMatchObject({ status: "done", counts: { indexJobs: 5001, indexSkippedFiles: 201, repositories: 50 } });
  expect(await owned(t, acme.organizationId, acme.repo._id)).toEqual({});
  expect(await t.run((ctx) => ctx.db.query("indexSkippedFiles").collect())).toEqual([]);
}, 60_000);

test("the retention sweep pages through workspaces, staying under 1,000 scheduled functions per transaction", async () => {
  const t = convexTest({ schema, modules, transactionLimits: true });
  await t.run(async (ctx) => { for (let i = 0; i < 1001; i++) await ctx.db.insert("organizations", { name: "Org" + i, createdAt: 0, reviewRetentionDays: 30 }); });
  await t.mutation(internal.dataControls.retentionSweep, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers, 1000);
  const runs = (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((j) => j.name.includes("dataControls:retention") && !j.name.includes("Sweep"));
  expect([runs.length, runs.every((j) => j.state.kind === "success")]).toEqual([1001, true]);
});

test("retention, data sharing and webhook pruning", async () => {
  const t = convexTest(schema, modules);
  const acme = await workspace(t, 521, "Acme"), rival = await workspace(t, 522, "Rival");
  // Settings are admin-only, validated and audited.
  await expect(t.mutation(api.dataControls.saveSettings, { token: acme.token, organizationId: acme.organizationId, dataSharing: "private", reviewRetentionDays: 3, transcriptRetentionDays: null })).rejects.toThrow(/between 7 and 3,650/);
  await t.mutation(api.dataControls.saveSettings, { token: acme.token, organizationId: acme.organizationId, dataSharing: "aggregate", reviewRetentionDays: 30, transcriptRetentionDays: 14 });
  expect((await t.run((ctx) => ctx.db.query("auditEvents").collect())).some((a) => a.action === "workspace.data_settings")).toBe(true);
  // Data sharing: only opted-in workspaces are counted, and only counts leave them.
  const report = await t.query(api.dataControls.aggregateReport, { secret: "data-service" });
  expect([report.workspaces, report.reviews, report.findings, report.byCategory]).toEqual([1, 1, 1, { correctness: 1 }]);
  await expect(t.query(api.dataControls.aggregateReport, { secret: "wrong" })).rejects.toThrow();
  // Retention: 20 days later, transcripts older than 14 days are gone, reviews (30 days) stay.
  vi.setSystemTime(Date.UTC(2026, 10, 3, 12));
  await t.mutation(internal.dataControls.retentionSweep, {});
  await t.finishAllScheduledFunctions(() => vi.runAllTimersAsync());
  const review = await t.run((ctx) => ctx.db.get(acme.reviewId));
  expect([review?.status, review?.agentStateStorageId, await t.run((ctx) => ctx.storage.get(acme.storage[2])), await t.run((ctx) => ctx.db.get(acme.threadId))]).toEqual(["completed", undefined, null, null]);
  // 40 days later the review, its findings and its result file are gone; the other workspace kept everything.
  vi.setSystemTime(Date.UTC(2026, 10, 23, 12));
  await t.mutation(internal.dataControls.retentionSweep, {});
  await t.finishAllScheduledFunctions(() => vi.runAllTimersAsync());
  expect(await t.run(async (ctx) => [await ctx.db.get(acme.reviewId), (await ctx.db.query("findings").withIndex("by_org", (q) => q.eq("organizationId", acme.organizationId)).collect()).length, await ctx.storage.get(acme.storage[1])])).toEqual([null, 0, null]);
  expect(await t.run(async (ctx) => [Boolean(await ctx.db.get(rival.reviewId)), Boolean(await ctx.db.get(rival.threadId))])).toEqual([true, true]);
  // Webhook payloads: processed deliveries older than 14 days are pruned with their payloads.
  const [oldPayload, newPayload] = await t.run(async (ctx) => [await ctx.storage.store(new Blob(["{}"])), await ctx.storage.store(new Blob(["{}"]))]);
  await t.run(async (ctx) => {
    await ctx.db.insert("webhookDeliveries", { deliveryId: "old", event: "pull_request", payloadStorageId: oldPayload, status: "completed", attempts: 1, createdAt: Date.now() - 20 * 86_400_000, updatedAt: Date.now() - 20 * 86_400_000 });
    await ctx.db.insert("webhookDeliveries", { deliveryId: "new", event: "pull_request", payloadStorageId: newPayload, status: "completed", attempts: 1, createdAt: Date.now(), updatedAt: Date.now() });
  });
  expect(await t.mutation(internal.dataControls.pruneWebhookPayloads, {})).toEqual({ deliveries: 1, events: 0 });
  expect(await t.run(async (ctx) => [(await ctx.db.query("webhookDeliveries").collect()).map((d) => d.deliveryId), await ctx.storage.get(oldPayload), Boolean(await ctx.storage.get(newPayload))])).toEqual([["new"], null, true]);
});

test("webhook payloads are pruned 14 days after their last processing attempt, whatever the outcome", async () => {
  const t = convexTest(schema, modules);
  const day = 86_400_000, now = Date.now(), old = now - 15 * day;
  const { connectionId, payloads } = await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", { name: "Acme", createdAt: now });
    const connectionId = await ctx.db.insert("providerConnections", { organizationId, kind: "gitlab", instance: "https://gitlab.example", name: "GitLab", credentials: "encrypted", webhookSecret: "encrypted", active: true, createdAt: now });
    const payloads: Record<string, Id<"_storage">> = {};
    // GitHub deliveries in every state, plus one that arrived long ago but was processed again recently.
    for (const [deliveryId, status, updatedAt] of [["completed", "completed", old], ["failed", "failed", old], ["queued", "queued", old], ["processing", "processing", old], ["recent", "failed", now - day], ["retried", "completed", now - day]] as const) {
      payloads[deliveryId] = await ctx.storage.store(new Blob(["{}"]));
      await ctx.db.insert("webhookDeliveries", { deliveryId, event: "pull_request", payloadStorageId: payloads[deliveryId], status, attempts: 1, createdAt: deliveryId === "retried" ? old : updatedAt, updatedAt });
    }
    for (const [externalId, status, createdAt, updatedAt] of [["done", "completed", old, old], ["gave-up", "failed", old, old], ["never-ran", "queued", old, undefined], ["fresh", "failed", now - day, now - day], ["retried", "failed", old, now - day]] as const)
      await ctx.db.insert("providerEvents", { connectionId, externalId, body: `{"id":"${externalId}"}`, eventType: "merge_request", status, attempts: 1, createdAt, ...(updatedAt ? { updatedAt } : {}) });
    return { connectionId, payloads };
  });
  expect(await t.mutation(internal.dataControls.pruneWebhookPayloads, {})).toEqual({ deliveries: 4, events: 3 });
  const deliveries = await t.run(async (ctx) => (await ctx.db.query("webhookDeliveries").collect()).map((d) => d.deliveryId).sort());
  expect(deliveries).toEqual(["recent", "retried"]);
  const files = await t.run(async (ctx) => Object.fromEntries(await Promise.all(Object.entries(payloads).map(async ([id, storageId]) => [id, Boolean(await ctx.storage.get(storageId))]))));
  expect(files).toEqual({ completed: false, failed: false, queued: false, processing: false, recent: true, retried: true });
  // Provider event rows stay (they dedupe redeliveries and list the delivery); only old bodies are cleared.
  const events = await t.run(async (ctx) => Object.fromEntries((await ctx.db.query("providerEvents").collect()).map((e) => [e.externalId, { body: e.body, deleted: Boolean(e.bodyDeletedAt) }])));
  expect(events).toEqual({ done: { body: "", deleted: true }, "gave-up": { body: "", deleted: true }, "never-ran": { body: "", deleted: true }, fresh: { body: '{"id":"fresh"}', deleted: false }, retried: { body: '{"id":"retried"}', deleted: false } });
  // A second run finds nothing new; an event whose payload is gone is never processed or retried again.
  expect(await t.mutation(internal.dataControls.pruneWebhookPayloads, {})).toEqual({ deliveries: 0, events: 0 });
  const gaveUp = await t.run(async (ctx) => (await ctx.db.query("providerEvents").withIndex("by_delivery", (q) => q.eq("connectionId", connectionId).eq("externalId", "gave-up")).unique())!);
  expect(await t.mutation(internal.providerConnections.claimEvent, { id: gaveUp._id })).toBe(false);
  expect(await t.run((ctx) => ctx.db.get(gaveUp._id))).toMatchObject({ status: "failed", attempts: 1 });
  // Redeliveries of a pruned event are still recognised as duplicates.
  expect(await t.mutation(internal.providerConnections.receive, { connectionId, externalId: "done", body: "{}" })).toBe((await t.run(async (ctx) => (await ctx.db.query("providerEvents").withIndex("by_delivery", (q) => q.eq("connectionId", connectionId).eq("externalId", "done")).unique())!._id)));
});

test("webhook pruning continues in further batches until the backlog is cleared", async () => {
  const t = convexTest(schema, modules);
  const old = Date.now() - 20 * 86_400_000;
  await t.run(async (ctx) => {
    for (let i = 0; i < 230; i++) await ctx.db.insert("webhookDeliveries", { deliveryId: "d" + i, event: "push", payloadStorageId: await ctx.storage.store(new Blob(["{}"])), status: "completed", attempts: 1, createdAt: old, updatedAt: old });
  });
  expect(await t.mutation(internal.dataControls.pruneWebhookPayloads, {})).toEqual({ deliveries: 200, events: 0 });
  await t.finishAllScheduledFunctions(() => vi.runAllTimersAsync());
  expect(await t.run(async (ctx) => (await ctx.db.query("webhookDeliveries").collect()).length)).toBe(0);
});

test("transcript retention reaches old threads and conversations behind hundreds of recent ones, and pages through workspaces", async () => {
  const t = convexTest(schema, modules);
  const day = 86_400_000, now = Date.now(), old = now - 30 * day;
  const ids = await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", { name: "Busy", transcriptRetentionDays: 14, createdAt: now });
    const [alice, bob] = [await ctx.db.insert("users", { login: "alice", avatar: "", createdAt: now }), await ctx.db.insert("users", { login: "bob", avatar: "", createdAt: now })];
    const repositoryId = await ctx.db.insert("repositories", { organizationId, fullName: "busy/app", defaultBranch: "main", enabled: true, indexStatus: "ready", createdAt: now });
    // The old code read 500 threads in user order and 500 conversations in pull request order, so these were never reached.
    for (let i = 0; i < 500; i++) await ctx.db.insert("chatThreads", { organizationId, userId: alice, title: "recent", repositoryIds: [], createdAt: now, updatedAt: now });
    const oldThread = await ctx.db.insert("chatThreads", { organizationId, userId: bob, title: "old", repositoryIds: [], createdAt: old, updatedAt: old });
    for (let i = 0; i < 500; i++) await ctx.db.insert("conversations", { organizationId, repositoryId, prNumber: 1, githubCommentId: i, author: "a", question: "q", status: "completed", createdAt: now });
    const oldConversation = await ctx.db.insert("conversations", { organizationId, repositoryId, prNumber: 2, githubCommentId: 9999, author: "a", question: "q", status: "completed", createdAt: old });
    return { organizationId, oldThread, oldConversation };
  });
  await t.mutation(internal.dataControls.retention, { organizationId: ids.organizationId });
  expect(await t.run(async (ctx) => [await ctx.db.get(ids.oldThread), await ctx.db.get(ids.oldConversation)])).toEqual([null, null]);
  expect((await t.run((ctx) => ctx.db.query("chatThreads").collect())).length).toBe(500);
  // More than one page of workspaces: the sweep continues with a cursor instead of stopping at a fixed count.
  await t.run(async (ctx) => { for (let i = 0; i < 600; i++) await ctx.db.insert("organizations", { name: `w${i}`, createdAt: now }); });
  await t.mutation(internal.dataControls.retentionSweep, {});
  const next = (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((s) => s.name.includes("retentionSweep"));
  expect(next).toHaveLength(1);expect((next[0].args[0] as { cursor?: string }).cursor).toBeTruthy();
});

test("conversation retention counts from the last reply, so an old thread replied to yesterday survives", async () => {
  const t = convexTest(schema, modules);
  const day = 86_400_000, now = Date.now();
  const ids = await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", { name: "Threads", transcriptRetentionDays: 30, createdAt: now });
    const repositoryId = await ctx.db.insert("repositories", { organizationId, fullName: "threads/app", defaultBranch: "main", enabled: true, indexStatus: "ready", createdAt: now });
    const row = (githubCommentId: number, createdAt: number, updatedAt: number) => ctx.db.insert("conversations", { organizationId, repositoryId, prNumber: 1, githubCommentId, author: "a", question: "q", status: "completed", createdAt, updatedAt });
    return { organizationId, active: await row(1, now - 31 * day, now - day), idle: await row(2, now - 40 * day, now - 35 * day) };
  });
  await t.mutation(internal.dataControls.retention, { organizationId: ids.organizationId });
  expect(await t.run(async (ctx) => [(await ctx.db.get(ids.active))?._id, await ctx.db.get(ids.idle)])).toEqual([ids.active, null]);
});

test("review retention deletes a review's children 500 at a time and the review only once none are left", async () => {
  const t = convexTest(schema, modules);
  const now = Date.now(), old = now - 60 * 86_400_000;
  const { organizationId, reviewId } = await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", { name: "Old", reviewRetentionDays: 30, createdAt: now });
    const repositoryId = await ctx.db.insert("repositories", { organizationId, fullName: "old/app", defaultBranch: "main", enabled: true, indexStatus: "ready", createdAt: now });
    const reviewId = await ctx.db.insert("reviews", { organizationId, repositoryId, prNumber: 1, headSha: "a".repeat(40), status: "completed", mode: "standard", attempts: 1, createdAt: old, updatedAt: old });
    for (let i = 0; i < 501; i++) await ctx.db.insert("modelCalls", { organizationId, reviewId, task: "review", provider: "p", model: "m", inputTokens: 1, outputTokens: 1, latencyMs: 1, estimatedCost: 0, cached: false, createdAt: old });
    return { organizationId, reviewId };
  });
  const state = () => t.run(async (ctx) => [!!(await ctx.db.get(reviewId)), (await ctx.db.query("modelCalls").withIndex("by_review", (q) => q.eq("reviewId", reviewId)).collect()).length]);
  // Fake timers keep the self-rescheduled run from firing between these calls.
  expect(await t.mutation(internal.dataControls.retention, { organizationId })).toMatchObject({ reviews: 0, more: true });
  expect(await state()).toEqual([true, 1]);
  expect(await t.mutation(internal.dataControls.retention, { organizationId })).toMatchObject({ reviews: 1, more: false });
  expect(await state()).toEqual([false, 0]);
});

// Runs one purge step by hand from a receipt parked on it, until the purge moves to the next step.
async function purgeStep(t: ReturnType<typeof convexTest>, organizationId: Id<"organizations">, requestedBy: Id<"users">, table: TableNames) {
  const step = purgePlan.findIndex((s) => s.table === table), now = Date.now();
  const deletionId = await t.run((ctx) => ctx.db.insert("workspaceDeletions", { organizationId, name: "Big", requestedBy, requestedAt: now, scheduledFor: now, status: "purging", step, counts: {} }));
  for (let i = 0; i < 100 && (await t.run((ctx) => ctx.db.get(deletionId)))!.step === step; i++) await t.mutation(internal.dataControls.purge, { deletionId });
  expect((await t.run((ctx) => ctx.db.get(deletionId)))!.step).toBe(step + 1);
}

test("the purge deletes identity grants of every repository, however many the workspace has", async () => {
  const t = convexTest(schema, modules);
  const userId = await t.mutation(api.users.login, { secret: "data-service", githubId: 531, login: "u531", avatar: "" }), now = Date.now();
  const { organizationId, grantId } = await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", { name: "Big", createdAt: now }), other = await ctx.db.insert("organizations", { name: "Other", createdAt: now });
    const connectionId = await ctx.db.insert("providerConnections", { organizationId: other, kind: "gitlab", instance: "https://gitlab.com", name: "g", credentials: "c", webhookSecret: "w", active: true, createdAt: now });
    let repositoryId!: Id<"repositories">;
    for (let i = 0; i < 2001; i++) repositoryId = await ctx.db.insert("repositories", { organizationId, fullName: `big/r${i}`, defaultBranch: "main", enabled: true, indexStatus: "ready", createdAt: now });
    const grantId = await ctx.db.insert("providerIdentityGrants", { repositoryId, connectionId, userId, digest: "d", tokenHash: "h", expiresAt: now, consumed: false });
    return { organizationId, grantId };
  });
  await purgeStep(t, organizationId, userId, "providerIdentityGrants");
  expect(await t.run((ctx) => ctx.db.get(grantId))).toBeNull();
});

test("the purge deletes skipped-file rows of every index job, not only a repository's first 500", async () => {
  const t = convexTest(schema, modules);
  const userId = await t.mutation(api.users.login, { secret: "data-service", githubId: 532, login: "u532", avatar: "" }), now = Date.now();
  const organizationId = await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", { name: "Big", createdAt: now });
    const repositoryId = await ctx.db.insert("repositories", { organizationId, fullName: "big/app", defaultBranch: "main", enabled: true, indexStatus: "ready", createdAt: now });
    for (let i = 0; i < 501; i++) {
      const jobId = await ctx.db.insert("indexJobs", { organizationId, repositoryId, sha: "a".repeat(40), status: "done", attempts: 1, processed: 1, total: 1, changed: 1, createdAt: now, updatedAt: now });
      if (i === 500) await ctx.db.insert("indexSkippedFiles", { jobId, path: "big.bin" });
    }
    return organizationId;
  });
  await purgeStep(t, organizationId, userId, "indexSkippedFiles");
  expect(await t.run((ctx) => ctx.db.query("indexSkippedFiles").collect())).toEqual([]);
});

test("webhook pruning reads byte-bounded pages, so large inline event bodies never stop it", async () => {
  const t = convexTest({ schema, modules, transactionLimits: { bytesRead: 8_000_000 } });
  const day = 86_400_000, now = Date.now(), old = now - 20 * day, body = "x".repeat(400_000);
  await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", { name: "Big bodies", createdAt: now });
    const connectionId = await ctx.db.insert("providerConnections", { organizationId, kind: "gitlab", instance: "https://gitlab.example", name: "GitLab", credentials: "encrypted", webhookSecret: "encrypted", active: true, createdAt: now });
    // A retried event at the head of the index keeps its body; the next pages step past it instead of rereading it.
    await ctx.db.insert("providerEvents", { connectionId, externalId: "retried", body, status: "failed", attempts: 2, createdAt: old - day, updatedAt: now - day });
    for (let i = 0; i < 30; i++) await ctx.db.insert("providerEvents", { connectionId, externalId: "e" + i, body, status: "completed", attempts: 1, createdAt: old });
    await ctx.db.insert("webhookDeliveries", { deliveryId: "old", event: "push", payloadStorageId: await ctx.storage.store(new Blob(["{}"])), status: "completed", attempts: 1, createdAt: old, updatedAt: old });
  });
  await t.mutation(internal.dataControls.pruneWebhookPayloads, {});
  // The continuation reuses this run's cutoff: Convex rejects a cursor on a query whose range changed.
  const next = (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).find((s) => s.name.includes("pruneWebhookPayloads"));
  expect(next?.args[0]).toMatchObject({ cursor: expect.any(String), cutoff: now - 14 * day });
  await t.finishAllScheduledFunctions(() => vi.runAllTimersAsync());
  const events = await t.run(async (ctx) => (await ctx.db.query("providerEvents").collect()).filter((e) => e.body !== "").map((e) => e.externalId));
  expect(events).toEqual(["retried"]);
  expect(await t.run(async (ctx) => (await ctx.db.query("webhookDeliveries").collect()).length)).toBe(0);
});

test("an undated old conversation expires even behind 100 older conversations that are still active", async () => {
  const t = convexTest(schema, modules);
  const day = 86_400_000, now = Date.now();
  const ids = await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", { name: "Legacy", transcriptRetentionDays: 14, createdAt: now });
    const repositoryId = await ctx.db.insert("repositories", { organizationId, fullName: "legacy/app", defaultBranch: "main", enabled: true, indexStatus: "ready", createdAt: now });
    for (let i = 0; i < 100; i++) await ctx.db.insert("conversations", { organizationId, repositoryId, prNumber: 1, githubCommentId: i, author: "a", question: "q", status: "completed", createdAt: now - 40 * day, updatedAt: now - day });
    return { organizationId, undated: await ctx.db.insert("conversations", { organizationId, repositoryId, prNumber: 2, githubCommentId: 999, author: "a", question: "q", status: "completed", createdAt: now - 30 * day }) };
  });
  await t.mutation(internal.dataControls.retention, { organizationId: ids.organizationId });
  expect(await t.run((ctx) => ctx.db.get(ids.undated))).toBeNull();
  expect((await t.run((ctx) => ctx.db.query("conversations").collect())).length).toBe(100);
});

test("the purge first stops new work: repositories are disabled, re-enabling is refused, and pushes and reviews during the drain write nothing", async () => {
  process.env.WORKSPACE_DELETION_GRACE_DAYS = "0";
  const t = convexTest(schema, modules);
  const acme = await workspace(t, 551, "Acme");
  await t.run((ctx) => ctx.db.patch(acme.repo._id, { enabled: true }));
  await t.mutation(api.dataControls.requestDeletion, { token: acme.token, organizationId: acme.organizationId, confirmName: "Acme" });
  const [deletion] = await t.run((ctx) => ctx.db.query("workspaceDeletions").collect());
  await t.mutation(internal.dataControls.startPurge, { deletionId: deletion._id });
  await t.mutation(internal.dataControls.quiesce, { deletionId: deletion._id });
  expect((await t.run((ctx) => ctx.db.get(acme.repo._id)))?.enabled).toBe(false);
  // While the purge runs, a webhook push and a pull request event are turned away, and nobody can switch the repository back on.
  expect(await t.mutation(internal.repositories.indexing, { repositoryId: acme.repo._id, sha: "c".repeat(40), total: 1 })).toBeNull();
  expect(await t.mutation(internal.reviews.enqueue, { repositoryId: acme.repo._id, prNumber: 9, headSha: "d".repeat(40), trigger: "automatic" })).toBeNull();
  await expect(t.mutation(api.repositories.configure, { token: acme.token, repositoryId: acme.repo._id, enabled: true })).rejects.toThrow(/being deleted/);
  // The purge itself waits for jobs already running, then removes everything.
  await t.finishAllScheduledFunctions(() => vi.runAllTimersAsync());
  expect((await t.run((ctx) => ctx.db.get(deletion._id)))?.status).toBe("done");
  expect(await owned(t, acme.organizationId, acme.repo._id)).toEqual({});
});
