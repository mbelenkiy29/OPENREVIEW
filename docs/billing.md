# Billing (cloud mode)

Billing is for hosted deployments only. With `BILLING_ENABLED` unset (the self-host default), reviews have no quota, the Stripe webhook endpoint returns 404, and the billing page says billing is off.

## Plans

- **Choosing a plan (new workspaces):** a workspace created while billing is on (`organizations.planRequired`) must choose a plan before anything else. Setup goes workspace → **Choose your plan** → connect. The plan step starts Stripe Checkout for the Starter plan with a `BILLING_TRIAL_DAYS` (default 14) day trial, and the card is always collected (`payment_method_collection: always`). The choice is recorded (`organizations.planSelectedAt`, `plan`, audit `billing.plan_selected`) only when Stripe confirms it: `checkout.session.completed` with a subscription, or a subscription that is trialing, active or past due. Until then the dashboard sends everyone to the plan step (Billing and Account settings stay open), and the server refuses indexing, reviews, advancing and finishing setup.
- **Trial (older workspaces):** workspaces from before plans were required have no `planRequired` flag and keep the app-level trial: `BILLING_TRIAL_DAYS` days, starting at the first review or first Checkout, with no card.
- **Starter (per seat):**
  - A Stripe subscription whose quantity is the number of active seats. Owners, admins and members are seats; viewers are free.
  - Reviews are unlimited under a monthly fair-use limit of seats × `BILLING_REVIEWS_PER_SEAT` (default 500).
  - The landing page, the setup plan step and Settings → Billing show `BILLING_SEAT_PRICE_LABEL` (for example `$12 per seat / month`). Set it on the web app and keep it in sync with the Stripe price.
- **Seat changes:** accepting an invitation or changing a member's role resyncs the subscription quantity, with prorations.
- **Past due:** reviews continue for `BILLING_GRACE_DAYS` (default 7) after the first failed payment, then pause until an invoice is paid.
- **Cancelled:** the workspace falls back to any remaining trial.

Higher tiers (Pro, Business) are planned in [roadmap/pricing-tiers.md](roadmap/pricing-tiers.md).

## Choosing a plan during setup

When billing is on, guided setup adds a **Choose your plan** step after inviting the team. It shows the Starter plan, the seat count and the trial, and offers two choices:
- **Add payment method:** opens Stripe Checkout and returns to the step.
- **Continue on the trial:** subscribe later in Settings → Billing.

Checkout carries any remaining trial into the subscription (`subscription_data.trial_end`), so the card is not charged until the trial ends. Stripe requires a trial end at least 48 hours away, so a trial with less time left is charged at Checkout. Without billing, the step does not exist and setup has one step fewer.

When a review is blocked, it is recorded as failed with a `Billing:` reason, visible on the pull request's review page. Blocked reviews are also counted on **Settings → Billing**.

## Discounts and free months

Checkout shows an **Add promotion code** box. To give a prospect a free month:
1. **Coupon:** create one in Stripe (Product catalog → Coupons): 100% off, duration **Multiple months** = 1, limited to the Starter product.
2. **Promotion code:** give the coupon a single-use code (limit 1 redemption, with an expiry date) and send that code to the prospect. Reuse the coupon and create one code per prospect.

The prospect enters the code at Checkout, from the setup plan step or Settings → Billing. Their first billed month is free for every seat. Any remaining trial still comes first, so the first charge falls one month after the trial ends, or one month after Checkout if the trial is over.

**Existing subscriptions:** in the Stripe Dashboard, open the subscription and choose **Actions → Update subscription → Add coupon**. The discount applies from the next invoice.

**Deactivating:** archive a promotion code to stop new redemptions. Deleting a coupon also stops them, and keeps the discounts already applied.

## Setup (operator)

