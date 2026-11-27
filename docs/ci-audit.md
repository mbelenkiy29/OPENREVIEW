# CI audit

`pnpm ci:audit owner/repo` reads a repository's last 30 days of GitHub Actions history and reports where the minutes go: billable minutes and an estimated cost per workflow, minutes in runs that were cancelled part-way, minutes spent after a newer commit's run had already started, and what cancelling superseded runs would save in a month.

It is read-only. It lists runs, jobs and workflow files through the REST API and never writes to the repository. It is the first slice of the CI cost work: the same code (`src/ci-audit.ts` for the analysis, `src/ci-audit-github.ts` for fetching) is meant to power a public `/ci` page and an in-app report later.

## Usage

```sh
GITHUB_TOKEN=... pnpm ci:audit owner/repo
pnpm ci:audit owner/repo --days 14 --max-job-runs 300 --json
```

- `GITHUB_TOKEN` (or `GH_TOKEN`): a fine-grained token with **Actions: read** and **Contents: read** on the repository, or a classic token with `repo` for private repositories. Public repositories work without a token, at GitHub's anonymous limit of 60 requests an hour, so job minutes are sampled lightly.
- `--days`: window, 1 to 90 days (default 30).
- `--max-job-runs`: how many runs get their jobs fetched (default 600 with a token, 25 without). The rest are estimated from their workflow's average, and the report says how many were measured.
- `--json`: the full report as JSON.

The audit keeps 100 requests of the token's hourly limit in reserve (5 without a token) and stops early, saying so, rather than use it up.

## How the numbers are worked out

- **Billable minutes:** each job's duration rounded up to the whole minute, as GitHub bills. Skipped jobs count as zero.
- **Cost:** list price per minute by runner (Linux $0.006, Windows $0.010, macOS $0.062, self-hosted $0), scaled by cores for larger runners. These are estimates: plan allowances are not subtracted, and public repositories do not pay for standard GitHub-hosted runners.
- **Superseded:** a run of the same workflow, event and branch for a different commit started while this run was still going. The minutes after that moment are what `concurrency` with `cancel-in-progress: true` would not spend.
- **Monthly saving:** superseded minutes scaled to 30 days, leaving out workflows that already cancel in progress and critical workflows (deploys, releases, backups, scheduled jobs), which should finish.
- **Recommendations:** text checks on each active workflow file at the default branch: missing `cancel-in-progress` (or one set by an expression, which is flagged to check), no draft guard for pull request runs, no `paths` filters, and scheduled workflows that have not run for more than two days or not at all in the window. A workflow started by a schedule is treated as critical even when its file could not be read.
- **Runs not finished:** queued runs count as zero minutes and running ones only for the time so far.

Draft pull request runs are not measured yet: telling them apart needs one more request per pull request.

## The /ci page

`/ci` explains the audit and has a box where a visitor checks one public GitHub repository. The check runs only when the server has `CI_AUDIT_GITHUB_TOKEN`, a token that can read public repositories and nothing else; without it the page says how to run the CLI. Private repositories are refused even if the token could read them. Uncached checks are limited to 60 an hour for the deployment and 6 per visitor address, and answers are cached by the CDN for six hours per repository.

## In the dashboard

With `CI_COST_ENABLED=true` on both the web app and Convex, **Organization Settings → CI Cost** lists each GitHub App repository with its latest audit, and admins can run one (at most once per repository every ten minutes). The audit uses the installation's own token, so the GitHub App needs the optional **Actions: Read** permission. Adding that permission to the App makes GitHub ask every installation's owner to accept it; until they do, audits fail with that reason and nothing else changes. The latest five audits per repository are kept and are deleted with the workspace.
