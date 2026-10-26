# Repository configuration as code

OpenReview reads review configuration from the repository. Server reviews always read it from the pull request's **base** revision, so a change cannot disable or weaken its own review. The CLI reads it from the base commit of the reviewed range.

## Files

| File | Purpose |
| --- | --- |
| `.openreview.json` | `settings` and `rules` (schema below) |
| `.openreview/config.json` | Same schema; applied after `.openreview.json` |
| `.openreview/rules.md` | Markdown rules: one `## Title` per rule, optional `severity:`, `category:` and `globs:` lines, then the instructions |
| `.openreview/files.json` | `{"ignore": [...], "include": [...]}` globs (repository-relative at the root) |
| `<dir>/.openreview/config.json`, `rules.md`, `files.json` | A cascade level for files under `<dir>/` (see [Directory cascade](#directory-cascade)) |
| `<dir>/.openreview.json` (nested) | Rules scoped to `<dir>/` (globs are prefixed; no globs means `<dir>/**`) plus scoped `settings.instructions`; other nested settings are ignored with a warning |
| `greptile.json`, `.greptile/config.json`, `.greptile/rules.md`, `<dir>/.greptile/…` | Greptile's files, translated (see [Greptile files](#greptile-files)) |
| `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.cursor/rules/*.mdc` and similar | Guidance for coding agents, read as low-severity rules when `assistantRules` is on (see [AI assistant rule files](#ai-assistant-rule-files)) |

```json
{
  "settings": {
    "mode": "deep",
    "minimumConfidence": 0.8,
    "severityThreshold": "medium",
    "maxComments": 10,
    "categories": ["correctness", "security", "data"],
    "ignoredPaths": ["generated/**"],
    "instructions": "Amounts are integer cents.",
    "commentStyle": "concise",
    "summarySections": ["overview", "affectedAreas", "findings", "score"],
    "strictness": 2,
    "reviewEngine": "pipeline",
    "hideFooter": false,
    "sectionLayout": { "diagram": "collapsed", "affectedAreas": "plain" }
  },
  "rules": [
    { "id": "cents", "instructions": "Never divide cents by 100.", "severity": "high", "category": "correctness", "globs": ["src/billing/**"], "enabled": true }
  ]
}
```

`commentStyle` is `concise`, `detailed` or `compact`. `compact` keeps inline comments to the badge, title, prose, suggestion and a folded "Prompt To Fix With AI". On GitHub it also lays out the summary as: summary, confidence score, important files, sequence diagram, then every other section collapsed, the fix-all prompt, and a one-line footer. Collapsed sections with nothing to report (no findings, nothing resolved or skipped, no test source, no risk assessment, tests not executed) are left out; Coverage is always shown. Compact summaries have no fixed section list, so a tool that reads them should look sections up by heading and treat a missing one as empty. The `concise` and `detailed` styles still show every selected section.

`hideFooter` leaves out the review number, re-run command and tip. `sectionLayout` sets how a summary section appears on GitHub with the `concise` and `detailed` styles: `plain` (always shown), `open` (expanded) or `collapsed`. Unlisted sections keep the default layout. Rule globs may start with `!` to exclude paths.

## Directory cascade

`.openreview/` folders can sit at any depth. Each one applies to the files under its parent directory, read from the base revision like everything else:
- **Per file:** `categories`, `strictness`, `severityThreshold` and `minimumConfidence` from a folder's `config.json` apply to that folder's files; a deeper folder overrides a shallower one field by field. `files.json` ignore globs (relative to the folder's directory) skip files, and a deeper `include` re-admits a file a shallower folder ignored. The review checks each finding against its own file's values; files ignored this way are listed as skipped with the folder that excluded them.
- **Per pull request:** the review tier (`mode`) and `maxComments` use the highest value among the root and the folders a change touches. A folder can raise them, never lower them. `"mode": "auto"` counts as no tier, so any folder with an explicit tier replaces it ([how auto picks](public/reviews.md#review-tier-per-pull-request)).
- **Rules and instructions:** a folder's `rules.md` and `config.json` rules are scoped to its directory, and its `instructions` are added as scoped text.
- **Disabling rules:** a folder's `config.json` (or a nested `.openreview.json`) can list `"disabledRules": ["cents"]` to turn off rules with those ids from the root or a parent folder, for files under that folder only. Use the id as written in its file; for a `rules.md` rule that is its heading in lowercase with dashes (`## Integer cents` → `integer-cents`). A finding that cites a rule on a file the rule does not apply to is dropped.
- **Locks:** keys an admin locked in the dashboard never change at any level (a locked `ignoredPaths` also disables folder ignores).

Invalid files produce a warning in the review's coverage notes and in the dashboard; the rest of the cascade still applies. The dashboard's **Effective configuration and sources** panel lists each level, what it overrides and which files it came from. At most 50 nested folders are read.

## API guidance packs

Markdown files in `.openreview/guides/` (at most 10, 16 KB each, read from the base branch like the other config files) add review guidance for third-party APIs. A pack loads when a changed file imports one of its packages or an added line calls one of its functions:

```markdown
---
id: acme-gateway
version: 2
title: ACME payment gateway
imports: @acme/gateway, acme_gateway
calls: chargeCard
---
- Gateway calls must pass the merchant id from the request context.
- Link to the vendor's documentation for each claim.
```

OpenReview ships built-in packs for webhook signature verification, idempotency keys and SDK retries and timeouts. A repository pack with the same `id` replaces the built-in one. Packs only add guidance: they can never suppress, downgrade or approve a finding. A pack that tries to (or that contains prompt-injection phrasing, budget changes, code blocks or HTML) is not used, and the review's coverage notes say why. Reviews list the packs they applied in the summary's Coverage section.

## Greptile files

A repository moving from Greptile keeps its files. OpenReview reads `.greptile/config.json` (or the legacy `greptile.json` when there is no `.greptile/` folder) and `.greptile/rules.md` at the root and in any folder, from the base revision, before its own files. An `.openreview` file in the same place overrides the translated values.

| Greptile | OpenReview |
| --- | --- |
| `strictness` 1–3 | `strictness`, reversed: Greptile's 3 (fewest comments) is OpenReview's 1 |
| `commentTypes` | `logic` → the default categories; `style` and `syntax` → those opt-in categories. Security and custom rules are always kept |
| `effort` `base` / `plus` / `apex` / `auto` | `mode` `fast` / `standard` / `deep` / `auto` |
| `ignorePatterns` (gitignore syntax) | Ignore globs for that folder; `!` negation is not supported |
| `instructions`, `customContext.other`, `rules.md` | Instructions (scoped to the folder for nested files) |
| `rules[]` (`rule`, `id`, `scope`, `severity`, `enabled`), `customContext.rules` | Rules in the `rules` category |
| `disabledRules` | `disabledRules` |
| `summarySection`, `issuesTableSection`, `confidenceScoreSection`, `sequenceDiagramSection`, `includeIssuesTable`, `includeConfidenceScore`, `includeSequenceDiagram` | `included` turns that section on or off on top of the effective sections (an OpenReview file's `summarySections` list wins); `collapsible` and `defaultOpen` set `sectionLayout` |
| `hideFooter` | `hideFooter` |

Trigger and filter keys (`autoReview`, `labels`, author, branch and keyword filters, `triggerOnDrafts`), `statusCheck`, `shouldUpdateDescription`, `autoApprove`, `context.repos`, `patternRepositories`, `customContext.files` and `.greptile/files.json` are not read from files. A review lists them in one warning; set their equivalents in the dashboard.

## AI assistant rule files

Off by default. With `"assistantRules": true` in the repository file's `settings`, `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.windsurfrules`, `GEMINI.md`, `.github/copilot-instructions.md` and `.cursor/rules/*.mdc` at the root are read from the base revision. Up to 20 directive statements about code become low-severity rules in the `rules` category, after the repository's own rules; any that repeat a repository or dashboard rule are skipped, and `disabledRules` can turn one off by its id (`assistant:<file>:<line>`). Administrators can lock `assistantRules` off. To review these lines one by one instead, import them as suggestions with `openreview onboard`. Statements about the agent's own workflow (commits, branches, chatting) are dropped, and every rule passes the same safety checks as imported rules, so none can suppress findings, approve changes or change budgets. Cursor rules keep their `globs`.

## Precedence

Workspace defaults → team → repository dashboard settings → repository file.

Administrators can **lock** keys at any of those levels under "Lock against the repository config file". A locked key keeps its dashboard value; the review's Coverage section and the repository settings page note that the file value was ignored. Trigger, branch, author and size settings are dashboard-only, because they decide whether a review runs before any file is read.

## Validation

Every OpenReview file is validated with the schema above (unknown keys are rejected) and limited to 64 KB. Greptile files list keys OpenReview does not read in a warning instead. An invalid file is ignored. A warning appears in the review summary's Coverage section and on the repository settings page, and the review still runs with the other settings.

The repository settings page shows the effective value of each configurable key and where it came from (default, workspace, team, repository, or repository file), along with the files read from the latest reviewed base revision.