1. **Sandbox:** use a Stripe sandbox (or test mode) for setup and testing.
2. **Product and price:** create the Product "OpenReview Starter" with a recurring, per-unit monthly price. Set its ID as `STRIPE_SEAT_PRICE_ID`. Each future tier gets its own Product.
3. **Webhook:** add the endpoint `https://<convex-site>/stripe/webhook` on API version `2026-08-26.dahlia` (`STRIPE_API_VERSION` in `src/billing.ts`) for these events:
   - `checkout.session.completed`
   - `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`
   - `invoice.payment_failed` and `invoice.paid`
   - with the [referral program](#referral-program): `charge.refunded`, `charge.dispute.created` and `charge.dispute.closed`

   Set its signing secret as `STRIPE_WEBHOOK_SECRET`.
4. **API key:** create a restricted key (`rk_test_…`) with write access to Customers, Checkout Sessions, Customer portal and Subscriptions. Set it as `STRIPE_SECRET_KEY` on Convex (a `sk_test_…` key also works).
   - With the referral program, also give it read access to Charges, Disputes, Invoices and Invoice payments. Customers write already covers customer balance transactions (referral credit). Permission names vary in the Dashboard: make one credit and one refund in the sandbox and check the key's request log for denied calls.
5. **Turn on billing:** set `BILLING_ENABLED=true` on Convex, and on the web app so the landing page shows pricing and the setup step count is right. Live keys (`rk_live_…`/`sk_live_…`) are refused unless `BILLING_ALLOW_LIVE=true`.
6. **Customer Portal:** turn it on in Stripe so admins can manage their payment method, invoices and cancellation. Turn off quantity changes, because seats follow workspace membership.
7. **Tax:** turn on Stripe Tax only after you have an active tax registration; until then Stripe collects no tax.

On Vercel, Stripe can also be provisioned from the Vercel Marketplace. The keys still belong in the Convex environment, because Convex runs Checkout, the portal and webhook handling.

## Switching from test to live

1. **Activate payments** on the Stripe account (business details and bank account) and fill in **Settings → Public details**: business name, support email and statement descriptor. Then, in live mode, create the same Product and Price, webhook endpoint (same events and API version) and portal configuration as in test mode, with the site's `/privacy` and `/terms` links in the portal.
2. **Live keys:** create a live restricted key (`rk_live_…`) with the same permissions. Set it as `STRIPE_SECRET_KEY`, and the live endpoint's signing secret as `STRIPE_WEBHOOK_SECRET`.
3. **Convex settings:** set `STRIPE_SEAT_PRICE_ID` to the live price and `BILLING_ALLOW_LIVE=true`.
4. **Drop test links:** test customers and subscriptions do not exist in live mode, so every workspace must drop its Stripe links. Run this once:
   ```bash
   npx convex run billing:forgetStripeLinks '{"confirm":"switch-stripe-mode"}' --prod
   ```
   Each workspace returns to its trial with the same end date, and its next Checkout creates a live customer.
5. **Old webhook:** cancel the test subscriptions and disable the test-mode webhook endpoint, so the sandbox stops sending events (and retries) that would now fail signature checks.
6. **Referrals:** commissions, credits and payout accounts don't record the Stripe mode. Keep `REFERRALS_ENABLED` off on a deployment until it is live. A deployment where any test invoice earned a commission (any `referralCommissions` row) must not be switched to live, even after voiding them: its referrals stay marked as paid, so live Checkout gives no coupon, the commission window counts from the test invoice and the conversion email is not sent again. Use a separate deployment. If referrals were on but no commission was ever earned, only delete its `referralPayoutAccounts` rows (test `acct_…` IDs don't exist in live mode). Add the three charge events to the live webhook endpoint too, and enable Connect in live mode.

## Referral program

Off unless `REFERRALS_ENABLED=true` and `BILLING_ENABLED=true`, on both Convex and the web app. Every signed-in user gets a link (`/r/<code>`) under Settings → Referrals. A new account created through it is credited to the link's owner, and so is the first workspace it creates.

- **Discount:** a referred workspace that has not paid yet gets the Stripe coupon `STRIPE_REFERRAL_COUPON_ID` at Checkout (`discounts`), and the subscription carries `metadata.referralId`. Promotion codes are never offered.
- **Commission:** each paid subscription invoice of a referred workspace earns the referrer `REFERRAL_RATE_BPS` (default 2000 = 20%) of the cash collected, excluding tax pro rata. Credits and overpayments don't count (an invoice they pay in full earns nothing but still counts as the workspace's first payment), $0 invoices and invoices in another currency than USD earn nothing, and one-off invoices without a subscription are skipped.
  - It lasts `REFERRAL_MONTHS` (default 12), counted from the earliest paid invoice. An invoice created after that ends the referral.
  - Each commission is held `REFERRAL_HOLD_DAYS` (default 30) after the payment before it counts toward the referrer's balance.
  - Commissions are computed in a job scheduled from the `invoice.paid` webhook, never in the webhook itself, so a referral problem cannot block billing.
  - The referrer gets one email when the workspace first pays, if they have a verified email (an email, Google, GitLab or SSO sign-in, or a verified address in Settings → Notifications).
