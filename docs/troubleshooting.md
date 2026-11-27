# Troubleshooting FAQ

Setup and usage questions belong in [GitHub Discussions Q&A](https://github.com/mbelenkiy29/OPENREVIEW/discussions/categories/q-a). Report vulnerabilities privately per [SECURITY.md](../SECURITY.md); do not file public issues for them.

This page restates what the README, `.env.example`, and docs already say. It is not a complete setup guide.

- [GitHub App registration](#github-app-registration)
- [Webhook deliveries failing or not arriving](#webhook-deliveries-failing-or-not-arriving)
- [Installation not linked to a workspace](#installation-not-linked-to-a-workspace)
- [Convex deploy or `convex dev` errors](#convex-deploy-or-convex-dev-errors)
- [Missing model credentials and `pnpm eval` blocked](#missing-model-credentials-and-pnpm-eval-blocked)
- [Minimum env vars for a local first review](#minimum-env-vars-for-a-local-first-review)
- [Other README troubleshooting notes](#other-readme-troubleshooting-notes)
- [Where to get help](#where-to-get-help)

## GitHub App registration

Each deployment registers its own GitHub App under GitHub **Settings → Developer settings → GitHub Apps**. Full tables: [GitHub App setup](public/github-app.md) and [README GitHub App setup](../README.md#github-app-setup).

**URLs** (your `APP_URL`, no trailing slash in production docs):

| Setting | Value |
| --- | --- |
| Homepage | `APP_URL` |
| Callback URL (user authorization) | `APP_URL/api/auth/callback` |
| Setup URL | `APP_URL/api/github/callback` |
| Webhook URL | README: `NEXT_PUBLIC_CONVEX_SITE_URL/github/webhook`. The GitHub App page writes `CONVEX_SITE_URL/github/webhook`. Production: `https://<deployment>.convex.site/github/webhook` |
| Webhook secret | `GITHUB_WEBHOOK_SECRET` |

`.env.example` defines `NEXT_PUBLIC_CONVEX_SITE_URL` (web) and `CONVEX_PUBLIC_SITE_URL` (Docker Compose). There is no `CONVEX_SITE_URL` variable in `.env.example`.

**Leave "Request user authorization (OAuth) during installation" off.** When it is on, GitHub skips the Setup URL and the installation is not linked to a workspace. The App's client ID and secret are still used for sign-in.

Turn **Redirect on update** on so changing repository access on GitHub returns to OpenReview and refreshes the repository list.

**Required repository permissions:** Contents read, Metadata read, Pull requests read and write, Issues read, Checks read. Contents read/write is optional (fix pull requests). Checks read and write is optional (an "OpenReview" check run, including as a [required status check](public/required-check.md)). OpenReview skips each optional feature when the permission is missing and logs `review.check_run_skipped` when Checks write is absent. After you add a permission, each installation's owner must accept it on GitHub.

**Events:** Installation, Installation repositories, Pull request, Pull request review, Pull request review comment, Issue comment, Push, and Repository.

**Private key:** GitHub issues a PKCS#1 key. Convert it to PKCS#8 before setting `GITHUB_APP_PRIVATE_KEY`:

```sh
openssl pkcs8 -topk8 -nocrypt -in github-key.pem -out app-key.pem
```

The README notes that literal `\n` in the PEM is accepted. Keep the key on server infrastructure only; installation tokens are minted per request and never stored.

Set `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_CLIENT_ID`, and `GITHUB_CLIENT_SECRET`. Copy the client ID and secret to the web app as well (they are used for sign-in). Synchronize App credentials to Convex. Setting them only in the web process is not enough.

## Webhook deliveries failing or not arriving

GitHub webhooks need a **public HTTPS** backend URL. A localhost backend cannot receive public GitHub deliveries without a tunnel.

Confirm:

1. The App webhook URL is the Convex HTTP-action origin plus `/github/webhook` (see the table above), not the Next.js origin.
2. The webhook secret on the App equals Convex `GITHUB_WEBHOOK_SECRET`.
3. GitHub **Advanced → Recent Deliveries** shows a `ping` or `pull_request` delivery returning 2xx ([production checklist](production-checklist.md)).
4. The web `/api/health` and Convex `/health` endpoints are up. A successful health response does **not** prove GitHub or model reachability ([deployment](deployment.md)).

For a local backend, keep the tunnel and `pnpm backend` running while you test. That is a verification setup, not durable hosting.

If deliveries arrive but nothing is reviewed, also check repository enabled status, draft handling, branch filters, and automatic reviews (README Troubleshooting). With **Automatic reviews** off, reviews run only on `@openreview review` (or a bare `@openreview`) or a trigger label.

## Installation not linked to a workspace

Typical causes, from the GitHub App docs and README:

- **"Request user authorization during installation" is on**, so GitHub never hits the Setup URL (`APP_URL/api/github/callback`).
- The install was started on github.com instead of from OpenReview, or it did not return to OpenReview.
- The GitHub sign-in token expired. README Troubleshooting: sign in again and restart installation within ten minutes. Installs started from OpenReview can take up to 30 minutes on GitHub; if the token expired meanwhile, OpenReview re-authorizes once and finishes linking.

Use **Link an existing installation** on the setup wizard, Repositories, or Code providers page. The page lists this App's installations your GitHub user can see. An installation belongs to one workspace at a time.

When GitHub suspends or uninstalls the App, OpenReview turns off the affected repositories. Unsuspending, or reinstalling and linking again, turns back on the ones that were on, and the index is refreshed.

## Convex deploy or `convex dev` errors

Local quickstart ([README](../README.md#local-quickstart), [quickstart](public/quickstart.md)):

```sh
pnpm install
CONVEX_AGENT_MODE=anonymous pnpm exec convex dev --once
pnpm setup:local
pnpm backend
# in another terminal
pnpm dev
```

`CONVEX_AGENT_MODE=anonymous` is required for that `convex dev --once` step when there is no `CONVEX_DEPLOYMENT` (CI uses the same flag).

`pnpm setup:local` generates the session, service, and webhook secrets and copies them to the local backend without printing them. `.env.local` and `.env.backend` are gitignored.

**After you edit provider, GitHub, or billing values in `.env.local`, run `pnpm setup:local` again.** Backend changes must be deployed with `pnpm backend` or `convex dev --once`.

To push env into Convex yourself:

```sh
pnpm exec convex env set --from-file .env.backend
```

Self-hosted production uses `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY` with the same `--from-file` command ([README Environment](../README.md#environment), [deployment](deployment.md)). The admin key is an operator credential; do not ship it to the browser.

On Vercel, `convex deploy` injects `NEXT_PUBLIC_CONVEX_URL` during the frontend build. Never expose `CONVEX_DEPLOY_KEY` through a `NEXT_PUBLIC_` variable.

## Missing model credentials and `pnpm eval` blocked

Reviews need a model on the **backend**. Set `LLM_PROVIDER` (`openai`, `anthropic`, `openrouter`, or `compatible`) and `LLM_API_KEY` on Convex. Optionally set `LLM_MODEL` and per-task overrides (`LLM_MODEL_REVIEW`, and so on). A compatible endpoint may run without a key if your server allows it; set `LLM_BASE_URL` to its API base. `LLM_ALLOW_LOCAL=true` is required for private/local endpoints.

Setting the key only in the Next.js process is not enough. Empty `LLM_MODEL` with `LLM_PROVIDER=anthropic` uses `claude-sonnet-5-5` (review/verify/conversation) and `claude-haiku-5-5` (summary/knowledge). Empty with `openai` defaults to `gpt-4.1`. Responses must support JSON objects.

`pnpm eval` requires a real model and writes `reports/evaluation.json`. **Without credentials it exits with a blocked report and does not invent scores.** That blocked result means the eval did not run, not that the fixtures failed. `pnpm eval --validate` checks fixture identities, source/diff presence, and expected finding locations without making model calls.

Use `--fixture=<id>` for a targeted run, and `--engine=agentic` for the tool-using engine ([agentic review](agentic-review.md)). Provider/schema failures are unscored, return a nonzero exit code, and are reported separately from missed bugs.

For a review without GitHub, `pnpm demo --fixture cross-file` uses the same model environment as the CLI.

## Minimum env vars for a local first review

Derived from [`.env.example`](../.env.example), the README local quickstart, [quickstart](public/quickstart.md), and [self-hosting](public/self-hosting.md). You need Node.js 24 and pnpm 11.

`pnpm setup:local` fills independent `SESSION_SECRET`, `SERVICE_SECRET`, and `GITHUB_WEBHOOK_SECRET` (32+ characters in the self-hosting checklist). Web and Convex must share `SESSION_SECRET` and `SERVICE_SECRET`.

| Variable | Where | Role for a first local review |
| --- | --- | --- |
| `APP_URL` | web and Convex | Example: `http://localhost:3000`. Homepage and callback base. |
| `NEXT_PUBLIC_CONVEX_URL` | web | Example: `http://127.0.0.1:3210` |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | web | Example: `http://127.0.0.1:3211`. Webhook URL base in the README. |
| `SESSION_SECRET` | web and Convex | Generated by `pnpm setup:local` |
| `SERVICE_SECRET` | web and Convex | Generated by `pnpm setup:local` |
| `GITHUB_APP_ID` | web and Convex | From the GitHub App |
| `GITHUB_APP_SLUG` | web (and Convex per README) | From the GitHub App |
| `GITHUB_APP_PRIVATE_KEY` | Convex (and web for the installation callback in production docs) | PKCS#8 PEM |
| `GITHUB_WEBHOOK_SECRET` | Convex (generated locally) | Must match the App webhook secret |
| `GITHUB_CLIENT_ID` | web | Sign-in |
| `GITHUB_CLIENT_SECRET` | web | Sign-in |
| `LLM_PROVIDER` | Convex | `openai`, `anthropic`, `openrouter`, or `compatible` |
| `LLM_API_KEY` | Convex | Required unless a compatible server allows an empty key |
| `LLM_MODEL` | Convex | Optional; see defaults above |

Then: sign in → create a workspace → install the App → enable a repository → wait for indexing → open a pull request.

Self-hosted production also requires `CREDENTIAL_ENCRYPTION_KEY` (32+ characters) on the backend, matching `APP_URL` on web and backend, and HTTPS origins. Docker Compose additionally uses `CONVEX_INSTANCE_SECRET`, `CONVEX_PUBLIC_BACKEND_URL`, `CONVEX_PUBLIC_SITE_URL`, `CONVEX_SELF_HOSTED_URL`, and `CONVEX_SELF_HOSTED_ADMIN_KEY`. Leave `BILLING_ENABLED` unset on self-hosted installs. See [self-hosting](public/self-hosting.md) and [deployment](deployment.md).

CLI local reviews (`openreview review --local`) use `LLM_PROVIDER`, `LLM_MODEL`, and `LLM_API_KEY` from the environment or `.env.local` in the **reviewed** repository, not OpenReview's checkout ([CLI](public/cli.md)). The `openreview-cli` package is not on npm yet; install from this checkout.

## Other README troubleshooting notes

- **Sign-in unavailable:** configure GitHub client ID/secret and the exact callback URL (`APP_URL/api/auth/callback`). Other methods: [identity](identity.md).
- **No reviews:** App permissions, webhook URL/secret, repository enabled status, draft behavior, branch filters, and automatic reviews.
- **Model failures:** ensure model env variables exist in Convex, verify the endpoint/model supports JSON output, and inspect persisted review errors.
- **Failed indexing:** inspect the repository error and retry indexing.
- **Unknown cost:** set provider/model token prices (`LLM_INPUT_COST_PER_MILLION` / `LLM_OUTPUT_COST_PER_MILLION`, or `INFERENCE_PRICES`). A zero estimate for an unknown model means unknown pricing, not free inference.

## Where to get help

- **Setup and usage:** [Discussions Q&A](https://github.com/mbelenkiy29/OPENREVIEW/discussions/categories/q-a)
- **Bugs and features:** GitHub issues, using the templates in `.github/ISSUE_TEMPLATE/`
- **Vulnerabilities:** [SECURITY.md](../SECURITY.md) (email the contact there; do not file a public issue)
- Deeper docs: [quickstart](public/quickstart.md), [GitHub App](public/github-app.md), [self-hosting](public/self-hosting.md), [deployment](deployment.md), [CLI](public/cli.md)
