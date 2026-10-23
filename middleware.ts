import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy } from "./src/security-headers";

// A fresh script nonce per page request (src/security-headers.ts). Next.js reads it from the request's
// Content-Security-Policy header for its own inline scripts; app/layout.tsx reads x-nonce.
export function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID()), policy = contentSecurityPolicy(nonce);
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
