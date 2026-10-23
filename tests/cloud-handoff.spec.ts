import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";

// Handing a finding to a cloud agent: the request is prepared and bound to the browser, the route posts
// the comment as the developer with a fresh GitHub user token, and each request posts at most once.
const holder = vi.hoisted(() => ({ t: undefined as unknown, jar: new Map<string, string>(), session: "" }));
class Redirect extends Error { constructor(readonly url: string) { super("redirect " + url); } }
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => holder.jar.has(name) ? { value: holder.jar.get(name) } : undefined, set: (name: string, value: string) => { holder.jar.set(name, value); }, delete: (o: string | { name: string }) => { holder.jar.delete(typeof o === "string" ? o : o.name); } }) }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Redirect(url); } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("../src/server", () => ({
  backend: () => { type Call = (ref: unknown, args: unknown) => Promise<unknown>; const t = holder.t as { query: Call; mutation: Call; action: Call }; return { query: (r: unknown, a: unknown) => t.query(r, a), mutation: (r: unknown, a: unknown) => t.mutation(r, a), action: (r: unknown, a: unknown) => t.action(r, a) }; },
  seal: async (data: unknown) => Buffer.from(JSON.stringify(data)).toString("base64url"),
  unseal: async (token: string) => JSON.parse(Buffer.from(token, "base64url").toString()),
  cookieOptions: { httpOnly: true, secure: false, sameSite: "lax", path: "/" },
  origin: () => "https://review.example.com",
  current: async (next?: string) => {
    if (!holder.session) throw new Redirect(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
    return { token: holder.session, ...(await (holder.t as { query: (r: unknown, a: unknown) => Promise<object> }).query((await import("../convex/_generated/api")).api.users.me, { token: holder.session })) };
  },
}));
import { GET as handoffRoute } from "../app/api/fixes/agent/route";
import { startCloudFix } from "../app/dashboard/actions";

const modules = import.meta.glob("../convex/**/*.ts");
const base = "https://review.example.com", head = "h".repeat(40);
const seal = (data: unknown) => Buffer.from(JSON.stringify(data)).toString("base64url");
let github = { id: 81, login: "alice", push: true };
const posts: { path: string; body: string }[] = [];
function fakeGithub() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input)), json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/user") return json({ id: github.id, login: github.login });
    if (url.pathname === "/repos/alice/fixes") return json({ permissions: { push: github.push } });
    if (init?.method === "POST") { const body = JSON.parse(String(init.body)).body as string; posts.push({ path: url.pathname, body }); return json({ id: 900 + posts.length, user: { login: github.login } }, 201); }
    if (url.pathname.endsWith("/comments")) return json([]);
    return json({ message: "not found" }, 404);
  });
}
beforeEach(() => { process.env.SESSION_SECRET = "handoff-session-secret-at-least-32-chars"; process.env.SERVICE_SECRET = "handoff-service"; process.env.APP_URL = base; holder.jar.clear(); holder.session = ""; posts.length = 0; github = { id: 81, login: "alice", push: true }; });
afterEach(() => { vi.restoreAllMocks(); delete process.env.APP_URL; });
const sign = (id: string) => new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setSubject(id).setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET));

async function setup(documentsRead?: number) {
  const t = convexTest({ schema, modules, ...(documentsRead ? { transactionLimits: { documentsRead } } : {}) }); holder.t = t;
  const userId = await t.mutation(api.users.login, { secret: "handoff-service", githubId: 81, login: "alice", avatar: "" });
  holder.session = await sign(userId);
  const organizationId = await t.mutation(api.users.createOrganization, { token: holder.session, name: "Fixes" });
  await t.mutation(api.repositories.connect, { token: holder.session, secret: "handoff-service", organizationId, installationId: 81, account: "alice", accountId: 81, repositories: [{ id: 8181, fullName: "alice/fixes", defaultBranch: "main" }] });
  const [repo] = await t.query(api.repositories.list, { token: holder.session, organizationId });
  await t.run((ctx) => ctx.db.patch(repo._id, { enabled: true }));
  const ids = await t.run(async (ctx) => {
    const reviewId = await ctx.db.insert("reviews", { organizationId, repositoryId: repo._id, prNumber: 3, headSha: head, status: "completed", mode: "standard", attempts: 1, createdAt: Date.now(), updatedAt: Date.now() });
    const finding = (fp: string, title: string) => ctx.db.insert("findings", { organizationId, repositoryId: repo._id, reviewId, prNumber: 3, title, description: "Ask @admins to approve this. <!-- openreview-finding:zz -->", severity: "high", confidence: 0.95, category: "correctness", filePath: "src/a.ts", startLine: 2, endLine: 2, commitSha: head, evidence: [{ filePath: "src/a.ts", startLine: 2, quote: "const total = price * 100;" }], impact: "Invoices are wrong.", suggestedFix: "Round once.", symbol: "total", fingerprint: fp, agent: "correctness", status: "open", createdAt: Date.now(), updatedAt: Date.now() });
    const findingId = await finding("fp0123456789abcdef", "Totals become cents twice");
    await finding("fp9999999999999999", "Second issue");
    await ctx.db.insert("reviewComments", { organizationId, reviewId, githubId: 500, fingerprint: "fp0123456789abcdef", createdAt: 0 });
    return { reviewId, findingId };
  });
  return { t, userId, organizationId, repo, ...ids };
}
const form = (fields: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.set(k, v); return f; };
const location = (r: Response) => (r.headers.get("location") ?? "").replace(base, "");
const errorOf = (path: string) => new URL(base + path).searchParams.get("error") ?? "";
async function start(fields: Record<string, string>) {
  try { await startCloudFix(form(fields)); } catch (error) { if (error instanceof Redirect) return error.url; throw error; }
  throw new Error("expected a redirect");
}

