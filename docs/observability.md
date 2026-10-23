# Error tracking and analytics (cloud)

The hosted site can report errors to [Sentry](https://sentry.io), product analytics to [PostHog](https://posthog.com) and ad conversions to OpenAI Ads and Reddit Ads. All are off unless their public keys are set when the web app is built, so self-hosted installs send nothing to any of them.

## What is collected

**Sentry (errors and performance):**
- Collected:
  - Unhandled errors in the browser, Server Components, route handlers, server actions and the edge runtime, with stack traces.
  - 10% of page loads and requests as performance traces (`NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE`).
  - After sign-in, the internal user ID and workspace ID.
- Not collected: cookies, request or response bodies, query strings, local variables, AI prompts or outputs, emails, or session replays. The SDK sends no IP address; to stop Sentry from recording the connecting IP too, turn on **Prevent Storing of IP Addresses** under Project Settings → Security & Privacy.

**PostHog (product analytics):**
- Collected:
  - Page views across the site.
  - Clicks on public pages (home, docs, changelog).
  - After sign-in, the internal user ID, with the active workspace ID on each event.
  - Four product milestones, for a sign-up funnel: `signed_up`, `workspace_created`, `repository_connected` and `first_review_completed`.
    - The server works them out (`convex/analyticsMilestones.ts`).
    - The browser sends each with the time it happened, and only after consent.
    - Each is then marked reported on the user, so it goes out once.
    - `repository_connected` uses the time the workspace's first enabled repository was added.
    - Workspace milestones go to one person, the workspace's earliest owner (normally its creator), so each workspace sends them once.
    - Internal and test accounts get none (see **Sign-in funnel** below), so they never count as ad conversions.
- Not collected:
  - Clicks and page text on signed-in pages (dashboard, invitations, fix links); those pages only send page views.
  - Session recordings, which are off.
  - Errors, which go to Sentry only.
- Anonymous visitors get no person profile, and browsers that send Do Not Track are not tracked. Turn on **Discard client IP data** in the PostHog project settings so IP addresses are not stored.

**Cookie consent:** PostHog sets a cookie, so it starts only after a visitor accepts the analytics banner (`app/consent.tsx`, rules in `src/consent.ts`).
- **The choice:** stored in the first-party `openreview_consent` cookie (`granted` or `denied`) for 180 days.
- **Browser signals:** Do Not Track and Global Privacy Control count as a refusal, so those visitors are never asked.
- **Declining later:** stops capture in the page and removes PostHog's cookies and storage.
- **Changing the choice:** **Cookie settings** in the site footer reopens the banner.
- **Self-hosted:** without `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` there is no banner.
- **Sentry:** sets no cookies and is not gated.

**OpenAI Ads pixel (ad measurement):** tells [Ads Manager](https://ads.openai.com) which visits and sign-ups came from our ads in ChatGPT ([docs](https://developers.openai.com/ads/measurement-pixel)). Code in `src/ads-pixel.ts`.
- **Consent:** it starts and stops with PostHog, under the same banner choice. Declining removes its `__oppref` and `__obref` cookies; it keeps `__oaiq_consent=false` to remember the refusal.
- **Page views:** each page is reported by its first path segment only (`/dashboard`, `/invite`), so ids and tokens in URLs are never sent.
- **Sign-up:** `registration_completed` is sent with the `signed_up` milestone above, so once per account and never on a later sign-in. Accounts more than a day old don't count.
- **Advanced matching:** if automatic advanced matching is on for the pixel in Ads Manager, the SDK itself hashes contact details it finds on the page (SHA-256) and sends the hashes. The privacy policy covers this; turn it off in Ads Manager to send none.
- **Self-hosted:** off without `NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID`.

**Reddit Pixel (ad measurement):** tells [Reddit Ads](https://ads.reddit.com) which visits and sign-ups came from our ads on Reddit. It runs Events Manager's base code from the bundle; code in `src/reddit-pixel.ts`.
- **Consent:** it starts and stops with PostHog, under the same banner choice. Declining stops its events in the page and removes its `_rdt_*` cookies and storage (`_rdt_uuid`, `_rdt_cid`).
- **Page views:** `PageVisit` when it starts and on each client-side navigation. We attach no URL, and the site's `Referrer-Policy` gives the pixel's requests only the origin as Referer.
- **Sign-up:** `SignUp` is sent with the `signed_up` milestone above, by the same rule as the OpenAI pixel: once per account, never on a later sign-in, and never for accounts more than a day old. Its `conversionId` is `signed_up:<user id>`, so Reddit drops a repeat, including the same sign-up sent later through its Conversions API.
- **Advanced matching:** we pass no email, phone or external ID. Keep automatic advanced matching off for the pixel in Events Manager so it sends none.
- **Self-hosted:** off without `NEXT_PUBLIC_REDDIT_PIXEL_ID`.

**URLs:** before any event leaves the browser or server, each URL keeps only a short allowlist of query parameters (`utm_*`, `ref`, `checkout`, `billing`, `signedout`) and loses its fragment. Invitation tokens, sign-in codes, error messages and repository filters are never sent. Referral links (`/r/<code>`) are reported as `/r/[code]`, in errors and performance traces alike, because a code identifies the person who shared it. Clicks aren't captured on those pages or on sign-up pages opened from them.

**Same-origin delivery:** events go through this site's own origin, so ad blockers that block Sentry and PostHog domains don't drop them:
- `/lighthouse` → Sentry.
- `/lantern` → PostHog.

The filters live in `src/telemetry.ts` and are tested in `tests/telemetry.test.ts`.

**Preview deployments:** neither ad pixel loads when `NEXT_PUBLIC_VERCEL_ENV` is `preview`, so test sign-ups there never count as conversions. Scope the pixel variables to Production in Vercel as well.

## Sign-in funnel (server-side)

The browser milestones above depend on consent and a dashboard visit. The server keeps its own record, written in the same transaction as each step and deduplicated by key (`convex/conversions.ts`, table `conversionEvents`):

| Event | When |
| --- | --- |
| `signup_verified:<user>` | A completed sign-in creates the account: a used magic link (proves the inbox), a verified OAuth callback or an SSO assertion. `method` is the provider. |
| `github_app_installed:<workspace>` | The workspace's first GitHub App installation. |
| `first_repository_connected:<workspace>`, `first_review_completed:<workspace>`, `subscribed:<workspace>` | The once-per-workspace lifecycle moments. These exist only for workspaces created since lifecycle emails existed. |

**Redundant steps:**
- "Email verified" and "magic link completed" are the same step: using the link is the verification.
- The first session starts in the transaction that creates the account.
- Returning sign-ins are the `sessions` rows (provider and time) with no new `signup_verified`.

**Internal and test accounts** are matched by `ANALYTICS_INTERNAL_EMAILS`, `ANALYTICS_INTERNAL_EMAIL_DOMAINS` and `ANALYTICS_INTERNAL_GITHUB_LOGINS` (Convex, comma-separated), `@resend.dev`, and the `.test`, `.example`, `.invalid` and `.localhost` TLDs. They are checked when read, so a changed list applies to existing accounts too.

**Comparing sign-in emails with real accounts:**
1. **Requests:** the web app logs one line per request to `/api/auth/email`:
   `{"event":"auth.magic_link","rid","decision","email":"<hmac>","ip":"<hmac>","domain","turnstile":{"outcome","codes"},"ms"}`.
   - `decision` is one of `sent`, `cooldown`, `limited`, `challenge_failed`, `origin_rejected`, `invalid` or `error`.
   - Count lines by `decision` in Vercel's logs. Add a log drain if you need more history than the plan keeps.
   - Convex logs `auth.magic_link_send` with the same `rid` and Resend's message id.
   - The changelog form logs `changelog.subscribe` the same way.
   - No line contains an address, an IP, a link or a token.
2. **Funnel per day:** `npx convex run authFunnel:report '{"since":<ms>,"until":<ms>}' --prod` returns:
   - links created and accepted by Resend;
   - links used, split into new accounts and returning users;
   - verified sign-ups by method, internal accounts left out;
   - of those sign-ups, how many own a workspace that installed the GitHub App, connected a repository and finished a review.
3. **Delivery:** use Resend's dashboard for delivery, bounce and complaint rates. Each magic link stores Resend's message id (`loginTokens.resendId`), and sends are tagged `category=magic_link`.

**Retention and access:**

| Data | Kept |
| --- | --- |
| Magic links | 30 days |
| Rate-limit counters | until a day after their window |
| `conversionEvents` | for the life of the account; a workspace's rows go with it |

Everything is read through internal Convex functions (dashboard and CLI) and Vercel logs only.

## Setup (operator)

Set these on the **web app** (Vercel → Project → Settings → Environment Variables → Production), then redeploy. `NEXT_PUBLIC_*` values are built into the browser bundle, so a change needs a new build.

| Variable | Value | Secret? |
|---|---|---|
| `NEXT_PUBLIC_SENTRY_DSN` | The project's DSN (Sentry → Project Settings → Client Keys) | No (public by design) |
| `SENTRY_ORG`, `SENTRY_PROJECT` | Organization and project slugs, for uploading source maps | No |
| `SENTRY_AUTH_TOKEN` | An organization auth token with the `project:releases` scope (Sentry → Settings → Auth Tokens). Without it, stack traces are minified. | **Yes** |
| `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | Optional, `0`–`1` (default `0.1`) | No |
| `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` | The project API key, `phc_…` (PostHog → Project settings) | No (public by design) |
| `NEXT_PUBLIC_POSTHOG_HOST` | `https://us.i.posthog.com` (default) or `https://eu.i.posthog.com` | No |
| `NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID` | The pixel ID (Ads Manager → Conversions → Data Source) | No (public by design) |
| `NEXT_PUBLIC_REDDIT_PIXEL_ID` | The pixel ID, `a2_…` (Reddit Ads → Events Manager) | No (public by design) |

**Ad pixels need PostHog:** set `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` too. Both ad pixels start from PostHog's consent banner, and their sign-ups ride the `signed_up` milestone, which is loaded and marked reported only with PostHog. With a pixel ID but no PostHog token, the pixel never starts.

**Release builds:** with `SENTRY_AUTH_TOKEN` set, a build uploads source maps and deletes them from the output, so they are never served publicly. Errors are tagged with the Vercel environment (`production` or `preview`) and the commit.

**Backend errors:** Convex functions are not covered by this setup. On a Convex Pro plan, turn on Sentry under Convex dashboard → Settings → Integrations → Exception Reporting with the same DSN. Otherwise, use the Convex dashboard's logs.

## Turning it off

Remove the variables and redeploy. Without `NEXT_PUBLIC_SENTRY_DSN`:
- Sentry isn't initialized anywhere.
- The `/lighthouse` route doesn't exist.

Without `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`:
- PostHog isn't initialized.
- The `/lantern` proxy doesn't exist.

Without `NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID` or `NEXT_PUBLIC_REDDIT_PIXEL_ID`, that ad pixel's script is never added to the page.
