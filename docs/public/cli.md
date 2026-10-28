# CLI

The `openreview` command reviews your commits before you push, from your terminal or from a coding agent such as Claude Code or Codex.

## Install and sign in

```sh
npm install -g openreview-cli
openreview login
```

`openreview login` opens your browser to sign in and choose a workspace. The CLI keeps the sign-in owner-only in `~/.config/openreview/config.json` and renews it on its own.

- **Self-hosted server:** pass `--url https://review.example.com`, or set `OPENREVIEW_URL`.
- **CI and scripts:** set `OPENREVIEW_API_KEY` (and `OPENREVIEW_URL` for a self-hosted server). It takes precedence over a saved sign-in and is never written to disk.
- **API key on a machine** (Pro plan, or a Perforce only key on any plan): `openreview login --api-key` prompts for the key without echoing it, or reads it from stdin (`printf %s "$KEY" | openreview login --api-key`). Avoid `--token <api-key>`, which leaves the key in your shell history and process list; it still works but warns.
- `openreview status` (or `openreview whoami`) shows the server and your repositories. `openreview logout` signs out and revokes the sign-in.

It needs Node.js 24 or newer. In a checkout of this repository, `pnpm cli` runs the same command, and `npm link` installs it.

## Review your changes

```sh
openreview review                   # committed changes since the merge base with main
openreview review --base develop
openreview review --security --mode deep
openreview review --agent           # one JSON object, for coding agents
openreview review --json
openreview review --inline          # file:line blocks with surrounding code
openreview review --instructions "focus on error handling in the retry logic"
```

Signed in, OpenReview reviews the change on your workspace. The CLI sends the diff and the changed files. The server adds context from the repository's index and applies the workspace's rules, settings and model.

- **Usage:** each review counts toward the workspace's plan like a pull request review, and its model usage shows in Analytics.
- **Repository:** the checkout's `origin` must be connected and indexed in the workspace.
- **Retention:** the uploaded code is deleted when the review ends, and the result after a day. Only you can read it.
- `--instructions` adds guidance for this run only, after the workspace's and repository's own instructions (up to 2,000 characters).
- `--mode` asks for a review tier, up to the workspace's cap; `--security` reviews security only. Commit your work first: uncommitted edits are not reviewed.

### Review status for hooks and CI

```sh
openreview review status --pr 42
openreview review status --pr 42 --json
```

It reports the latest review of pull request 42 in this checkout's repository, and exits with a code you can gate on:

| Code | Meaning |
| --- | --- |
| 0 | A completed review covers the pull request's current head |
| 1 | No review yet, the review is for an older head, you are signed out, or the origin is not connected |
| 2 | Invalid usage, such as a missing `--pr` |
| 3 | The review is queued or running |
| 4 | The latest review failed |
| 5 | The latest review was cancelled |

### Review on this machine

`--local`, or reviewing while signed out, runs the review on this machine with model credentials from your environment (`LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`):

```sh
openreview review --local
openreview review --local --engine agentic
openreview review --local --resume  # continue an interrupted agentic review
```

- **Repository config:** local reviews read `.openreview.json` from the base commit.
- **Limits:** they never execute repository code, and index at most 5,000 files or 20 MB.

`--inline` prints each finding as a `file:line` block. The block includes two lines of code on either side, with the flagged lines marked `>`, then the priority, any tags, the explanation and the suggested fix.

`--engine agentic` runs the tool-using reviewer. It saves its progress after every step in your OS cache directory: `~/Library/Caches/openreview` on macOS, `$XDG_CACHE_HOME/openreview` or `~/.cache/openreview` on Linux, and `%LOCALAPPDATA%\openreview\cache` on Windows. The saved file is owner-only and keyed by checkout and base commit.

If a review is interrupted (for example with Ctrl-C), run the same command with `--resume`, which implies the agentic engine, to continue from the last completed step. The saved progress is used only when `HEAD` is unchanged. If you committed since, it is discarded and the review starts over. It is removed when a review finishes.

## With coding agents

Claude Code, Codex and other agents can run `openreview review --agent` before they push, and fix what it finds. After you sign in once, it runs without prompts. The animated logo and the progress line appear only in an interactive terminal, never in agent output or pipes.

- The [agent plugin](agent-plugins.md) has a **review-local-changes** skill that runs this loop.
- `openreview resolve --pr <number>` fixes an open pull request's findings with Claude Code or Codex.

## Onboard a workspace

```sh
openreview onboard --url https://review.example.com --api-key   # prompts for the admin key
```

`openreview onboard` walks through setup with the workspace's API key. Create an admin-scope key under Organization Settings → API Keys. API keys are on the Pro plan; on Free and Starter, set up in the dashboard's guided setup instead, and use `openreview login` (browser sign-in) for reviews.

1. **Workspace.** It shows the workspace the key belongs to. An API key belongs to one workspace. To use another workspace, or to create a new one, the command prints the dashboard steps: switch to or create the workspace, generate a key there, and run it again.
2. **Install link.** It prints the GitHub App install link for the workspace. It never changes settings at your code provider.
3. **Repositories.** It lists the installed repositories and enables the ones you choose, which starts indexing. Pass `--repositories owner/name,…` or `--repositories all`. With `--yes` and no list, it enables only the repository of the current checkout.
4. **Rules.** It finds AI rule files in the current repository: `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.cursor/rules/*`, `.github/copilot-instructions.md`, `GEMINI.md` and `.windsurfrules`.
   - It imports their review-relevant statements as suggested rules. Agent workflow, persona text and code blocks are left out.
   - Each suggestion waits for an admin's approval on the Custom rules page, and the server discards text that fails the rule safety checks.
   - `--no-rules` skips this step.

For coding agents, `openreview onboard --yes --json` never prompts and prints one JSON summary. `--json` without `--yes` is refused. The exit code is non-zero if a step stopped or a repository could not be enabled.

## Fix with your coding agent

The bridge dispatches **Fix** and **Fix All** from the dashboard to Codex, Claude Code or Cursor Agent running on your machine:

```sh
openreview bridge install
openreview bridge pair --url https://review.example.com
openreview bridge register /absolute/path/to/repository
openreview bridge status
```

The agent works in your registered checkout, and you review, commit and push its changes yourself. The next review checks whether each finding was resolved.

Without the bridge, each finding offers prompt links for Cursor, Claude Code, Codex and Conductor. These are the agents' documented deep links, and each one only pre-fills the prompt. **Send to Devin** uses Devin's API with your own key, saved under Personal agents. It appears only after you save that key.