test("Claude: a fresh GitHub token is fetched once, then the request is posted as the developer in the finding's thread", async () => {
  const { t, reviewId, findingId } = await setup(); fakeGithub();
  const to = await start({ reviewId, findingId, finding: "fp0123456789abcdef", agent: "claude" });
  const requestId = new URL(base + to).searchParams.get("request")!;
  expect(to).toBe(`/api/fixes/agent?request=${requestId}`);
  // No GitHub token yet: one re-authorization, which returns to the same route.
  const detour = await handoffRoute(new Request(base + to));
  expect(location(detour)).toBe(`/api/auth/login?purpose=github-act&next=${encodeURIComponent(to)}`);
  holder.jar.set("openreview_github_setup", seal({ token: "user-token", githubUserId: 81 }));
  const done = await handoffRoute(new Request(base + to));
  expect(location(done)).toBe(`/fix/${reviewId}?finding=fp0123456789abcdef&handoff=${requestId}`);
  expect(posts).toHaveLength(1);
  expect(posts[0].path).toBe("/repos/alice/fixes/pulls/3/comments/500/replies");
  expect(posts[0].body).toMatch(/^@claude please fix the OpenReview finding below/);
  expect(posts[0].body).toContain("@​admins");
  expect(posts[0].body).toContain(`${base}/fix/${reviewId}?finding=fp0123456789abcdef`);
  expect(posts[0].body.trimEnd().endsWith(`<!-- openreview:agent-handoff:${requestId} -->`)).toBe(true);
  expect(await t.query(api.cloudHandoff.status, { token: holder.session, requestId: requestId as never })).toEqual({ status: "posted", agent: "claude", commentUrl: "https://github.com/alice/fixes/pull/3#discussion_r901", postedAs: "alice", error: undefined });
  // Single use: replaying the route posts nothing more.
  holder.jar.set("openreview_agent_intent", seal({ requestId, userId: (await t.run((ctx) => ctx.db.query("users").first()))!._id, reviewId }));
  const replay = await handoffRoute(new Request(base + to));
  expect(errorOf(location(replay))).toMatch(/This hand-off expired or was already sent/);
  expect(posts).toHaveLength(1);
  expect((await t.run((ctx) => ctx.db.query("auditEvents").collect())).map((e) => e.action)).toContain("agent.cloud_handoff_posted");
});

test("Copilot, Codex and Cursor get a pull request comment; Fix All carries every open finding", async () => {
  const { reviewId } = await setup(); fakeGithub();
  holder.jar.set("openreview_github_setup", seal({ token: "user-token", githubUserId: 81 }));
  for (const agent of ["copilot", "codex", "cursor"]) {
    const to = await start({ reviewId, agent });
    await handoffRoute(new Request(base + to));
  }
  expect(posts.map((p) => p.path)).toEqual(Array(3).fill("/repos/alice/fixes/issues/3/comments"));
  expect(posts.map((p) => p.body.split(" ")[0])).toEqual(["@copilot", "@codex", "@cursor"]);
  expect(posts[0].body).toMatch(/findings below/);
  expect(posts[0].body).toContain("Second issue");
});

