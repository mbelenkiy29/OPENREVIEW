import { beforeEach, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");
const secret = "milestones-session-secret-at-least-32-characters", service = "milestones-service-secret";
beforeEach(() => { process.env.SESSION_SECRET = secret; process.env.SERVICE_SECRET = service; });
const jwt = (id: string) => new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setSubject(id).setExpirationTime("1h").sign(new TextEncoder().encode(secret));

async function setup() {
  const t = convexTest(schema, modules);
  const ownerId = await t.mutation(api.users.login, { secret: service, githubId: 1, login: "owner", avatar: "" });
  const memberId = await t.mutation(api.users.login, { secret: service, githubId: 2, login: "member", avatar: "" });
  const owner = await jwt(ownerId), member = await jwt(memberId);
  const organizationId = await t.mutation(api.users.createOrganization, { token: owner, name: "Acme" });
  await t.run((ctx) => ctx.db.insert("organizationMembers", { organizationId, userId: memberId as Id<"users">, role: "member" }));
  return { t, owner, member, organizationId };
}
const events = (list: { event: string }[]) => list.map((m) => m.event);

test("milestones follow the workspace's progress, with the time each happened", async () => {
  const { t, owner, member, organizationId } = await setup();
  expect(events(await t.query(api.analyticsMilestones.pending, { token: owner }))).toEqual(["signed_up"]);
  expect(events(await t.query(api.analyticsMilestones.pending, { token: owner, organizationId }))).toEqual(["signed_up", "workspace_created"]);
  expect(events(await t.query(api.analyticsMilestones.pending, { token: member, organizationId })), "only owners created the workspace").toEqual(["signed_up"]);

  const repositoryId = await t.run((ctx) => ctx.db.insert("repositories", { organizationId, fullName: "acme/shop", defaultBranch: "main", enabled: true, indexStatus: "pending", createdAt: 1 }));
  const review = (status: string, createdAt: number) => t.run((ctx) => ctx.db.insert("reviews", { organizationId, repositoryId, prNumber: createdAt, headSha: "abc", status, mode: "standard", attempts: 0, createdAt, updatedAt: createdAt }));
  await review("failed", 1_000);
  await review("completed", 2_000);
  await review("completed", 3_000);
  const all = await t.query(api.analyticsMilestones.pending, { token: owner, organizationId });
  expect(events(all)).toEqual(["signed_up", "workspace_created", "repository_connected", "first_review_completed"]);
  expect(all.find((m) => m.event === "first_review_completed")?.at, "the oldest completed review").toBe(2_000);
  expect(all.every((m) => m.event === "signed_up" || m.workspaceId === organizationId)).toBe(true);
  expect(events(await t.query(api.analyticsMilestones.pending, { token: member, organizationId })), "members never send workspace milestones").toEqual(["signed_up"]);
  // A second owner doesn't send them again: only the earliest owner reports the workspace's milestones.
  const coOwnerId = await t.mutation(api.users.login, { secret: service, githubId: 4, login: "co-owner", avatar: "" });
  await t.run((ctx) => ctx.db.insert("organizationMembers", { organizationId, userId: coOwnerId as Id<"users">, role: "owner" }));
  expect(events(await t.query(api.analyticsMilestones.pending, { token: await jwt(coOwnerId), organizationId }))).toEqual(["signed_up"]);
  expect(events(await t.query(api.analyticsMilestones.pending, { token: owner, organizationId }))).toHaveLength(4);
});

test("reported milestones are not sent again, and unknown keys are ignored", async () => {
  const { t, owner, organizationId } = await setup();
  await t.mutation(api.analyticsMilestones.markReported, { token: owner, keys: ["signed_up", `workspace_created:${organizationId}`, "made_up", "signed_up:extra"] });
  expect(await t.query(api.analyticsMilestones.pending, { token: owner, organizationId })).toEqual([]);
  const stored = await t.run(async (ctx) => (await ctx.db.query("users").collect()).find((u) => u.login === "owner")?.analyticsMilestones);
  expect(stored).toEqual(["signed_up", `workspace_created:${organizationId}`]);
});

test("another workspace's milestones are not visible", async () => {
  const { t, member } = await setup();
  const strangerId = await t.mutation(api.users.login, { secret: service, githubId: 3, login: "stranger", avatar: "" });
  const other = await t.mutation(api.users.createOrganization, { token: await jwt(strangerId), name: "Other" });
  expect(events(await t.query(api.analyticsMilestones.pending, { token: member, organizationId: other }))).toEqual(["signed_up"]);
});
