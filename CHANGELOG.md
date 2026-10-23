# Changelog

<!-- Everything here is live on openreview.tech. Add entries under the current month; start a new "## Month YYYY" heading when the month changes. -->

## October 2026

### Landing page
- The landing page now moves:
  - The headline rises in as the page opens.
  - Sections reveal as you scroll, and "How it works" plays as a pinned sequence.
  - The terminal types its commands, and scrolling is smooth on desktop.
- The header stays with you: it steps aside while you read down and returns when you scroll up, with a reading-progress line.
- It loads more cleanly. The hero demo no longer appears half-built on slow connections, and the main text is readable from the first frame. The animation code loads only after the page is interactive.
- If you prefer reduced motion, the page shows without animation or smooth scrolling.

### Memory
- Custom rules is now a searchable table, laid out like Greptile's Memory tab:
  - Search by text, or filter with `status:active|disabled` and `repository:owner/name`.
  - Each rule shows its usage (findings that cite it) and addressed rate.
  - Click a rule for an analytics panel: acceptance rate, uses this month, upvote and downvote ratios, and recent usage.
  - Add, edit and delete happen in dialogs. "Draft with AI" (the rule assistant) lives in the Add dialog, and its suggestions appear as Suggested rows to approve or dismiss.
- The Memory sidebar has icons and a Greptile-style order. Cross-repo context and Knowledge Base have new empty states, and Integrations is split into Connected and Available tables.

### Dashboard look
- The dashboard now has a cleaner, Greptile-style look:
  - Neutral greys in light and dark mode.
  - Main tabs with icons and an underline for the current page.
  - A role badge next to the workspace name.
  - A bold stat strip, and chart cards with small caps headers and leaderboards underneath.
  - Settings groups separated by dividers.
  - Compact Analytics filters.
- The public site keeps its existing style.

### Analytics
- The Analytics tab now follows Greptile's layout:
  - Time period presets: this week, month, quarter or year, or custom dates.
  - Four cards: Total PRs, Total Reviews, average merge time and bugs caught.
  - Six charts, each with a leaderboard: reviews, bugs caught by severity, time to merge, top contributors, addressed rate, and comment ratings with the most upvoted comments.
- Model cost, tokens, time saved and fixed-before-merge now sit in a Cost & impact section at the bottom.
- "View all bugs" opens Findings for the same period. Findings gained an Until date filter.
- Merge times are recorded for pull requests merged from now on.
- The CSV export adds a count per severity.

### Plans
- Three plans:
  - **Free:** no card, with a monthly usage allowance that never expires, for one workspace per owner. Other new workspaces you own choose Starter or Pro; workspaces from before plans keep Free.
  - **Starter:** per seat.
  - **Pro:** per seat, with more usage and with deep reviews, generated reproduction tests and fix pull requests. Pro also includes requirements checks from Linear, Jira, Confluence and Notion, learned conventions, API keys, analytics older than 30 days, SSO and the audit log.
- On other plans, Pro settings stay visible but disabled, with a link to Settings → Billing. SSO that is already set up keeps working, conventions you approved keep applying, and existing API keys are kept: they answer with an upgrade message until you upgrade.
- Usage is pooled across the workspace, and extra usage is billed at model cost up to a cap you set.
- Workspace owners and admins get an email when the workspace has used 80% and then 100% of its monthly usage, and Settings → Billing shows a banner. On Free the email says when reviews resume and how to upgrade; on Starter and Pro it says whether extra usage is on and how much of the cap is left. Add a verified email under Settings → Notifications to get them.
- Security checks, every provider, and the CLI and MCP signed in through the browser are on every plan.

### Your own model key
- Workspace owners and admins can run reviews, chat and fixes on their own Anthropic, OpenAI or OpenRouter key under Settings → API Keys. The key is checked, stored encrypted and never shown again, and the provider bills its usage.

### Pull request reviews
- Draft pull requests (when draft reviews are off) and pull requests over your file or line limit now show as **skipped** rather than cancelled, with the reason in the review's timeline. A skipped draft is still reviewed once it is marked ready for review, and `openreview review status` exits 5 for skipped reviews, as it does for cancelled ones.
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


### OpenReview CLI
- `openreview login --api-key` reads the key from a hidden prompt or stdin, and `OPENREVIEW_API_KEY` signs CI in without saving anything. `--token` still works but warns that it leaves the key in your shell history.
- `openreview review --instructions "…"` adds guidance for one run, on the server or with `--local`.
- `openreview review status --pr <number>` reports a pull request's latest review and exits 0 when a completed review covers its head, so hooks and CI can gate on it.
- `openreview whoami` is another name for `openreview status`.
- Install the CLI with `npm install -g openreview-cli` and sign in through your browser with `openreview login`. No API key to copy; the sign-in renews itself and `openreview logout` revokes it.
- Signed in, `openreview review` reviews your commits before you push on your workspace, with its model, rules and repository index. Each review counts toward your plan, and its usage shows in Analytics. `--local` keeps reviewing on your machine with your own model key.
- **Behavior change:** once a login is saved (including an API key from `openreview login --token` or `openreview onboard`), `openreview review` runs on the server: it uploads the diff and changed files and counts against the plan. Add `--local` to keep reviews on your machine.
- Claude Code, Codex and other agents can run `openreview review --agent`, and the agent plugin's new **review-local-changes** skill runs the review-and-fix loop before a push.
- The CLI shows the OpenReview logo, animated, and a progress line in interactive terminals, and stays plain in agent output, pipes and CI.

### Fixing findings
- Signing in from a **Fix with your agent** link in a pull request now returns you to that fix, instead of the dashboard.
- One default coding agent everywhere: Claude Code, unless the workspace or you choose another. The settings page no longer shows a preview-only button.
- Every finding on a review page links to the full Fix page (deep links, Devin and more), and deep links are hidden on findings that are already resolved or dismissed.
- The Fix link under each inline finding is built the same way on every provider, and is left out when `APP_URL` is not a plain web origin.
- Saving your coding agent confirms with a message, and shows the error if saving fails.
- Settings → Agents starts with the fixes that need nothing installed from OpenReview: cloud agents, the Open in links and the agent plugin. The local bridge steps are collapsed below them.
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
- Referral program (hosted cloud, off unless `REFERRALS_ENABLED=true`): every user gets a link under Settings → Referrals. A referred workspace gets a Checkout discount, and the referrer earns 20% of what it pays, excluding tax, for 12 months, held 30 days. Refunds and disputes claw commissions back, and earnings can be applied as credit on a workspace bill or, with `REFERRAL_PAYOUTS_ENABLED=true`, cashed out to a US bank account through Stripe Connect (cash-outs that bring someone's total over $500 in 30 days are reviewed first, and every payout step needs a sign-in from the last 15 minutes). See [How referrals work](/docs/referrals).

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
- The changelog can also come by email: subscribe on `/changelog` and confirm the link. At most once a week you get only the entries added since the last email, and every email has an unsubscribe link.
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