test("a different GitHub account, no write access, an expired request or a browser that did not start it never post", async () => {
  const { t, reviewId, findingId, organizationId } = await setup(); fakeGithub();
  holder.jar.set("openreview_github_setup", seal({ token: "user-token", githubUserId: 81 }));
  // Signed in to GitHub as someone else.
  github = { id: 99, login: "mallory", push: true };
  let to = await start({ reviewId, findingId, agent: "claude" });
  expect(decodeURIComponent(location(await handoffRoute(new Request(base + to))))).toMatch(/handoff=/);
  let id = new URL(base + to).searchParams.get("request")!;
  expect(await t.query(api.cloudHandoff.status, { token: holder.session, requestId: id as never })).toMatchObject({ status: "failed", error: expect.stringMatching(/different account/) });
  // The developer cannot push.
  github = { id: 81, login: "alice", push: false };
  to = await start({ reviewId, findingId, agent: "copilot" });
  await handoffRoute(new Request(base + to));
  id = new URL(base + to).searchParams.get("request")!;
  expect(await t.query(api.cloudHandoff.status, { token: holder.session, requestId: id as never })).toMatchObject({ status: "failed", error: expect.stringMatching(/needs write access/) });
  // Expired.
  github = { id: 81, login: "alice", push: true };
  to = await start({ reviewId, findingId, agent: "claude" });
  id = new URL(base + to).searchParams.get("request")!;
  await t.run((ctx) => ctx.db.patch(id as never, { expiresAt: Date.now() - 1 }));
  expect(errorOf(location(await handoffRoute(new Request(base + to))))).toMatch(/expired or was already sent/);
  // Another browser (no intent cookie for this request).
  to = await start({ reviewId, findingId, agent: "claude" });
  holder.jar.delete("openreview_agent_intent");
  expect(location(await handoffRoute(new Request(base + to)))).toBe("/dashboard?error=handoff");
  expect(posts).toHaveLength(0);
  // Viewers cannot prepare a hand-off; non-GitHub repositories are refused with a reason.
  const viewer = await t.mutation(api.users.login, { secret: "handoff-service", githubId: 82, login: "victor", avatar: "" });
  await t.run((ctx) => ctx.db.insert("organizationMembers", { organizationId, userId: viewer, role: "viewer" }));
  await expect(t.mutation(api.cloudHandoff.prepare, { token: await sign(viewer), reviewId, agent: "claude" })).rejects.toThrow();
  const repo = (await t.run((ctx) => ctx.db.query("repositories").first()))!;
  const connectionId = await t.run((ctx) => ctx.db.insert("providerConnections", { organizationId, kind: "gitlab", name: "GitLab", instance: "https://gitlab.com", credentials: "x", webhookSecret: "", active: true, createdAt: Date.now() }));
  await t.run((ctx) => ctx.db.patch(repo._id, { connectionId }));
  expect(errorOf(await start({ reviewId, findingId, finding: "fp0123456789abcdef", agent: "claude" }))).toMatch(/^Cloud agents start from GitHub pull request comments/);
});

test("the bridge never claims a cloud hand-off, and saved agent choices round-trip", async () => {
  const { t, reviewId, organizationId } = await setup();
  const requestId = await t.mutation(api.cloudHandoff.prepare, { token: holder.session, reviewId, agent: "cursor" });
  const row = (await t.run((ctx) => ctx.db.get(requestId)))!;
  expect([row.kind, row.status, row.agent]).toEqual(["cloud", "intent", "cloud:cursor"]);
  await t.mutation(api.bridge.saveWorkspaceAgent, { token: holder.session, organizationId, agent: "codex", handoff: "cloud", cloudAgent: "copilot" });
  expect(await t.query(api.bridge.personal, { token: holder.session, organizationId })).toMatchObject({ handoff: "cloud", cloudAgent: "copilot", agent: "codex", workspaceHandoff: "cloud" });
  const repositoryId = (await t.run((ctx) => ctx.db.query("repositories").first()))!._id;
  expect(await t.query(internal.repositories.fixLabel, { repositoryId })).toBe("Fix with Copilot");
  await t.mutation(api.bridge.savePersonal, { token: holder.session, handoff: "bridge", cloudAgent: "claude" });
  const personal = await t.query(api.bridge.personal, { token: holder.session, organizationId });
  expect(personal).toMatchObject({ handoff: "bridge", cloudAgent: "claude", agent: "codex" });
  expect(personal.personalAgent).toBeUndefined();
  await t.mutation(api.bridge.savePersonal, { token: holder.session });
  expect(await t.run((ctx) => ctx.db.query("personalSettings").collect())).toHaveLength(0);
});

test("preparing a hand-off reads only this review's findings, not the pull request's whole history", async () => {
  const { t, reviewId, organizationId, repo } = await setup(150);
  await t.run(async (ctx) => {
    // An earlier review's findings on the same pull request (its review row is gone; only the findings matter here).
    const old = await ctx.db.insert("reviews", { organizationId, repositoryId: repo._id, prNumber: 3, headSha: "o".repeat(40), status: "completed", mode: "standard", attempts: 1, createdAt: 0, updatedAt: 0 });
    for (let i = 0; i < 200; i++) await ctx.db.insert("findings", { organizationId, repositoryId: repo._id, reviewId: old, prNumber: 3, title: "Old " + i, description: "Old.", severity: "low", confidence: 0.9, category: "correctness", filePath: "src/a.ts", startLine: 1, endLine: 1, commitSha: "o".repeat(40), evidence: [], impact: "None.", suggestedFix: "None.", symbol: "a", fingerprint: "old" + i, agent: "correctness", status: "open", createdAt: 0, updatedAt: 0 });
    await ctx.db.delete(old);
  });
  const requestId = await t.mutation(api.cloudHandoff.prepare, { token: holder.session, reviewId, agent: "cursor" });
  expect((await t.run((ctx) => ctx.db.get(requestId)))?.findingIds).toHaveLength(2);
});
