# openreview-cli

AI code review of your commits before you push, from your terminal or from a coding agent such as Claude Code or Codex.

This package is **not on npm yet**. From a clone of [OpenReview](https://github.com/mbelenkiy29/OPENREVIEW) (Node.js 24, pnpm 11):

```sh
pnpm install
npm link
openreview login           # signs in through your browser
openreview review          # reviews the commits since the merge base with main
```

`npm link` from the repository root puts `openreview` on your PATH. `pnpm build:cli` then `npm --prefix packages/cli link` installs this packaged binary instead. Publishing `openreview-cli` to the npm registry is a tracked open item.

Signed in, the review runs on your [OpenReview](https://openreview.tech) workspace with its model, rules and repository index, and counts toward the workspace's plan. `openreview review --local` reviews on your machine instead, with your own model key (`LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`).

- `--agent` prints one JSON object for coding agents; `--json` and `--inline` are other formats.
- `--base <branch>`, `--mode fast|standard|deep` and `--security` adjust the review.
- `openreview login --url <server>` signs in to a self-hosted server; `--token <api-key>` signs in with an API key for CI.
- `openreview resolve --pr <number>` fixes a pull request's open findings with Claude Code or Codex until a re-review is clean.
- `openreview bridge install` lets the dashboard's **Fix** button start Codex, Claude Code or Cursor Agent on your machine.

Requires Node.js 24 or newer. Full documentation: [CLI](https://openreview.tech/docs/cli).
