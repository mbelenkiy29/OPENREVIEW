# Pricing tiers roadmap

A build checklist for adding paid tiers above **Starter**. It is written so an AI coding agent can pick up the next unchecked item and finish it without other context. Humans can read it as the product plan.

## How to use this file

1. Pick the first unchecked item (`- [ ]`) whose **Depends on** items are all checked.
2. Read every file listed under **Files** in full before you edit anything.
3. Build it with tests. Run the gate: `pnpm lint && pnpm typecheck && pnpm test`. UI changes also need `pnpm build`, and `pnpm test:smoke && pnpm test:e2e` when the local servers run.
4. Check the item off. Add one line under it: `done: <date> · <commit> · tests: <files>`.
5. Anything that needs a human (Stripe Dashboard, DNS, provider settings) goes in **Human steps** at the end of the item. Do not do it yourself.

**Rules that always apply**
- **Stripe:** one Stripe Product per tier, never several tiers on one product. Prices are variants of one tier, such as monthly and annual.
  - Never pass `payment_method_types`.
  - Every subscription state change arrives by webhook (`convex/http.ts`), never from the Checkout success page.
  - Keep `STRIPE_API_VERSION` in `src/billing.ts` and the webhook endpoint's API version the same.
- **Keys:** prefer a restricted key (`rk_…`). Never print, log or commit key values.
- **Schema:** changes are backward compatible. New fields are optional and no data is dropped. Regenerate `convex/_generated` after Convex changes.
- **Convex functions:** every new one checks access with the helpers in `convex/auth.ts` and audits admin changes with `audit`.
- **Security review:** a tier can never switch security review off or weaken it. Security checks run on every tier, including the trial.
- **Self-hosting:** with `BILLING_ENABLED` unset, every entitlement is granted. Self-hosted installs are never gated.
- **Design:** follow DESIGN.md. Locked features show what they do and how to upgrade; they are never hidden.

## Pricing

Positioning: well under Greptile, which charges $30 per seat per month for 50 review credits, $1 for each extra credit, and gates SSO and audit logs to Enterprise.

| Plan | Price (per seat / month) | Included model usage | Status |
|---|---|---|---|
| **Free** | $0, no card | $3 per workspace per month (about 40 standard reviews) | Live |
| **Starter** | $12 ($10 billed annually) | $6 per seat, pooled | Live: `STRIPE_SEAT_PRICE_ID` |
| **Pro** | $24 ($20 billed annually) | $12 per seat, pooled | Live: `STRIPE_PRO_PRICE_ID` |
| Enterprise | Contact | Custom | Process only: SCIM, custom DPA, invoicing, self-host help |

- **Seats:** owners, admins and members count as seats; viewers are free.
- **Extra usage:** billed at model cost × 1.3 (set in the Stripe metered price), up to the admin cap.
- **Unit economics:**
  - A standard review costs about $0.06–0.07 in inference.
  - The worst case, with all included usage used, leaves about 47% margin after Stripe fees on both Starter and Pro.
  - At 10 reviews per developer per week, Starter's margin is about 72%.
  - Free costs at most $3 per workspace per month, and the deployment-wide `inferenceBudgets` cap bounds the total.
- **Spend ceiling:** the global inference budget (`convex/inferenceBudget.ts`) is the hard ceiling for the whole deployment.

## Feature matrix

Status: **gated** = enforced by `src/plans.ts` today; **planned** = on Pro by design, but every plan still gets it until it is gated.

| Feature | Free | Starter | Pro | Status | Entitlement key |
|---|---|---|---|---|---|
| Reviews, summaries, inline findings, suggestions, re-reviews, `.openreview.json` | ✓ | ✓ | ✓ | always on | none |
| Security checks and OSV advisories | ✓ | ✓ | ✓ | never gated | none |
| All providers, CLI, MCP, Claude Code/Codex plugins, chat, custom rules, 👍/👎 learning, Slack and email | ✓ | ✓ | ✓ | always on | none |
| Extra usage up to an admin cap |  | ✓ | ✓ | live | none |
| Deep reviews (agentic and hypothesis engines) |  |  | ✓ | gated | `review.deep` |
| Generated reproduction tests |  |  | ✓ | gated | `review.reproTests` |
| Fix pull requests |  |  | ✓ | gated | `fix.pullRequests` |
| Requirements check from Linear, Jira, Confluence and Notion |  |  | ✓ | planned | `context.requirements` |
| Learned conventions from human reviewers |  |  | ✓ | planned | `memory.conventions` |
| Public API keys |  |  | ✓ | planned | `api.access` |
| Analytics beyond 30 days |  |  | ✓ | planned | `analytics.history` |
| SSO (SAML / OIDC) and the audit log |  |  | ✓ | planned (both exist) | `auth.sso`, `audit.log` |

