# OpenReview product audit

17 November 2026. First-round engineering audit of this repository: architecture, local run, tests, bugs, UI, onboarding, and a comparison with Greptile and CodeRabbit. No Greptile or CodeRabbit code, copy or branding was used.

**Gate on this checkout (Node.js 24.11.1, pnpm 11.1.2):** `pnpm lint` (3 pre-existing warnings, 0 errors), `pnpm typecheck`, `pnpm test` (658 Node tests + 560 Vitest tests). `pnpm build` and Playwright screenshots are follow-up work.

## Architecture

OpenReview is a self-hostable AI pull-request reviewer. The same TypeScript engine reviews GitHub pull requests and local Git changes.

```
GitHub App → signed Convex HTTP webhook → durable delivery → scheduled review
                                                        ↓
                 incremental blob index → code graph → ranked context
                                                        ↓
                  specialty reviewers → evidence checks → verifier
                                                        ↓
                    stored findings/usage → GitHub batch review
                                                        ↓
                     Next.js dashboard / authenticated API / MCP

Local Git branch → CLI (`bin/openreview.mjs` / `packages/cli`) → the same reviewChange engine
```

| Layer | Stack | Role |
| --- | --- | --- |
| Web | Next.js App Router (`app/`), hand-written CSS (`app/globals.css`) | Landing, docs, dashboard, HTTP API, MCP |
| Backend | Convex (`convex/`) | Auth, workspaces, index/review jobs, webhooks, billing |
| Engine | `src/engine/` | Retrieval, specialists, agentic loop, grounding, verification |
| Providers | `src/github.ts`, `gitlab.ts`, `gitea.ts`, `bitbucket-*.ts`, `origin.ts`, `perforce*.ts` | SCM adapters behind `Scm` |
| CLI | `src/cli.ts`, `bin/openreview.mjs`, `packages/cli` | Local and signed-in reviews, bridge, resolve loop |
| Deploy | Vercel + Convex Cloud, or Docker Compose / Helm | See `docs/deployment.md` |

**GitHub App / webhook / LLM path.** GitHub sends `POST` to `NEXT_PUBLIC_CONVEX_SITE_URL/github/webhook`. `convex/http.ts` checks payload size, verifies `X-Hub-Signature-256` (HMAC-SHA256 of the exact body), stores the blob, and claims the delivery ID. `convex/webhookJobs.ts` applies triggers (automatic, label, mention, size, draft, excluded authors/branches), claims a review for that repository/PR/head, and runs the engine. Model keys live only in Convex env; Convex actions call `src/engine/model.ts`. Findings must quote exact source lines (`grounded()`) and pass a second verifier before publish. GitLab/Gitea/Azure/Bitbucket/Origin webhooks go through Next (`app/api/providers/[id]/webhook` or `app/api/origin/webhook`) into `convex/providerJobs.ts`, which verifies the connection secret before enqueue.

**Local run** (from the README):

```sh
pnpm install
CONVEX_AGENT_MODE=anonymous pnpm exec convex dev --once
pnpm setup:local
pnpm backend
# another terminal
pnpm dev
```

Open http://localhost:3000. `pnpm setup:local` generates session, service and webhook secrets into `.env.local` / `.env.backend` (mode 0600) and syncs them to the anonymous Convex backend without printing values.

## Issues

Severity, location, status. **Fixed** in this round means the change is in the open pull requests from this audit, not merged.

