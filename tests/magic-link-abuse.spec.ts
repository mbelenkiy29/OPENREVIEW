import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { limitKey } from "../src/limit-key";
import { canonicalEmail } from "../src/email";

// Sign-in emails under attack: the web route's checks (Origin, Turnstile, the trusted client IP) and
// the limits in convex/identity.ts, run against convex-test. Turnstile's siteverify and Resend are
// faked through fetch.
const holder = vi.hoisted(() => ({ t: undefined as unknown, sentry: [] as string[] }));
vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureMessage: (message: string) => { holder.sentry.push(message); } }));
vi.mock("../src/server", () => ({
  backend: () => { type Call = (ref: unknown, args: unknown) => Promise<unknown>; const t = holder.t as { query: Call; mutation: Call; action: Call }; return { query: (r: unknown, a: unknown) => t.query(r, a), mutation: (r: unknown, a: unknown) => t.mutation(r, a), action: (r: unknown, a: unknown) => t.action(r, a) }; },
  origin: () => "https://review.example.com",
}));
import { POST as requestLink } from "../app/api/auth/email/route";

const modules = import.meta.glob("../convex/**/*.ts");
const base = "https://review.example.com", svc = "abuse-service";
const env = { SESSION_SECRET: "abuse-session-secret-at-least-32-characters", SERVICE_SECRET: svc, APP_URL: base, RESEND_API_KEY: "re_test", EMAIL_FROM: "OpenReview <login@example.com>", CLIENT_IP_SOURCE: "header:x-real-ip" };
const turnstile = { TURNSTILE_SITE_KEY: "0x4AAA-site", TURNSTILE_SECRET_KEY: "0x4AAA-secret" };
let mails: string[], verified: string[], siteverify: () => Response;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.UTC(2026, 9, 23, 12));
  Object.assign(process.env, env);
  holder.t = convexTest(schema, modules); holder.sentry = []; mails = []; verified = [];
  siteverify = () => Response.json({ success: true, action: "magic_link", hostname: "review.example.com" });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("siteverify")) { verified.push(String((init?.body as URLSearchParams).get("response"))); return siteverify(); }
    const mail = JSON.parse(String(init?.body)) as { to: string[]; subject: string };
    if (mail.subject === "Your OpenReview sign-in link") mails.push(mail.to[0]);
    return Response.json({ id: `email_${mails.length}` });
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const key of [...Object.keys(env), ...Object.keys(turnstile), "TURNSTILE_MODE", "AUTH_EMAIL_HOURLY"]) delete process.env[key]; });

async function post(email: string, o: { token?: string; origin?: string | null; ip?: string } = {}) {
  const form = new FormData(), headers = new Headers();
  form.set("email", email);
  if (o.token) form.set("cf-turnstile-response", o.token);
  if (o.origin !== null) headers.set("origin", o.origin ?? base);
  if (o.ip) headers.set("x-real-ip", o.ip);
  const location = (await requestLink(new Request(`${base}/api/auth/email`, { method: "POST", headers, body: form }))).headers.get("location");
  return new URL(location!).searchParams.get("email");
}
const t = () => holder.t as ReturnType<typeof convexTest>;
const tokens = () => t().run((ctx) => ctx.db.query("loginTokens").collect());

test("another site's form and a missing bot-check token never reach Convex or Resend", async () => {
  Object.assign(process.env, turnstile);
  expect(await post("a@example.com", { origin: null, token: "tok" })).toBe("error");
  expect(await post("a@example.com", { origin: "https://evil.example", token: "tok" })).toBe("error");
  expect(await post("a@example.com")).toBe("challenge");
  expect(verified, "no token means no siteverify call").toEqual([]);
  expect([mails, await tokens()]).toEqual([[], []]);
  expect(await post("a@example.com", { token: "tok" })).toBe("sent");
  expect([verified, mails]).toEqual([["tok"], ["a@example.com"]]);
});

test("a replayed or failed token is refused, while a Cloudflare outage falls through to the limits", async () => {
  Object.assign(process.env, turnstile);
  siteverify = () => Response.json({ success: false, "error-codes": ["timeout-or-duplicate"] });
  expect(await post("a@example.com", { token: "used" })).toBe("challenge");
  siteverify = () => new Response("unavailable", { status: 503 });
  expect(await post("a@example.com", { token: "tok" })).toBe("sent");
  expect(mails).toEqual(["a@example.com"]);
  process.env.TURNSTILE_MODE = "monitor";
  siteverify = () => Response.json({ success: false, "error-codes": ["invalid-input-response"] });
  expect(await post("b@example.com"), "monitor mode only logs").toBe("sent");
});

