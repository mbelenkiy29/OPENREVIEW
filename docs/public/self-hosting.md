# Self-hosting

OpenReview has two parts:
- **Web app:** Next.js. It runs on Vercel, Docker or any Node.js 24 host.
- **Backend:** Convex. Use Convex Cloud, or the open-source Convex backend on your own infrastructure.

Repository files are stored as Convex file blobs. Metadata, symbols, the code graph and embeddings live in Convex tables.

## Checklist

1. Set the core configuration:
   - `APP_URL` identically on the web app and the backend.
   - `SESSION_SECRET` (32+ characters) and `SERVICE_SECRET` on both.
   - `CREDENTIAL_ENCRYPTION_KEY` (32+ characters) on the backend, to encrypt provider and integration credentials. Back it up.
2. Configure a model (`LLM_PROVIDER`, `LLM_API_KEY`) and the inference budget.
3. Register your [GitHub App](github-app.md) or connect another provider.
4. Optionally add:
   - embeddings (`EMBEDDING_MODEL`, `EMBEDDING_API_KEY`).
   - Slack and email ([notifications](../notifications.md)): `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`.
   - more sign-in methods ([identity](../identity.md)).
5. Decide on outbound advisory lookups: security checks query OSV.dev for changed dependency versions. Set `OSV_ENABLED=false` on the backend to stop those requests (pattern checks still run), or set `OSV_API_URL` to an internal OSV mirror.
6. Leave `BILLING_ENABLED` unset. [Billing](../billing.md) is for hosted cloud deployments only, and self-hosted installs have no quotas.

## Docker

```sh
docker build -t openreview:local .
```

The [deployment guide](../deployment.md) covers Docker Compose with a self-hosted Convex backend, backups and upgrades.

## Support and updates contract

Self-hosting is free, and every feature is on. Companies that want a vendor to call can buy a yearly support and updates contract.

**It covers:**
- Named support contacts on your side and ours.
- Response targets for incidents and questions, written into the contract.
- Help with upgrades and migrations.
- Security advisories before they are public.

**It does not cover:**
- Access to features. Nothing in the code is locked, so there is nothing to unlock.
- A license key. There is none, and the code stays MIT.

OpenReview adds no telemetry, phone-home or license check for this. Your install talks to the same endpoints with or without a contract. The contract is invoiced yearly; ask through the contact link on the pricing page.
