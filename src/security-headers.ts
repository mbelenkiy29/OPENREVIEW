// Response headers for every route (next.config.ts). Nothing embeds OpenReview pages in a frame: the
// Bitbucket Forge app ships its own UI and reaches OpenReview server-to-server through Forge Remote,
// and the Slack, Atlassian, Linear and Notion integrations use API calls and full-page OAuth redirects.
// So framing is refused outright, in both the legacy header and CSP.
// Pages get their Content-Security-Policy from middleware.ts with a fresh script nonce per request:
// Next.js puts it on its own inline scripts, app/layout.tsx on the theme script, and 'strict-dynamic'
// lets those scripts load the rest (webpack chunks, PostHog, UserJot). Responses middleware skips
// (API routes, static files, the PostHog and Sentry proxies, prefetches) run no scripts and get the
// policy without script-src from next.config.ts instead, where default-src 'self' covers scripts.
export const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  // HTTPS only, here and on subdomains; set by the app so self-hosted deployments send it too (browsers ignore it over http).
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

/** Paths middleware.ts never runs on. Its matcher repeats them literally (tests/security-headers.test.ts). */
export const middlewareSkips = "api|_next/static|_next/image|favicon.ico|lantern|lighthouse";
/** Prefetch requests middleware.ts never runs on: the Next.js router's and the browser's. */
export const prefetchHeaders = [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }] as const;

/** The Content-Security-Policy value: pages pass their script nonce, other responses none. */
export function contentSecurityPolicy(nonce?: string, development = process.env.NODE_ENV === "development") {
  return [
    "default-src 'self'",
    // Development builds evaluate code for Fast Refresh.
    nonce && `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    // 'unsafe-inline' for React style={} attributes, the email sign-in page and UserJot's shadow-DOM <style>;
    // UserJot also adds its stylesheets and the Google Fonts CSS for Inter.
    "style-src 'self' 'unsafe-inline' https://cdn.userjot.com https://fonts.googleapis.com",
    // UserJot serves post and team images through its media proxy; the Reddit pixel may fall back to an image beacon.
    // Profile pictures come from the sign-in provider (src/identity.ts): GitHub, Google (lh3–lh6), and GitLab.com
    // uploads or Gravatar for GitLab accounts without one.
    "img-src 'self' data: blob: https://media.userjot.com https://cdn.userjot.com https://alb.reddit.com https://avatars.githubusercontent.com https://*.googleusercontent.com https://gitlab.com https://secure.gravatar.com",
    // Our fonts ship in the bundle (@fontsource); UserJot's Inter comes from Google Fonts.
    "font-src 'self' https://fonts.gstatic.com",
    // PostHog and Sentry go through same-origin proxies (src/telemetry.ts). UserJot's API and live updates,
    // and the OpenAI Ads and Reddit pixels' config and events (src/ads-pixel.ts, src/reddit-pixel.ts).
    "connect-src 'self' https://widget.userjot.com wss://widget.userjot.com https://bzrcdn.openai.com https://bzr.openai.com https://pixel-config.reddit.com https://alb.reddit.com",
    // Cloudflare Turnstile's challenge (app/turnstile.tsx) and the embedded UserJot board on /feedback.
    "frame-src https://challenges.cloudflare.com https://*.userjot.com",
    "media-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    // Forms and the redirects they lead to: sign-in providers, SSO IdPs and Stripe are https; an MCP client's
    // OAuth redirect URI may be loopback http (src/oauth-server.ts).
    "form-action 'self' https: http://localhost:* http://127.0.0.1:*",
    "frame-ancestors 'none'",
  ].filter(Boolean).join("; ");
}
