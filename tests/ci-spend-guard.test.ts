import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetStep, criticalProblems, guardMessages, monthToDate, type RepositorySpend } from "../src/ci-spend-guard";
import type { CiAudit, WorkflowAudit } from "../src/ci-audit";

const now = Date.parse("2026-11-27T13:00:00Z");
const workflow = (o: Partial<WorkflowAudit>): WorkflowAudit => ({ workflowId: 1, name: "Backup", path: ".github/workflows/backup.yml", runs: 1, events: {}, minutes: 5, cost: 0.03, cancelledRuns: 0, cancelledMinutes: 0, failedRuns: 0, supersededRuns: 0, supersededMinutes: 0, critical: true, recommendations: [], ...o });
const spendFor = (workflows: WorkflowAudit[], cost = 10): RepositorySpend => ({ repository: "acme/app", cost, minutes: 1000, audit: { workflows } as unknown as CiAudit });

test("monthToDate names the UTC month and the days elapsed", () => {
  assert.deepEqual(monthToDate(now), { period: "2026-11", days: 27 });
  assert.deepEqual(monthToDate(Date.parse("2027-01-01T00:30:00Z")), { period: "2027-01", days: 1 });
});

test("budgetStep reports the highest step reached, and nothing without a budget", () => {
  assert.equal(budgetStep(40, 100), undefined);
  assert.equal(budgetStep(50, 100), 50);
  assert.equal(budgetStep(85, 100), 80);
  assert.equal(budgetStep(130, 100), 100);
  assert.equal(budgetStep(130, 0), undefined);
});

test("critical workflows that stopped, failed or never ran are reported; healthy ones are not", () => {
  const critical = [{ repository: "acme/app", path: ".github/workflows/backup.yml" }];
  assert.deepEqual(criticalProblems(critical, [spendFor([workflow({ lastRunAt: "2026-11-27T03:00:00Z", lastConclusion: "success" })])], now), []);
  assert.match(criticalProblems(critical, [spendFor([workflow({ lastRunAt: "2026-11-22T03:00:00Z", lastConclusion: "success" })])], now)[0].problem, /last ran 5 days ago/);
  assert.match(criticalProblems(critical, [spendFor([workflow({ lastRunAt: "2026-11-27T03:00:00Z", lastConclusion: "failure" })])], now)[0].problem, /ended failure/);
  assert.match(criticalProblems(critical, [spendFor([])], now)[0].problem, /has not run this month/);
  // A repository that could not be read is reported through its error, not as a stopped workflow.
  assert.deepEqual(criticalProblems(critical, [{ repository: "acme/app", cost: 0, minutes: 0, error: "no access" }], now), []);
});

test("guardMessages builds the budget, critical and daily messages", () => {
  const spend = [spendFor([], 85), { repository: "acme/web", cost: 0, minutes: 0, error: "the GitHub App needs Actions: Read" }];
  const m = guardMessages({ workspace: "Acme", period: "2026-11", budget: 100, spend, problems: [{ repository: "acme/app", path: ".github/workflows/backup.yml", name: "Backup", problem: "last ran 5 days ago" }], step: 80, url: "https://openreview.tech/dashboard/organization/ci" });
  assert.equal(m.total, 85);
  assert.equal(m.budget?.subject, "GitHub Actions spend passed 80% of its budget");
  assert.match(m.budget!.text, /at least \$85\.00 of the \$100\.00 monthly budget/);
  assert.match(m.budget!.text, /acme\/web: could not be read/);
  assert.equal(m.critical?.subject, "Critical workflow Backup needs a look");
  assert.match(m.daily.subject, /\$85\.00 so far in 2026-11/);
  assert.equal(guardMessages({ workspace: "Acme", period: "2026-11", budget: 100, spend, problems: [], step: 100 }).budget?.subject, "GitHub Actions spend reached its $100.00 budget");
  assert.equal(guardMessages({ workspace: "Acme", period: "2026-11", spend, problems: [] }).budget, undefined);
});

test("a partial month is a lower bound, says so, and raises no has-not-run alarm", () => {
  const partial = { ...spendFor([], 12), partial: true };
  const m = guardMessages({ workspace: "Acme", period: "2026-11", spend: [partial], problems: [], notes: ["acme/app: only part of the month could be read, so its spend is at least the amount shown."] });
  assert.match(m.daily.text, /is at least \$12\.00/);
  assert.match(m.daily.text, /acme\/app: at least \$12\.00/);
  assert.match(m.daily.text, /only part of the month could be read/);
  assert.deepEqual(criticalProblems([{ repository: "acme/app", path: ".github/workflows/backup.yml" }], [partial], Date.parse("2026-11-27T00:00:00Z")), []);
});

test("a full month with every repository read says about", () => {
  const m = guardMessages({ workspace: "Acme", period: "2026-11", spend: [spendFor([], 12)], problems: [] });
  assert.match(m.daily.text, /is about \$12\.00/);
});