| ID | Severity | Location | Status | Issue |
| --- | --- | --- | --- | --- |
| O1 | **High** | `README.md`, `docs/public/cli.md`, `packages/cli/README.md`, dashboard Fix settings, agent skill | **Fixed (docs)** / **open (publish)** | README and docs told users to `npm install -g openreview-cli`. That package **404s on the npm registry**. The real package name is `openreview-cli` (`packages/cli/package.json`); it is built by `pnpm build:cli` (`scripts/build-cli.ts` → `packages/cli/dist/openreview.mjs`). Docs now install from this checkout (`pnpm install` + `npm link`, or `pnpm cli`). Publishing remains an open operator step: `.github/workflows/publish-cli.yml` (`workflow_dispatch`) needs an `NPM_TOKEN` secret and a version bump. Flip `cliNpmPublished` in `src/cli-install.ts` after the first successful publish. |
| B1 | Medium | `app/api/sentry/webhook/route.ts` | **Fixed** | Signed but invalid JSON threw and returned 500. Now 400 `Invalid payload`. |
| B2 | Medium | `app/api/origin/webhook/route.ts` | **Fixed** | Auth failures (bad signature, identity mismatch) returned 503, so Origin would retry as if the backend were down. Now 401 for auth, 400 for bad JSON, 503 for unavailability. |
| B3 | Medium | `app/api/providers/[id]/webhook/route.ts`, `convex/providerJobs.ts` | **Fixed** | Every Convex failure became 401, including invalid JSON after a valid signature. JSON parse is explicit; statuses are 401 / 400 / 503. |
| B4 | Medium | `src/github.ts` `verifyWebhook` | **Fixed** | The provider route fell back to `X-Hub-Signature` (SHA-1) but verification only accepted `sha256=`. Legacy GitHub Enterprise deliveries that send only SHA-1 were dropped. SHA-1 HMAC of the exact body is now accepted when the header matches `sha1=` plus 40 hex chars. |
| B5 | Low | `src/pull-actions-server.ts` | **Fixed** | Dashboard GitHub actions swallowed audit-log write failures after GitHub had already performed the action. Failures are now structured-logged (`pull.audit_failed`). |
| C1 | Medium | `.github/workflows/ci.yml` | Open | CI runs lint, typecheck and test, not `pnpm build`. CONTRIBUTING and the README treat build as required. |
| C2 | Medium | `Dockerfile` vs `package.json` `engines` vs CI | Open | Docker builds on **Node 26**; docs and CI use **Node 24**. Behaviour can diverge for native addons and CLI. |
| C3 | Low | `.github/ISSUE_TEMPLATE/` | Open | No bug / feature / support issue templates. |
| C4 | Low | `CONTRIBUTING.md` | Open | Eight lines; no PR checklist, security pointer, or CLI-from-checkout notes. |
| U1 | Medium | `app/oauth/consent/page.tsx` | Open | Uses class `narrow` with no CSS; consent pages are full-width unstyled `<main>`. |
| U2 | Medium | `app/dashboard/error.tsx`, `loading.tsx` | Open | Error and first-load skeleton drop portal chrome (nav/tabs). |
| U3 | Medium | `app/globals.css` landing links | Open | DESIGN.md requires underlined links in running text on public pages; landing feature CTAs are not underlined. |
| U4 | Low | `app/layout.tsx` | Open | No skip-to-main link. |
| U5 | Low | `app/globals.css` charts | Open | `--text-ter` used for chart axes (DESIGN: decorative only). Dark `#6f6e69` on `#14120b` is weak for 12px labels. |
| U6 | Low | `app/dashboard/pulls.tsx` | Open | Pulls table scrolls via `.table-box` but is not wrapped in `ScrollTable` (keyboard/ARIA region used elsewhere). |
| S1 | Low | `app/api/bridge/[action]/route.ts` | Open | Pairing rate limit prefers `X-Forwarded-For` / `X-Real-IP`. Fine behind a stripping proxy; spoofable if the app is reached directly. |
| S2 | Info | `convex/runtime.ts` `claim` | Open (by design) | Claim patches a queued job without an extra status CAS. Convex mutations are OCC-serializable, so concurrent workers retry; not a practical race. Left documented rather than “fixed”. |
| S3 | Info | `convex/providerConnections.ts` `claimEvent` | Open (by design) | 15-minute recovery is after typical Convex action timeouts (~10 min), so a still-running handler should already have been killed. |
| T1 | Low | `tests/bridge.test.ts` | Open | Documented flake: Node child SIGSEGV/SIGBUS under parallel load on some Node versions. |

**Already solid (do not re-fix):** GitHub webhook HMAC in `convex/http.ts` (size limits, exact-byte SHA-256, delivery dedup); Stripe and Slack signature checks; hashed API keys; `scripts/bootstrap.ts` never prints secrets; CSP / HSTS / `X-Frame-Options: DENY`; docs link checker (`tests/docs-links.test.ts`).

## Feature gap analysis vs Greptile and CodeRabbit

Built from public product descriptions only. Ranked by **user impact** (whether a team evaluating those products would miss it) and **effort**. OpenReview already has a large parity surface (see `docs/parity/REPORT.md`); this table is what still matters for winning users.

| Rank | Gap | Impact | Effort | Notes |
| --- | --- | --- | --- | --- |
| 1 | One-click hosted install / GitHub Marketplace listing | High | Medium (human) | Greptile and CodeRabbit install from the Marketplace in a minute. OpenReview requires registering your own GitHub App, converting a PKCS#1 key, and wiring Convex. Time-to-first-review is the conversion killer. |
| 2 | Published CLI (`openreview-cli` on npm) | High | Low once npm org exists | CodeRabbit and Greptile ship a global CLI. **O1** unblocks docs; publish is still open. |
| 3 | Demo GIF / interactive hosted demo with a public sample PR | High | Medium | Greptile’s marketing shows a real review. OpenReview has an interactive landing replica (`app/landing/`) but no recorded GIF in the README and no public demo workspace. |
| 4 | Comparison pages (`/compare/greptile`, `/compare/coderabbit`) | High | Low | Buyers search “[tool] alternative”. No comparison page exists. Keep original wording; do not copy competitor UI. |
| 5 | GitHub check-run as a required status out of the box | Medium | Low–medium | CodeRabbit is often a required check. OpenReview supports check runs only with Checks write and an explicit failure threshold (default remaining `neutral`). |
| 6 | IDE inline comments (VS Code / JetBrains) | Medium | High | CodeRabbit has editor extensions. OpenReview has MCP + CLI + dashboard. |
| 7 | Automatic issue filing (Linear/Jira) from findings | Medium | Medium | CodeRabbit/Greptile-style “create ticket from finding” is a common workflow. OpenReview reads tickets as requirements; it does not open them. |
| 8 | Org-wide learning defaults that ship useful without admin work | Medium | Medium | Greptile emphasises memory that just works. OpenReview’s conventions need admin approval unless auto-approve is on (correct for security, slower for “it got smarter”). |
| 9 | Bitbucket Cloud Forge app actually listed | Medium | High (human) | Adapter exists; the Forge app is not registered. |
| 10 | Windows/Linux native bridge verification | Low–medium | Medium (human) | macOS Codex path was verified; Windows/Linux remain Needs-human in the parity ledger. |

