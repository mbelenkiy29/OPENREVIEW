# Issues and Autofix

## Issues

**Pull Requests → Issues** turns findings into tickets. Every verified finding belongs to an issue, and the same problem found on several pull requests in a repository is one issue. Security findings carry a **Security** tag; the **Security issues** link filters to them.

Each issue has:
- A number (`#12`), priority, category and status: **open**, **in progress**, **resolved**, **won't fix** or **false positive**.
- An assignee: any workspace member with write access to the repository.
- Its occurrences: every pull request it was found on, with that pull request's state.
- An activity log: when it was found, seen again, assigned, commented on, fixed or closed, and by whom.

Issues move on their own:
- A commit that fixes the latest occurrence resolves the issue.
- Closing that pull request without merging resolves it.
- Merging it while the issue is open keeps the issue open and marks it **merged**, because the problem is now in the target branch.
- A resolved issue reopens when a review reports the problem again. **Won't fix** and **false positive** stand.

When you set an issue to resolved, won't fix or false positive, every open occurrence gets the same feedback, so pull request threads and learned preferences follow. Feedback on a single finding moves its issue once no other occurrence is still open.

Issues are on every plan. Changing an issue needs write access to its repository; viewers can read them.

## Autofix

Autofix opens fix pull requests without anyone asking. When a review completes, OpenReview opens one for each of its critical and high findings, at most three per review and one per issue. Each is the same validated, single-range change as **Open a fix PR** (see [Fix with agents](/docs/fix-with-agents)): a new `openreview/fix-*` branch that targets your pull request's branch, opened for the pull request's author. Your branch is never written, and no tests are run.

Turn it on per repository under **Settings → Code Review → Fix pull requests**. It needs:
- **Fix pull requests** on for the repository, and the GitHub App's **Contents: Read and write** permission.
- The **Pro** plan on the hosted cloud (the free trial includes it). Self-hosted installs have it without a plan.

The issue links to the fix pull request, and its activity log says Autofix opened it. Autofix skips a finding when the pull request moved since the review, the author lost write access, or no validated fix exists; the workspace audit log records why.
