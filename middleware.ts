import { NextResponse, type NextRequest } from "next/server";
import { anyFormTargetPages, contentSecurityPolicy } from "./src/security-headers";
import { dashboardRoute, loginFor, sessionCookie, sessionJwtValid } from "./src/session-token";

// A fresh script nonce per page request (src/security-headers.ts). Next.js reads it from the request's
// Content-Security-Policy header for its own inline scripts; app/layout.tsx reads x-nonce.
// Dashboard routes also verify the session JWT here so a logged-out GET is a 307 to /login instead of
// HTTP 200 with app/dashboard/loading.tsx. src/server.ts session() remains the revoked-session fallback.
export async function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID()), policy = contentSecurityPolicy(nonce, anyFormTargetPages.test(request.nextUrl.pathname));
  if (dashboardRoute(request.nextUrl.pathname) && !(await sessionJwtValid(request.cookies.get(sessionCookie)?.value))) {
    const response = NextResponse.redirect(new URL(loginFor(request.nextUrl.pathname + request.nextUrl.search), request.url));
    response.headers.set("Content-Security-Policy", policy);
    return response;
  }
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

// Next.js reads this at build time, so it is a literal: middlewareSkips and prefetchHeaders in
// src/security-headers.ts, where next.config.ts sends the static policy instead.
export const config = {
  matcher: [{
    source: "/((?!api|_next/static|_next/image|favicon.ico|lantern|lighthouse).*)",
    missing: [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }],
  }],
};
