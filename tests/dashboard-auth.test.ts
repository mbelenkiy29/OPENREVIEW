import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config as middlewareConfig, middleware } from "../middleware";
import { dashboardRoute, loginFor, sessionCookie, sessionJwtValid } from "../src/session-token";

const secret = "dashboard-auth-session-secret-at-least-32-chars";

const sign = (opts?: { expired?: boolean; secret?: string; issuer?: string }) => {
  const jwt = new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("user_fixture")
    .setIssuer(opts?.issuer ?? "openreview")
    .setAudience("openreview");
  if (opts?.expired) jwt.setIssuedAt(Math.floor(Date.now() / 1000) - 120).setExpirationTime(Math.floor(Date.now() / 1000) - 60);
  else jwt.setIssuedAt().setExpirationTime("1h");
  return jwt.sign(new TextEncoder().encode(opts?.secret ?? secret));
};

const request = (path: string, token?: string) =>
  new NextRequest(`https://openreview.tech${path}`, token ? { headers: { cookie: `${sessionCookie}=${token}` } } : undefined);

const toLogin = (response: Response, next: string) => {
  assert.ok([302, 307].includes(response.status), String(response.status));
  const location = new URL(response.headers.get("location") ?? "", "https://openreview.tech");
  assert.equal(location.pathname, "/login");
  assert.equal(location.searchParams.get("next"), next);
};

test("dashboard paths are the ones that require a session", () => {
  assert.equal(dashboardRoute("/dashboard"), true);
  assert.equal(dashboardRoute("/dashboard/pulls"), true);
  assert.equal(dashboardRoute("/dashboard/organization/billing"), true);
  assert.equal(dashboardRoute("/dashboarding"), false);
  assert.equal(dashboardRoute("/login"), false);
  assert.equal(dashboardRoute("/api/health"), false);
  assert.equal(loginFor("/dashboard/pulls?repository=abc"), "/login?next=%2Fdashboard%2Fpulls%3Frepository%3Dabc");
});

test("session JWTs are verified, not accepted by cookie presence", async () => {
  process.env.SESSION_SECRET = secret;
  assert.equal(await sessionJwtValid(undefined), false);
  assert.equal(await sessionJwtValid("not-a-jwt"), false);
  assert.equal(await sessionJwtValid(await sign()), true);
  assert.equal(await sessionJwtValid(await sign({ secret: "other-session-secret-at-least-32-chars!!" })), false);
  assert.equal(await sessionJwtValid(await sign({ expired: true })), false);
  assert.equal(await sessionJwtValid(await sign({ issuer: "other" })), false);
});

test("logged-out dashboard requests redirect to /login and keep the path", async () => {
  process.env.SESSION_SECRET = secret;
  for (const path of ["/dashboard", "/dashboard/pulls", "/dashboard/organization/billing"]) {
    toLogin(await middleware(request(path)), path);
  }
  toLogin(await middleware(request("/dashboard/pulls?repository=abc")), "/dashboard/pulls?repository=abc");
});

test("a valid session reaches the dashboard; invalid and expired cookies do not", async () => {
  process.env.SESSION_SECRET = secret;
  const allowed = await middleware(request("/dashboard/pulls", await sign()));
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("location"), null);
  toLogin(await middleware(request("/dashboard", "not-a-jwt")), "/dashboard");
  toLogin(await middleware(request("/dashboard", await sign({ secret: "other-session-secret-at-least-32-chars!!" }))), "/dashboard");
  toLogin(await middleware(request("/dashboard/onboarding", await sign({ expired: true }))), "/dashboard/onboarding");
});

test("public pages and API health checks are not redirected", async () => {
  process.env.SESSION_SECRET = secret;
  const runs = (url: string) => unstable_doesMiddlewareMatch({ config: middlewareConfig, url });
  assert.ok(!runs("/api/health"));
  assert.ok(!runs("/api/auth/callback"));
  assert.ok(runs("/dashboard"));
  assert.ok(runs("/login"));
  for (const path of ["/", "/login", "/signup", "/changelog", "/docs/quickstart", "/privacy", "/api/health", "/oauth/consent"]) {
    const response = await middleware(request(path));
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("location"), null, path);
  }
});
