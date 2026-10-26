import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";

// Sign-in leftovers are deleted on a schedule (convex/authHygiene.ts), and SAML starts, which need no
// sign-in, are capped deployment-wide.
const modules = import.meta.glob("../convex/**/*.ts");
const day = 86_400_000, now = Date.UTC(2026, 9, 23, 12);
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now); process.env.SERVICE_SECRET = "hygiene-service"; });
afterEach(() => { vi.useRealTimers(); });

test("expired counters, 30-day-old magic links and stale SAML request ids are deleted; live ones stay", async () => {
  const t = convexTest(schema, modules);
  vi.setSystemTime(now - 31 * day);
  await t.run(async (ctx) => {
    await ctx.db.insert("loginTokens", { email: "old@example.com", tokenHash: "a".repeat(64), expiresAt: now - 31 * day + 900_000, createdAt: now - 31 * day });
    await ctx.db.insert("ssoRequests", { key: "old", value: "v", expiresAt: now - 31 * day + 600_000 });
  });
  vi.setSystemTime(now);
  await t.run(async (ctx) => {
    await ctx.db.insert("loginTokens", { email: "new@example.com", tokenHash: "b".repeat(64), expiresAt: now + 900_000, createdAt: now });
    await ctx.db.insert("ssoRequests", { key: "new", value: "v", expiresAt: now + 600_000 });
    await ctx.db.insert("rateLimits", { key: "stale", window: 1, count: 1, expiresAt: now - 2 * day });
    await ctx.db.insert("rateLimits", { key: "recent", window: 1, count: 1, expiresAt: now - 3_600_000 });
    await ctx.db.insert("rateLimits", { key: "magic-link:legacy@example.com", window: 1, count: 3 });
  });
  expect(await t.mutation(internal.authHygiene.prune, {})).toEqual({ counters: 1, links: 1, samlRequests: 1 });
  const left = await t.run(async (ctx) => ({ counters: (await ctx.db.query("rateLimits").collect()).map((r) => r.key), links: (await ctx.db.query("loginTokens").collect()).map((l) => l.email), saml: (await ctx.db.query("ssoRequests").collect()).map((s) => s.key) }));
  expect(left).toEqual({ counters: ["recent", "magic-link:legacy@example.com"], links: ["new@example.com"], saml: ["new"] });
  // The one-time cleanup drops counters written before they carried an expiry, such as raw-address keys.
  expect(await t.mutation(internal.authHygiene.dropUnexpiringCounters, {})).toEqual({ deleted: 1 });
  expect((await t.run((ctx) => ctx.db.query("rateLimits").collect())).map((r) => r.key)).toEqual(["recent"]);
});

test("every counter write records when its window ends", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.identity.storeLoginToken, { email: "a@example.com", tokenHash: "c".repeat(64) });
  const rows = await t.run((ctx) => ctx.db.query("rateLimits").collect());
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((r) => r.expiresAt !== undefined && r.expiresAt > now)).toBe(true);
});

test("SAML request ids are capped deployment-wide", async () => {
  const t = convexTest(schema, modules);
  for (let i = 0; i < 300; i++) await t.mutation(api.sso.cacheSave, { secret: "hygiene-service", key: `r${i}`, value: "v" });
  await expect(t.mutation(api.sso.cacheSave, { secret: "hygiene-service", key: "r300", value: "v" })).rejects.toThrow(/Rate limit/);
});
