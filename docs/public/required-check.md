# Make OpenReview a required check

OpenReview posts an **OpenReview** check run on every reviewed GitHub pull request when the GitHub App installation has **Checks: write**. The check is in progress while the review runs, then completes:

| Review | Conclusion |
| --- | --- |
| Completed, no findings at or above the blocking severity | `success` |
| Completed, one or more blocking findings | `failure` |
| Incomplete (skipped files, failed specialist, missing score) or failed | `action_required` (never `success`) |
| Superseded by a newer commit | `neutral` |

The default **minimum blocking severity** is `off`: findings never fail the check. A completed review still reports `success`, so you can require the check with no extra configuration. The gate is "a complete review ran". Raise the threshold to `critical`, `high`, `medium` or `low` when findings at that severity should block merge.

Incomplete reviews never report success. GitHub treats a `neutral` conclusion as passing a required check, so OpenReview uses `action_required` instead — the same idea as [not publishing a full confidence score on incomplete reviews](https://github.com/mbelenkiy29/OPENREVIEW/pull/160).

## 1. Grant Checks: write

On the GitHub App: **Permissions → Repository permissions → Checks → Read and write**, then save. Each installation owner must accept the updated permissions (GitHub emails them, or **Settings → Applications → Installed GitHub Apps → Configure**).

Until the installation grants Checks: write, OpenReview skips the check run and logs `review.check_run_skipped`. A required "OpenReview" check then stays pending. Code Providers on the dashboard shows whether each installation has Checks write. See [GitHub App setup](github-app.md).

## 2. Require the check on the protected branch

The check name is exactly `OpenReview`.

**Rulesets** (preferred): repository **Settings → Rules → Rulesets** → New branch ruleset. Add the target branch (for example `main`). Enable **Require status checks to pass**, add **OpenReview**, and save. Organization rulesets work the same way.

**Classic branch protection:** repository **Settings → Branches → Add branch protection rule**. Enable **Require status checks to pass before merging**, search for **OpenReview**, and save. Optionally require the branch to be up to date.

GitHub lists a check only after it has run at least once on the repository. Open or update a pull request so OpenReview posts the check, then add it to the rule.

## 3. Choose which findings block merge

In the dashboard, **Code Review Settings → Status Checks → Minimum blocking severity**, or in `.openreview.json` on the **base** branch:

```json
{
  "settings": {
    "checkFailureSeverity": "critical"
  }
}
```

Values are `off`, `critical`, `high`, `medium`, `low`. Admins can lock `checkFailureSeverity` so a pull request cannot weaken it. The check-run summary lists blocking findings and links each one to its inline comment.

A separate **Check run minimum confidence** setting can also fail the check when the published score is below 1–5. It is not applied when no score was recorded.

## Self-hosted Apps

Self-hosted installs use the same Checks: write permission and the same check name. After you add the permission to the App, every installation must accept it before check runs appear.
