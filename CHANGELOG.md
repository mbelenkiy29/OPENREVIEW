# Changelog

<!-- Everything here is live on openreview.tech. Add entries under the current month; start a new "## Month YYYY" heading when the month changes. -->

## October 2026

### Dashboard navigation
- Switching tabs no longer shows a loading screen. The header, tabs and sidebar stay in place, the tab you click is marked at once, and the page changes when it's ready.
- Tabs have icons and an underline that slides to the current tab. On phones, the main tabs move to a bar at the bottom of the screen.
- Findings moved to **Analytics → Bugs Caught**, next to **PR Reviews**. Old Findings links still work.
- Review pages are split into **Overview**, **Findings**, **Code**, **History** and **Diagnostics** tabs.
- **Settings → Code Review** lists the page's sections in the sidebar and marks the one you're reading.
- Dashboard pages load faster: independent data now loads in parallel.

### Your own model key
- Workspace owners and admins can run reviews, chat and fixes on their own Anthropic, OpenAI or OpenRouter key under Settings → API Keys. The key is checked, stored encrypted and never shown again, and the provider bills its usage.

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
- **New workspaces choose a plan first.** On the hosted cloud, setup now goes workspace → Choose your plan → connect your code. The Starter plan's 14-day free trial starts by adding a card in Stripe Checkout, and nothing is charged until it ends. Until Stripe confirms the plan, every dashboard page leads back to the plan step, and repositories aren't indexed or reviewed. The choice is stored with the workspace. Workspaces created before this change are not affected.
- Guided workspace setup: connect a provider, choose repositories, watch the code graph build, then shape the summary, comment scope, triggers and tools with live previews, and invite your team. Automatic reviews wait until you choose when reviews run.
- Installing the GitHub App now works from any signed-in session (email, Google or GitLab) and returns you to setup.
- Installing the GitHub App no longer ends on an error page when it takes more than ten minutes on GitHub. OpenReview re-authorizes once and finishes linking, for up to 30 minutes. Problems show as a message on the page you started from.
- **Link an existing installation** connects an App installation made directly on github.com, or one that never returned to OpenReview, and refreshes the repository list of a linked one.
- When the GitHub account you pick already has the App for another OpenReview workspace, setup now says so and explains what to do, instead of leaving you on GitHub. Choosing repositories for that account on GitHub changes the other workspace.
- Reinstalling the GitHub App keeps your repositories: they follow the new installation and the ones that were on come back on. Unsuspending an installation does the same, and repositories whose access was removed and given back are restored.
- Repositories added on GitHub get their real default branch, settings and team, the same as at install time.
- The first review of a new repository waits for its first index with backoff, and if indexing hasn't finished after 30 minutes it fails with a clear message instead of waiting forever.
- If the semantic search endpoint fails, the review carries on with graph and text context, and its coverage notes say so.
- Fixed: after choosing repositories, setup could stay on "Starting indexing…" until the next click, even though indexing had started. The cause was a bug in the React version bundled with Next.js 15.5, which could also stall other page changes in the dashboard. OpenReview now includes React's fix.


### Fixing findings
- Signing in from a **Fix with your agent** link in a pull request now returns you to that fix, instead of the dashboard.
- One default coding agent everywhere: Claude Code, unless the workspace or you choose another. The settings page no longer shows a preview-only button.
- Every finding on a review page links to the full Fix page (deep links, Devin and more), and deep links are hidden on findings that are already resolved or dismissed.
- The Fix link under each inline finding is built the same way on every provider, and is left out when `APP_URL` is not a plain web origin.
- Saving your coding agent confirms with a message, and shows the error if saving fails.
- **Open a fix PR** on a finding's Fix page: OpenReview commits its validated suggestion to a new `openreview/fix-*` branch and opens a pull request against your branch, checked against your own GitHub write access. It needs the repository's Fix pull requests setting and the App's Contents: Read and write permission; the page says which one is missing.
- Settings → Code providers shows, for each GitHub installation, whether it granted Contents and Checks write access.
- **Cloud agents.** Hand a finding to Claude, Codex, Copilot or Cursor from its Fix page. OpenReview posts a comment as you that mentions the agent, so it starts in its own cloud: Claude replies in the finding's thread, the others in the pull request conversation. Choose your agent, or the workspace default, under Settings → Agents, which also lists what each agent needs. When cloud agents are the workspace default, the link under each finding reads, for example, **Fix with Claude**. See [Fix with agents](docs/public/fix-with-agents.md).
- On Gitea, fix pull request requests now say the feature isn't available there, instead of mentioning GitHub permissions.

### Sign in
- Sign-in and sign-up pages (`/login`, `/signup`): continue with GitHub, Google or GitLab, or get an emailed sign-in link, showing only the methods the deployment has configured. Errors and sign-in results now land on the sign-in page instead of the home page.

### Monitoring
- Optional error tracking with Sentry and product analytics with PostHog for hosted deployments, off unless configured. Nothing sensitive leaves the browser or server: no session replays, no cookies or request bodies, no clicks or page text on signed-in pages, and secret URL parameters are stripped.
- Product milestones for a sign-up funnel:
  - `signed_up`, `workspace_created`, `repository_connected` and `first_review_completed`;
  - each is sent once, with the time it happened, and only for visitors who accepted analytics.

### Billing
- Starter plan: unlimited reviews under a monthly fair-use limit (500 per seat by default).
- When billing is on, guided setup ends with a plan step: add a payment method through Stripe Checkout without being charged before the trial ends, or continue on the trial.
- The 14-day trial now starts with a workspace's first review instead of its creation date.
- Restricted Stripe keys (`rk_…`) are accepted, and Stripe requests pin an API version.
- Stripe Checkout accepts promotion codes, so a prospect can redeem a single-use code for a free month.
- Referral program (hosted cloud, off unless `REFERRALS_ENABLED=true`): every user gets a link under Settings → Referrals. A referred workspace gets a Checkout discount, and the referrer earns 20% of what it pays, excluding tax, for 12 months, held 30 days. Refunds and disputes claw commissions back, and earnings can be applied as credit on a workspace bill or, with `REFERRAL_PAYOUTS_ENABLED=true`, cashed out to a US bank account through Stripe Connect (cash-outs that bring someone's total over $500 in 30 days are reviewed first, and every payout step needs a sign-in from the last 15 minutes). See [docs/billing.md](docs/billing.md#referral-program).

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
