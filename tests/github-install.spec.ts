import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import { generateKeyPairSync } from "node:crypto";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// The GitHub App install routes and the "Link an existing installation" action run for real against
// convex-test. Next's request scope (cookies, redirect) is faked, and GitHub is a fetch fake.
const holder = vi.hoisted(() => ({ t: undefined as unknown, jar: new Map<string, string>(), session: "" }));
class Redirect extends Error { constructor(readonly url: string) { super("redirect " + url); } }
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => holder.jar.has(name) ? { value: holder.jar.get(name) } : undefined, set: (name: string, value: string) => { holder.jar.set(name, value); }, delete: (o: string | { name: string }) => { holder.jar.delete(typeof o === "string" ? o : o.name); } }) }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Redirect(url); } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("../src/server", () => ({
  backend: () => { type Call = (ref: unknown, args: unknown) => Promise<unknown>; const t = holder.t as { query: Call; mutation: Call; action: Call }; return { query: (r: unknown, a: unknown) => t.query(r, a), mutation: (r: unknown, a: unknown) => t.mutation(r, a), action: (r: unknown, a: unknown) => t.action(r, a) }; },
  seal: async (data: unknown) => Buffer.from(JSON.stringify(data)).toString("base64url"),
  unseal: async (token: string) => { if (token === "expired") throw new Error("expired"); return JSON.parse(Buffer.from(token, "base64url").toString()); },
  cookieOptions: { httpOnly: true, secure: false, sameSite: "lax", path: "/" },
  origin: () => "https://review.example.com",
  current: async (next?: string) => {
    if (!holder.session) throw new Redirect(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
    return { token: holder.session, ...(await (holder.t as { query: (r: unknown, a: unknown) => Promise<object> }).query((await import("../convex/_generated/api")).api.users.me, { token: holder.session })) };
  },
}));
import { GET as install } from "../app/api/github/install/route";
import { GET as callback } from "../app/api/github/callback/route";
import { GET as authCallback } from "../app/api/auth/callback/route";
import { linkGithubInstallation } from "../app/dashboard/actions";

const modules = import.meta.glob("../convex/**/*.ts");
const base = "https://review.example.com";
const seal = (data: unknown) => Buffer.from(JSON.stringify(data)).toString("base64url");
const unseal = (value: string | undefined) => JSON.parse(Buffer.from(value ?? "", "base64url").toString()) as Record<string, unknown>;
type Install = { id: number; account: { id: number; login: string; type: string }; repositories: { id: number; full_name: string; default_branch: string; owner: { login: string; id: number; type: string } }[]; admin?: boolean; suspended?: boolean };
let installs: Install[] = [];
const calls: string[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function github() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input)), auth = new Headers(init?.headers).get("authorization") ?? "";
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/user/installations") return json({ installations: installs.map((i) => ({ id: i.id, app_id: 4242, account: i.account, suspended_at: i.suspended ? "2026-10-01T00:00:00Z" : null })) });
    const token = url.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (token) return json({ token: "installation-" + token[1], permissions: { contents: "read", pull_requests: "write", issues: "read", checks: "write", metadata: "read" } });
    if (url.pathname === "/installation/repositories") return json({ repositories: (installs.find((i) => auth === "Bearer installation-" + i.id)?.repositories ?? []).map((r) => ({ ...r, name: r.full_name.split("/")[1], private: true })) });
    const repo = url.pathname.match(/^\/repos\/(.+)$/);
    if (repo) return json({ permissions: { admin: installs.find((i) => i.repositories.some((r) => r.full_name === repo[1]))?.admin ?? true } });
    return json({ message: "not found" }, 404);
  });
}
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
beforeEach(() => {
  process.env.SESSION_SECRET = "install-session-secret-at-least-32-chars"; process.env.SERVICE_SECRET = "install-service-secret";
  process.env.GITHUB_APP_ID = "4242"; process.env.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.GITHUB_APP_SLUG = "openreview-test"; process.env.GITHUB_CLIENT_ID = "Iv1.test"; process.env.APP_URL = base;
  holder.jar.clear(); holder.session = ""; calls.length = 0;
  installs = [{ id: 501, account: { id: 77, login: "acme", type: "Organization" }, repositories: [{ id: 9001, full_name: "acme/shop", default_branch: "master", owner: { login: "acme", id: 77, type: "Organization" } }] }];
});
afterEach(() => { vi.restoreAllMocks(); });
async function setup() {
  const t = convexTest(schema, modules); holder.t = t;
  const id = await t.mutation(api.users.login, { secret: "install-service-secret", githubId: 31, login: "alice", avatar: "" });
  holder.session = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(id).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET));
  const organizationId = await t.mutation(api.users.createOrganization, { token: holder.session, name: "Acme" });
  return { t, id, organizationId };
}
const location = (response: Response) => { const value = response.headers.get("location") ?? ""; return value.startsWith(base) ? value.slice(base.length) : value; };
const callbackUrl = (state: string, installationId = 501) => `${base}/api/github/callback?installation_id=${installationId}&setup_action=install&state=${state}`;
async function startInstall(organizationId: string) {
  holder.jar.set("openreview_github_setup", seal({ token: "user-token", githubUserId: 31 }));
  const started = await install(new Request(`${base}/api/github/install?organization=${organizationId}&returnTo=%2Fdashboard%2Fonboarding%2Fconnect`));
  expect(location(started)).toMatch(/^https:\/\/github\.com\/apps\/openreview-test\/installations\/new\?state=[a-f0-9]{64}$/);
  return String(unseal(holder.jar.get("openreview_install_state")).state);
}

