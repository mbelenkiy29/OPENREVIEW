# OpenReview vs Greptile

_Last checked Nov 20, 2026. Competitor facts come from the public pages linked below as read on that date. They change, so re-check before publishing. OpenReview facts come from this repository. We have not benchmarked either product and make no accuracy claims._

## At a glance

| | OpenReview | Greptile |
| --- | --- | --- |
| Positioning | Repository-aware pull request reviews with exact-quote evidence. Self-host it or use the cloud | "AI agents that review and test pull requests with full context of the codebase" |
| License | MIT, source on GitHub | Closed source |
| Self-hosting | Free and unlimited. Docker Compose, Helm chart, AWS Terraform module, offline mode | Listed under the Enterprise plan, custom pricing |
| SSO and SAML | In the open-source code (SAML 2.0 and OIDC). Included in the cloud Pro plan | Enterprise plan |
| Audit log, roles | In the open-source code | Role-based access control on Enterprise |
| Cloud pricing (list) | Starter $12 per seat per month with $6 of model usage per seat. Pro $24 with $12 of usage. 14-day Starter trial, no card; Pro collects a card at checkout | Starter free for 1 developer (50 credits a month). Pro is $1 per credit with no seat fees. A base review is 1 credit, Plus 3, Apex 10 |
| Free for open-source projects | Not offered in the billing docs today | Free for qualified non-commercial projects with an OSI-approved license |
| Model choice | Anthropic, OpenAI, OpenRouter or any OpenAI-compatible endpoint, per-task routing, hard inference budget | Not stated on the pricing page |
| Code hosts | GitHub, GitHub Enterprise, GitLab, Azure DevOps, Bitbucket Cloud and Data Center, Gitea, Perforce | GitHub on all plans. GitHub Enterprise, GitLab Self-Managed, Bitbucket Data Center, Gitea and Perforce are listed under Enterprise |
| Codebase understanding | Tree-sitter code graph across 12 languages, optional embeddings, specialist pipeline or tool-using agent | Graph index of the codebase with a swarm of agents |
| Runtime validation | Opt-in generated reproduction tests run in an isolated runtime sandbox, attached to up to three verified findings | TREX runtime validation (beta, 3 credits per run) |
| Agent and IDE tooling | CLI, remote and local MCP server, Claude Code and Codex plugins | Knowledge Base MCP, Greptile CLI, coding agent integrations |
| Customers and scale | New. No public customer list | Claims 22,000+ teams on its home page |

## Where OpenReview is a good fit

- You need to run reviews on your own infrastructure without an enterprise contract.
- You want to choose the model and cap spend yourself.
- You want a single review engine behind GitHub, your CLI and your coding agent.
- You want to read and change the review logic.

## Where Greptile is a good fit

- You want a managed product with a long customer track record and a published benchmark program.
- You prefer usage-based credits with no per-seat fee.
- You are a qualifying open-source project and want free reviews.

## Things we do not claim

- That OpenReview finds more bugs, or fewer false positives, than Greptile. The README states "This project makes no Greptile parity claims". The parity report records feature coverage with evidence levels, not review quality.
- That the cloud's per-seat price is lower than Greptile's. The two models are not comparable without your PR volume.
- That every code host has been verified live. See the [acceptance matrix](../acceptance-matrix.md).

## Sources

- Greptile pricing: https://www.greptile.com/pricing (read Nov 20, 2026)
- Greptile home page: https://www.greptile.com (read Nov 20, 2026)
- OpenReview pricing and demo: https://openreview.tech
- OpenReview billing: [docs/billing.md](../billing.md)
- OpenReview self-hosting kit: [docs/self-hosting-kit.md](../self-hosting-kit.md)
- OpenReview parity report: [docs/parity/REPORT.md](../parity/REPORT.md)
