import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { Github } from "../src/github";

// "Re-review" on a review page: a failing backend action (closed PR, lost access, rate limit) becomes an error toast, not the dashboard error page.
const holder = vi.hoisted(() => ({ t: undefined as unknown, jar: new Map<string, string>(), session: "" }));
class Redirect extends Error { constructor(readonly url: string) { super("redirect " + url); } }
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => holder.jar.has(name) ? { value: holder.jar.get(name) } : undefined, set: (name: string, value: string) => { holder.jar.set(name, value); } }) }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Redirect(url); } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("../src/server", () => ({
  backend: () => { type Call = (ref: unknown, args: unknown) => Promise<unknown>; const t = holder.t as { query: Call; mutation: Call; action: Call }; return { query: (r: unknown, a: unknown) => t.query(r, a), mutation: (r: unknown, a: unknown) => t.mutation(r, a), action: (r: unknown, a: unknown) => t.action(r, a) }; },
  cookieOptions: { httpOnly: true, secure: false, sameSite: "lax", path: "/" },
  current: async () => ({ token: holder.session, ...(await (holder.t as { query: (r: unknown, a: unknown) => Promise<object> }).query((await import("../convex/_generated/api")).api.users.me, { token: holder.session })) }),
}));
import { reviewAgain } from "../app/dashboard/actions";

const modules = import.meta.glob("../convex/**/*.ts");
const head = "a".repeat(40);
beforeEach(() => { process.env.SESSION_SECRET = "review-again-session-secret-long-enough"; process.env.SERVICE_SECRET = "review-again-service"; holder.jar.clear(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

async function setup(state: "open" | "closed") {
  const t = convexTest({ schema, modules }); holder.t = t;
  const userId = await t.mutation(api.users.login, { secret: "review-again-service", githubId: 91, login: "alice", avatar: "" });
  holder.session = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setSubject(userId).setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET));
  const organizationId = await t.mutation(api.users.createOrganization, { token: holder.session, name: "Again" });
  await t.mutation(api.repositories.connect, { token: holder.session, secret: "review-again-service", organizationId, installationId: 91, account: "alice", accountId: 91, repositories: [{ id: 9191, fullName: "alice/again", defaultBranch: "main" }] });
  const [repo] = await t.query(api.repositories.list, { token: holder.session, organizationId });
  await t.run((ctx) => ctx.db.patch(repo._id, { enabled: true }));
  const reviewId = await t.run((ctx) => ctx.db.insert("reviews", { organizationId, repositoryId: repo._id, prNumber: 4, headSha: head, status: "completed", mode: "standard", attempts: 1, createdAt: Date.now(), updatedAt: Date.now() }));
  const scm = new Github("fixture"); vi.spyOn(Github, "installation").mockResolvedValue(scm);
  vi.spyOn(scm, "pullRequest").mockResolvedValue({ state, head: { sha: "c".repeat(40) } } as Awaited<ReturnType<Github["pullRequest"]>>);
  return { t, reviewId };
}
async function again(reviewId: string) {
  const form = new FormData(); form.set("reviewId", reviewId);
  try { await reviewAgain(form); } catch (error) { if (error instanceof Redirect) return error.url; throw error; }
  return undefined;
}
const toast = () => JSON.parse(decodeURIComponent(holder.jar.get("openreview_toast") ?? "null"));

test("a closed pull request shows an error toast and stays on the page instead of throwing", async () => {
  const { t, reviewId } = await setup("closed");
  expect(await again(reviewId)).toBeUndefined();
  expect(toast()).toEqual({ tone: "error", text: "Couldn’t re-review: Change is closed" });
  expect(await t.run((ctx) => ctx.db.query("reviews").collect())).toHaveLength(1);
});

test("an open pull request queues a new review and redirects to it", async () => {
  vi.useFakeTimers();
  const { t, reviewId } = await setup("open");
  const to = await again(reviewId);
  const reviews = await t.run((ctx) => ctx.db.query("reviews").collect());
  expect(reviews).toHaveLength(2);
  expect(to).toBe("/dashboard/pulls/" + reviews.find((r) => r._id !== reviewId)!._id);
  expect(holder.jar.has("openreview_toast")).toBe(false);
});