**What OpenReview already has that those products often charge for or lock to cloud:** self-hosting, bring-your-own model, evidence-gated findings, configuration-as-code, MCP, offline mode, Helm/Terraform. Lead with those; do not claim “Greptile parity”.

## Onboarding / DX friction (time-to-first-review)

Measured as the path a new OSS user follows from clone to a review on their own PR.

1. **Node version.** `engines.node` is `>=24`. A Node 22 environment fails the engine check (`pnpm install` warns). The README does not mention `nvm` / `fnm`. **~10 minutes** if the user is on 22.
2. **pnpm 11.** Corepack can install it; not everyone has Corepack enabled.
3. **Convex anonymous backend.** `CONVEX_AGENT_MODE=anonymous pnpm exec convex dev --once` needs network to Convex. Confusing if the user expected a fully offline first run.
4. **Two processes.** `pnpm backend` and `pnpm dev` in separate terminals. Easy to miss.
5. **GitHub App registration** (the long pole). PKCS#8 conversion, webhook URL pointing at a **public** Convex site URL, permissions, events, Setup URL vs OAuth. A localhost backend cannot receive GitHub webhooks without a tunnel. **30–90 minutes** for a first-time App author. This is the main gap vs Marketplace install.
6. **Model key.** Reviews do nothing useful without `LLM_API_KEY` on Convex, not only in Next.js. Easy to set the key only in `.env.local`.
7. **CLI (O1).** Until this fix, `npm install -g openreview-cli` failed immediately. Working path is now clone → `pnpm install` → `npm link`. Still worse than a one-line global install.

**Honest time-to-first-review today:** an hour or more for GitHub-hosted reviews; about 15 minutes for a local `pnpm cli review --local` once Node 24, pnpm, and a model key exist. Greptile/CodeRabbit: minutes, because the App is pre-registered.

## Growth plan (OSS dev tool)

1. **README / landing.** Lead with a 20-second demo GIF of a PR summary + inline finding. Keep the architecture diagram. Put “not on npm yet / install from checkout” next to the CLI until publish. Add a one-click **Deploy to Render** / **Deploy on Railway** button only if the Compose/Helm path is actually one-click (it is not today; Convex + GitHub App still need human steps).
2. **Demo GIF.** Record `pnpm test:e2e`’s landing + a fixture review; commit under `docs/images/` (or a short MP4 like `public/whats-new/`).
3. **GitHub Marketplace listing.** Needs a public GitHub App, a listing description, screenshots, and support URL. Human-only (cannot be done from this agent). Highest-leverage distribution.
4. **Show HN / Product Hunt.** After Marketplace or a public demo workspace exists. Show HN wants a working playground, not a self-hosting essay.
5. **Docs site.** `/docs` already exists (`docs/public/` + selected guides). Add a short “Install the GitHub App (hosted)” page once a hosted App exists, distinct from “Register your own App (self-host)”.
6. **Comparison pages.** `/docs/compare` with original, factual tables: self-host, BYO model, evidence gating, price. Never use competitor trademarks in product UI chrome.
7. **Issue templates + CONTRIBUTING.** Tracked as C3/C4. Bug, feature, and support templates; CONTRIBUTING that repeats the real CLI install and the `pnpm lint && pnpm typecheck && pnpm test && pnpm build` gate.
8. **Good-first-issues.** Label and write three: (1) Node 24 vs Docker 26 alignment, (2) skip-to-main link, (3) `ScrollTable` on the pulls list. Point at `docs/AUDIT.md` IDs U4, U6, C2.

### Needs human (publish and hosted distribution)

1. Create an npmjs org, add repository secret `NPM_TOKEN` with publish rights for `openreview-cli`.
2. Bump `packages/cli/package.json` version if needed, run **Publish CLI** (`workflow_dispatch`).
3. Set `cliNpmPublished` to `true` in `src/cli-install.ts` and restore `npm install -g openreview-cli` in README and `docs/public/cli.md` (the test in `tests/cli-install.test.ts` enforces this).
4. Register a public GitHub App and a Marketplace listing (or document why the project stays “bring your own App”).
5. Align Dockerfile Node 26 vs documented Node 24.
