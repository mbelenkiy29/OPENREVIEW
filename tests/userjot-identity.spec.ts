import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT, decodeJwt } from "jose";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// The identity route runs for real; its Convex client is backed by convex-test and its cookies by a map.
const holder = vi.hoisted(() => ({ t: undefined as unknown, jar: new Map<string, string>() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => holder.jar.has(name) ? { value: holder.jar.get(name) } : undefined }) }));
vi.mock("../src/server", () => ({
  backend: () => { const t = holder.t as { query: (r: unknown, a: unknown) => Promise<unknown> }; return { query: (r: unknown, a: unknown) => t.query(r, a) }; },
}));
import { GET } from "../app/api/userjot/identity/route";

const sessionSecret = "userjot-session-secret-at-least-32-characters";
const modules = import.meta.glob("../convex/**/*.ts");
const env = { NEXT_PUBLIC_USERJOT_PROJECT_ID: "proj", USERJOT_PROJECT_SECRET: "userjot-project-secret", OPENREVIEW_OFFLINE: undefined };
const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
const setEnv = (values: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(values)) if (v === undefined) delete process.env[k]; else process.env[k] = v; };
beforeEach(() => { process.env.SESSION_SECRET = sessionSecret; process.env.SERVICE_SECRET = "userjot-service-secret"; setEnv(env); holder.jar.clear(); });
afterEach(() => setEnv(saved));

async function signedIn() {
  const t = convexTest(schema, modules); holder.t = t;
  const id = await t.mutation(api.users.login, { secret: "userjot-service-secret", githubId: 71, login: "ada", avatar: "https://avatars.example/ada.png" });
  await t.run(async (ctx) => {
    await ctx.db.insert("identities", { userId: id, provider: "google", providerUserId: "g-unverified", email: "old@example.com", emailVerified: false, createdAt: 0, lastLoginAt: 0 });
    await ctx.db.insert("identities", { userId: id, provider: "email", providerUserId: "ada@example.com", email: "ada@example.com", emailVerified: true, createdAt: 1, lastLoginAt: 1 });
  });
  holder.jar.set("openreview_session", await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setSubject(id).setExpirationTime("1h").sign(new TextEncoder().encode(sessionSecret)));
  return id;
}

test("is not found when UserJot is unconfigured or the install is offline", async () => {
  await signedIn();
  setEnv({ NEXT_PUBLIC_USERJOT_PROJECT_ID: undefined });
  expect((await GET()).status).toBe(404);
  setEnv({ NEXT_PUBLIC_USERJOT_PROJECT_ID: "proj", OPENREVIEW_OFFLINE: "true" });
  expect((await GET()).status).toBe(404);
});

test("anonymous and invalid sessions get an empty, uncached answer", async () => {
  holder.t = convexTest(schema, modules);
  const anonymous = await GET();
  expect(anonymous.status).toBe(204);
  expect(anonymous.headers.get("cache-control")).toBe("no-store");
  holder.jar.set("openreview_session", "not-a-session");
  expect((await GET()).status).toBe(204);
});

test("a signed-in user gets a signed identity with their verified email", async () => {
  const id = await signedIn();
  const response = await GET();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json() as { token: string; user: object };
  expect(body.user).toEqual({ id, firstName: "ada", email: "ada@example.com", avatar: "https://avatars.example/ada.png" });
  expect(decodeJwt(body.token)).toMatchObject({ sub: id, iss: "proj", aud: "userjot", email: "ada@example.com" });
  setEnv({ USERJOT_PROJECT_SECRET: undefined });
  expect(await (await GET()).json()).toEqual({ user: body.user });
});