**Potential Pro features to build later:**
- Scheduled full-repository security audits.
- A merge gate that requires a minimum confidence score.
- A priority review queue.
- A model choice per repository.
- A weekly team quality digest.
- A cheaper bring-your-own-key seat (`convex/modelKeys.ts` already skips metering).

The phases below are the original build checklist. P0.1, P0.2, P1.1, P1.3 and P1.5 shipped with the Free/Starter/Pro plans (`src/plans.ts`, `billingAccounts.plan`, Checkout per plan, and the deep, repro-test and fix-PR gates). The Business tier is dropped: its SSO and audit items move to Pro.

---

## Phase 0: Entitlements foundation

### - [ ] P0.1 Plan catalog and entitlement keys
**Why:** features need one place that says which tier includes them.
**Files:** `src/billing.ts`, new `src/plans.ts`, `tests/billing.test.ts`, new `tests/plans.test.ts`.
**Build:**
- `src/plans.ts` exports:
  - `tiers = ["trial", "starter", "pro", "business"] as const`.
  - `entitlementKeys` (every key in the matrix above).
  - `planCatalog: Record<Tier, { name: string; reviewsPerSeat: number; entitlements: readonly EntitlementKey[] }>`.
  - `entitled(tier, key, billingEnabled)`, which returns true for every key when billing is disabled.
- The trial gets **Pro** entitlements (try everything), with its existing review cap.
- Keep `BILLING_REVIEWS_PER_SEAT` as the Starter override, and add `BILLING_PRO_REVIEWS_PER_SEAT` and `BILLING_BUSINESS_REVIEWS_PER_SEAT` with the defaults from the pricing table.

**Acceptance:**
- [ ] Unit tests: every matrix row maps to the right tiers, disabled billing grants everything, and unknown keys are a type error.
- [ ] `billingDecision` uses the tier's fair-use limit. Existing Starter behaviour and tests are unchanged.

### - [ ] P0.2 Store the tier on the billing account
**Depends on:** P0.1
**Files:** `convex/schema.ts` (`billingAccounts`), `convex/billing.ts` (`applyStripeEvent`, `status`), `convex/http.ts` (webhook parsing), `tests/billing.spec.ts`.
**Build:**
- Add optional `tier` to `billingAccounts` (absent means `starter` while subscribed).
- Map the subscription item's price to a tier with env `STRIPE_SEAT_PRICE_ID` (Starter), `STRIPE_PRO_PRICE_ID` and `STRIPE_BUSINESS_PRICE_ID` (and their annual variants after P3.2).
- Parse `items.data[0].price.id` in the webhook. An unknown price ID is recorded as outcome `unknown price` and changes nothing.
- `billing.status` returns `tier` and `entitlements`.

**Acceptance:**
- [ ] Convex tests:
  - Starter, Pro and Business subscription events set the tier.
  - An upgrade event updates it.
  - An older (stale) event cannot downgrade it.
  - An unknown price is ignored.
  - Cancellation falls back to the trial or locked state.

### - [ ] P0.3 Server-side gate helper
**Depends on:** P0.2
**Files:** `convex/billing.ts`, plus each feature entry point listed in P1.
**Build:**
- `export async function requireEntitlement(ctx, organizationId, key)`. It throws `Error("Upgrade required: <feature>")` and records nothing.
- `hasEntitlement(ctx, organizationId, key)` for soft checks, for example skipping a review stage.
- **Rule:** a gated stage inside a review is **skipped** and noted in the summary's coverage section. It never fails the review.

**Acceptance:**
- [ ] Tests: allowed and denied for every tier, always allowed with billing disabled, and a member of another workspace cannot probe the entitlements.

