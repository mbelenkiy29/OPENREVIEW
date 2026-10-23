import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { GithubApiError } from "../src/github";

// Sign-in failures that every visitor would hit (a broken Resend key, Convex down, a provider
// rejecting the code exchange) reach Sentry as one issue each; failures the visitor caused (an
// expired visit, a cancel at the provider, a reused link, linking someone else's account) do not.
// The backend is faked: each test sets what its calls return or throw.
const holder = vi.hoisted(() => ({ jar: new Map<string, string>(), reported: [] as { message: string; fingerprint?: string[]; tag?: string }[], backend: {} as Record<"query" | "mutation" | "action", (ref: unknown, args: unknown) => Promise<unknown>> }));
vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({
  captureException: (error: unknown, hint?: { fingerprint?: string[]; tags?: Record<string, string> }) => { holder.reported.push({ message: error instanceof Error ? error.message : String(error), fingerprint: hint?.fingerprint, tag: hint?.tags?.auth_failure }); },
  captureMessage: () => {},
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => holder.jar.has(name) ? { value: holder.jar.get(name) } : undefined, set: (name: string, value: string) => { holder.jar.set(name, value); }, delete: (name: string) => { holder.jar.delete(name); } }), headers: async () => new Headers({ "user-agent": "vitest" }) }));
vi.mock("../src/server", () => ({
  backend: () => holder.backend,
  seal: async (data: unknown) => Buffer.from(JSON.stringify(data)).toString("base64url"),
  unseal: async (token: string) => JSON.parse(Buffer.from(token, "base64url").toString()),
  signSession: async () => "session-jwt",
  cookieOptions: { httpOnly: true, secure: false, sameSite: "lax", path: "/" },
  origin: () => "https://review.example.com",
}));
import { beginOAuth, finishOAuth } from "../src/oauth-flow";
import { POST as requestLink } from "../app/api/auth/email/route";
import { POST as confirmLink } from "../app/api/auth/email/verify/route";

const base = "https://review.example.com";
const fail = (message: string) => async () => { throw new Error(message); };
beforeEach(() => {
  process.env.SERVICE_SECRET = "sentry-service";
  holder.jar.clear(); holder.reported = [];
  holder.backend = { query: async () => false, mutation: async () => "user-1", action: async () => ({ status: "sent", nearCap: false }) };
  vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); delete process.env.SERVICE_SECRET; });

const askForLink = async () => {
  const form = new FormData();
  form.set("email", "someone@example.com");
  return new URL((await requestLink(new Request(`${base}/api/auth/email`, { method: "POST", headers: { origin: base }, body: form }))).headers.get("location")!).searchParams.get("email");
};
const useLink = async () => (await confirmLink(new Request(`${base}/api/auth/email/verify`, { method: "POST", headers: { origin: base }, body: new URLSearchParams({ token: "t".repeat(43) }) }))).headers.get("location");
const begin = async (query = "") => { let state = ""; await beginOAuth(new Request(`${base}/api/auth/login?${query}`), "github", (s) => { state = s; return "https://github.com/login/oauth/authorize"; }); return state; };
const finish = (callbackQuery: string, profile = async () => ({ providerUserId: "7", login: "octo", avatar: "", emailVerified: false })) =>
  finishOAuth(new Request(`${base}/api/auth/callback?${callbackQuery}`), "github", profile);

test("a sign-in email that cannot be sent is reported once per cause, never a limit or a sent link", async () => {
  expect(await askForLink()).toBe("sent");
  holder.backend.action = async () => ({ status: "limited" });
  expect(await askForLink()).toBe("busy");
  expect(holder.reported).toEqual([]);
  holder.backend.action = fail("Email provider returned HTTP 403");
  expect(await askForLink()).toBe("error");
  expect(holder.reported).toEqual([{ message: "Email provider returned HTTP 403", fingerprint: ["auth-email-send-failed"], tag: "email-send" }]);
});

test("using a sign-in link reports Convex failing, not an expired or used link", async () => {
  holder.backend.mutation = async () => null;
  expect(await useLink()).toBe(`${base}/login?error=link`);
  expect(holder.reported).toEqual([]);
  holder.backend.mutation = fail("Server Error");
  expect(await useLink()).toBe(`${base}/login?error=link`);
  expect(holder.reported).toEqual([{ message: "Server Error", fingerprint: ["auth-email-link-failed"], tag: "email-link" }]);
});

test("OAuth: expired visits, replays and cancels at the provider are not reported", async () => {
  await finish("code=c1&state=whatever");
  const state = await begin();
  await finish(`code=c1&state=${state}x`);
  await begin();
  await finish("error=access_denied");
  expect(holder.reported).toEqual([]);
});

test("OAuth: a failing code exchange or account step is reported per provider and step", async () => {
  await finish(`code=c1&state=${await begin()}`, fail("GitHub OAuth exchange failed"));
  holder.backend.mutation = fail("Server Error");
  await finish(`code=c1&state=${await begin()}`);
  expect(holder.reported).toEqual([
    { message: "GitHub OAuth exchange failed", fingerprint: ["auth-oauth-failed", "github", "provider"], tag: "oauth" },
    { message: "Server Error", fingerprint: ["auth-oauth-failed", "github", "account"], tag: "oauth" },
  ]);
});

test("OAuth: linking an account that belongs to someone else tells the visitor and is not reported; Convex failing while linking is", async () => {
  holder.jar.set("openreview_session", "session-jwt");
  holder.backend.mutation = async () => { throw new ConvexError("This account is already linked to another OpenReview user"); };
  const response = await finish(`code=c1&state=${await begin("link=1&next=/settings")}`);
  expect(response.headers.get("location")).toBe(`${base}/settings`);
  expect(holder.reported).toEqual([]);
  holder.backend.mutation = fail("Server Error");
  await finish(`code=c1&state=${await begin("link=1&next=/settings")}`);
  expect(holder.reported).toEqual([{ message: "Server Error", fingerprint: ["auth-oauth-failed", "github", "account"], tag: "oauth" }]);
});

test("OAuth: a provider refusing for its own rate limit is reported, since nobody can sign in meanwhile", async () => {
  await finish(`code=c1&state=${await begin()}`, async () => { throw new GithubApiError("GitHub rate limit", 429); });
  expect(holder.reported).toEqual([{ message: "GitHub rate limit", fingerprint: ["auth-oauth-failed", "github", "provider"], tag: "oauth" }]);
});
