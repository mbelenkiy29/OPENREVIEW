import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import config from "../next.config";
import { config as middlewareConfig, middleware } from "../middleware";
import { contentSecurityPolicy, middlewareSkips, prefetchHeaders, securityHeaders } from "../src/security-headers";

const fetchPolicy = [
  "style-src 'self' 'unsafe-inline' https://cdn.userjot.com https://fonts.googleapis.com",
  "img-src 'self' data: blob: https://media.userjot.com https://cdn.userjot.com https://alb.reddit.com",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self' https://widget.userjot.com wss://widget.userjot.com https://bzrcdn.openai.com https://bzr.openai.com https://pixel-config.reddit.com https://alb.reddit.com",
  "frame-src https://challenges.cloudflare.com https://*.userjot.com",
  "media-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'; base-uri 'self'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
].join("; ");
const staticPolicy = `default-src 'self'; ${fetchPolicy}`;

test("every route sends nosniff, a referrer policy and refuses to be framed", async () => {
  const csp = [{ key: "Content-Security-Policy", value: staticPolicy }];
  assert.deepEqual(await config.headers!(), [
    { source: "/:path*", headers: securityHeaders },
    { source: `/(${middlewareSkips})(.*)`, headers: csp },
    { source: "/:path*", has: [prefetchHeaders[0]], headers: csp },
    { source: "/:path*", has: [prefetchHeaders[1]], headers: csp },
  ]);
  assert.deepEqual(Object.fromEntries(securityHeaders.map((h) => [h.key, h.value])), {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  });
});

test("pages get a nonce script policy from middleware; everything it skips gets the static one", async () => {
  // The middleware matcher must be a literal; it mirrors the paths and prefetches next.config.ts covers.
  assert.deepEqual(middlewareConfig.matcher, [{ source: `/((?!${middlewareSkips}).*)`, missing: prefetchHeaders }]);
  const runs = (url: string, headers = {}) => unstable_doesMiddlewareMatch({ config: middlewareConfig, url, headers });
  for (const page of ["/", "/login", "/dashboard", "/docs/quickstart", "/oauth/consent"]) assert.ok(runs(page), page);
  for (const skipped of ["/api/health", "/_next/static/chunks/main.js", "/_next/image", "/favicon.ico", "/lantern/e/", "/lighthouse"]) assert.ok(!runs(skipped), skipped);
  assert.ok(!runs("/dashboard", { "next-router-prefetch": "1" }));
  assert.ok(!runs("/dashboard", { purpose: "prefetch" }));

  const response = middleware(new NextRequest("https://openreview.tech/login"));
  const policy = response.headers.get("content-security-policy")!;
  const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(policy)?.[1];
  assert.ok(nonce && nonce.length >= 32, policy);
  assert.equal(policy, contentSecurityPolicy(nonce));
  // Next.js reads the nonce from the forwarded request headers; app/layout.tsx from x-nonce.
  assert.equal(response.headers.get("x-middleware-request-x-nonce"), nonce);
  assert.equal(response.headers.get("x-middleware-request-content-security-policy"), policy);
  assert.notEqual(nonce, /'nonce-([^']+)'/.exec(middleware(new NextRequest("https://openreview.tech/login")).headers.get("content-security-policy")!)?.[1]);

  assert.equal(contentSecurityPolicy("abc", false), `default-src 'self'; script-src 'self' 'nonce-abc' 'strict-dynamic'; ${fetchPolicy}`);
  assert.equal(contentSecurityPolicy("abc", true), `default-src 'self'; script-src 'self' 'nonce-abc' 'strict-dynamic' 'unsafe-eval'; ${fetchPolicy}`);
  // Inline styles are allowed (React style attributes); inline scripts and eval never are in production.
  assert.doesNotMatch(/script-src [^;]*/.exec(contentSecurityPolicy("abc", false))![0], /unsafe-inline|unsafe-eval/);
  // No directive falls back to "anything": every fetch directive is set, and none is a bare scheme or *.
  for (const directive of ["style-src", "img-src", "font-src", "connect-src", "frame-src", "media-src", "manifest-src", "worker-src"]) assert.match(staticPolicy, new RegExp(`(^|; )${directive} `), directive);
  assert.doesNotMatch(staticPolicy.replace(/form-action [^;]*/, ""), /(\s|^)(https:|http:|\*)(\s|;|$)/);
  assert.equal(contentSecurityPolicy(), staticPolicy);
});

test("nothing that ships with OpenReview frames its pages", () => {
  // The Bitbucket Forge app talks to OpenReview through Forge Remote, never an iframe.
  const forge = readFileSync("forge/bitbucket/manifest.yml", "utf8");
  assert.match(forge, /remote: openreview/);
  const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === "node_modules" || e.name === "build" ? [] : sources(join(dir, e.name))) : /\.(m?[jt]sx?|html)$/.test(e.name) ? [join(dir, e.name)] : []);
  for (const file of [...sources("app"), ...sources("src"), ...sources("forge/bitbucket/static")]) assert.doesNotMatch(readFileSync(file, "utf8"), /<iframe/i, file);
});