test("an install that outlives the sign-in token resumes through one GitHub re-authorization and links", async () => {
  const { t, organizationId } = await setup(); github();
  const state = await startInstall(organizationId);
  // Twelve minutes on GitHub: the ten-minute sign-in token is gone, the 30-minute install state is not.
  holder.jar.delete("openreview_github_setup");
  const bounced = await callback(new Request(callbackUrl(state)));
  expect(location(bounced)).toBe(`/api/auth/login?purpose=github-install&next=${encodeURIComponent(`/api/github/callback?installation_id=501&setup_action=install&state=${state}`)}`);
  expect(unseal(holder.jar.get("openreview_install_state"))).toMatchObject({ state, resumed: true });
  expect(await t.run((ctx) => ctx.db.query("githubInstallations").collect())).toHaveLength(0);
  // The detour leaves a fresh token and returns to the same callback URL.
  holder.jar.set("openreview_github_setup", seal({ token: "fresh-token", githubUserId: 31 }));
  const done = await callback(new Request(callbackUrl(state)));
  expect(location(done)).toBe("/dashboard/onboarding/connect");
  expect(holder.jar.has("openreview_install_state")).toBe(false);
  const [installation] = await t.run((ctx) => ctx.db.query("githubInstallations").collect());
  expect(installation).toMatchObject({ installationId: 501, organizationId, account: "acme", accountType: "Organization", active: true, permissions: { contents: "read", checks: "write" } });
  const [repo] = await t.run((ctx) => ctx.db.query("repositories").collect());
  expect(repo).toMatchObject({ fullName: "acme/shop", defaultBranch: "master", installationId: 501, enabled: false });
  expect(repo.teamId).toBeDefined();
  expect(await t.run((ctx) => ctx.db.query("repositorySettings").collect())).toHaveLength(1);
  expect((await t.run((ctx) => ctx.db.query("auditEvents").collect())).map((e) => e.action)).toContain("github.installation_linked");
});

test("a second missing token ends with a message in the wizard, not a loop or a raw error", async () => {
  const { t, organizationId } = await setup(); github();
  const state = await startInstall(organizationId);
  holder.jar.delete("openreview_github_setup");
  await callback(new Request(callbackUrl(state)));
  const second = await callback(new Request(callbackUrl(state)));
  expect(second.status).toBe(307);
  expect(location(second)).toMatch(/^\/dashboard\/onboarding\/connect\?error=github-install&message=GitHub%20sign-in%20did%20not%20finish/);
  expect(await t.run((ctx) => ctx.db.query("githubInstallations").collect())).toHaveLength(0);
});

