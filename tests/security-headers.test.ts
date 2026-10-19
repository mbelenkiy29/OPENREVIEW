import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import config from "../next.config";
import { securityHeaders } from "../src/security-headers";

test("every route sends nosniff, a referrer policy and refuses to be framed", async () => {
  const rules = await config.headers!();
  assert.deepEqual(rules, [{ source: "/:path*", headers: securityHeaders }]);
  assert.deepEqual(Object.fromEntries(securityHeaders.map((h) => [h.key, h.value])), {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "frame-ancestors 'none'",
  });
  // Framing protection only: a script policy would block Next.js inline scripts, Sentry and PostHog.
  assert.doesNotMatch(securityHeaders.map((h) => h.value).join(";"), /script-src|default-src/);
});

test("nothing that ships with OpenReview frames its pages", () => {
  // The Bitbucket Forge app talks to OpenReview through Forge Remote, never an iframe.
  const forge = readFileSync("forge/bitbucket/manifest.yml", "utf8");
  assert.match(forge, /remote: openreview/);
  const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === "node_modules" || e.name === "build" ? [] : sources(join(dir, e.name))) : /\.(m?[jt]sx?|html)$/.test(e.name) ? [join(dir, e.name)] : []);
  for (const file of [...sources("app"), ...sources("src"), ...sources("forge/bitbucket/static")]) assert.doesNotMatch(readFileSync(file, "utf8"), /<iframe/i, file);
});