test("one mailbox gets one email a minute and three per 15 minutes, its Gmail variants included", async () => {
  expect(await post("j.doe@gmail.com")).toBe("sent");
  expect(await post("j.doe@gmail.com"), "a second click within the minute says sent but sends nothing").toBe("sent");
  expect(mails).toHaveLength(1);
  vi.advanceTimersByTime(61_000);
  expect(await post("jdoe+promo@gmail.com")).toBe("sent");
  vi.advanceTimersByTime(61_000);
  expect(await post("JDoe@googlemail.com")).toBe("sent");
  vi.advanceTimersByTime(61_000);
  expect(await post("j.d.o.e@gmail.com")).toBe("busy");
  expect(mails, "each email still goes to the address as typed").toEqual(["j.doe@gmail.com", "jdoe+promo@gmail.com", "jdoe@googlemail.com"]);
  vi.advanceTimersByTime(15 * 60_000);
  expect(await post("j.doe@gmail.com")).toBe("sent");
});

test("one network gets ten sign-in emails per 10 minutes; others are unaffected, and an untrusted address is ignored", async () => {
  for (let i = 0; i < 10; i++) expect(await post(`user${i}@example.com`, { ip: "203.0.113.9" })).toBe("sent");
  expect(await post("user10@example.com", { ip: "203.0.113.9" })).toBe("busy");
  expect(await post("user10@example.com", { ip: "198.51.100.1" })).toBe("sent");
  delete process.env.CLIENT_IP_SOURCE;
  expect(await post("user11@example.com", { ip: "203.0.113.9" }), "without a trusted source the header is not believed").toBe("sent");
});

test("the deployment-wide cap refuses everyone alike, warns at half, and a refusal rolls back the other counters", async () => {
  process.env.AUTH_EMAIL_HOURLY = "2";
  // An existing account and a new address get the same answers and the same emails.
  const existing = await t().mutation(api.identity.signIn, { secret: svc, provider: "google", providerUserId: "g-1", login: "old", avatar: "", email: "old@example.com", emailVerified: true, sessionHash: "a".repeat(64) });
  expect(existing).toBeTruthy();
  expect([await post("old@example.com"), await post("new@example.com"), await post("third@example.com")]).toEqual(["sent", "sent", "busy"]);
  expect(mails).toEqual(["old@example.com", "new@example.com"]);
  expect(holder.sentry).toHaveLength(2);
  const third = `magic-link:to:${await limitKey(canonicalEmail("third@example.com"), svc)}:1m`;
  expect((await t().run((ctx) => ctx.db.query("rateLimits").collect())).map((r) => r.key), "the refused request's mailbox counter was rolled back").not.toContain(third);
});

test("limits are stored and logged by keyed hash only, and links carry the request id and Resend id", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  expect(await post("Private.Person@example.com", { ip: "203.0.113.9" })).toBe("sent");
  const lines = log.mock.calls.map(([line]) => String(line)), route = JSON.parse(lines.find((l) => l.includes('"auth.magic_link"'))!);
  expect(route).toMatchObject({ decision: "sent", domain: "example.com" });
  expect(lines.join("\n")).not.toMatch(/private\.person|203\.0\.113\.9|token=/i);
  expect((await t().run((ctx) => ctx.db.query("rateLimits").collect())).map((r) => r.key).join(" ")).not.toMatch(/@|203\.0/);
  const [link] = await tokens();
  expect(link).toMatchObject({ requestId: route.rid, resendId: "email_1" });
});

test("the Convex side still requires the service secret", async () => {
  await expect(t().action(api.identityJobs.requestMagicLink, { secret: "wrong", email: "a@example.com" })).rejects.toThrow();
  await expect(t().mutation(api.identity.consumeLoginToken, { secret: "wrong", tokenHash: "a".repeat(64), sessionHash: "b".repeat(64) })).rejects.toThrow();
  await expect(t().mutation(internal.identity.storeLoginToken, { email: "a@example.com", tokenHash: "a".repeat(64), ipHash: "not-a-hash" })).rejects.toThrow();
});
