import test from "node:test";
import assert from "node:assert/strict";
import { checkTurnstile, turnstileConfig, verifyTurnstile } from "../src/turnstile";

const keys = { TURNSTILE_SITE_KEY: "0x4AAA-site", TURNSTILE_SECRET_KEY: "0x4AAA-secret" };
type Call = { url: string; body: URLSearchParams };
function siteverify(reply: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), body: init?.body as URLSearchParams }); return reply(); }) as typeof fetch;
  return { calls, fetchImpl };
}
const ok = (body: object) => () => Response.json(body);
const check = (token: unknown, fetchImpl: typeof fetch, secret = keys.TURNSTILE_SECRET_KEY) => verifyTurnstile(token, { secret, action: "magic_link", hostname: "openreview.tech", ip: "203.0.113.9", fetchImpl });

test("the bot check is off without both keys or offline, enforced by default, and monitor never blocks", () => {
  assert.equal(turnstileConfig({}).mode, "off");
  assert.equal(turnstileConfig({ TURNSTILE_SITE_KEY: "s" }).mode, "off", "a site key alone cannot be checked");
  assert.equal(turnstileConfig(keys).mode, "enforce");
  assert.equal(turnstileConfig({ ...keys, TURNSTILE_MODE: "monitor" }).mode, "monitor");
  assert.equal(turnstileConfig({ ...keys, TURNSTILE_MODE: "off" }).mode, "off", "the kill switch");
  assert.equal(turnstileConfig({ ...keys, OPENREVIEW_OFFLINE: "true" }).mode, "off", "offline installs cannot reach Cloudflare");
});

test("a token passes only when Cloudflare accepts it for this site and this form", async () => {
  const pass = siteverify(ok({ success: true, action: "magic_link", hostname: "openreview.tech" }));
  assert.deepEqual(await check("tok", pass.fetchImpl), { outcome: "pass", codes: [] });
  assert.equal(pass.calls[0].url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  assert.deepEqual(Object.fromEntries(pass.calls[0].body), { secret: keys.TURNSTILE_SECRET_KEY, response: "tok", remoteip: "203.0.113.9" });
  assert.deepEqual(await check("tok", siteverify(ok({ success: true, action: "changelog", hostname: "openreview.tech" })).fetchImpl), { outcome: "fail", codes: ["action-mismatch"] }, "a token solved for another form");
  assert.deepEqual(await check("tok", siteverify(ok({ success: true, action: "magic_link", hostname: "evil.example" })).fetchImpl), { outcome: "fail", codes: ["hostname-mismatch"] }, "a token solved on another site");
  assert.deepEqual(await check("tok", siteverify(ok({ success: false, "error-codes": ["invalid-input-response"] })).fetchImpl), { outcome: "fail", codes: ["invalid-input-response"] });
});

test("expired and replayed tokens fail; a missing or oversized token fails without calling Cloudflare", async () => {
  assert.deepEqual(await check("used", siteverify(ok({ success: false, "error-codes": ["timeout-or-duplicate"] })).fetchImpl), { outcome: "fail", codes: ["timeout-or-duplicate"] });
  const none = siteverify(ok({ success: true }));
  for (const token of [undefined, "", 42, "x".repeat(2049)]) assert.equal((await check(token, none.fetchImpl)).outcome, "fail");
  assert.equal(none.calls.length, 0);
});

test("Cloudflare being unreachable or erroring is 'unavailable', which callers let through to the rate limits", async () => {
  assert.equal((await check("tok", siteverify(() => { throw new TypeError("fetch failed"); }).fetchImpl)).outcome, "unavailable");
  assert.equal((await check("tok", siteverify(() => new Response("bad gateway", { status: 502 })).fetchImpl)).outcome, "unavailable");
  assert.equal((await check("tok", siteverify(() => new Response("<html>", { status: 200 })).fetchImpl)).outcome, "unavailable");
  assert.equal((await check("tok", siteverify(ok({ success: false, "error-codes": ["internal-error"] })).fetchImpl)).outcome, "unavailable");
});

test("Cloudflare's test secrets pass dummy tokens without a hostname or action", async () => {
  assert.equal((await check("XXXX.DUMMY.TOKEN.XXXX", siteverify(ok({ success: true })).fetchImpl, "1x0000000000000000000000000000000AA")).outcome, "pass");
  assert.equal((await check("XXXX.DUMMY.TOKEN.XXXX", siteverify(ok({ success: false, "error-codes": ["timeout-or-duplicate"] })).fetchImpl, "3x0000000000000000000000000000000AA")).outcome, "fail");
});

test("the form check blocks only a failed token in enforce mode", async () => {
  const form = new FormData(), fail = siteverify(ok({ success: false, "error-codes": ["invalid-input-response"] }));
  form.set("cf-turnstile-response", "tok");
  const o = (env: Record<string, string>) => ({ hostname: "openreview.tech", env, fetchImpl: fail.fetchImpl });
  assert.equal((await checkTurnstile(form, "magic_link", o(keys))).allowed, false);
  assert.equal((await checkTurnstile(new FormData(), "magic_link", o(keys))).allowed, false, "no token at all");
  assert.equal((await checkTurnstile(form, "magic_link", o({ ...keys, TURNSTILE_MODE: "monitor" }))).allowed, true);
  const off = await checkTurnstile(null, "magic_link", o({}));
  assert.deepEqual([off.allowed, off.result], [true, null]);
  const down = await checkTurnstile(form, "magic_link", { hostname: "openreview.tech", env: keys, fetchImpl: siteverify(() => new Response("", { status: 503 })).fetchImpl });
  assert.deepEqual([down.allowed, down.result?.outcome], [true, "unavailable"]);
});
