import test from "node:test";
import assert from "node:assert/strict";
import { adsPageViewed, measureSignup } from "../src/ads-pixel";

const calls: unknown[][] = [];
const browser = globalThis as unknown as { window: Window };
browser.window = { oaiq: (...args: unknown[]) => { calls.push(args); } } as Window;

test("a sign-up converts once, only while its milestone is pending and less than a day old", () => {
  const now = Date.UTC(2026, 9, 21), hour = 3_600_000;
  calls.length = 0;
  assert.equal(measureSignup([{ key: "signed_up", at: now - hour }], "u1", now), true);
  assert.deepEqual(calls, [["measure", "registration_completed", { type: "customer_action" }, { event_id: "signed_up:u1" }]]);
  assert.equal(measureSignup([{ key: "workspace_created:w1", at: now }], "u1", now), false, "already reported: a sign-in");
  assert.equal(measureSignup([{ key: "signed_up", at: now - 25 * hour }], "u1", now), false, "an older account");
  assert.equal(calls.length, 1);
});

test("without the pixel nothing is sent and nothing throws", () => {
  const pixel = browser.window.oaiq;
  browser.window.oaiq = undefined;
  assert.equal(measureSignup([{ key: "signed_up", at: Date.now() }], "u1"), false);
  adsPageViewed("/");
  browser.window.oaiq = pixel;
});

test("page views name only the first path segment", () => {
  calls.length = 0;
  adsPageViewed("/invite/secret-token");
  adsPageViewed("/");
  assert.deepEqual(calls.map((c) => (c[2] as { contents: { id: string }[] }).contents[0].id), ["/invite", "/"]);
});
