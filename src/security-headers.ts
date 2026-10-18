// Response headers for every route (next.config.ts). Nothing embeds OpenReview pages in a frame: the
// Bitbucket Forge app ships its own UI and reaches OpenReview server-to-server through Forge Remote,
// and the Slack, Atlassian, Linear and Notion integrations use API calls and full-page OAuth redirects.
// So framing is refused outright, in both the legacy header and CSP. There is no script CSP: Next.js inline scripts, Sentry and the PostHog proxy
// would first need nonces or hashes.
export const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
];