### - [ ] P0.4 Locked-feature UI pattern
**Depends on:** P0.2
**Files:** new `app/dashboard/locked.tsx`, `app/globals.css`, DESIGN.md.
**Build:**
- A `<Locked tier="pro" feature="Fix pull requests">` wrapper. It keeps the settings visible but disabled, adds one line saying which tier includes the feature, and links to Settings → Billing (admins) or tells members to ask an admin.
- No gradients and no modal upsell. The ember accent appears only on the upgrade link.

**Acceptance:**
- [ ] Renders at 390px with no horizontal scroll, in both themes; the e2e test checks the disabled state.

## Phase 1: Pro tier

### - [ ] P1.1 Pro product, Checkout and plan choice
**Depends on:** P0.2
**Files:** `convex/billingJobs.ts` (`checkout` gets a `tier` argument), `app/dashboard/billing.tsx`, `app/dashboard/onboarding/[step]/page.tsx` (plan step), `app/page.tsx` (pricing section).
**Build:**
- The plan step and Settings → Billing show Starter and Pro cards side by side. Each card's button opens Checkout for that tier's price. The remaining trial still carries over (`checkoutTrialEnd`).
- Prices are shown from `BILLING_<TIER>_PRICE_LABEL` and are display only. Stripe is the source of truth at Checkout.

**Acceptance:**
- [ ] Tests: Checkout uses the right price per tier, rejects unknown tiers, and keeps `integration_identifier` and the trial end.

**Human steps:**
- In Stripe, create the Product "OpenReview Pro" with a monthly per-unit price of $29.
- Set `STRIPE_PRO_PRICE_ID` on Convex.

### - [ ] P1.2 Upgrades and downgrades in the Customer Portal
**Depends on:** P1.1
**Files:** `convex/billingJobs.ts` (`portal`), `docs/billing.md`.
**Build:**
- The portal session uses a portal configuration (`STRIPE_PORTAL_CONFIGURATION_ID`) that lists the Starter and Pro products for switching plans, with prorations.
- Seat quantity stays app-controlled: quantity changes are disabled in the portal.

**Acceptance:**
- [ ] Test: the portal session includes the configuration. A webhook test covers an upgrade from Starter to Pro.

**Human steps:**
- Create the portal configuration in Stripe with plan switching on and quantity changes off.

### - [ ] P1.3 Gate the deep review engines (`engine.deep`)
**Depends on:** P0.3
**Files:** the review engine selection in `convex/reviews.ts`, `src/engine/*`, and review settings (`src/review-settings.ts`, the settings UI).
**Build:** when `mode` is agentic or hypothesis without the entitlement, run the default pipeline and add a coverage note: "Deeper review is on Pro."
**Acceptance:**
- [ ] Tests: the engine falls back on Starter, runs as chosen on Pro, and security checks run in both.

### - [ ] P1.4 Gate requirements context (`context.requirements`)
**Depends on:** P0.3
**Files:** the requirements check entry points (search `requirements` in `convex/` and `src/`), the integrations settings UI.
**Build:**
- Without the entitlement, tickets are not fetched and the check is skipped with a coverage note.
- Existing integrations stay connected, so upgrading turns them back on.

**Acceptance:**
- [ ] Tests: no ticket fetch on Starter (the fake fetch is not called), and a normal check on Pro.

### - [ ] P1.5 Gate fix pull requests and reproduction tests (`fix.pullRequests`, `review.reproTests`)
**Depends on:** P0.3
**Files:** the fix handling (search `fixPullRequests`), the repro test runner, `app/dashboard/onboarding/configure.tsx` (tools step).
**Build:**
- On Starter, `@openreview fix this` still replies with a validated suggestion. `… in a new PR` replies with one line saying fix pull requests are on Pro.
- In the onboarding tools step, show `<Locked>` on the fix-PR toggle.

**Acceptance:**
- [ ] Tests: no branch is created on Starter, the reply text is correct, and Pro works as before.

### - [ ] P1.6 Gate learned conventions and API/MCP access (`memory.conventions`, `api.access`)
**Depends on:** P0.3
**Files:** `convex/conventionJobs.ts`, `convex/conventions.ts`, `convex/apiKeys.ts`, `app/api/mcp`, `app/api/query`, `app/api/search`.
**Build:**
- Convention ingestion skips workspaces without the entitlement. Already approved conventions keep applying, because the customer paid for that learning.
- Creating API keys needs `api.access`. Existing keys return `402` with a JSON error on Starter. They are not deleted.

