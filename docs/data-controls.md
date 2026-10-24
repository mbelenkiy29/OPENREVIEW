# Data controls and workspace deletion

Settings → **Data & deletion**.

## Data sharing

Each workspace is **private** by default: its review data is never used outside the workspace. Admins can opt in to **aggregate** sharing.

- With aggregate sharing, only counts may be included in operator statistics: reviews, and findings by category and severity. No code, titles or text are included.
- Operators read these statistics with `pnpm tsx scripts/aggregate-report.ts`, which uses `api.dataControls.aggregateReport` with the backend secret. Workspaces that are not sharing are left out.
- Evaluations use only the fixtures in `fixtures/`, never workspace data.

## Retention

Admins can limit how long data is kept. Both limits are between 7 and 3,650 days; blank means keep until deleted.

- **Reviews and findings:** older reviews are deleted together with their findings, feedback, reactions, outcome signals, model-call records, comments, jobs and stored results.
- **Transcripts:** agent run state, chat threads and pull request Q&A conversations older than the limit are deleted. The reviews themselves stay.

A daily job applies the settings in small batches, and every change to them is recorded in the audit log.

Separately, webhook payloads are deleted 14 days after they were last processed, whether processing succeeded, failed or never finished. A job every six hours handles this across the deployment. GitHub deliveries, which are not linked to any workspace, are deleted along with their payload files. Deliveries from other code hosts keep their record, which stops a redelivery from being processed twice and still appears under **Recent deliveries**. Their payload is cleared, so they can no longer be retried.

## Deleting a workspace

1. **Request.** Only the owner can request deletion, by typing the workspace name.
   - On the hosted cloud, a workspace with a subscription that has not ended cannot be deleted. Cancel it under Settings → Billing → **Manage billing** first, then delete the workspace once Stripe has ended the subscription.
2. **Grace period.** The purge starts after `WORKSPACE_DELETION_GRACE_DAYS` (default 7). Until then the workspace works as usual and the owner can cancel.
   - If the workspace subscribes during the grace period, the deletion is cancelled when the purge would start, and the audit log records `workspace.deletion_blocked`.
3. **Purge.** It first disables every repository, so webhooks, indexing and reviews stop writing and repositories cannot be re-enabled, then waits 10 minutes for running jobs to finish. The purge then removes every workspace-owned row and the files those rows reference: repositories, indexes, embeddings, reviews, findings, rules, conventions, chats, members, teams, settings, keys, OAuth grants, SSO, billing records and the audit log.
   - It runs in small transactions and records its progress in a deletion receipt, so it resumes after an interruption. Running a step twice deletes nothing extra.
   - The tables it keeps, with reasons, are listed in `sharedTables` in `convex/dataControls.ts`: personal accounts and sessions, deployment-wide budgets and replay-protection receipts, and on the hosted cloud the referrer's referral records (attributions, commissions, credits and payouts, and their Stripe payout account link), which keep only the deleted workspace's id.
   - A test fails if a new table is in neither the purge plan nor that list.
4. **Provider access.** OpenReview does not change settings at your code providers. After deletion, uninstall the GitHub App (or disconnect GitLab, Bitbucket, Azure DevOps, Slack, Linear, Jira, Confluence and Notion) from each provider's own settings.
