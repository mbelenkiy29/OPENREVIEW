# Notifications, Slack and email

OpenReview sends nothing until a workspace connects Slack or a member verifies an email address.

## Slack

1. An operator creates the Slack app from [slack-app-manifest.yml](slack-app-manifest.yml).
2. Set the app's credentials:
   - `SLACK_CLIENT_ID` on both Next.js and Convex.
   - `SLACK_CLIENT_SECRET` and `SLACK_SIGNING_SECRET` on Convex only.
3. A workspace admin opens **Organization Settings → Notifications → Add to Slack**. The bot token is stored encrypted with `CREDENTIAL_ENCRYPTION_KEY`. One Slack workspace can connect to only one OpenReview workspace.
4. The admin links channels by ID. For each channel they choose:
   - **Notifications:** review completed and/or high-severity findings, for all repositories or selected ones.
   - **Q&A:** off by default. It answers `@OpenReview <question>` about 1–5 selected repositories.
     - Answers come from the codebase-chat engine. Every claim cites lines at the indexed revision.
     - Anyone in the channel can ask, so link only repositories that channel may read. Code is read with the installing admin's repository access.
     - Questions are rate-limited to 20 per Slack workspace per minute, count against the inference budget, and are recorded as `slack` usage.
5. `/openreview status` shows a channel's links and each repository's index state, visible only to the person who ran it.

Every request from Slack is checked against `SLACK_SIGNING_SECRET`. Requests more than five minutes old are rejected, and retried events are processed only once.

## Email

Set `RESEND_API_KEY` and `EMAIL_FROM` on Convex. Each member sets a notification email in **Organization Settings → Notifications** and confirms it through a one-hour link; only a hash of the link token is stored. Members choose, separately for completed reviews and for high-severity findings, one of:
- **Off.**
- **My pull requests:** pull requests whose author matches the member's login.
- **All repositories I can access.**

Without email configuration, deliveries are recorded as skipped.

With email configured, OpenReview also sends four one-time emails (`convex/lifecycleEmails.ts`): a thank-you on sign-up, and to workspace owners when the workspace connects its first repository, completes its first review and subscribes. The thank-you goes out once per user and the others once per workspace (only workspaces created after these emails shipped), and only to a verified address (a Google, GitLab, email-link or SSO sign-in, or a confirmed notification email), so GitHub-only users get none.

### Changelog emails

Visitors to `/changelog` can get its new entries by email. Create a segment in Resend and set its ID as `RESEND_CHANGELOG_SEGMENT_ID` on both Next.js and Convex, next to `RESEND_API_KEY` and `EMAIL_FROM`.
- **Signing up is double opt-in.** The form mails a 24-hour confirmation link, and nothing is stored until it is clicked. Each address can ask for 3 links an hour, and the whole site sends at most 100 an hour.
- **Resend keeps the list.** Confirming adds the address to the segment, or subscribes it again if it unsubscribed before.
- **Unsubscribing is Resend's.** Every email carries Resend's unsubscribe link.
- **One email a week at most.** Every Tuesday at 16:00 UTC, Convex reads the live `/changelog/feed.xml` and sends one Resend broadcast with the bullets that are new since the last one. An edited bullet counts as new. The first run only records what is already there, so subscribers never get the whole history.

## Delivery guarantees

Each (event, review, target) is delivered at most once; a failed delivery is retried when the job runs again. A repository the member can no longer access is never emailed about.
