import test from "node:test";
import assert from "node:assert/strict";

// The pixel ID is read when the module loads, so it is set before the import.
process.env.NEXT_PUBLIC_REDDIT_PIXEL_ID = "a2_test";
const scripts: { src?: string; async?: boolean }[] = [];
const browser = globalThis as unknown as { window: Window; document: unknown };
browser.window = {} as Window;
browser.document = { createElement: () => ({}), head: { append: (script: { src?: string; async?: boolean }) => scripts.push(script) } };
const { measureRedditSignup, redditPageVisit, startRedditPixel, stopRedditPixel } = await import("../src/reddit-pixel");

const sent: unknown[][] = [];
const queued = () => (browser.window.rdt?.callQueue ?? []).map((args) => [...args]);

test("starting loads pixel.js once and queues init and the first PageVisit until it arrives", () => {
  startRedditPixel();
  assert.deepEqual(scripts, [{ async: true, src: "https://www.redditstatic.com/ads/pixel.js" }]);
  assert.deepEqual(queued(), [["init", "a2_test"], ["track", "PageVisit"]]);
  // pixel.js has loaded: calls go straight to it.
  browser.window.rdt!.sendEvent = (...args: unknown[]) => { sent.push(args); };
  redditPageVisit();
  assert.deepEqual(sent, [["track", "PageVisit"]]);
  assert.equal(queued().length, 2);
});

test("a sign-up converts once, only while its milestone is pending and less than a day old", () => {
  const now = Date.UTC(2026, 9, 22), hour = 3_600_000;
  sent.length = 0;
  assert.equal(measureRedditSignup([{ key: "signed_up", at: now - hour }], "u1", now), true);
  assert.deepEqual(sent, [["track", "SignUp", { conversionId: "signed_up:u1" }]]);
  assert.equal(measureRedditSignup([{ key: "workspace_created:w1", at: now }], "u1", now), false, "already reported: a sign-in");
  assert.equal(measureRedditSignup([{ key: "signed_up", at: now - 25 * hour }], "u1", now), false, "an older account");
  assert.equal(sent.length, 1);
});

test("after a refusal nothing is sent until the visitor accepts again, without a second install", () => {
  sent.length = 0;
  stopRedditPixel();
  redditPageVisit();
  assert.equal(measureRedditSignup([{ key: "signed_up", at: Date.now() }], "u1"), false);
  assert.deepEqual(sent, []);
  startRedditPixel();
  assert.deepEqual(sent, [["track", "PageVisit"]]);
  assert.equal(scripts.length, 1);
  assert.deepEqual(queued(), [["init", "a2_test"], ["track", "PageVisit"]]);
});

test("without the pixel nothing is sent and nothing throws", () => {
  const pixel = browser.window.rdt;
  browser.window.rdt = undefined;
  assert.equal(measureRedditSignup([{ key: "signed_up", at: Date.now() }], "u1"), false);
  redditPageVisit();
  browser.window.rdt = pixel;
});
