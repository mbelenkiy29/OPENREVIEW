# OpenReview product audit

17 November 2026. First-round engineering audit of this repository: architecture, local run, tests, bugs, UI, onboarding, and a comparison with Greptile and CodeRabbit. No Greptile or CodeRabbit code, copy or branding was used.

**Status refreshed 18 November 2026** against `main` at `d952840946a18f6368e86f4bce392c578f037819`. PR merge states and repository content were checked. Application gates, live providers, backend connectivity, sign-in, model reviews, hosting, and public npm installation were not rerun for this documentation refresh.

**Historical gate reported on 17 November (Node.js 24.11.1, pnpm 11.1.2; execution revision not recorded):** `pnpm lint` (3 pre-existing warnings, 0 errors), `pnpm typecheck`, `pnpm test` (658 Node tests + 560 Vitest tests). Build coverage was deferred to #152 at that time. Public-page screenshots (1280 and 390) were attached to #151.

**Later gate reported in [#165](https://github.com/mbelenkiy29/OPENREVIEW/pull/165), 18 November:** Node.js 24.22.3 / pnpm 11.1.2, 699 Node tests + 571 Vitest tests (1,270 total), lint (3 existing warnings), typecheck, and production build passed. This is prior-run evidence for that PR's head `e689a8882e0e5c06c57bcda867d24e23d936b2d4`, not a fresh run on this documentation checkout.

Pull requests from this audit and its follow-ups:

| Theme | PR | Status |
| --- | --- | --- |
| Critical bugs, CLI onboarding, this audit | [#149](https://github.com/mbelenkiy29/OPENREVIEW/pull/149) | **Merged** 17 Nov 2026 |
| UI/UX polish | [#151](https://github.com/mbelenkiy29/OPENREVIEW/pull/151) | **Merged** 17 Nov 2026 (`1041633`) |
| CI build, issue templates, CONTRIBUTING | [#152](https://github.com/mbelenkiy29/OPENREVIEW/pull/152) | **Merged** 17 Nov 2026 |
| README sample-data demo GIF | [#153](https://github.com/mbelenkiy29/OPENREVIEW/pull/153) | **Merged** 17 Nov 2026 |
| Clean-checkout Docker build and runtime assets | [#163](https://github.com/mbelenkiy29/OPENREVIEW/pull/163) | **Merged** 18 Nov 2026 |
| Explicit proxy trust for bridge pairing | [#164](https://github.com/mbelenkiy29/OPENREVIEW/pull/164) | **Merged** 18 Nov 2026 |
| Deterministic confirmation-token tamper test | [#165](https://github.com/mbelenkiy29/OPENREVIEW/pull/165) | **Merged** 18 Nov 2026 |

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

Severity, location, and status as of 18 November. **Merged** means the change is in `main`; it does not establish live deployment or provider acceptance. Original findings remain below as history.

| ID | Severity | Location | Status | Issue |
| --- | --- | --- | --- | --- |
| O1 | **High** | `README.md`, `docs/public/cli.md`, `packages/cli/README.md`, dashboard Fix settings, agent skill | **Merged (docs)** in #149 / **open (publish readiness and release)** | The 17 November registry check returned 404 for `openreview-cli`. Docs now install from this checkout (`pnpm install` + `npm link`, or `pnpm cli`). The package remains version `0.1.0` and `cliNpmPublished=false` in this revision; no registry install was tested in this refresh. The manual publish workflow exists, but that alone does not establish release readiness. Review package contents, ownership, credentials and version, and validate the artifact before a human release. Change the flag only after successful publication and a real registry-install check. |
| B1 | Medium | `app/api/sentry/webhook/route.ts` | **Merged** in #149 | Signed but invalid JSON threw and returned 500. Now 400 `Invalid payload`. |
| B2 | Medium | `app/api/origin/webhook/route.ts` | **Merged** in #149 | Auth failures (bad signature, identity mismatch) returned 503, so Origin would retry as if the backend were down. Now 401 for auth, 400 for bad JSON, 503 for unavailability. |
| B3 | Medium | `app/api/providers/[id]/webhook/route.ts`, `convex/providerJobs.ts` | **Merged** in #149 | Every Convex failure became 401, including invalid JSON after a valid signature. JSON parse is explicit; statuses are 401 / 400 / 503. |
| B4 | Medium | `src/github.ts` `verifyWebhook` | **Merged** in #149 | The provider route fell back to `X-Hub-Signature` (SHA-1) but verification only accepted `sha256=`. Legacy GitHub Enterprise deliveries that send only SHA-1 were dropped. SHA-1 HMAC of the exact body is now accepted when the header matches `sha1=` plus 40 hex chars. |
| B5 | Low | `src/pull-actions-server.ts` | **Merged** in #149 | Dashboard GitHub actions swallowed audit-log write failures after GitHub had already performed the action. Failures are now structured-logged (`pull.audit_failed`). |
| C1 | Medium | `.github/workflows/ci.yml` | **Merged** in #152 | CI runs `pnpm build` after lint, typecheck and test. Docker image smoke checks are not wired into this workflow. |
| C2 | Medium | `Dockerfile` vs `package.json` `engines` vs CI | **Documented** in merged #152 | Docker uses **Node 26**; development and CI use **Node 24**. Both satisfy `engines.node >=24`. Alignment is an optional operator choice, not a required fix for the build failures addressed in #163. |
| C3 | Low | `.github/ISSUE_TEMPLATE/` | **Merged** in #152 | Bug and feature templates; blank issues off; security reports go to SECURITY.md. |
| C4 | Low | `CONTRIBUTING.md` | **Merged** in #152 | Node 24 vs Docker 26, unpublished CLI install, check commands, security pointer. |
| C5 | Medium | `Dockerfile`, `scripts/docker-smoke.sh` | **Merged** in #163 | Removed the missing `patches` input, installed pinned pnpm without absent Corepack, and packaged `public/` assets. That PR reports a successful production image build and offline non-root health/static-asset smoke; later rebuilds hit sandbox OOM. The smoke command exists, but Docker CI wiring and live backend/sign-in/model acceptance remain unverified here. |
| U1 | Medium | `app/oauth/consent/page.tsx` | **Merged** in #151 | `.narrow` matches `.welcome`; expired consent has Home and MCP docs links. |
| U2 | Medium | `app/dashboard/error.tsx`, `loading.tsx` | **Merged** in #151 | First-load and layout errors show portal chrome; page errors keep the portal layout. |
| U3 | Medium | `app/globals.css` landing links | **Merged** in #151 | Landing, welcome, and consent running-text links are underlined. |
| U4 | Low | `app/layout.tsx` | **Merged** in #151 | Skip-to-content is the first tab stop and targets `#main`. |
| U5 | Low | `app/globals.css` charts | **Merged** in #151 | Chart axes, tooltips, and board captions use `--muted`. |
| U6 | Low | `app/dashboard/pulls.tsx` | **Merged** in #151 | Pull list (and legal markdown tables) use `ScrollTable`. |
| S1 | Low | `app/api/bridge/[action]/route.ts` | **Merged** in #164 | Pairing previously trusted caller-controlled forwarding headers. It now ignores them by default and shares the 30-per-minute `unknown` bucket. `BRIDGE_TRUSTED_IP_HEADER` can select one header with one canonical IP only behind an overwriting proxy and isolated origin; it does not select a first or last chain entry. The 300-per-minute deployment cap remains. See [bridge pairing client identity](deployment.md#bridge-pairing-client-identity). |
| S2 | Info | `convex/runtime.ts` `claim` | Open (by design) | Claim patches a queued job without an extra status CAS. Convex mutations are OCC-serializable, so concurrent workers retry; not a practical race. Left documented rather than “fixed”. |
| S3 | Info | `convex/providerConnections.ts` `claimEvent` | Open (by design) | 15-minute recovery is after typical Convex action timeouts (~10 min), so a still-running handler should already have been killed. |
| T1 | Low | `tests/bridge.test.ts` | Historical observation; not re-reproduced in this refresh | Node child SIGSEGV/SIGBUS under parallel load was documented on some Node versions. The later passing gate does not prove this intermittent failure is eliminated. |
| T2 | Low | `tests/changelog-email.spec.ts` | **Merged** in #165 | Text-only edits could preserve decoded authentication-tag bytes and make the rejection test fail randomly. The test now flips one decoded tag bit and checks that rejection makes no email-provider requests. This test-only fix is separate from T1. |

**Already solid (do not re-fix):** GitHub webhook HMAC in `convex/http.ts` (size limits, exact-byte SHA-256, delivery dedup); Stripe and Slack signature checks; hashed API keys; `scripts/bootstrap.ts` never prints secrets; CSP / HSTS / `X-Frame-Options: DENY`; docs link checker (`tests/docs-links.test.ts`).

## Feature gap analysis vs Greptile and CodeRabbit

The original ranking uses public product descriptions, **user impact** (whether a team evaluating those products would miss it), and **effort**. OpenReview already has a large parity surface (see `docs/parity/REPORT.md`). Status notes were refreshed on 18 November; rows marked **Shipped** are no longer absent features. Competitor facts and live availability were not rechecked.

| Rank | Gap | Impact | Effort | Notes |
| --- | --- | --- | --- | --- |
| 1 | One-click hosted install / GitHub Marketplace listing | High | Medium (human) | Greptile and CodeRabbit install from the Marketplace in a minute. OpenReview requires registering your own GitHub App, converting a PKCS#1 key, and wiring Convex. Time-to-first-review is the conversion killer. |
| 2 | Published CLI (`openreview-cli` on npm) | High | Low once npm org exists | CodeRabbit and Greptile ship a global CLI. **O1** unblocks docs; publish is still open. |
| 3 | Demo / public sample PR | High | Medium | **Shipped (sample-data recording):** README embeds [the demo GIF](images/demo.gif), added in #153. The interactive landing replica remains sample data, not live review-quality evidence. A real public-review/workspace acceptance check was not performed in this refresh. |
| 4 | Comparison content and discoverability | High | Low | **Shipped:** [Greptile](compare/greptile.md) and [CodeRabbit](compare/coderabbit.md) comparisons exist, README links to both, and the hosted site serves `/compare/greptile` and `/compare/coderabbit`. Their competitor facts are dated 16 November; recheck them before making new marketing claims. |
| 5 | GitHub check-run as a required status out of the box | Medium | Low–medium | CodeRabbit is often a required check. OpenReview supports check runs only with Checks write and an explicit failure threshold (default remaining `neutral`). |
| 6 | IDE inline comments (VS Code / JetBrains) | Medium | High | CodeRabbit has editor extensions. OpenReview has MCP + CLI + dashboard. |
| 7 | Automatic issue filing (Linear/Jira) from findings | Medium | Medium | CodeRabbit/Greptile-style “create ticket from finding” is a common workflow. OpenReview reads tickets as requirements; it does not open them. |
| 8 | Org-wide learning defaults that ship useful without admin work | Medium | Medium | Greptile emphasises memory that just works. OpenReview’s conventions need admin approval unless auto-approve is on (correct for security, slower for “it got smarter”). |
| 9 | Bitbucket Cloud Forge app actually listed | Medium | High (human) | Adapter exists; the Forge app is not registered. |
| 10 | Windows/Linux native bridge verification | Low–medium | Medium (human) | macOS Codex path was verified; Windows/Linux remain Needs-human in the parity ledger. |

**What OpenReview already has that those products often charge for or lock to cloud:** self-hosting, bring-your-own model, evidence-gated findings, configuration-as-code, MCP, offline mode, Helm/Terraform. Lead with those; do not claim “Greptile parity”.

## Onboarding / DX friction (time-to-first-review)

Historical estimates from the 17 November audit for the path from clone to a review on the user's own PR; timings were not remeasured in this refresh.

1. **Node version.** `engines.node` is `>=24`. A Node 22 environment fails the engine check (`pnpm install` warns). The README does not mention `nvm` / `fnm`. **~10 minutes** if the user is on 22.
2. **pnpm 11.** Corepack can install it; not everyone has Corepack enabled.
3. **Convex anonymous backend.** `CONVEX_AGENT_MODE=anonymous pnpm exec convex dev --once` needs network to Convex. Confusing if the user expected a fully offline first run.
4. **Two processes.** `pnpm backend` and `pnpm dev` in separate terminals. Easy to miss.
5. **GitHub App registration** (the long pole). PKCS#8 conversion, webhook URL pointing at a **public** Convex site URL, permissions, events, Setup URL vs OAuth. A localhost backend cannot receive GitHub webhooks without a tunnel. **30–90 minutes** for a first-time App author. This is the main gap vs Marketplace install.
6. **Model key.** Reviews do nothing useful without `LLM_API_KEY` on Convex, not only in Next.js. Easy to set the key only in `.env.local`.
7. **CLI (O1).** Until this fix, `npm install -g openreview-cli` failed immediately. Working path is now clone → `pnpm install` → `npm link`. Still worse than a one-line global install.

**17 November time-to-first-review estimate:** an hour or more for GitHub-hosted reviews; about 15 minutes for a local `pnpm cli review --local` once Node 24, pnpm, and a model key exist. The original comparison estimated minutes for Greptile/CodeRabbit because their Apps are pre-registered; no fresh timing comparison was run.

## Growth plan (OSS dev tool)

1. **README / landing.** Keep the existing sample-data demo GIF and architecture diagram. Keep “not on npm yet / install from checkout” next to the CLI until publish. Add a one-click **Deploy to Render** / **Deploy on Railway** button only when a tested template provisions the backend and prompts for required secrets; the documented setup still needs human Convex + GitHub App steps.
2. **Demo GIF — shipped in #153.** Maintain the recording under `docs/images/` with its sample-data label. Re-recording instructions are in [scripts/demo/README.md](../scripts/demo/README.md). Treat a real public review as separate evidence, not as something this recording proves.
3. **GitHub Marketplace listing.** Needs a public GitHub App, a listing description, screenshots, and support URL. Human-only (cannot be done from this agent). Highest-leverage distribution.
4. **Show HN / Product Hunt.** After Marketplace or a public demo workspace exists. Show HN wants a working playground, not a self-hosting essay.
5. **Docs site.** `/docs` already exists (`docs/public/` + selected guides). Add a short “Install the GitHub App (hosted)” page once a hosted App exists, distinct from “Register your own App (self-host)”.
6. **Comparison content — shipped.** Maintain [Greptile](compare/greptile.md) and [CodeRabbit](compare/coderabbit.md) tables with dated sources and factual claims. Hosted routes are `/compare/greptile` and `/compare/coderabbit`.
7. **Issue templates + CONTRIBUTING.** Done in #152 (C3/C4).
8. **Remaining engineering work.** Add Docker smoke coverage to CI, complete CLI publish readiness, and investigate T1 only with a reproducible failure and recorded runtime. S1 shipped in #164; follow its explicit proxy/header policy instead of trusting a chain position. Node-version alignment is optional (C2). U4/U6 shipped in #151.

### Needs human (publish and hosted distribution)

1. Complete and review CLI build, package-content, and install validation before release. The package remains `0.1.0`; publication is not established by a successful local build or by a prepared but unmerged change.
2. Confirm npm package ownership, approved publish credentials (`NPM_TOKEN` for the existing manual workflow), package contents, and the release version before a human runs **Publish CLI** (`workflow_dispatch`). No release was dispatched by this refresh.
3. Only after publication and a successful registry install, set `cliNpmPublished` to `true` in `src/cli-install.ts` and restore `npm install -g openreview-cli` in README and `docs/public/cli.md` (the test in `tests/cli-install.test.ts` enforces this).
4. Register a public GitHub App and a Marketplace listing (or document why the project stays “bring your own App”).
5. Add Docker build/smoke coverage through a reviewed CI workflow change and verify it on a runner with sufficient memory. The smoke script is merged; CI wiring is not. This is separate from optional Node-version alignment.
