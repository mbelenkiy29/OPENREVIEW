// Edge-safe session JWT checks for middleware.ts. src/server.ts still asks Convex whether the
// session is revoked; this only verifies the cookie is a current HS256 token (issuer/audience,
// expiry). Cookie presence alone is not enough.
import { jwtVerify } from "jose";

export const sessionCookie = "openreview_session";

/** Same-origin path a sign-in may return to. */
export function safeNext(value: string | null | undefined) {
  return value && /^\/(?!\/)[A-Za-z0-9/_?=&.%-]{0,300}$/.test(value) ? value : "/dashboard";
}

/** Dashboard pages that must not stream a loading skeleton to a logged-out visitor. */
export function dashboardRoute(pathname: string) {
  return pathname === "/dashboard" || pathname.startsWith("/dashboard/");
}

/** Where sign-in returns after a dashboard bounce; `next` is the same-origin path `safeNext` allows. */
export function loginFor(next: string) {
  return `/login?next=${encodeURIComponent(safeNext(next))}`;
}

export async function sessionJwtValid(token: string | undefined) {
  const secret = process.env.SESSION_SECRET;
  if (!token || !secret || secret.length < 32) return false;
  try {
    await jwtVerify(token, new TextEncoder().encode(secret), { issuer: "openreview", audience: "openreview", algorithms: ["HS256"] });
    return true;
  } catch {
    return false;
  }
}
