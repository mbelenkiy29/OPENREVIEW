import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import config from "../next.config";
import { config as middlewareConfig, middleware } from "../middleware";
import { contentSecurityPolicy, middlewareSkips, prefetchHeaders, securityHeaders } from "../src/security-headers";

const formTargets = "'self' https://checkout.stripe.com https://billing.stripe.com https://connect.stripe.com https://app.devin.ai https://github.com https://gitlab.com";
const fetchPolicy = [
  "style-src 'self' 'unsafe-inline' https://cdn.userjot.com https://fonts.googleapis.com",
  "img-src 'self' data: blob: https://media.userjot.com https://cdn.userjot.com https://alb.reddit.com https://avatars.githubusercontent.com https://*.googleusercontent.com https://gitlab.com https://secure.gravatar.com",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self' https://widget.userjot.com wss://widget.userjot.com https://bzrcdn.openai.com https://bzr.openai.com https://pixel-config.reddit.com https://alb.reddit.com",
  "frame-src https://challenges.cloudflare.com https://*.userjot.com",
  "media-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  `object-src 'none'; base-uri 'self'; form-action ${formTargets}; frame-ancestors 'none'`,
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
  assert.equal(policy, contentSecurityPolicy(nonce, true));
  // Next.js reads the nonce from the forwarded request headers; app/layout.tsx from x-nonce.
  assert.equal(response.headers.get("x-middleware-request-x-nonce"), nonce);
  assert.equal(response.headers.get("x-middleware-request-content-security-policy"), policy);
  assert.notEqual(nonce, /'nonce-([^']+)'/.exec(middleware(new NextRequest("https://openreview.tech/login")).headers.get("content-security-policy")!)?.[1]);

  assert.equal(contentSecurityPolicy("abc", false, false), `default-src 'self'; script-src 'self' 'nonce-abc' 'strict-dynamic'; ${fetchPolicy}`);
  assert.equal(contentSecurityPolicy("abc", false, true), `default-src 'self'; script-src 'self' 'nonce-abc' 'strict-dynamic' 'unsafe-eval'; ${fetchPolicy}`);
  // Inline styles are allowed (React style attributes); inline scripts and eval never are in production.
  assert.doesNotMatch(/script-src [^;]*/.exec(contentSecurityPolicy("abc", false, false))![0], /unsafe-inline|unsafe-eval/);
  // No directive falls back to "anything": every fetch directive is set, and none is a bare scheme or *.
  for (const directive of ["style-src", "img-src", "font-src", "connect-src", "frame-src", "media-src", "manifest-src", "worker-src"]) assert.match(staticPolicy, new RegExp(`(^|; )${directive} `), directive);
  assert.doesNotMatch(staticPolicy, /(\s|^)(https:|http:|\*)(\s|;|$)/);
  assert.equal(contentSecurityPolicy(), staticPolicy);
});

test("forms lead only to known hosts, except on pages with sign-in (any SSO IdP) and MCP OAuth consent (any redirect URI)", () => {
  const formAction = (path: string) => /form-action ([^;]*)/.exec(middleware(new NextRequest(`https://openreview.tech${path}`)).headers.get("content-security-policy")!)![1];
  const pages = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? pages(join(dir, e.name)) : e.name === "page.tsx" ? [dir] : []);
  const signIn = pages("app").filter((dir) => /<(SignInOptions|AuthScreen)\b/.test(readFileSync(join(dir, "page.tsx"), "utf8"))).map((dir) => dir.slice("app".length).replace(/\[[^\]]+\]/g, "ABCD2345"));
  assert.ok(signIn.includes("/login") && signIn.includes("/oauth/consent"), String(signIn));
  for (const page of signIn) assert.equal(formAction(page), `${formTargets} https: http://localhost:* http://127.0.0.1:*`, page);
  for (const page of ["/", "/dashboard", "/dashboard/organization/billing", "/dashboard/onboarding/plan", "/fix/abc", "/changelog", "/r", "/login/x", "/oauth/consent/x"]) assert.equal(formAction(page), formTargets, page);
});

test("profile pictures from GitHub, Google and GitLab sign-ins are allowed images", () => {
  // CSP host sources: an exact https origin, or https://*. for any subdomain of the rest.
  const sources = /img-src ([^;]*)/.exec(contentSecurityPolicy("abc"))![1].split(" ");
  const allowed = (url: string) => { const { protocol, host } = new URL(url); return protocol === "https:" && sources.some((s) => s === `https://${host}` || (s.startsWith("https://*.") && host.endsWith(s.slice("https://*".length)))); };
  for (const avatar of [
    "https://avatars.githubusercontent.com/u/1?v=4",
    "https://lh3.googleusercontent.com/a/ACg8ocJ=s96-c",
    "https://lh6.googleusercontent.com/a/ACg8ocJ=s96-c",
    "https://gitlab.com/uploads/-/system/user/avatar/1/avatar.png",
    "https://secure.gravatar.com/avatar/0bc83cb571cd1c50ba6f3e8a78ef1346?s=80&d=identicon",
  ]) assert.ok(allowed(avatar), avatar);
  assert.ok(!allowed("https://example.com/avatar.png"));
});

test("nothing that ships with OpenReview frames its pages", () => {
  // The Bitbucket Forge app talks to OpenReview through Forge Remote, never an iframe.
  const forge = readFileSync("forge/bitbucket/manifest.yml", "utf8");
  assert.match(forge, /remote: openreview/);
  const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === "node_modules" || e.name === "build" ? [] : sources(join(dir, e.name))) : /\.(m?[jt]sx?|html)$/.test(e.name) ? [join(dir, e.name)] : []);
  for (const file of [...sources("app"), ...sources("src"), ...sources("forge/bitbucket/static")]) assert.doesNotMatch(readFileSync(file, "utf8"), /<iframe/i, file);
});
