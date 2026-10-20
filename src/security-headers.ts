// Response headers for every route (next.config.ts). Nothing embeds OpenReview pages in a frame: the
// Bitbucket Forge app ships its own UI and reaches OpenReview server-to-server through Forge Remote,
// and the Slack, Atlassian, Linear and Notion integrations use API calls and full-page OAuth redirects.
// So framing is refused outright, in both the legacy header and CSP.
// Pages get their Content-Security-Policy from middleware.ts with a fresh script nonce per request:
// Next.js puts it on its own inline scripts, app/layout.tsx on the theme script, and 'strict-dynamic'
// lets those scripts load the rest (webpack chunks, PostHog, UserJot). Responses middleware skips
// (API routes, static files, the PostHog and Sentry proxies, prefetches) serve no HTML and get the
// policy without script-src from next.config.ts instead.
export const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
];

/** Paths middleware.ts never runs on. Its matcher repeats them literally (tests/security-headers.test.ts). */
export const middlewareSkips = "api|_next/static|_next/image|favicon.ico|lantern|lighthouse";
/** Prefetch requests middleware.ts never runs on: the Next.js router's and the browser's. */
export const prefetchHeaders = [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }] as const;

/** The Content-Security-Policy value: pages pass their script nonce, other responses none. */
export function contentSecurityPolicy(nonce?: string, development = process.env.NODE_ENV === "development") {
  return [
    // Development builds evaluate code for Fast Refresh.
    nonce && `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    // Forms and the redirects they lead to: sign-in providers, SSO IdPs and Stripe are https; an MCP client's
    // OAuth redirect URI may be loopback http (src/oauth-server.ts).
    "form-action 'self' https: http://localhost:* http://127.0.0.1:*",
    "frame-ancestors 'none'",
  ].filter(Boolean).join("; ");
}
