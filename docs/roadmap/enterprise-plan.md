# Enterprise plan roadmap

A build checklist for an **Enterprise** plan above Pro. It is written so an AI coding agent can pick up the next unchecked item and finish it without other context. Humans can read it as the product plan. It follows the conventions of [pricing-tiers.md](pricing-tiers.md).

## How to use this file

1. Pick the first unchecked item (`- [ ]`) whose **Depends on** items are all checked.
2. Read every file listed under **Files** in full before you edit anything.
3. Build it with tests. Run the gate: `pnpm lint && pnpm typecheck && pnpm test`. UI changes also need `pnpm build`, and `pnpm test:smoke && pnpm test:e2e` when the local servers run.
4. Check the item off. Add one line under it: `done: <date> · <commit> · tests: <files>`.
5. Anything that needs a human (Stripe Dashboard, contracts, prices) goes in **Human steps** at the end of the item. Do not do it yourself. Never run Stripe CLI or Convex commands against a live account.

**Rules that always apply**
- Every rule in [pricing-tiers.md](pricing-tiers.md#how-to-use-this-file) still applies. That covers one Stripe Product per tier, webhook-only state changes, the pinned `STRIPE_API_VERSION`, restricted keys, backward-compatible schema, `convex/auth.ts` checks with `audit`, security review on every tier, and self-hosting never being gated.
- **Self-hosting:** with `BILLING_ENABLED` unset, nothing in this file runs and every entitlement is granted. The paid self-host support contract is a service agreement, never a license key or a code gate. The repo stays MIT.
- **Money values:** every dollar figure here is a proposal. Defaults live in env (`src/billing.ts` `billingConfig`), negotiated values live on the contract row, and Stripe prices are created per contract. Nothing is hardcoded in UI copy.
- **Operators only:** contracts are created and changed by operators (`requireOperator` in `convex/operator.ts`). There is no self-serve Checkout for Enterprise. Workspace admins can read their contract but cannot edit it.
- **Counting is auditable:** every billed contributor is a stored row that an admin can see. Nobody is billed from a number we cannot list.

## Pricing

| | Starter | Pro | Enterprise: Managed | Enterprise: Own key |
|---|---|---|---|---|
| Billing unit | named seat | named seat | **active contributor** | **active contributor** |
| Price per unit / month | $12 ($10 annual) | $24 ($20 annual) | ~$22 at 100+ contributors (list ~$30) | ~$15 (list ~$30 less included usage) |
| Included model usage | $6 per seat, pooled | $12 per seat, pooled | $12 per contributor, pooled | none: the workspace's own key pays |
| Extra usage | cost × 1.3 up to the cap | cost × 1.3 up to the cap | cost × 1.15 up to the cap | none: OpenReview meters nothing |
| Minimum | 1 seat | 1 seat | 25 contributors | 25 contributors |
| Payment | card, Checkout | card, Checkout | annual invoice, net terms | annual invoice, net terms |

- **Active contributor:** a person who authored a pull request that OpenReview reviewed (a review that reached `completed`) in the UTC calendar month. Defined exactly in E1.1.
- **Commitment:** the contract commits to N contributors for 12 months (N ≥ 25), invoiced up front. Months with more than N active contributors get a monthly true-up for the extra ones. Months with fewer are not refunded.
- **List price and discounts:** list near $30 gives room for the market's average negotiated discount (about 31% off list). Volume bands are per contract, so they are just the contract's unit price.
- **Unit economics (unverified):** a standard review costs about $0.065 in inference. That is the roadmap figure in `reviewsLeft` (`src/billing.ts`), not a measurement of production usage. At full use of the included $12, Managed keeps about $10 of $22 before Stripe and infra costs, about 45%. Own key keeps nearly all of $15. **E0.1 must replace these estimates with real `billingUsage` numbers before any price is quoted to a customer.**

**The trade-off, plainly:** Starter and Pro bill every owner, admin and member (`seatCount`), including people who never open a pull request. Enterprise bills only people whose pull requests we reviewed. A 120-member workspace with 80 active authors pays Pro for 120 seats ($2,880/month) but Enterprise Managed for 80 contributors ($1,760/month at $22). The $960/month gap is idle-seat revenue we give up on purpose. The 25-contributor minimum and the annual commitment are what limit that loss.

## Feature matrix additions

Enterprise gets every Pro entitlement (`entitlements` in `src/plans.ts`). New keys are added only when the feature that uses them ships, in Phase 4.

| Feature | Pro | Enterprise | Phase | Entitlement key |
|---|---|---|---|---|
| Everything on Pro | ✓ | ✓ | E0.2 | existing keys |
| Invoiced annual contract, net terms | | ✓ | E2 | none (billing mode) |
| Own-key mode with nothing metered | | ✓ | E0.4 | `model.ownKey` (existing) |
| SCIM provisioning | | ✓ | E4.1–E4.2 | `auth.scim` |
| Audit log export | | ✓ | E4.3 | `audit.export` |
| One contract across several workspaces | | ✓ | E4.4 | none (contract) |
| Custom retention terms | | ✓ | E4.5 | none (contract) |
| SLA and support terms | | ✓ | E4.6 | none (contract) |
| Self-host support and updates contract | n/a | n/a | E3.3 | never gated |

---

## Phase 0: Plan and contract foundation

### - [x] E0.1 Verify unit costs against real usage
done (build only; human steps still open): 2026-11-18 · uncommitted on `enterprise-phase-0` · tests: `tests/billing.spec.ts`. Built as `billing.costReport` from `billingUsage` only: cost per review is `usedMicros / reviews` per workspace-month (an upper bound, since chat and fix usage are included), with p50/p90 across workspace-months. The per-review join through `inferenceReservations` was skipped because that table has no index by usage row.
measured: 2026-11-18, production, read-only table export (nothing deployed). Source: `modelCalls.estimatedCost` summed per `reviewId`, 2026-10-02 to 2026-11-18. 231 reviews, $48.55 total, all from one workspace (since cancelled); the only live paid workspace has no reviews. Cost per review: mean $0.21, median $0.078, p90 $0.57, max $2.33. 73 reviews cost $0; without them the median is $0.22. So $12 of included usage covers about 57 average reviews, not the 185 the $0.065 estimate implies. One workspace is too small a sample to quote from: re-run when there are paying customers.
**Why:** the $0.065 review cost and the $12 included usage are estimates. A wrong number here is wrong in every contract for a year.
**Depends on:** none
**Files:** `convex/billing.ts`, `convex/schema.ts` (`billingUsage`, `inferenceReservations`), `src/billing.ts` (`reviewsLeft`).
**Build:**
- An `internalQuery` `billing.costReport({ months })` that returns, for each paid workspace and month, the following:
  - `usedMicros`, `overageMicros` and `reviews` from `billingUsage`.
  - Active seats.
  - The p50/p90 settled cost per review from `inferenceReservations.settledMicros`, joined through `usageId`.
- No UI. Operators run it with `npx convex run`.

**Tests:** `tests/billing.test.ts` checks that the report sums seeded rows correctly and returns nothing with billing disabled.
**Human steps:**
- Run the report on production for the last three months.
- Record the median and p90 cost per review and the monthly cost per active author in this file's Pricing section.
- Adjust the proposed $22, $15 and $12 figures before quoting any customer.

### - [x] E0.2 The `enterprise` plan in the catalog
done: 2026-11-18 · uncommitted on `enterprise-phase-0` · tests: `tests/plans.test.ts`
**Why:** entitlement checks, the webhook and the UI all read the plan from one place.
**Depends on:** none
**Files:** `src/plans.ts`, `src/billing.ts` (`BillingDecision`, `billingDecision`), `tests/plans.test.ts`.
**Build:**
- `plans = ["free", "starter", "pro", "enterprise"]` and `planCatalog.enterprise = { name: "Enterprise", entitlements }`. That is every key, the same as Pro today.
- `planForPrice` keeps returning only `starter | pro`. Enterprise prices are per contract, so the plan is recognised by product instead (E2.3).
- `upgradeNote` text stays the same: Pro features are named "on the Pro plan", which Enterprise includes.

**Tests:**
- `entitled("enterprise", key)` is true for every key.
- `planEntitlements("disabled")` is unchanged.
- An unknown plan string is still a type error.

### - [x] E0.3 Contract fields on the billing account
done: 2026-11-18 · uncommitted on `enterprise-phase-0` · tests: `tests/billing.test.ts`, `tests/billing.spec.ts`
**Why:** price, included usage, overage multiplier, minimum and mode differ per contract and must survive restarts.
**Depends on:** E0.2
**Files:** `convex/schema.ts` (`billingAccounts`), `src/billing.ts` (`BillingAccount`, `billingConfig`), `convex/_generated`.
**Build:**
- Add one optional field, `contract`, to `billingAccounts`. Absent means no Enterprise contract, so every existing row stays valid. Its fields:
  - `id` (a random nonce, written before any Stripe call).
  - `mode: "managed" | "ownKey"`.
  - `startsAt` and `endsAt` (UTC ms; start is the first of a month).
  - `committedContributors` and `minimumContributors`.
  - `contributorPriceCents` (per month) and `includedUsagePerContributorUsd` (0 for ownKey).
  - `overageMultiplier` (display only; Stripe's price holds the markup, as today).
  - `netDays` and `graceDays`.
  - `nonBillableAuthors: string[]`.
  - `stripe: { productId, commitPriceId, contributorPriceId, usagePriceId?, scheduleId? }`.
  - `notes?`.
- Add defaults to `billingConfig`, all overridable:
  - `BILLING_ENTERPRISE_MIN_CONTRIBUTORS` (25).
  - `BILLING_ENTERPRISE_USAGE_PER_CONTRIBUTOR_USD` (12).
  - `BILLING_ENTERPRISE_NET_DAYS` (30).
  - `BILLING_ENTERPRISE_GRACE_DAYS` (30).
- `plan` gains the value `enterprise`. The schema comment on `plan` is updated to match.

**Tests:**
- `billingConfig` parses the new env vars and falls back to the defaults on bad values.
- `tests/billing.spec.ts` checks that an existing row without `contract` still loads and bills as before.

### - [x] E0.4 Enterprise in the billing decision and the guards
done: 2026-11-18 · uncommitted on `enterprise-phase-0` · tests: `tests/billing.test.ts`, `tests/contributors.spec.ts`. `billingDecision` takes `activeContributors` as its last argument and returns `units` (billed contributors), which `fixRunLimit` uses. An `enterprise` row without a `contract` bills as Starter. Own key allows the enqueue pre-check and refuses any metered reservation. `convex/modelKeys.ts` needed no change. Not done here: a new workspace still needs `planSelectedAt` before reviews run; E2.2 must set it when it creates the contract.
**Why:** without this an Enterprise account bills as Starter, and seat sync would overwrite the committed quantity.
**Depends on:** E0.3, E1.2
**Files:** `src/billing.ts` (`billingDecision`, `fixRunLimit`), `convex/billing.ts` (`decide`, `hasEntitlement`, `settleUsage`, `status`, `scheduleSeatSync`, `seatSyncTarget`, `checkoutContext`), `convex/billingJobs.ts` (`checkout`, `changePlan`, `syncSeats`), `convex/modelKeys.ts`.
**Build:**
- `billingDecision` takes an optional `activeContributors`. For `plan === "enterprise"`:
  - **Managed:** `limit = max(committed, active) × includedUsagePerContributor`. The cap and overage work as today.
  - **Own key:** `limit = 0` and `capMicros = 0`. Any call that falls back to the operator's model is refused with "This workspace's contract uses its own model key. Save one in Organization Settings → Model." This is the "meters nothing" rule. `budgetModel` (`convex/budgetModel.ts`) already skips `reserveUsage` when a key is saved.
  - Past due allows `contract.graceDays` instead of `graceDays`, because net-30 invoices go `past_due` only after the due date.
- `settleUsage` treats `enterprise` like `starter`/`pro` when it computes `overage`. Own key never reaches it.
- `fixRunLimit` uses `proFixesPerSeat × max(committed, active)`.
- `scheduleSeatSync` and `syncSeats` do nothing for an account with `contract`. Membership never changes an Enterprise quantity.
- `checkout` refuses an account with `contract`. `changePlan` refuses `enterprise` with "Contract changes go through your OpenReview account manager."

**Tests (`tests/billing.test.ts`, `tests/billing.spec.ts`):**
- The managed limit uses the higher of committed and active.
- Own key refuses a metered reservation.
- Enterprise past due respects `contract.graceDays`.
- A member added to an Enterprise workspace schedules no `syncSeats`.
- `changePlan` and `checkout` refuse an Enterprise workspace.
- With billing disabled, everything is allowed.

## Phase 1: Counting active contributors

### - [x] E1.1 The contributor key and the bot rules
done: 2026-11-18 · uncommitted on `enterprise-phase-0` · tests: `tests/contributors.test.ts`. The GitLab bot pattern `^(project|group)_\d+_bot` is from memory of GitLab's access-token bot usernames (`project_<id>_bot_<random>`), not re-checked against the docs. GitLab service accounts are not treated as bots; list them in `nonBillableAuthors`.
**Why:** the count is the invoice, so the definition must be a pure function with tests.
**Depends on:** none
**Files:** new `src/contributors.ts`, new `tests/contributors.test.ts`. Read `convex/schema.ts` (`reviews`, `pullRequests`, `repositories`, `identities`, `providerIdentities`), `convex/identity.ts` (`githubAccounts`) and `src/review-settings.ts` (`newWorkspaceDefaults.excludedAuthors`).
**Build:**
- **Data source:**
  - PR authors are on `reviews.author`, copied from `pullRequests.author`. Older review rows have no `author`. For those, read `pullRequests` by `by_repo_number`.
  - The provider comes from the repository: `installationId` means GitHub; `connectionId` means a `providerConnections` row, whose `kind` and `instance` say which.
- **"Active" is defined as:** the set of distinct contributor keys over `reviews` with `organizationId = org`, `status = "completed"` and `finishedAt` in `[monthStart, nextMonthStart)` UTC (`periodKey(finishedAt)`). It excludes:
  - CLI reviews (`cliReviews` is a separate table and never counts).
  - Failed, cancelled and skipped reviews.
  - Reviews with no resolvable author.
- **Contributor key:** `contributorKey({ provider, connectionId?, login, userId? })` returns `user:<userId>` when the login maps to an OpenReview user, else `<provider>:<connectionId|github>:<login lowercased>`. A login maps to a user in either of two ways:
  - **GitHub:** an `identities` row with `provider: "github"` and that `login`.
  - **Other providers:** a `providerIdentities` row for that connection and `username`.
- **Same person on two providers:** one key when both accounts link to the same OpenReview user (Personal Settings → provider identities). Unlinked accounts count twice. The Billing & Usage list (E3.1) shows this, and the fix is to link the accounts, not to merge them by hand.
- **Bots never count:**
  - Any login ending in `[bot]`.
  - GitLab project and group bot users matching `^(project|group)_\d+_bot`. Confirm this pattern against GitLab docs while building.
  - Logins in the contract's `nonBillableAuthors`.
  - Authors in `excludedAuthors` are never reviewed, so they never appear.
  - A PR authored by a human but written by an agent (`reviews.aiAuthored`) counts the human.

**Tests:**
- One key per user across GitHub and GitLab when linked; two when not.
- The rule matches `dependabot[bot]`, `renovate[bot]` and GitLab bots.
- Case-insensitive logins.
- `nonBillableAuthors` is honoured.
- A missing author returns null.

### - [x] E1.2 A per-month contributor ledger
done: 2026-11-18 · uncommitted on `enterprise-phase-0` · tests: `tests/contributors.spec.ts`. One index (`by_org_period_key`) serves both lookups. Login-to-user lookup added three indexes: `identities.by_provider_login`, `providerIdentities.by_connection_username`, `users.by_login`. The backfill clears the month and refills it, so the count dips while it runs (`shortcut:` comment in `convex/contributors.ts`). The table is in the workspace purge list (`convex/dataControls.ts`). No cron was needed for this item.
**Why:** recounting a month of reviews at invoice time hits Convex read limits. The analytics rollup already caps at 4,000 rows a day (`convex/analyticsRollup.ts`). A ledger also gives admins the exact list they are billed for.
**Depends on:** E1.1
**Files:** `convex/schema.ts`, `convex/reviews.ts` (`finished`), new `convex/contributors.ts`, `convex/crons.ts`, `tests/contributors.spec.ts`.
**Build:**
- New table `activeContributors`:
  - Fields: `{ organizationId, period, key, login, provider, userId?, firstReviewId, firstAt, bot: boolean }`.
  - Indexes: `by_org_period_key` and `by_org_period`.
- In `reviews.finished`, when the status becomes `completed` and billing is on, upsert the author's row for `periodKey(now)`. Bots are stored with `bot: true`, so the admin list can show them as not billed.
- `contributors.count(organizationId, period)` counts rows with `bot: false`. `billing.decide` passes it to `billingDecision` for Enterprise accounts only.
- `contributors.backfill(organizationId, period)` is an internal mutation that pages `reviews` `by_org_time` for one month. Use it at contract start and in migration (E2.4).
- When a linked identity is added later, rows are not re-keyed retroactively for closed months. The current month is recomputed by the backfill.

**Tests:**
- Two reviews by one author give one row.
- A failed review gives no row.
- A bot row is not counted.
- A review finished at 23:59:59 UTC on the 31st lands in that month.
- The backfill matches the incremental count on seeded data.
- With billing disabled, no rows are written.

### - [x] E1.3 Report contributors above the commitment to Stripe
done (build only; human steps and E2.1 still open): 2026-11-18 · uncommitted on `enterprise-phase-0` · tests: `tests/billing.test.ts`, `tests/contributors.spec.ts`. `billing.queueContributorReports` runs monthly and skips contracts not in force in the closed month. Nothing has been sent to Stripe; the meter does not exist yet.
**Why:** the monthly true-up is billed by a metered price that Stripe needs a number for.
**Depends on:** E1.2, E2.1
**Files:** `convex/schema.ts` (`billingMeterEvents`), `convex/billing.ts` (`meterEvent`, `meterResult`), `convex/billingJobs.ts` (`reportUsage`), `convex/crons.ts`, `src/billing.ts`.
**Build:**
- `billingMeterEvents` gains an optional `kind: "usage" | "contributors"` (absent means usage) and an optional `quantity`.
- A cron at 00:10 UTC on the 1st runs over Enterprise accounts. It inserts one `contributors` row per account for the month that just closed, with `quantity = max(0, active − committed)`.
- `reportUsage` sends it to `STRIPE_CONTRIBUTOR_METER_EVENT` (default `openreview_contributors_over`):
  - `identifier`: `contributors:<org>:<period>`, so a retry is never billed twice.
  - `timestamp`: one second before the period ends.
  - `value`: the quantity.
- Zero is still reported, so the invoice line shows 0 and nothing is billed.
- Retries and backoff reuse `meterResult`. A row that ends `failed` logs `{"event":"billing.contributor_report_failed"}` for the operator.

**Tests:**
- The quantity is above the commitment only.
- The identifier is the same across retries.
- The timestamp falls inside the closed month.
- Usage rows still use the micro-dollar meter.
- An account without a contract gets no row.

**Human steps:**
- Create the meter `openreview_contributors_over` with aggregation **Sum**. One event per month makes Sum exact.
- In Invoice settings, add a finalization grace-period rule for **Has a metered price** + **Invoice is from a subscription cycle** of at least 24 hours. The default 1 hour is too short for a cron that may retry. Stripe allows up to 72 hours.

## Phase 2: Stripe contract and webhooks

### - [x] E2.1 Stripe objects
done (docs only; human steps still open): 2026-11-18 · uncommitted on `enterprise-phase-0` · `docs/billing.md` → Enterprise contracts. Changed from the text below: the true-up price needs the meter's ID, so there is a fourth setting, `STRIPE_CONTRIBUTOR_METER_ID`; `billing_mode: flexible` is sent explicitly (Stripe's default is classic); the term ends through the schedule's `end_behavior: cancel`, so `cancel_at: max_period_end` is not used.
**Why:** one product, with prices per contract, keeps the "one Product per tier" rule.
**Depends on:** E0.1
**Files:** `docs/billing.md` (Setup), `src/billing.ts` (`STRIPE_API_VERSION` stays `2026-08-26.dahlia`).
**Build (documentation and env names only):**
- **Product** "OpenReview Enterprise" (`STRIPE_ENTERPRISE_PRODUCT_ID`).
- **Per contract, on that product** (created by E2.2, never by hand):
  - **Commitment price:** licensed, `recurring.interval = year`, `unit_amount = contributorPriceCents × 12`, quantity = committed contributors.
  - **True-up price:** metered on the contributors meter, `recurring.interval = month`, `unit_amount = contributorPriceCents`.
- **Overage price:** metered on the existing `openreview_usage_micros` meter, month, with the 1.15 markup (`STRIPE_ENTERPRISE_USAGE_PRICE_ID`). It is shared by all Managed contracts. A contract that negotiates another multiplier gets its own price on the same meter. Own-key contracts have no overage item.
- **Subscription:** these items on one subscription, with these settings:
  - `collection_method: send_invoice` and `days_until_due: netDays`.
  - `billing_mode: flexible`, which mixed intervals require and which is the default on our API version.
  - `billing_cycle_anchor` on the first of a month, so Stripe's monthly periods match `periodKey`.
  - Metadata `organizationId` and `contractId`.
- **What the customer receives:** an annual invoice on day one for the commitment. Each month after that, an invoice for the true-up and overage, which may be $0.
- **Cancellation:** use `cancel_at: max_period_end` at end of term, never `cancel_at_period_end`. On a mixed-interval subscription the latter cancels at the first monthly period end.

**Tests:** none (docs).
**Human steps:**
- Create the product and the shared 1.15 overage price.
- Set `STRIPE_ENTERPRISE_PRODUCT_ID`, `STRIPE_ENTERPRISE_USAGE_PRICE_ID` and `STRIPE_CONTRIBUTOR_METER_EVENT` on Convex.
- In Billing settings, set what happens to a past-due invoiced subscription: **leave it past due**. The app's `graceDays` decides when reviews pause.
- Turn on Stripe's invoice reminder emails.

### - [x] E2.2 Operator creates a contract
done: 2026-11-18 · uncommitted on `enterprise-phase-0` · tests: `tests/enterprise.spec.ts`, `tests/billing.test.ts`. Changed from the text below: every contract is a subscription schedule, past or future start; Preview is computed by the app (`contractPreview`, before tax) and does not call `invoices/create_preview`; the backfill runs only for a contract already in force. Not verified: the request shapes were checked against Stripe's docs and a fake fetch, never against a Stripe sandbox, and the operator page section was type-checked but not opened in a browser. Renewing an existing contract is refused until E2.5.
**Why:** contracts are negotiated, so an operator enters them and the app creates the Stripe objects consistently.
**Depends on:** E0.3, E2.1
**Files:** new `convex/enterprise.ts` (queries and mutations), new `convex/enterpriseJobs.ts` (Stripe actions), `convex/operator.ts` (`requireOperator`, `recordAccess`), `app/dashboard/(portal)/operator/page.tsx`, `app/dashboard/actions.ts`, `tests/operator.spec.ts`.
**Build:**
- The operator page gets an "Enterprise contracts" section. It has a form: workspace, mode, start month, committed contributors (≥ minimum), monthly unit price, included usage, overage price (shared or custom), net days, grace days, non-billable authors and notes. Defaults come from `billingConfig`.
- **Preview** calls `POST /v1/invoices/create_preview` with the would-be subscription items and shows the first invoice and the first monthly invoice. Nothing is created.
- **Create**, in order:
  1. `enterprise.saveDraft` writes `contract` with a fresh `id` and audits `billing.contract_draft`.
  2. `enterpriseJobs.createContract` creates the two per-contract prices and then the subscription. A future start date uses a subscription schedule with `phases[0].duration = 1 year`. Each Stripe call has an idempotency key `contract:<id>:<step>`.
  3. The action saves the Stripe IDs.
- **Done:** the webhook (E2.3), not the action, sets `plan: "enterprise"`.
- Every step checks `requireOperator` with a browser session, is written to `operatorAudit`, and audits `billing.contract_created` on the workspace.
- `contributors.backfill` runs for the start month.

**Tests:**
- A non-operator is refused, and so is an API-key token.
- Committed below the minimum is refused.
- The start date must be the first of a month.
- The Stripe request bodies are right, including `send_invoice`, `days_until_due`, flexible mode, `max_period_end` and metadata (fake fetch).
- A retried create reuses its idempotency keys.

### - [x] E2.3 Webhook handling for invoiced subscriptions
done: 2026-11-18 · uncommitted on `enterprise-phase-0` · tests: `tests/enterprise.spec.ts`, `tests/billing.spec.ts`. The licensed item is preferred, with the old price-ID comparison kept as a fallback for payloads without `usage_type`. The contract's first event skips the stale check, because ordering is per subscription. The replaced Pro subscription's `deleted` event is recorded as `replaced subscription`.
**Why:** today's webhook picks the "seat item" by excluding one price ID and rejects a second subscription. Both break with three items and a contract that replaces Pro.
**Depends on:** E2.2
**Files:** `convex/http.ts` (`stripeObject`, the `customer.subscription.*` branch), `convex/billing.ts` (`applyStripeEvent`, `subscriptionArgs`), `tests/billing.spec.ts`.
**Build:**
- Parse `items.data[].price.product` and `price.recurring.usage_type` in `stripeObject`.
- Pick the licensed item (`usage_type === "licensed"`) as the seat or commitment item, for every plan. This replaces the `STRIPE_USAGE_PRICE_ID` comparison and covers Starter and Pro unchanged.
- Pass `metadata.contractId` and `product` through `subscriptionArgs`.
- **In `applyStripeEvent`:**
  - When `product === STRIPE_ENTERPRISE_PRODUCT_ID`, it sets `plan: "enterprise"` and `seats` = committed quantity.
  - A subscription whose `contractId` equals `account.contract.id` may replace a different live subscription. Only that case skips the "other subscription" guard. Every other second subscription is still refused.
- `invoice.paid` and `invoice.payment_failed` keep their current handling. Past due still arrives on `customer.subscription.updated`.
- Referral accrual is skipped for Enterprise invoices until the open question below is decided.

**Tests:**
- A three-item subscription records the commitment item and quantity.
- A Starter subscription with the usage item still records the seat item.
- A contract subscription replaces a live Pro one.
- A foreign second subscription is still "other subscription".
- An older event cannot downgrade Enterprise.
- `customer.subscription.deleted` for the replaced Pro subscription is ignored.

### - [x] E2.4 Move a Pro workspace to Enterprise
done: 2026-11-18 · uncommitted on `enterprise-phase-0` · tests: `tests/enterprise.spec.ts`. Changed from the text below: "start now" is a contract backdated to the 1st of the current month, which ends the old subscription about a minute later with prorations; there is no mid-month start, because contracts start on the 1st. Added: if the old subscription's `deleted` event arrives before the contract's first event, the contract takes over at once (`contract takeover`). Not verified against Stripe: `cancel_at` with `proration_behavior` on the old subscription.
**Why:** most Enterprise customers will start on Pro, mid-period, with a card on file.
**Depends on:** E2.3
**Files:** `convex/enterpriseJobs.ts`, `convex/billing.ts`, `docs/billing.md`.
**Build:**
- The operator form shows the workspace's current Pro subscription, if any, and the active contributors for the last three months (`activeContributors`, after a backfill). The committed number is set from data, not from seats.
- **Default, start next month:**
  1. Create the contract with a schedule that starts on the first of next month.
  2. Set the Pro subscription's `cancel_at` to that instant with `proration_behavior: none`. Pro bills normally until then.
- **Optional, start now:** cancel Pro immediately with prorations, which credits the unused Pro period to the customer balance. Then create the contract anchored to the next first, prorating the current partial month.
- The audit trail records `billing.migrated_from_pro`. SSO, API keys and conventions keep working, because Enterprise holds every Pro key.

**Tests:**
- The next-month path sets `cancel_at` and no proration.
- The webhook order "Enterprise created, then Pro deleted, in the same second" ends on Enterprise.
- Entitlements never drop to Free during the switch.

**Human steps:** sign the order form, then run the operator flow. Confirm the customer's billing email and tax details on the Stripe customer.

### - [x] E2.5 Renewal and end of term
done: 2026-11-18 · uncommitted on `enterprise-phase-0` · tests: `tests/enterprise.spec.ts`. Changed from the text below: a renewal is a second one-year schedule that starts when the first ends (kept in `billingAccounts.nextContract` until its subscription starts), not a new phase on the old schedule. The reminders live in `convex/enterprise.ts` and reuse `lifecycleEmails.send`. Added: `queueContributorReports({ final: true })` at 23:30 UTC on a term's last day, because a meter event sent after the subscription cancels is never invoiced. Not verified against Stripe: that a cancelling schedule invoices the final month's metered usage.
**Why:** an annual contract must not silently renew at last year's price or lapse into Free.
**Depends on:** E2.3
**Files:** `convex/enterprise.ts`, `convex/crons.ts`, `convex/lifecycleEmails.ts`.
**Build:**
- 60 and 30 days before `endsAt`, email the operator list and the workspace owners once each.
- The operator renews with the same form, which adds a new schedule phase with new prices, or lets the term end.
- At `max_period_end` the subscription cancels and the account falls back as a cancelled Pro subscription does today.

**Tests:** the reminders are sent once each, and an ended contract leaves the workspace with the same lapsed-plan behaviour as Pro.

## Phase 3: What customers see

### - [x] E3.1 Billing & Usage for an Enterprise workspace
done except the e2e test (human step still open): 2026-11-18 · uncommitted on `enterprise-phase-0` · tests: `tests/contributors.spec.ts` (admins get the price and the list, members only counts). `status` returns `enterprise`; the card reads "Enterprise plan" with the badge "Invoiced". Not done: the e2e render at 390px in both themes, because the local environment has no sign-in; the panel has been type-checked but never seen in a browser. DESIGN.md was not changed: the card reuses existing classes.
**Why:** admins must see what they committed to, who counted this month, and what the next invoice may hold.
**Depends on:** E0.4, E1.2
**Files:** `convex/billing.ts` (`status`), `app/dashboard/billing.tsx` (`BillingPanel`), `app/dashboard/sections/usage.tsx`, `app/dashboard/locked.tsx` (unchanged), DESIGN.md.
**Build:**
- `status` returns `contract` (mode, term, committed, minimum, unit price label, included usage, net days) and `activeContributors` for the month. Admins also get the list: key, login, provider, first review, and bot rows marked "not billed".
- The plan card reads "Enterprise plan" with the badge "Invoiced". The facts are:
  - The contract term.
  - "N active contributors this month of M committed". Above M: "K above commitment, billed on the next monthly invoice".
  - Included usage (Managed) or "Your own model key, nothing metered" (Own key).
- The card has no Checkout, plan switch or seat line.
- "Past Invoices" and "Billing Portal" stay. The portal session uses `STRIPE_ENTERPRISE_PORTAL_CONFIGURATION_ID`, with cancellation and plan switching off and invoices visible.
- The extra usage cap row stays for Managed.

**Tests:**
- An e2e test renders an Enterprise workspace at 390px in both themes.
- Members see counts but not the list.
- The cap form is hidden in Own-key mode.

**Human steps:** create the Enterprise portal configuration in Stripe.

### - [x] E3.2 Pricing page and docs
done: 2026-11-18 · uncommitted on `enterprise-phase-0` · tests: `tests/plans.test.ts` (`enterpriseOffer`). The card was checked in a browser at desktop and 375px widths. The contact link must be `mailto:` or `https:`. The onboarding line links to the same contact URL and is hidden without it.
**Why:** buyers need to know Enterprise exists and how it is billed before they talk to us.
**Depends on:** E0.2
**Files:** `app/page.tsx` (pricing section), `app/dashboard/onboarding/[step]/page.tsx` (plan step), `docs/billing.md`, `README.md`.
**Build:**
- Add a third pricing card, "Enterprise". It shows `BILLING_ENTERPRISE_PRICE_LABEL` (for example "From $22 per active contributor") and four facts: active-contributor billing, the minimum, the invoiced annual contract, and the own-key option.
- The card links to `BILLING_ENTERPRISE_CONTACT_URL` (a mailto or form). With no URL set, the card is hidden.
- The onboarding plan step shows one line: "50+ developers? Talk to us about Enterprise."
- `docs/billing.md` gets an Enterprise section covering the definition of active contributor, the bot rules, the true-up, net terms, the operator flow and the human steps.

**Tests:** the pricing page renders the card only with a contact URL and never when billing is off.

### - [x] E3.3 Self-host support and updates contract
done (docs only; human steps still open): 2026-11-18 · uncommitted on `enterprise-phase-0`. The section is in `docs/deployment.md` and in `docs/public/self-hosting.md`, which is the page the site serves at `/docs/self-hosting`.
**Why:** self-hosting companies want a vendor to call. The code stays MIT and ungated.
**Depends on:** none
**Files:** `docs/deployment.md`, `README.md`, `app/page.tsx` (one line under Pricing).
**Build:**
- **Docs:** what the contract covers and does not cover. It covers named support contacts, response targets, upgrade help and security advisories ahead of public release. It does not cover feature access or a license key.
- **Billing:** a separate Stripe Product "OpenReview Self-Hosted Support", invoiced yearly by hand from the Dashboard. No app code touches it.
- **Never:** no telemetry, phone-home or license check is added for this.

**Tests:** none. Review the docs.
**Human steps:** write the support terms and create the product.

## Phase 4: Later

### - [x] E4.1 SCIM users (`auth.scim`)
done: 2026-11-19 · uncommitted on `enterprise-phase-0` · tests: `tests/scim.test.ts`, `tests/scim.spec.ts`. Built in `src/scim.ts`, `convex/scim.ts`, `src/scim-server.ts` and four routes under `app/api/scim/v2`, with a settings card under Enterprise SSO. People are matched by verified email; someone without an account joins at first SSO sign-in (`scimJoin` in `convex/sso.ts`). Request bodies cross to Convex as JSON text, because Convex values cannot carry SCIM's `$ref` field. Not built: `/Bulk`, `/Schemas`, `/ServiceProviderConfig`. Not verified against a live identity provider, and the settings card has not been seen in a browser. `auth.scim` and `audit.export` are Enterprise only; Pro and grandfathered Starter keep every earlier feature.
**Why:** large customers deprovision from their IdP. Not in the first release.
**Depends on:** E0.4
**Files:** `convex/sso.ts`, `convex/schema.ts`, new `app/api/scim/v2/Users/route.ts`, `src/plans.ts`.
**Build:**
- A SCIM 2.0 `/Users` subset: list, get, create, patch active, delete.
- Per-workspace bearer tokens, hashed at rest.
- Deactivation removes membership and revokes sessions.
- Active-contributor counting is unaffected, because it is based on pull requests, not membership.

**Tests:**
- Token scoping across workspaces.
- Deactivate revokes sessions.
- Unknown attributes are ignored.
- Rate limits apply.

### - [x] E4.2 SCIM groups and role mapping
done: 2026-11-19 · uncommitted on `enterprise-phase-0` · tests: `tests/scim.spec.ts`. Stricter than the text below: SCIM never changes an owner's role at all, and the last owner cannot be deprovisioned (409). Once any group is mapped, someone in no mapped group is a member.
**Depends on:** E4.1
**Build:** `/Groups` with a mapping from IdP group to role (admin, member, viewer). The owner role is never assigned by SCIM.
**Tests:** a group change updates roles, and SCIM can never remove the last owner.

### - [x] E4.3 Audit log export (`audit.export`)
done: 2026-11-19 · uncommitted on `enterprise-phase-0` · tests: `tests/audit-export.test.ts`, `tests/enterprise.spec.ts`. `scopes.activityExport` pages 500 rows; `app/api/audit/export` streams CSV or JSON. CSV cells that would start a spreadsheet formula are quoted as text. Confirmed: nothing pruned `auditEvents` before; E4.5 adds the only prune, and only when a contract asks for it. The route itself (streaming, download headers) has no automated test.
**Depends on:** E0.2
**Files:** `convex/scopes.ts` (audit queries at the `audit.log` checks), `app/dashboard/scopes.tsx`, `convex/schema.ts` (`auditEvents`).
**Build:**
- CSV and JSON export for a date range, streamed and paginated, for admins.
- Export does not expire. Check whether `auditEvents` is pruned at all today: no cron in `convex/crons.ts` prunes it.

**Tests:** the export contains only the workspace's own rows, the range is respected, and members are refused.

### - [x] E4.4 One contract across several workspaces
done: 2026-11-19 · uncommitted on `enterprise-phase-0` · tests: `tests/enterprise.spec.ts`. `billingAccounts.contractGroupId` names the billed workspace (index `by_contract_group`); `contractGroup` in `convex/billing.ts` resolves it for every billing decision. Extra usage is metered to the billed workspace. Known limits: agent fix runs and usage alert emails are still counted per workspace, not pooled; a group is read up to 100 workspaces.
**Depends on:** E2.3, E1.2
**Build:**
- An optional `contractGroupId` on `billingAccounts`. One workspace is billed, and the others point to it.
- Active contributors are deduped by key across the group. Included usage is pooled across the group.
- The operator page shows the rollup.

**Tests:**
- An author active in two workspaces counts once.
- Usage pools across the group.
- Removing a workspace from the group returns it to its own plan.

### - [x] E4.5 Custom retention terms
done: 2026-11-19 · uncommitted on `enterprise-phase-0` · tests: `tests/enterprise.spec.ts`. `contract.retention` holds `minDays`, `maxDays` and `auditDays`. The terms apply only once the workspace is on Enterprise. With a contract maximum, "unlimited" is refused and an older unlimited setting is treated as the maximum.
**Depends on:** E0.3
**Files:** `convex/dataControls.ts` (`saveSettings`, `retentionSweep`).
**Build:**
- A contract may set the bounds for `reviewRetentionDays` and `transcriptRetentionDays`, which today are 7 to 3,650 days.
- It may also set an audit-event retention period, enforced by a new prune.

**Tests:**
- Settings outside the contract's bounds are refused.
- The sweep honours contract bounds.
- With no contract, behaviour is unchanged.

### - [x] E4.6 SLA and support terms
done (the numbers are the owner's to fill in): 2026-11-19 · uncommitted on `enterprise-phase-0` · tests: `tests/enterprise.spec.ts`. `contract.supportTier` shows on the Operator page and in Billing & Usage. `docs/sla.md` describes the structure and deliberately states no response or availability numbers and no status page address.
**Depends on:** E2.2
**Build:**
- A `contract.supportTier` field (display only) shown on the operator page and in Billing & Usage.
- An SLA document and status-page link in `docs/`.
- No runtime behaviour.

**Tests:** the field is displayed.

### - [x] E4.7 Own cloud account for Own-key mode
done: 2026-11-19 · uncommitted on `enterprise-phase-0` · tests: `tests/cloud-models.test.ts`. `src/cloud-models.ts` adds Bedrock, Azure OpenAI and Vertex through each provider's OpenAI-compatible endpoint, so the existing client is reused. Auth is a Bedrock API key (bearer), an Azure `api-key` header, and a Vertex access token minted from a service account key. Endpoints were read from the providers' docs on 2026-11-19; nothing was run against a real account. Limits: Bedrock's endpoint serves only models whose model card lists Chat Completions (AWS's docs do not say Claude does), there is no SigV4 or Converse support, a Vertex token is minted once per job and lasts an hour, and the Azure key check accepts any answer except 401 or 403.
**Why:** "own key or cloud account" is in the offer, but `modelKeys.save` accepts only `anthropic`, `openai` and `openrouter`.
**Depends on:** E0.4
**Files:** `convex/modelKeys.ts`, `convex/modelKeyJobs.ts`, `convex/budgetModel.ts`, `src/egress.ts`.
**Build:**
- Add AWS Bedrock, Google Vertex and Azure OpenAI as key providers, with the provider's own auth.
- Test the connection on save, as today.

**Tests:**
- Each provider's request shape (fake fetch).
- No egress when offline.
- Calls are never metered.

## Approved decisions

The owner approved this plan on 2026-11-18 with these answers. Items above already follow them.

- **Start dates:** every contract starts on the 1st of a month.
- **Own cloud accounts:** Own-key mode launches with Anthropic, OpenAI and OpenRouter keys. Bedrock, Vertex and Azure stay in Phase 4 (E4.7).
- **Agent-authored pull requests:** not billed at launch (the bot rule stands). Revisit once real usage shows what they cost in Managed mode.
- **Prices:** no price is quoted to a customer until E0.1 has replaced the $0.065 per review estimate with measured cost.

## Risks and open questions

- **Idle-seat revenue:** Enterprise gives it up by design (see Pricing). If many Pro customers with low author ratios ask to move, Pro revenue falls. Only offer Enterprise at 25+ committed contributors.
- **Unverified costs:** $0.065 per review is not measured (E0.1). Own-key contracts carry our infra cost with no usage revenue. Check whether $15 covers indexing and storage for large monorepos.
- **Agent-authored pull requests:** PRs opened by agent apps (`copilot-swe-agent[bot]`, Devin and similar) end in `[bot]` and are free under the bot rule, but cost real inference in Managed mode. As agents author more PRs, this grows. Decide whether to bill the human who triggered the agent, or price per review for bot authors.
- **Same person, unlinked accounts:** counted twice until they link identities. The admin list makes it visible. Decide whether operators may issue a credit note instead of a code fix.
- **Contributors before linking:** keys for closed months are not recomputed. Disputes are settled with credit notes, never by rewriting history.
- **Stripe timing:** the true-up relies on usage reported within the invoice finalization grace period, after the period ends. A missed cron run past the grace period means that month's true-up is lost (Stripe accepts the event but does not add it to any invoice). Monitor `billing.contributor_report_failed`.
- **Mid-cycle price changes:** Stripe drops grace-period usage when an item's price changes mid-cycle. Renewals and price changes must take effect on the first of a month.
- **Referral commissions:** should invoiced Enterprise revenue earn referral commissions (`convex/referrals.ts` accrues on `invoice.paid`)? It is skipped until decided.
- **Existing subscriptions' billing mode:** Starter and Pro subscriptions were created by Checkout on `2026-08-26.dahlia`, where flexible is the default for new API subscriptions. Confirm in the Dashboard which mode existing subscriptions use. This matters only if a Pro subscription is ever converted in place instead of replaced (E2.4 replaces).
- **Stripe recommends Metronome** for new usage-based integrations. We stay on Billing Meters because the app already reports usage with them, which the docs say is fine. Revisit if contract usage pricing grows more complex.

---

## Unverified items

These were checked against code or Stripe docs (docs.stripe.com, read November 2026); the rest were not:
- **Confirmed in Stripe docs:**
  - Mixed-interval subscriptions with a yearly licensed and monthly metered item need flexible billing mode and API ≥ `2025-06-30.basil`, and cannot be made by Checkout.
  - `send_invoice` with `days_until_due` works on subscriptions.
  - Meter aggregation is sum, count or last.
  - Meter event timestamps may be up to 35 days in the past.
  - The default finalization grace is 1 hour, configurable up to 72 hours by rule, and it only covers subscription-cycle invoices.
  - `cancel_at: max_period_end` exists.
  - Subscription schedules support mixed intervals with `duration`.
  - Tiered pricing works with usage.
- **Not confirmed:**
  - That `POST /v1/invoices/create_preview` previews a future-dated mixed-interval schedule.
  - That Stripe Quotes support this item mix. Quotes are not used.
  - The GitLab bot-user login pattern.
  - That a Customer Portal configuration can hide cancellation per session. The existing roadmap assumes `configuration` per session.
