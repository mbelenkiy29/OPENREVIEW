# Changelog

<!-- Everything here is live on openreview.tech. Add entries under the current month; start a new "## Month YYYY" heading when the month changes. -->

## October 2026

### Pull request reviews
- Reviews catch boundaries that contradict their own documentation, such as a comment saying "$50.00 or more" over code that compares `> 50`.
- Findings are no longer dropped when the model attaches a made-up rule ID. Only custom-rule findings need a real rule.
- On GitHub the review summary now goes at the end of the pull request description and is replaced on every review. The author's own text is kept, and reviews never read the block back. Choose "one comment" under Settings → Review to keep the previous behavior.
- A more compact summary on GitHub:
  - The verdict, the confidence score and its reason come first.
  - Each issue links to its inline thread.
  - Detail sections are collapsed.
- A copyable **Prompt for your coding agent** lists every open finding. Each inline finding has its own collapsed prompt.
- Reactions show progress: 👀 when OpenReview picks up a request, 👍 when a requested review is published or when someone acknowledges a finding.
- Check runs report the files reviewed, the verdict and the score. They can fail below a minimum confidence score, and they end as "Superseded" when a newer commit replaces the review.
- When the plan blocks a review on the hosted cloud, the pull request gets one short note pointing admins to billing.
- Fixes:
  - Evidence quotes keep their backticks.
  - Counts in the summary read "1 changed file".
  - The risk line no longer shows a second confidence number.

### Setup
- Guided workspace setup: connect a provider, choose repositories, watch the code graph build, then shape the summary, comment scope, triggers and tools with live previews, and invite your team. Automatic reviews wait until you choose when reviews run.
- Installing the GitHub App now works from any signed-in session (email, Google or GitLab) and returns you to setup.

### Sign in
- Sign-in and sign-up pages (`/login`, `/signup`): continue with GitHub, Google or GitLab, or get an emailed sign-in link, showing only the methods the deployment has configured. Errors and sign-in results now land on the sign-in page instead of the home page.

### Monitoring
- Optional error tracking with Sentry and product analytics with PostHog for hosted deployments, off unless configured. Nothing sensitive leaves the browser or server: no session replays, no cookies or request bodies, no clicks or page text on signed-in pages, and secret URL parameters are stripped.

### Billing
- Starter plan: unlimited reviews under a monthly fair-use limit (500 per seat by default).
- When billing is on, guided setup ends with a plan step: add a payment method through Stripe Checkout without being charged before the trial ends, or continue on the trial.
- The 14-day trial now starts with a workspace's first review instead of its creation date.
- Restricted Stripe keys (`rk_…`) are accepted, and Stripe requests pin an API version.
- Stripe Checkout accepts promotion codes, so a prospect can redeem a single-use code for a free month.

### Site
- Privacy Policy and Terms of Service pages for the hosted service, linked from the footer and the sign-in buttons.
- Cookie consent: analytics starts only after a visitor accepts. Do Not Track and Global Privacy Control count as a refusal, and **Cookie settings** in the footer changes the choice.
- The product screens on the home page are interactive demos with sample data:
  - The hero window is a small working dashboard: open pull requests, findings, chat, analytics, memory and settings.
  - Chat answers sample questions with citations, and the summary re-reviews a pushed fix.
  - Evidence opens in its file, the Fix button walks through the agent hand-off, and analytics filter by repository and period.
  - The chat and summary demos play once when they scroll into view. Nothing reaches the backend, and reduced motion turns off autoplay and typing.
- The home page says the trial needs no card, and the pricing cards link to sign-up.
- Visitors who have not accepted analytics no longer download PostHog. The home page loads about a third less JavaScript: 597 KB instead of 906 KB, or 192 KB instead of 293 KB compressed.
- Links to the source on GitHub in the header, the footer and the self-hosting section.
- Public pages declare their canonical address, and the home page carries structured data (site name, app, licence, prices) for search engines.
- A Security page (`/security`) describes how the hosted service handles code: what is stored and sent to the model, secret redaction, access control, encryption, GitHub App permissions, retention and how to report a vulnerability. The reporting contact is also published in `/.well-known/security.txt` and `SECURITY.md`.
- Docs search: page titles and section headings, with `/` to focus it and Enter to open the top result.
- The changelog is dated by month, each section has a link, and it has an RSS feed at `/changelog/feed.xml`.
- Accessibility:
  - tables, code and demo windows that scroll can be reached and scrolled with the keyboard;
  - links inside text are underlined;
  - chat thread lists are navigation regions.

  An axe scan of the home, docs, changelog, security and sign-in pages finds no issues at desktop or phone width.

### Security
- Secret redaction also covers Stripe, Slack, GitLab and Google API keys, JSON Web Tokens, AWS secret access keys, quoted secrets under JSON keys, and secret-named settings in `.env`-style lines. Ordinary code and placeholders such as `your-api-key` are left as they are.
- Webhook payloads are deleted 14 days after they were last processed, including deliveries that failed or never finished. Event payloads from other code hosts are cleared after the same 14 days. Their delivery records stay, so a redelivery is still recognised.
- Every response sends `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`, and pages refuse to be framed (`X-Frame-Options: DENY`, `frame-ancestors 'none'`).
- The Privacy Policy now says that signing in with GitHub gives OpenReview no email address.

### Reviews
- Agentic review engine (opt-in) that follows code across files with read-only tools, under per-mode budgets.
- Tree-sitter code graph with resolved cross-file edges, plus optional chunk-level semantic retrieval.
- Summary comment edited in place: overview, files changed, issues, confidence score and an optional sequence diagram.
- Committable suggestions, multi-line comments, incremental re-reviews that resolve fixed threads, and optional GitHub check runs.
- Review triggers (labels, authors, size limits), strictness presets, and repository configuration as code read from the base branch.

### Learning and memory
- 👍/👎 reactions become feedback. Team conventions are learned from human review comments behind guardrails.
- A Memory page to edit, scope (repository, team or workspace), enable, disable or delete what OpenReview has learned.
- `@openreview fix this`: validated suggestions, with optional fix pull requests on a new branch.

### Design
- New look across the site and dashboard: warm parchment and ink, a single ember accent, Inter with JetBrains Mono for code and metadata, and matching light and dark themes.
- New logo: four lines of code with an ember dot pinned to one of them, with pixel-fitted cuts for the header and favicon, an app icon and a dark-mode-aware tab icon.
- The landing page shows the real dashboard screens: a pull request review with an inline finding, verified evidence, the review summary, chat, agent hand-off and analytics.

### Product surfaces
- Codebase chat with cited answers, a public query/search API with scoped API keys, and a remote MCP endpoint.
- Slack app (notifications, Q&A and `/openreview status`) and verified email notifications.
- Notion requirements context, and a finished Confluence/Jira resource picker.

### Running it as a product
- Optional Stripe billing for hosted deployments (trial, per-seat quotas, past-due grace).
- Sign in with GitHub, GitLab, Google or an email link. Server-side sessions with sign-out everywhere, and email invitations.
- Public documentation at /docs, this changelog and a new landing page.