test("installs without state, from another user, for owner approval or without admin access never link and never return JSON", async () => {
  const { t, organizationId } = await setup(); github();
  // No install started in this browser (or the state expired): the recovery page takes over.
  const stateless = await callback(new Request(`${base}/api/github/callback?installation_id=501&setup_action=update`));
  expect(location(stateless)).toBe(`/dashboard/github-link?organization=${organizationId}&returnTo=%2Fdashboard%2Frepositories`);
  // State mismatch.
  const state = await startInstall(organizationId);
  const mismatch = await callback(new Request(callbackUrl("b".repeat(64))));
  expect(location(mismatch)).toMatch(/^\/dashboard\/onboarding\/connect\?error=github-install&message=Installation%20state%20mismatch/);
  // Another user's state.
  holder.jar.set("openreview_install_state", seal({ state, organizationId, userId: "someone-else", returnTo: "/dashboard/settings/providers" }));
  const other = await callback(new Request(callbackUrl(state)));
  expect(location(other)).toBe("/dashboard/settings/providers");
  expect(JSON.parse(decodeURIComponent(holder.jar.get("openreview_toast") ?? ""))).toMatchObject({ tone: "error", text: expect.stringMatching(/another session/) });
  // An organization owner must approve the install first.
  holder.jar.set("openreview_install_state", seal({ state, organizationId, userId: (await t.run((ctx) => ctx.db.query("users").first()))!._id, returnTo: "/dashboard/onboarding/connect" }));
  const request = await callback(new Request(`${base}/api/github/callback?setup_action=request&state=${state}`));
  expect(decodeURIComponent(location(request))).toMatch(/error=github-install&message=your request was sent to the organization’s owners/);
  // The installer is not an admin of every organization repository.
  installs[0].admin = false;
  const again = await startInstall(organizationId);
  const refused = await callback(new Request(callbackUrl(again)));
  expect(decodeURIComponent(location(refused))).toMatch(/requires GitHub repository admin access/);
  for (const response of [stateless, mismatch, other, request, refused]) expect(response.headers.get("content-type") ?? "").not.toMatch(/json/);
  expect(await t.run((ctx) => ctx.db.query("githubInstallations").collect())).toHaveLength(0);
});

test("non-admins and unconfigured servers are sent back with a message instead of JSON", async () => {
  const { t, organizationId } = await setup(); github();
  const member = await t.mutation(api.users.login, { secret: "install-service-secret", githubId: 32, login: "bob", avatar: "" });
  await t.run((ctx) => ctx.db.insert("organizationMembers", { organizationId, userId: member, role: "member" }));
  holder.session = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(member).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET));
  const refused = await install(new Request(`${base}/api/github/install?organization=${organizationId}&returnTo=%2Fdashboard%2Fonboarding%2Fconnect`));
  expect(decodeURIComponent(location(refused))).toMatch(/^\/dashboard\/onboarding\/connect\?error=github-install&message=Only workspace owners and admins/);
  // Signed out: sign-in returns to the install.
  holder.session = "";
  await expect(install(new Request(`${base}/api/github/install?organization=${organizationId}&returnTo=%2Fdashboard%2Frepositories`))).rejects.toMatchObject({ url: `/login?next=${encodeURIComponent(`/api/github/install?organization=${organizationId}&returnTo=%2Fdashboard%2Frepositories`)}` });
});

test("GitHub sending an install to the sign-in callback is handed to the install callback", async () => {
  const response = await authCallback(new Request(`${base}/api/auth/callback?code=abc&installation_id=501&setup_action=install&state=${"c".repeat(64)}`));
  expect(location(response)).toBe(`/api/github/callback?installation_id=501&setup_action=install&state=${"c".repeat(64)}`);
});

