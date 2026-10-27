# Fix findings with an agent

Every finding OpenReview posts has a **Fix with …** link. It opens the finding's Fix page, which offers four ways to fix it. Your preferred one comes first: choose it under **Settings → Agents**. A workspace admin sets the default for everyone else.

## Cloud agents (GitHub)

A cloud agent works in its vendor's infrastructure and starts from a pull request comment that mentions it. OpenReview posts that comment **as you**, through the OpenReview GitHub App, because these agents ignore comments from bots and only act for people who can push to the repository. GitHub shows the comment as yours, with the App's badge.

The comment mentions only the agent you picked. Any other `@` in the finding text is neutralised, so it can't ping people, and the finding is framed as data rather than instructions. A preview of the comment appears on the Fix page before you send it.

| Agent | Mention | Set up once | Where it answers |
| --- | --- | --- | --- |
| [Claude Code GitHub Actions](https://code.claude.com/docs/en/github-actions) | `@claude` | Install the Claude GitHub App, add an `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` secret, and add the `claude.yml` workflow (or run `/install-github-app` in Claude Code). | In the finding's thread |
| [Codex](https://learn.chatgpt.com/docs/third-party/github) | `@codex` | Connect the repository to Codex and turn on code review for it. | Pull request conversation |
| [GitHub Copilot coding agent](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/make-changes-to-an-existing-pr) | `@copilot` | A Copilot plan with the coding agent enabled for the repository. By default it commits to the pull request's branch. | Pull request conversation |
| [Cursor cloud agents](https://cursor.com/docs/cloud-agent) | `@cursor` | A Cursor admin connects GitHub, and you connect your GitHub account in Cursor (paid plan). | Pull request conversation |

How it works:

1. Click **Fix with Claude** (or another agent) on the Fix page.
2. If needed, GitHub asks you to re-authorize the OpenReview App. This does not sign you in again; the token is used for this one comment and never stored.
3. OpenReview checks that you are signed in to the GitHub account linked to OpenReview and that it can push to the repository.
4. It posts the comment once and links you to it.

OpenReview never replies to its own hand-off comments.

Cloud agents are available for repositories on the OpenReview GitHub App.

## Local agents (your machine)

**Fix** buttons start Claude Code, Codex or Cursor Agent in your own checkout through the OpenReview bridge (`openreview bridge install`, then pair and register the repository under **Settings → Agents**). The agent leaves an uncommitted diff for you to review.

Without the bridge, use **Open in Claude Code / Cursor / Codex / Conductor**, which opens the app with the prompt filled in, or copy the prompt.

## Devin

Add your Devin API key under **Settings → Agents** to show **Send to Devin**, which starts an unlisted Devin session.

## OpenReview fix pull requests

**Open a fix PR** on a finding's Fix page commits OpenReview's validated suggestion for that finding to a new `openreview/fix-*` branch, and opens a pull request against your pull request's branch. Your branch is never written. You can also ask for one by replying `@openreview fix this in a new PR` in the finding's thread.

This needs:
- **Fix pull requests** turned on for the repository (Settings → Repositories).
- The GitHub App's **Contents: Read and write** permission, accepted by the owner of the GitHub account. **Settings → Code providers** shows which installations have it.
- Write access for your linked GitHub account.
- The **Pro** plan on the hosted cloud (the free trial includes it). On Starter, `@openreview fix this` still replies with a suggestion, and `… in a new PR` explains that fix pull requests are on Pro.

To open them automatically for critical and high findings, turn on [Autofix](/docs/issues-and-autofix#autofix).