- **Self-referral:** you can't use your own code. Checkout gives no coupon to a workspace the referrer is or ever was a member of, and the referral is voided at its next paid invoice, with its commissions still on hold.
- **Codes in Settings → Billing:** owners and admins can add a referral code to a workspace that has none, within its first 30 days and before it has subscribed. The code's owner must not be, or ever have been, a member of the workspace, nor someone the caller referred, and a caller who was already referred can only bring that same referral. Five attempts per person per hour.
- **Refunds and disputes:** `charge.refunded`, `charge.dispute.created` and `charge.dispute.closed` take a commission back in proportion to the cash its invoice lost. The webhook only queues a job; the job reads the charge (and its dispute) from Stripe, then every invoice the charge's PaymentIntent paid (`/v1/invoice_payments`), so out-of-order events cannot leave a stale state. An open or lost dispute counts as lost; a won, `warning_closed` or `prevented` one gives the commission back. Clawbacks follow `BILLING_ENABLED`, not `REFERRALS_ENABLED`, so they continue after the program is switched off. A refund of a deleted workspace still counts. A failed Stripe read is retried at 1, 4, 16 and 64 minutes, then logged as `{"event":"referral.charge_unresolved"}`; re-run it with `npx convex run referralJobs:resolveChargeEvent '{"chargeId":"ch_…","kind":"refund"}'`. A refund that arrives before its invoice's commission exists is looked at again on the same schedule.
  - `refund.failed`, `refund.updated` and `charge.dispute.updated` are not handled: a refund that later fails, or a dispute that changes without closing, is corrected at that charge's next event or by hand.
  - **Negative balance:** a clawback after the referrer redeemed makes their balance negative. Credits already applied are not taken back; future commissions pay the difference first.
  - **Credit notes** that only credit the customer balance (no refund) send no charge event. Void the commission by hand with `referralOps:voidCommission`.
- **Workspace credit:** once at least $10 is available, a referrer can apply it to the bill of a workspace they own or administer that has a Stripe customer (Settings → Referrals). It becomes a negative customer balance transaction with `metadata.referralRedemptionId`, which Stripe takes off the workspace's next invoices, and it shows as **Referral credit** in that workspace's Settings → Billing. The workspace must be billed in USD. Ten requests per person per hour.
  - Each credit is posted with a stored idempotency key (`referral-credit:<id>:1`), and every attempt first looks the balance transaction up, so a retry or a crash never credits twice. Network errors, 409 and 429 responses and offline mode retry with the same key; a 5xx is never posted again, only looked up; any other 4xx fails the credit after a lookup finds nothing, and the amount returns to the referrer's balance.
  - A cron retries credits still processing every 15 minutes while billing is on. One that cannot be confirmed for a day after a 5xx, or that is still processing after 3 days, is logged as `{"event":"referral.redemption_stuck"}`.
