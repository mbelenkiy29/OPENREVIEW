# Contributing

Use **Node.js 24** and **pnpm 11**. Start from the README [local quickstart](README.md#local-quickstart). Keep changes scoped and reuse the shared engine for new SCM/API adapters. Never add static findings or dashboard metrics to production pages.

CI (`.github/workflows/ci.yml`) uses Node 24 and runs `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. The production `Dockerfile` uses Node 26, which satisfies `engines.node >= 24`. Do not lower the engine range without checking both.

## CLI

The `openreview-cli` npm package in `packages/cli` is **not published yet**. `npm install -g openreview-cli` returns 404. From this checkout:

```sh
pnpm install
npm link
# or, without installing on PATH:
pnpm cli --help
```

`pnpm build:cli` builds `packages/cli`. Publishing `openreview-cli` to the npm registry is an open operator step. Do not tell users to `npm install -g openreview-cli` until that package exists on the registry.

## Checks

Before submitting a change run:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Run browser checks (`pnpm test:e2e`) for dashboard flows and real evaluation when modifying review quality. Document environment/schema changes. A deterministic test demonstrates orchestration invariants; it does not establish model detection accuracy.

Prefer regression tests with actual source evidence and cross-file context. Validate all external payloads, enforce organization authorization in backend functions, and keep repository content untrusted. Never commit credentials, `.env` files, or private repository captures.

## Issues and pull requests

Use the [bug](.github/ISSUE_TEMPLATE/bug.yml) and [feature](.github/ISSUE_TEMPLATE/feature.yml) templates. Report vulnerabilities privately per [SECURITY.md](SECURITY.md), not as public issues.

Pull requests should stay on one theme (bugs, UI, docs/CI) so they can be reviewed independently. Do not merge your own audit PRs until a human has reviewed them.
