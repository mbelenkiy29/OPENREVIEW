import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs/config';
import { posthogHosts, posthogProxyPath, posthogToken, sentryDsn, sentryTunnelPath } from './src/telemetry';
import { contentSecurityPolicy, middlewareSkips, prefetchHeaders, securityHeaders } from './src/security-headers';

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: process.cwd(),
  poweredByHeader: false,
  // PostHog proxying needs exact paths, only when analytics is configured (src/telemetry.ts).
  ...(posthogToken ? { skipTrailingSlashRedirect: true } : {}),
  async headers() {
    // Content-Security-Policy only where middleware.ts does not set one (with its nonce): exactly one per
    // response, since a second header would be enforced alongside it and platforms differ on which wins.
    const csp = [{ key: 'Content-Security-Policy', value: contentSecurityPolicy() }];
    return [
      { source: '/:path*', headers: securityHeaders },
      { source: `/(${middlewareSkips})(.*)`, headers: csp },
      ...prefetchHeaders.map((header) => ({ source: '/:path*', has: [header], headers: csp })),
    ];
  },
  async redirects() {
    // Sign-in results used to land on the home page; older links and bookmarks now go to the sign-in
    // page with their query string. Redirecting here keeps app/page.tsx free of query handling.
    const signIn = ['error', 'email', 'signedout'].map((key) => ({ source: '/', has: [{ type: 'query' as const, key }], destination: '/login', permanent: false }));
    // The roadmap is a view of the feedback board (app/feedback).
    return [...signIn, { source: '/roadmap', destination: '/feedback/roadmap', permanent: false }];
  },
  async rewrites() {
    // OAuth discovery documents for the remote MCP endpoint (RFC 9728 and RFC 8414 well-known paths).
    const oauth = [
      { source: '/.well-known/oauth-protected-resource', destination: '/api/oauth/metadata/protected-resource' },
      { source: '/.well-known/oauth-protected-resource/api/mcp', destination: '/api/oauth/metadata/protected-resource' },
      { source: '/.well-known/oauth-authorization-server', destination: '/api/oauth/metadata/authorization-server' },
    ];
    if (!posthogToken) return oauth;
    // PostHog through this site's own origin.
    const hosts = posthogHosts();
    return [
      ...oauth,
      { source: `${posthogProxyPath}/static/:path*`, destination: `${hosts.assets}/static/:path*` },
      { source: `${posthogProxyPath}/array/:path*`, destination: `${hosts.assets}/array/:path*` },
      { source: `${posthogProxyPath}/:path*`, destination: `${hosts.api}/:path*` },
    ];
  },
};

// Sentry wraps the build only when error tracking is configured. Source maps upload when
// SENTRY_AUTH_TOKEN (with SENTRY_ORG and SENTRY_PROJECT) is present at build time.
export default sentryDsn ? withSentryConfig(config, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  tunnelRoute: sentryTunnelPath,
  widenClientFileUpload: true,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN, deleteSourcemapsAfterUpload: true },
  silent: !process.env.CI,
  telemetry: false,
}) : config;
