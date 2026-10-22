---
description: Audit and fix security and performance issues in rounds until a round finds none
argument-hint: "[folder or area to focus on]"
---

Goal: leave this repository with no security or performance issue you can find. Work in rounds and keep going
until a full round finds nothing new to fix. Focus area, if given: $ARGUMENTS

Each round:

1. **Audit.** Read the code where a mistake costs most: auth and tenant checks on every public Convex function and
   API route, webhooks and their signatures, money and quotas, data deletion and retention, background jobs and
   recovery, outbound requests (SSRF, timeouts, response size), and anything that reads unbounded data (Convex
   limits: 16,384 documents / 8 MB read per function; `.collect()`, `.filter()` scans, a query per item). Use
   read-only subagents for areas you have not read this session. Skip what earlier rounds fixed.
2. **Check.** Keep a finding only with a concrete case ("this input leads to this wrong result"). Grep before calling
   code unused or a check missing. A `shortcut:` comment that names its limit is a decision unless the expected load
   (hosted multi-tenant service, plus self-hosted installs) already crosses it.
3. **Fix.** The smallest change that fully works, matching the surrounding code. Every fix gets one test that fails
   without it (run the test against the old code to prove it). Agents working in parallel touch separate files and
   never stash, reset or check out files they do not own.
4. **Gate.** `pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm test:smoke` when pages changed. Commit locally
   with a message listing the fixes. Never push.
5. **Report** the round in a few lines: fixed, left as a decision (and why), not checked.

Stop when a round's audit finds no must-fix or should-fix security or performance issue. Then give a final report:
every fix with its commit, what was left and why, and what was never read.
