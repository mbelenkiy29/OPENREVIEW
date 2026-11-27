import type { CiAudit } from "./ci-audit";

// Spend guard v1 (convex/ciSpendGuardJobs.ts): once a day, each workspace's month-to-date GitHub Actions
// spend is estimated from CI audits, compared with its monthly budget, and its critical workflows are
// checked for having stopped. This module decides what to say; delivery reuses the notification
// pipeline, so each alert goes out at most once (per month for a budget step, per day for the rest).
// It cannot keep GitHub running a job past a spending limit; it can only warn before and when that happens.

export const budgetSteps = [50, 80, 100] as const;
export type BudgetStep = (typeof budgetSteps)[number];

export type CriticalWorkflow = { repository: string; path: string };
/** partial: only part of the month could be read, so cost is a lower bound. */
export type RepositorySpend = { repository: string; cost: number; minutes: number; audit?: CiAudit; error?: string; partial?: boolean };
export type CriticalProblem = { repository: string; path: string; name: string; problem: string };

/** The UTC month ("2026-11") and the days of it elapsed, counting today. */
export function monthToDate(now: number) {
  const d = new Date(now);
  return { period: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, days: d.getUTCDate() };
}

/** The highest budget step the spend has reached, if any. */
export function budgetStep(spent: number, budget: number): BudgetStep | undefined {
  if (!(budget > 0)) return undefined;
  const share = (spent / budget) * 100;
  return [...budgetSteps].reverse().find((step) => share >= step);
}

/** Critical workflows that did not run in the last two days, whose latest run failed, or that did not run at all. */
export function criticalProblems(critical: CriticalWorkflow[], spend: RepositorySpend[], now: number): CriticalProblem[] {
  const problems: CriticalProblem[] = [];
  for (const c of critical) {
    const repo = spend.find((s) => s.repository.toLowerCase() === c.repository.toLowerCase());
    if (!repo?.audit) continue; // Could not be read today; reported with the repository's error instead.
    const w = repo.audit.workflows.find((x) => x.path === c.path);
    // A partial history covers only the newest days, so a run may still have happened earlier in the month.
    if ((!w || !w.lastRunAt) && repo.partial) continue;
    if (!w || !w.lastRunAt) { problems.push({ repository: c.repository, path: c.path, name: w?.name ?? c.path, problem: "has not run this month" }); continue; }
    const quiet = Math.floor((now - Date.parse(w.lastRunAt)) / 86400000);
    if (quiet >= 2) problems.push({ repository: c.repository, path: c.path, name: w.name, problem: `last ran ${quiet} days ago` });
    else if (w.lastConclusion && !["success", "skipped", "neutral"].includes(w.lastConclusion)) problems.push({ repository: c.repository, path: c.path, name: w.name, problem: `latest run ended ${w.lastConclusion}` });
  }
  return problems;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

export function guardMessages(input: { workspace: string; period: string; budget?: number; spend: RepositorySpend[]; problems: CriticalProblem[]; step?: BudgetStep; url?: string; notes?: string[] }) {
  const total = input.spend.reduce((n, s) => n + s.cost, 0);
  const top = [...input.spend].sort((a, b) => b.cost - a.cost).slice(0, 5);
  const lines = top.map((s) => s.error ? `- ${s.repository}: could not be read (${s.error})` : `- ${s.repository}: ${s.partial ? "at least " : ""}${usd(s.cost)} (${Math.round(s.minutes)} min)`);
  const budget = input.budget ? ` of the ${usd(input.budget)} monthly budget` : "";
  const incomplete = input.spend.some((s) => s.partial || s.error);
  const summary = `${input.workspace}: GitHub Actions spend for ${input.period} is ${incomplete ? "at least" : "about"} ${usd(total)}${budget}.`;
  const tail = [...(input.notes ?? []), ...(input.url ? [`Details: ${input.url}`] : []), "Estimates at list price per runner minute; plan allowances are not subtracted."];
  return {
    total,
    budget: input.step && input.budget ? {
      subject: input.step >= 100 ? `GitHub Actions spend reached its ${usd(input.budget)} budget` : `GitHub Actions spend passed ${input.step}% of its budget`,
      text: [summary, "", ...lines, "", ...tail].join("\n"),
    } : undefined,
    critical: input.problems.length ? {
      subject: input.problems.length === 1 ? `Critical workflow ${input.problems[0].name} needs a look` : `${input.problems.length} critical workflows need a look`,
      text: [`${input.workspace}: these workflows are marked critical in OpenReview's spend guard.`, "", ...input.problems.map((p) => `- ${p.repository} ${p.name} (${p.path}) ${p.problem}`), "", ...tail.slice(0, 1)].join("\n"),
    } : undefined,
    daily: { subject: `GitHub Actions spend: ${usd(total)} so far in ${input.period}`, text: [summary, "", ...lines, "", ...tail].join("\n") },
  };
}
