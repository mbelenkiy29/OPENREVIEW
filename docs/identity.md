# Sign-in, accounts and sessions

## Sign-in methods

| Method | Configure (web app) | Email trusted for account linking |
| --- | --- | --- |
| GitHub | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Never (no email scope is requested) |
| GitLab | `GITLAB_OAUTH_CLIENT_ID`, `GITLAB_OAUTH_CLIENT_SECRET`, optional `GITLAB_OAUTH_URL`; scope `read_user` for sign-in, and for "Join a team" also allow `read_api` on the GitLab application and set `GITLAB_JOIN_TEAMS=true` (only that re-authorization asks for it, to list the user's groups); redirect URI `<APP_URL>/api/auth/gitlab/callback` | Only confirmed gitlab.com accounts |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`; scopes `openid email profile`; redirect URI `<APP_URL>/api/auth/google/callback` | When Google reports `email_verified` |
| Email link | `EMAIL_SIGN_IN=true` on the web app, plus `RESEND_API_KEY`/`EMAIL_FROM` on Convex | Always (clicking the link proves ownership) |

## Sign-in and sign-up pages

- **Pages:** `/login` ("Sign in to OpenReview") and `/signup` ("Create your account") offer the same choices and link to each other.
  - **Order:** the configured providers come first, GitHub on top, then the emailed sign-in link when email is configured. **Use single sign-on** takes a work email and continues with the workspace's SAML or OIDC provider.
  - **Offline installs:** with `OPENREVIEW_OFFLINE=true`, Google is not offered.
  - **Same flow:** there is no separate registration. A provider identity seen for the first time creates the account, and a new account starts guided setup.
  - **Trial note:** with billing on, `/signup` mentions the free trial.
- **Where visitors land:**
  - The landing page's **Sign in** and **Get started** buttons open these pages.
  - Signed-out visits to the dashboard, failed sign-ins, emailed-link results and "signed out everywhere" all go to `/login` with a short message.
  - Signed-in visitors are sent straight to the dashboard, or to `next`.
- **`next`:** carried through every method, as a same-origin path only.

## Abuse protection for emailed links

Anyone can type an address into the sign-in form, so sending the link is guarded in layers. None of
them depends on whether an account exists for the address, and GitHub, Google, GitLab and SSO sign-in
never meet them.

- **Same site only:** `/api/auth/email` (and the changelog form) refuse a POST whose `Origin` is not `APP_URL`, so another site cannot make its visitors' browsers request links.
- **Bot check (optional):** with `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` set, the form carries a Cloudflare Turnstile token, which the route checks with Cloudflare before anything reaches Convex (`src/turnstile.ts`).
  - `TURNSTILE_MODE=enforce` (the default) refuses a missing, invalid, expired or reused token. `monitor` checks and logs only. `off` skips it, and is the kill switch.
  - If Cloudflare cannot be reached, the request goes on to the limits below, so accounts that can only sign in by email are never locked out by an outage.
  - Off without both keys, and in offline mode.
- **Limits (Convex, `storeLoginToken`):**

  | Limit | Default |
  | --- | --- |
  | Per mailbox: Gmail dots, `+tags` and googlemail.com count as one inbox, for this limit only | 1 per minute (a repeat within it says "sent" but sends nothing), 3 per 15 minutes, 10 per day |
  | Per client network: IPv4 address, or IPv6 /64, when `CLIENT_IP_SOURCE` names a trusted header | 10 per 10 minutes, 50 per day |
  | Whole deployment | `AUTH_EMAIL_HOURLY` (60) and `AUTH_EMAIL_DAILY` (300); keep them below your Resend quota |

  - A Sentry warning fires when the deployment-wide count passes half.
  - Past a limit the page says "Too many sign-in emails were requested", the same for every address.
- **Other email anyone signed in can send:** invitations (20 per hour per workspace, 30 per day per inviter) and notification-address checks (10 per day per member) share one deployment-wide daily cap, `USER_EMAIL_DAILY` (200). It is separate from sign-in links.
- **Client IP (`CLIENT_IP_SOURCE`):**

  | Value | Reads |
  | --- | --- |
  | `vercel` (default on Vercel) | `x-real-ip`, which the platform sets |
  | `header:<name>` | a header your proxy overwrites, e.g. `header:x-real-ip` behind nginx with `proxy_set_header X-Real-IP $remote_addr` |
  | `xff-rightmost` | the last `X-Forwarded-For` entry, for proxies that append (AWS ALB) |

  Unset elsewhere: Next.js keeps any `X-Forwarded-For` the client sent, so no header is trusted and the per-network limit is skipped.
- **Stored data:**
  - Limits are keyed by an HMAC of the address or network (`src/limit-key.ts`), never the value itself.
  - Counters are deleted a day after their window ends, magic links after 30 days, and SAML request ids after a day (`convex/authHygiene.ts`, every 6 hours).
  - After deploying this, run `npx convex run authHygiene:dropUnexpiringCounters --prod` once. It removes older counters, including ones keyed by raw addresses.

## Account linking

- **Same provider account:** a sign-in from a provider account OpenReview has seen before is the same user.
- **Different provider, same email:**
  - It joins the existing user only when **both** identities carry the same email marked verified by their provider.
  - Otherwise a separate user is created.
  - This means an attacker who registers someone else's address somewhere without verification cannot take over that person's account.
- **Explicit linking:** to attach another method, sign in, open **Personal Settings → Account Settings** and choose **Link …**. A provider account that already belongs to another user cannot be linked.

## Sessions

- **Cookie and server-side record:**
  - Browser sessions carry a random session ID in the signed cookie, and only its SHA-256 is stored.
  - Every Convex call and every dashboard page load checks that the session exists, belongs to the user, has not been revoked and has not expired (7 days).
- **Managing sessions:**
  - **Personal Settings → Account Settings** lists active sessions.
  - **Sign out** ends the current one.
  - **Sign out everywhere** revokes all of them, plus any older session-less cookies from before this change. Its cutoff time is checked on every request, so it ends every earlier session even when there are more rows than one revoke pass marks.
- **Workspace removal:** removing a member from a workspace signs them out everywhere. It also revokes their API keys and bridge pairings for that workspace.

## Email invitations

Admins can invite by email (**Organization Settings → People**). The link is single use, expires in 7 days and can be revoked. Whoever opens it signs in with any method and accepts. Only the token's hash is stored. GitHub-login invitations continue to work.

## Migration

`users.githubId` is optional. Existing GitHub users get a `github` identity on their next sign-in. After deploying, you can also backfill all users at once:

```bash
npx convex run identity:backfillIdentities --prod
```

The backfill is idempotent and paginated.

## SSO / SAML

SSO/SAML is deferred. When it is added, plan to front OpenReview with a self-hosted OIDC/SAML broker that exposes a standard OIDC provider, using the same identity and linking rules.
