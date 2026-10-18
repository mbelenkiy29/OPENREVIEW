# Security

**Updated October 17, 2026**

This page explains how the hosted OpenReview service at [openreview.tech](https://openreview.tech) handles your code: what is stored, what the AI model sees, who can access it, and how to report a vulnerability. It describes the service as it is built today. OpenReview is open source, so you can check any of it in the [source code](https://github.com/mbelenkiy29/OPENREVIEW).

## At a glance

- Reviews read your code. They never run it.
- Values that look like secrets are removed before your code is stored or sent to a model.
- Your code is not used to train AI models.
- Credentials for connected services are encrypted. API keys and sessions are stored only as hashes.
- Every finding must quote the exact lines it depends on, or it is not posted.
- You can run the whole service on your own infrastructure instead.

## Where your code goes

1. **Your code host notifies OpenReview.** When a pull request opens or changes, your code host sends a signed webhook. OpenReview checks the signature before doing anything with it.
2. **The repository is indexed.** OpenReview reads your default branch with the access you granted. It removes secret-looking values, then stores files, searchable text, symbols and embeddings in its database. Files such as `.env`, `id_rsa`, `.pem`, `.key` and `.p12` are skipped.
3. **The change is reviewed.** OpenReview sends the AI model:
   - the pull request's title and description;
   - the diff;
   - related code it found, such as changed files, their callers, tests and configuration;
   - your workspace's rules and learned preferences.

   In agentic review modes the model can also ask to read more files from the indexed repository. If you connect a ticket tracker, linked tickets are included to check the change against its requirements.
4. **Findings are checked, then posted.** Model output must match a strict format. Each finding must sit on a changed line and quote the reviewed code exactly. Anything that fails is dropped before OpenReview comments on your pull request.

On the hosted service the AI model provider is OpenAI. Data is processed and stored in the United States. The services that process data for OpenReview, including Vercel (hosting) and Convex (database), are listed in the [Privacy Policy](/privacy).

## What OpenReview does not do

- **Run your code.** Reviews parse source code; they never execute it. An optional worker can attach test results to reviews. It is off by default, runs as a separate process, and uses a container with no network access, a read-only file system and strict resource limits. The hosted service does not run one.
- **Train AI models on your code.** Your code, pull requests and comments are used only to provide the service to you. See section 3 of the [Terms of Service](/terms).
- **Share your workspace with other workspaces.** An admin can opt in to sharing counts across workspaces. Code, titles and text are never shared.

## Secrets in your code

Before files are stored, and before code or pull request text is sent to a model or shown in chat, OpenReview replaces values that look like secrets. These include:

- private key blocks;
- GitHub tokens;
- `sk-` style API keys;
- AWS access key IDs;
- quoted values assigned to names like `password`, `secret`, `api_key` or `access_token`.

This matching is based on patterns, so it cannot recognize every secret format. Keep secrets out of source code, and rotate any secret that was ever committed.

## Repository content is treated as data

- Code, pull request text, comments and tickets are given to the model as data. They are never treated as instructions.
- Chat answers must cite lines that match the indexed source.
- Commands such as `@openreview review` run only for people with write access to the repository.
- Rules learned from your team's feedback are rejected if they read like instructions to the model.

## Access control

- **Sign-in:** GitHub, Google, GitLab, an emailed link, or SAML/OIDC single sign-on. Email links work once and expire after 15 minutes.
- **Sessions:** a secure, HTTP-only cookie holds a signed token that expires after 7 days. Signing out ends the session on the server.
- **Single sign-on:** a workspace can require it for everyone except its owners, so owners cannot lock themselves out.
- **Roles:** owners, admins, members and viewers. Only admins can change settings, and viewers cannot change anything. Teams can limit which repositories people see.
- **Audit log:** OpenReview records who changed what, and when. This covers members, roles, API keys, single sign-on, integrations, rules, settings and deletion. Admins can read it under **Settings → Audit Log**.
- **API keys:** they can be limited to read, write or admin, and are stored only as hashes. MCP clients can sign in with OAuth 2.1 and PKCE.

## Credentials and encryption

- **In transit:** all traffic uses HTTPS, and browsers are told to always use HTTPS for openreview.tech.
- **Connected-service credentials:** OpenReview encrypts them with AES-256-GCM before storing them. This covers code-host credentials, webhook secrets, Slack, Linear, Atlassian and Notion tokens, and single sign-on client secrets.
- **Hashed only:** API keys, session IDs and worker tokens.
- **GitHub App key:** the private key is kept only in the server environment, never in the database. The short-lived tokens GitHub issues for each installation are not stored.

## GitHub App permissions

OpenReview asks for:

- **Required:**
  - read access to code, issues and checks;
  - write access to pull requests, so it can post reviews.
- **Optional:**
  - write access to checks, to report a check run;
  - write access to code, to open fix pull requests.

  Features that need these turn themselves off when the permission isn't granted.

You choose which repositories the app can access when you install it.

## Limits

Reviews, chat, sign-in emails and other actions are rate-limited. Webhook and review sizes are capped. Spending on AI models has a hard budget that is checked before every model call.

## Retention and deletion

- **GitHub webhook payloads** are deleted 14 days after they are processed.
- **Review history and chat transcripts** are kept for as long as you choose, from 7 days to 10 years, under **Settings → Data & deletion**.
- **Deleting a workspace:** owners can delete it under **Settings → Data & deletion**. Its data is erased after a grace period you set (7 days by default, up to 90).
- **Removing a repository or uninstalling the app:** this stops reviews but does not erase the data already stored. Email us to erase it, or to delete your account. We delete data within 30 days, and backups within 90 days, as the [Privacy Policy](/privacy) describes.

## Self-hosting

You can run OpenReview on your own Next.js host and Convex backend, with your own model provider and budget. Your code then goes only to the model you configure. See the [self-hosting guide](/docs/self-hosting).

## Audits and certifications

OpenReview has not had an independent security audit or penetration test. It does not hold SOC 2 or ISO 27001 certification. If you need those assurances, self-hosting keeps your code inside your own infrastructure.

## Reporting a vulnerability

Email [mbelenkiy29@gmail.com](mailto:mbelenkiy29@gmail.com) with "Security" in the subject line. Please include:

- what you found and its impact;
- the steps to reproduce it;
- the affected page, API endpoint or version.

While testing, please:

- use only your own accounts and workspaces;
- don't access, change or delete other people's data;
- don't run denial-of-service attacks, spam or social engineering;
- give us reasonable time to fix the issue before you disclose it publicly.

The same contact is published in [security.txt](/.well-known/security.txt).