test("Link an existing installation uses the same verified path, and refuses installations of another workspace", async () => {
  const { t, organizationId } = await setup(); github();
  holder.jar.set("openreview_github_setup", seal({ token: "user-token", githubUserId: 31 }));
  const form = (installationId: number) => { const f = new FormData(); f.set("organizationId", organizationId); f.set("installationId", String(installationId)); f.set("returnTo", "/dashboard/onboarding/connect"); return f; };
  await expect(linkGithubInstallation(form(501))).rejects.toMatchObject({ url: "/dashboard/onboarding/connect" });
  expect(await t.run((ctx) => ctx.db.query("githubInstallations").collect())).toMatchObject([{ installationId: 501, organizationId }]);
  expect(await t.run((ctx) => ctx.db.query("repositories").collect())).toMatchObject([{ fullName: "acme/shop", defaultBranch: "master" }]);
  // Linking again refreshes: a repository added on GitHub appears, nothing is duplicated.
  installs[0].repositories.push({ id: 9002, full_name: "acme/api", default_branch: "main", owner: { login: "acme", id: 77, type: "Organization" } });
  await expect(linkGithubInstallation(form(501))).rejects.toMatchObject({ url: "/dashboard/onboarding/connect" });
  expect((await t.run((ctx) => ctx.db.query("repositories").collect())).map((r) => r.fullName).sort()).toEqual(["acme/api", "acme/shop"]);
  expect(await t.run((ctx) => ctx.db.query("githubInstallations").collect())).toHaveLength(1);
  // An installation this GitHub user cannot see is refused.
  await expect(linkGithubInstallation(form(999))).rejects.toMatchObject({ url: `/dashboard/github-link?organization=${organizationId}&returnTo=%2Fdashboard%2Fonboarding%2Fconnect` });
  expect(JSON.parse(decodeURIComponent(holder.jar.get("openreview_toast") ?? "")).text).toMatch(/not accessible/);
  // Another workspace cannot take it over.
  const rival = await t.mutation(api.users.login, { secret: "install-service-secret", githubId: 33, login: "mallory", avatar: "" });
  holder.session = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(rival).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET));
  const rivalOrg = await t.mutation(api.users.createOrganization, { token: holder.session, name: "Rival" });
  const f = form(501); f.set("organizationId", rivalOrg);
  await expect(linkGithubInstallation(f)).rejects.toMatchObject({ url: expect.stringMatching(/^\/dashboard\/github-link/) });
  expect(JSON.parse(decodeURIComponent(holder.jar.get("openreview_toast") ?? "")).text).toMatch(/already installed on acme for another OpenReview workspace/);
  expect(await t.query(api.repositories.installationOwnership, { token: holder.session, secret: process.env.SERVICE_SECRET!, organizationId: rivalOrg, installationIds: [501, 777] })).toEqual({ "501": "elsewhere", "777": "none" });
  // Without the web server's secret a workspace owner cannot probe installation ids directly.
  await expect(t.query(api.repositories.installationOwnership, { token: holder.session, secret: "guess", organizationId: rivalOrg, installationIds: [501] })).rejects.toThrow("Unauthorized");
  // Without a fresh GitHub token the action re-authorizes first.
  holder.jar.delete("openreview_github_setup");
  await expect(linkGithubInstallation(f)).rejects.toMatchObject({ url: expect.stringMatching(/^\/api\/auth\/login\?purpose=github-install&next=%2Fdashboard%2Fgithub-link/) });
});

test("installing on an account whose App already belongs to another workspace explains it in setup and links nothing", async () => {
  const { t, organizationId } = await setup(); github();
  // The App on acme is linked to the first workspace.
  const first = await startInstall(organizationId);
  await callback(new Request(callbackUrl(first)));
  // A second OpenReview account starts setup and picks the same GitHub account on GitHub.
  const second = await t.mutation(api.users.login, { secret: "install-service-secret", githubId: 34, login: "newcomer", avatar: "" });
  holder.session = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(second).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET));
  const newWorkspace = await t.mutation(api.users.createOrganization, { token: holder.session, name: "New" });
  const state = await startInstall(newWorkspace);
  const response = await callback(new Request(callbackUrl(state)));
  const target = new URL("https://x" + location(response));
  expect(target.pathname).toBe("/dashboard/onboarding/connect");
  expect(target.searchParams.get("message")).toMatch(/^OpenReview is already installed on acme for another OpenReview workspace/);
  expect((await t.run((ctx) => ctx.db.query("repositories").collect())).map((r) => r.organizationId)).toEqual([organizationId]);
});