- **Moving to another workspace:** until the workspace it is on subscribes, even to a trial, the referral moves to the workspace its referred person opens Checkout from, if they own it, it has never paid, and it was created after they signed up or is the one they added the code to.
- **Cash payouts** (`REFERRAL_PAYOUTS_ENABLED=true` on Convex): a referrer cashes out to a bank account through their own Stripe Connect account (Settings → Referrals → **Cash out with Stripe**). See [Cash payouts (Stripe Connect)](#cash-payouts-stripe-connect).

### Setup

1. **Coupon:** create a coupon, for example `referral-20-3mo` with `percent_off=20`, `duration=repeating` and `duration_in_months=3`. Set its ID as `STRIPE_REFERRAL_COUPON_ID` on Convex, and describe it in `REFERRAL_DISCOUNT_LABEL` on the web app (for example `20% off the first 3 paid months`). Never create promotion codes for it.
   - The coupon's months start when the subscription is created, which is the start of a carried trial. With `BILLING_TRIAL_DAYS` under 28, 3 months cover 3 paid monthly invoices. For longer trials, set `duration_in_months` to `2 + ceil((trialDays + 1) / 28)` (`couponMonthsNeeded(3, trialDays)` in `src/referrals.ts`) and word the label "at least the first 3 paid months".
   - `max_redemptions` and `redeem_by` are optional. When the coupon is used up, expired or deleted, Checkout continues without the discount and logs `{"event":"referral.coupon_unavailable"}`.
   - **Annual prices** (pricing-tiers P3.2): a repeating coupon discounts the whole first annual invoice. Use a separate `once` coupon for annual prices, or none.
2. **Settings:** set `REFERRALS_ENABLED=true` on Convex and on the web app. `REFERRAL_RATE_BPS`, `REFERRAL_MONTHS` and `REFERRAL_HOLD_DAYS` are read on Convex.
3. **Deploy order:** `npx convex deploy --cmd '<build>'` builds the web app first and pushes the Convex functions afterwards, and Vercel promotes the build only after both succeed, so forward deploys are safe. **Never roll Convex back past the referral sign-up release (Phase 1) without first setting `REFERRALS_ENABLED=false` on the web app**: the web app would send referral codes to functions that no longer accept them, and referred sign-ins would fail.

### Cash payouts (Stripe Connect)

- **Accounts:** **Set up payouts** creates an Accounts v2 connected account with the Express dashboard and the `recipient` configuration (`stripe_balance.stripe_transfers`), `fees_collector` and `losses_collector` set to `application`, and `metadata.userId`. Stripe-hosted onboarding collects the identity, tax and bank details; OpenReview stores only the account ID, its country and its transfer status (`referralPayoutAccounts`). The idempotency key is `referral-account:<userId>:<COUNTRY>:<hash of contact email>`, since Stripe keeps v2 keys for 30 days.
- **Status:** the transfer status (`configuration.recipient.capabilities.stripe_balance.stripe_transfers.status`) and the earliest requirement deadline are read from Stripe when Settings → Referrals loads (at most once a minute per account), including the return from onboarding (`?payouts=return`), and again before every transfer. There is no Connect webhook or notification banner. An account onboards the first time its status is `active`; after that, **Continue setup** opens an `account_update` link instead of `account_onboarding`.
- **Cash out:** at least $50, at most the available balance, ten requests per person per hour. Each one is a `/v1/transfers` from the platform's balance with `transfer_group=referral-redemption-<id>` and `metadata.referralRedemptionId`, posted with a stored idempotency key (`referral-transfer:<id>:1`) after a lookup by `transfer_group`, with the same retry rules as credits. A `balance_insufficient` answer keeps the cash-out processing, and once a lookup confirms no transfer exists, the next try uses a new key (`…:2`), because Stripe saves that answer under the old key for 24 hours. Before each post the referrer's balance is checked again: a cash-out not yet sent (paused, or waiting on `balance_insufficient`) fails, returning the amount, once refunds or disputes have left the balance below zero.
- **Review:** a cash-out that brings the referrer's cash-outs (all but failed ones) over $500 in 30 days waits in `review` and logs `{"event":"referral.payout_review"}`, so splitting one doesn't skip it. Approve or reject them with the operator tools below; approving refuses when refunds or disputes since the request left the referrer's balance below zero.
- **Recent sign-in:** setting up payouts, cashing out and opening the Stripe dashboard need a browser sign-in from the last 15 minutes. While payouts are on, so does linking another provider (Settings → Account), since the linked provider could later sign in fresh; the session a link starts keeps the linking session's sign-in time (`sessions.signedInAt`). With an older session (or an API key) the request is refused and the web app signs the session out and asks for a new sign-in.
- **Switch:** with `REFERRAL_PAYOUTS_ENABLED` (or `REFERRALS_ENABLED`) off, the Cash out card is hidden, no new cash-outs are accepted, and cash-outs already processing pause (`pausedAt`) without a transfer. They are not reported as stuck or retried (so they never hold up credits); each 15-minute cron run logs `{"event":"referral.redemptions_paused","count":n}` while any wait, and sends them once the switch is back on (unless the balance check above cancels them).

Setup:

1. **Connect:** enable Connect on the platform account (Accounts v2), complete the platform profile and the Express branding (name, icon, color), and acknowledge that the platform is liable for connected-account losses (losses are collected from the application).
2. **Countries:** payouts go to US bank accounts only (`REFERRAL_PAYOUT_COUNTRIES` in `src/referrals.ts`). Other countries need a code change and must be ones Stripe supports for cross-border payouts from the platform's country.
3. **Funding:** transfers draw from the platform's available Stripe balance, and Stripe doesn't retry a failed transfer. Under **Settings → Payouts**, keep a minimum balance for automatic payouts, or switch to manual payouts, or add funds with top-ups (US, UK and JP platforms). Otherwise automatic payouts sweep the balance and cash-outs wait with `balance_insufficient` until funds arrive.
4. **API key:** add write access for Transfers, Accounts (v2) and Account Links (v2), and Login Links, to `STRIPE_SECRET_KEY`'s restricted key. Check the key's request log in the sandbox for denied calls.
5. **Tax reporting:** turn on Connect tax reporting and choose 1099-NEC or 1099-MISC with a tax advisor. Stripe issues no 1099-K when the application collects fees, so the platform files; the 1099-NEC/MISC threshold is $2,000 a year. Workspace credits are customer balance credits, not Connect transfers, so they don't appear in Stripe's 1099 totals.
6. **Turn it on:** set `REFERRAL_PAYOUTS_ENABLED=true` on Convex.

### Operator tools

- `npx convex run referralOps:voidReferral '{"referralId":"…","reason":"…"}'`: stops a referral (abuse found by hand). Its commissions still on hold are voided; available ones stay.
- `npx convex run referralOps:voidCommission '{"commissionId":"…","reason":"…"}'`: voids one commission, for example after a credit note that only credited the customer balance (no refund).
- `npx convex run referralOps:resolveStuck '{"redemptionId":"…","outcome":"completed","stripeId":"cbtxn_…"}'`: settles a credit or cash-out logged as stuck, after you check Stripe by hand: the customer's balance transactions for its `referralRedemptionId`, or the transfers with `transfer_group` `referral-redemption-<id>`. `"outcome":"failed"` returns the amount to the referrer's balance; use it only when Stripe has no such object.
- `npx convex run referralOps:approveRedemption '{"redemptionId":"…"}'`: sends a cash-out waiting in review. `referralOps:rejectRedemption '{"redemptionId":"…","reason":"…"}'` declines it and returns the amount to the referrer's balance; the referrer sees the reason in their activity.
- `npx convex run referralJobs:refreshPayoutAccount '{"accountId":"acct_…"}'`: re-reads a payout account's status from Stripe.
- `{"event":"referral.ledger_full"}`: a referrer has 5000 credits and cash-outs, failed ones included. Balances read only that many, so they can't redeem anything more (and `approveRedemption` refuses) until a running-balance table is added.
- A commission job that failed is not retried. Run `npx convex run referrals:accrue '{"customer":"cus_…","subscription":"sub_…","id":"in_…","amountPaid":…,"total":…,"totalExcludingTax":…,"currency":"usd","invoiceCreated":<ms>,"paidAt":<ms>}'` with the invoice's values from the Stripe Dashboard; an invoice that already has a commission is skipped. If the invoice's charge was refunded or disputed, then also run `referralJobs:resolveChargeEvent` for that charge.

## Guarantees

- **API version:** requests pin `Stripe-Version`. Invoice events are read from both the current shape (`parent.subscription_details.subscription`) and the older one (`subscription`).

- **Signatures:** webhooks are verified against the `Stripe-Signature` header with a five-minute tolerance.
- **Duplicates:** each event ID is applied at most once.
- **Ordering:** subscription events older than the last one applied are recorded as `stale` and ignored, so redelivery and reordering cannot roll state back.
- **Workspace linking:** Checkout sets both `client_reference_id` and subscription metadata. A subscription that claims a different workspace than its customer's is ignored.
