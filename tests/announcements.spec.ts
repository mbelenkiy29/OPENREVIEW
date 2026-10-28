import { beforeEach, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { announcements, currentAnnouncement } from "../src/announcements";

// "What's new": closing the pop-up is stored per person and per announcement.
const modules = import.meta.glob("../convex/**/*.ts");
const secret = "announcements-session-secret-at-least-32-characters", service = "announcements-service-secret";
beforeEach(() => { process.env.SESSION_SECRET = secret; process.env.SERVICE_SECRET = service; });
const jwt = (id: string) => new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setSubject(id).setExpirationTime("1h").sign(new TextEncoder().encode(secret));

test("closing an announcement is saved once for that person only; unknown ids and signed-out calls change nothing", async () => {
  const t = convexTest(schema, modules);
  const aliceId = await t.mutation(api.users.login, { secret: service, githubId: 1, login: "alice", avatar: "" });
  const bobId = await t.mutation(api.users.login, { secret: service, githubId: 2, login: "bob", avatar: "" });
  const dismissed = async (id: string) => (await t.run((ctx) => ctx.db.get(id as Id<"users">)))?.dismissedAnnouncements;
  const [latest] = announcements;
  for (let i = 0; i < 2; i++) await t.mutation(api.announcements.dismiss, { token: await jwt(aliceId), id: latest.id });
  await t.mutation(api.announcements.dismiss, { token: await jwt(aliceId), id: "not-an-announcement" });
  expect(await dismissed(aliceId)).toEqual([latest.id]);
  expect(await dismissed(bobId)).toBeUndefined();
  await expect(t.mutation(api.announcements.dismiss, { token: "not-a-session", id: latest.id })).rejects.toThrow();
  expect(currentAnnouncement(await dismissed(aliceId))).toBeUndefined();
  expect(currentAnnouncement(await dismissed(bobId))?.id).toBe(latest.id);
});

test("the newest announcement not yet closed is the one that opens", () => {
  expect(currentAnnouncement()).toBe(announcements[0]);
  expect(new Set(announcements.map((a) => a.id)).size).toBe(announcements.length);
  for (const a of announcements) {
    expect(a.video).toMatch(/^\/whats-new\/[a-z0-9-]+\.mp4$/);
    expect(a.links.every((l) => l.href.startsWith("/"))).toBe(true);
  }
});