**Acceptance:**
- [ ] Tests: ingestion is skipped, existing rules still apply, key creation is denied, and the API returns 402 with an upgrade message.

### - [ ] P1.7 Fair-use alerts
**Depends on:** P0.1
**Files:** `convex/billing.ts` (`reviewAllowance`), `convex/notifications.ts`, the email templates.
**Build:**
- When a workspace crosses 80% and then 100% of its monthly fair-use limit, email the admins once per threshold per month and show a banner in Settings → Billing.

**Acceptance:**
- [ ] Tests: each alert is sent exactly once per threshold per month and never to viewers.

## Phase 2: Business tier

### - [ ] P2.1 Business product and Checkout
**Depends on:** P1.1
Same as P1.1, for "OpenReview Business" at $49.
**Human steps:** create the Product and Price, and set `STRIPE_BUSINESS_PRICE_ID`.

### - [ ] P2.2 SSO with SAML and OIDC (`auth.sso`)
**Depends on:** P0.3
**Files:** `convex/identity.ts`, `app/api/auth/*`, `src/oauth-flow.ts`, the settings UI.
**Build:**
- Per-workspace IdP configuration: SAML metadata URL or OIDC issuer and client.
- Domain verification by DNS TXT record.
- Optional "require SSO" for members of verified domains.
- Use a maintained, pinned library for SAML signature validation; never parse SAML by hand.

**Acceptance:**
- [ ] Tests:
  - An unsigned or wrong-audience assertion is rejected.
  - Assertion replay is rejected.
  - With "require SSO" on, other sign-in methods are blocked for that domain.
  - Owners keep a break-glass sign-in.

### - [ ] P2.3 SCIM provisioning (`auth.scim`)
**Depends on:** P2.2
**Build:**
- A SCIM 2.0 `/scim/v2/Users` and `/Groups` subset with per-workspace bearer tokens (hashed at rest).
- Deprovisioning removes membership and revokes sessions.
- Seat sync follows (`scheduleSeatSync`).

**Acceptance:**
- [ ] Tests: create, update, deactivate, token scoping, and seat sync scheduled.

### - [ ] P2.4 Audit log export and retention (`audit.export`)
**Depends on:** P0.3
**Files:** `app/dashboard` (Settings → Audit), the Convex audit queries.
**Build:**
- Admins export CSV or JSON for a date range, streamed and paginated.
- Business keeps 1 year of audit history; other tiers keep 90 days. Pruning runs in a cron.

**Acceptance:**
- [ ] Tests: the export covers only the workspace's own rows, the date range is respected, and pruning respects the tier.

### - [ ] P2.5 Spending caps (`billing.caps`)
**Depends on:** P1.7
**Build:**
- Admins set a monthly review cap below the fair-use limit.
- Reviews past the cap are blocked with a `Billing:` reason, as the trial quota does today.

**Acceptance:**
- [ ] Tests: the cap is enforced, raising it unblocks, and it resets monthly.

## Phase 3: Billing polish

### - [ ] P3.1 Grandfathering
**Depends on:** P1.3–P1.6
Workspaces that subscribed to Starter before a feature moved to Pro keep it until their next plan change. Store `grandfatheredEntitlements` on the billing account and record it in the audit log.

### - [ ] P3.2 Annual prices
**Depends on:** P1.1
- Add an annual price per tier product ($120, $290 and $490 per seat per year), with a monthly/annual toggle on the plan cards.
- Map each annual price ID to the same tier.
- Referral coupon: a repeating coupon discounts the whole first annual invoice. Give annual prices a separate `once` coupon, or skip the referral coupon for them (see [billing.md](../billing.md#referral-program)).

### - [ ] P3.3 Stripe Tax
**Depends on:** none (a human decision first)
- Only after the business has an active tax registration in Stripe: set `automatic_tax: { enabled: true }` on Checkout and collect billing addresses.
- Enabling it without a registration collects no tax.

### - [ ] P3.4 Go-live checklist
- Switch to live restricted keys (`BILLING_ALLOW_LIVE=true`) and create a live-mode webhook endpoint with the same events and API version.
- Run one real end-to-end subscription and refund it.
- Follow https://docs.stripe.com/get-started/checklist/go-live.
