// CI audit: where a repository's GitHub Actions minutes go, and how many of them buy nothing.
// Pure analysis over run and job history (src/ci-audit-github.ts fetches it), so the CLI
// (scripts/ci-audit.ts), a public /ci page and an in-app report can share one implementation.
// Read-only by design: nothing here writes to a repository.

export type ActionsRun = {
  id: number;
  workflowId: number;
  name: string;
  path: string;
  event: string;
  branch: string | null;
  headSha: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  startedAt?: string | null;
  updatedAt: string;
  attempt?: number;
  /** The fork (or this repository) a pull request run came from, so same-named branches in forks stay apart. */
  headRepository?: string | null;
};
export type ActionsJob = {
  runId: number;
  name: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  labels: string[];
};
export type WorkflowFile = { id: number; name: string; path: string; state?: string; content?: string };
export type ActionsHistory = {
  repository: string;
  private: boolean;
  defaultBranch: string;
  days: number;
  from: string;
  to: string;
  runs: ActionsRun[];
  /** Jobs keyed by run id, for the runs whose jobs were fetched (all of them, or a sample). */
  jobs: Record<number, ActionsJob[]>;
  workflows: WorkflowFile[];
  /** Why the history is incomplete (API limits), shown in the report. */
  truncated?: string[];
};

export type RunnerClass = "linux" | "windows" | "macos" | "self-hosted";
// Per-minute list prices for GitHub-hosted 2-core runners (USD). Estimates: GitHub changes these, and
// a plan's included minutes are not subtracted. Override with the `rates` option.
export const defaultRates: Record<RunnerClass, number> = { linux: 0.006, windows: 0.010, macos: 0.062, "self-hosted": 0 };

// GitHub bills each job rounded up to the whole minute; skipped jobs and jobs that never started cost nothing.
export function jobMinutes(job: Pick<ActionsJob, "startedAt" | "completedAt" | "conclusion">, after?: number): number {
  if (!job.startedAt || !job.completedAt || job.conclusion === "skipped") return 0;
  const start = Math.max(Date.parse(job.startedAt), after ?? -Infinity), end = Date.parse(job.completedAt);
  return end > start ? Math.ceil((end - start) / 60000) : 0;
}

// Runner class and price multiplier from a job's labels. Larger runners ("ubuntu-24.04-8-cores") scale with cores.
export function runnerFor(labels: string[]): { runner: RunnerClass; multiplier: number } {
  const all = labels.map((l) => l.toLowerCase());
  if (all.includes("self-hosted")) return { runner: "self-hosted", multiplier: 1 };
  const runner: RunnerClass = all.some((l) => l.startsWith("macos")) ? "macos" : all.some((l) => l.startsWith("windows")) ? "windows" : "linux";
  const cores = Math.max(0, ...all.map((l) => Number(/(\d+)[-_]?cores?\b/.exec(l)?.[1] ?? 0)));
  return { runner, multiplier: cores > 2 ? cores / 2 : 1 };
}

export type WorkflowHints = {
  pullRequest: boolean;
  scheduled: boolean;
  concurrency: boolean;
  cancelsInProgress: boolean;
  /** cancel-in-progress is an expression, so whether it applies to a given run is unknown. */
  cancelsConditionally: boolean;
  pathFilters: boolean;
  draftGuard: boolean;
};
// Light text checks on a workflow file (no YAML parser): enough to tell which fixes are already in place.
export function workflowHints(yaml: string): WorkflowHints {
  return {
    pullRequest: /(^|[\s[,{])pull_request(_target)?\b/m.test(yaml),
    scheduled: /^\s*schedule\s*:/m.test(yaml),
    concurrency: /^\s*concurrency\s*:/m.test(yaml),
    cancelsInProgress: /cancel-in-progress\s*:\s*true\b/.test(yaml),
    cancelsConditionally: /cancel-in-progress\s*:\s*\$\{\{/.test(yaml),
    pathFilters: /^\s*paths(-ignore)?\s*:/m.test(yaml),
    draftGuard: /draft\s*==\s*false|!\s*github\.event\.pull_request\.draft|draft\s*!=\s*true/.test(yaml),
  };
}

// Deploys, releases, backups and scheduled jobs are never suggested for cancellation; the spend guard watches them instead.
export const criticalWorkflow = (w: { name: string; path: string }, hints?: WorkflowHints) =>
  Boolean(hints?.scheduled) || /deploy|release|publish|backup|migrat/i.test(`${w.name} ${w.path}`);

export type WorkflowAudit = {
  workflowId: number;
  name: string;
  path: string;
  runs: number;
  events: Record<string, number>;
  minutes: number;
  cost: number;
  cancelledRuns: number;
  cancelledMinutes: number;
  failedRuns: number;
  supersededRuns: number;
  supersededMinutes: number;
  lastRunAt?: string;
  lastConclusion?: string | null;
  critical: boolean;
  hints?: WorkflowHints;
  recommendations: string[];
};
export type CiAudit = {
  repository: string;
  private: boolean;
  days: number;
  from: string;
  to: string;
  runs: number;
  sampledRuns: number;
  estimated: boolean;
  /** wasted counts each run once: all of a cancelled run, or a superseded run's minutes after the newer run started. */
  minutes: { total: number; cancelled: number; superseded: number; failed: number; wasted: number };
  cost: { total: number; cancelled: number; superseded: number };
  runners: Partial<Record<RunnerClass, number>>;
  /** Scaled to 30 days. The saving counts only superseded minutes that cancel-in-progress would stop. */
  monthly: { runs: number; minutes: number; cost: number; savingMinutes: number; savingCost: number };
  workflows: WorkflowAudit[];
  notes: string[];
};

type Estimate = { minutes: number; cost: number; byRunner: Partial<Record<RunnerClass, number>> };
const round2 = (n: number) => Math.round(n * 100) / 100;

export function auditActions(history: ActionsHistory, options: { rates?: Partial<Record<RunnerClass, number>>; now?: number } = {}): CiAudit {
  const rates = { ...defaultRates, ...options.rates };
  const now = options.now ?? Date.parse(history.to);
  const hintsByPath = new Map(history.workflows.filter((w) => w.content).map((w) => [w.path, workflowHints(w.content!)]));

  // Measured cost of a run (its jobs), optionally only the minutes after a moment.
  const measure = (jobs: ActionsJob[], after?: number): Estimate => {
    const e: Estimate = { minutes: 0, cost: 0, byRunner: {} };
    for (const job of jobs) {
      const minutes = jobMinutes(job, after);
      if (!minutes) continue;
      const { runner, multiplier } = runnerFor(job.labels);
      e.minutes += minutes;
      e.cost += minutes * rates[runner] * multiplier;
      e.byRunner[runner] = (e.byRunner[runner] ?? 0) + minutes;
    }
    return e;
  };

  // Per-workflow averages from the sampled runs stand in for runs whose jobs were not fetched.
  const averages = new Map<number, { minutes: number; cost: number; wall: number; runner: Partial<Record<RunnerClass, number>> }>();
  for (const run of history.runs) {
    const jobs = history.jobs[run.id];
    if (!jobs) continue;
    const e = measure(jobs), a = averages.get(run.workflowId) ?? { minutes: 0, cost: 0, wall: 0, runner: {} };
    a.minutes += e.minutes; a.cost += e.cost; a.wall += 1;
    for (const [k, m] of Object.entries(e.byRunner)) a.runner[k as RunnerClass] = (a.runner[k as RunnerClass] ?? 0) + m;
    averages.set(run.workflowId, a);
  }
  const wallMinutes = (run: ActionsRun, after?: number) => {
    const start = Math.max(Date.parse(run.startedAt ?? run.createdAt), after ?? -Infinity), end = Date.parse(run.updatedAt);
    return end > start ? Math.ceil((end - start) / 60000) : 0;
  };
  const estimate = (run: ActionsRun, after?: number): Estimate => {
    const jobs = history.jobs[run.id];
    if (jobs) return measure(jobs, after);
    if (run.status !== "completed") {
      // Queued or waiting runs have not used a runner; a running one has used its time so far, at Linux prices.
      const minutes = run.startedAt && run.status === "in_progress" ? wallMinutes(run, after) : 0;
      return { minutes, cost: minutes * rates.linux, byRunner: minutes ? { linux: minutes } : {} };
    }
    const a = averages.get(run.workflowId);
    if (!a || !a.wall) {
      // No sample for this workflow: wall time on Linux, a lower bound for runs with parallel jobs.
      const minutes = wallMinutes(run, after);
      return { minutes, cost: minutes * rates.linux, byRunner: minutes ? { linux: minutes } : {} };
    }
    const share = after === undefined ? 1 : (wallMinutes(run) ? wallMinutes(run, after) / wallMinutes(run) : 0);
    const minutes = (a.minutes / a.wall) * share, cost = (a.cost / a.wall) * share;
    const byRunner: Partial<Record<RunnerClass, number>> = {};
    for (const [k, m] of Object.entries(a.runner)) byRunner[k as RunnerClass] = (m / a.minutes) * minutes;
    return { minutes, cost, byRunner };
  };

  // A run is superseded when a run of the same workflow, event and branch for a newer commit starts while it is
  // still going: with `concurrency` and `cancel-in-progress`, the minutes after that moment are not spent.
  const supersededAt = new Map<number, number>();
  const groups = new Map<string, ActionsRun[]>();
  for (const run of history.runs) {
    if (!run.branch) continue;
    const key = `${run.workflowId}\u0000${run.event}\u0000${run.headRepository ?? ""}\u0000${run.branch}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  for (const runs of groups.values()) {
    runs.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i], end = Date.parse(run.updatedAt);
      const next = runs.slice(i + 1).find((n) => n.headSha !== run.headSha);
      if (next && Date.parse(next.createdAt) < end) supersededAt.set(run.id, Date.parse(next.createdAt));
    }
  }

  const byWorkflow = new Map<number, WorkflowAudit>();
  const totals = { minutes: 0, cost: 0, wasted: 0, cancelled: 0, cancelledCost: 0, superseded: 0, supersededCost: 0, failed: 0, saving: 0, savingCost: 0 };
  const supersededCost = new Map<number, number>();
  const runners: Partial<Record<RunnerClass, number>> = {};
  for (const run of history.runs) {
    const file = history.workflows.find((w) => w.id === run.workflowId);
    const path = file?.path ?? run.path, hints = hintsByPath.get(path);
    const w = byWorkflow.get(run.workflowId) ?? {
      workflowId: run.workflowId, name: file?.name ?? run.name, path, runs: 0, events: {}, minutes: 0, cost: 0,
      cancelledRuns: 0, cancelledMinutes: 0, failedRuns: 0, supersededRuns: 0, supersededMinutes: 0,
      critical: criticalWorkflow({ name: file?.name ?? run.name, path }, hints), hints, recommendations: [],
    };
    const e = estimate(run);
    w.runs++; w.events[run.event] = (w.events[run.event] ?? 0) + 1; w.minutes += e.minutes; w.cost += e.cost;
    if (!w.lastRunAt || run.createdAt > w.lastRunAt) { w.lastRunAt = run.createdAt; w.lastConclusion = run.conclusion; }
    totals.minutes += e.minutes; totals.cost += e.cost;
    for (const [k, m] of Object.entries(e.byRunner)) runners[k as RunnerClass] = (runners[k as RunnerClass] ?? 0) + m;
    if (run.conclusion === "cancelled") { w.cancelledRuns++; w.cancelledMinutes += e.minutes; totals.cancelled += e.minutes; totals.cancelledCost += e.cost; }
    if (run.conclusion === "failure") { w.failedRuns++; totals.failed += e.minutes; }
    const at = supersededAt.get(run.id);
    const wasted = at === undefined ? undefined : estimate(run, at);
    totals.wasted += run.conclusion === "cancelled" ? e.minutes : wasted?.minutes ?? 0;
    if (wasted) {
      if (wasted.minutes > 0) {
        w.supersededRuns++; w.supersededMinutes += wasted.minutes; totals.superseded += wasted.minutes; totals.supersededCost += wasted.cost;
        supersededCost.set(run.workflowId, (supersededCost.get(run.workflowId) ?? 0) + wasted.cost);
      }
    }
    byWorkflow.set(run.workflowId, w);
  }

  // Active scheduled workflows with no runs in the window are the ones most likely to have stopped.
  for (const file of history.workflows) {
    const hints = hintsByPath.get(file.path);
    if (byWorkflow.has(file.id) || !hints?.scheduled || (file.state && file.state !== "active")) continue;
    byWorkflow.set(file.id, { workflowId: file.id, name: file.name, path: file.path, runs: 0, events: {}, minutes: 0, cost: 0, cancelledRuns: 0, cancelledMinutes: 0, failedRuns: 0, supersededRuns: 0, supersededMinutes: 0, critical: true, hints, recommendations: [] });
  }

  const scale = 30 / Math.max(1, history.days);
  const workflows = [...byWorkflow.values()].sort((a, b) => b.cost - a.cost || b.minutes - a.minutes);
  for (const w of workflows) {
    // A run started by a schedule makes a workflow critical even when its file could not be read.
    if (w.events.schedule) w.critical = true;
    // Already cancelled in progress, or a workflow that must finish: not counted as a saving.
    if (!w.critical && !w.hints?.cancelsInProgress) { totals.saving += w.supersededMinutes; totals.savingCost += supersededCost.get(w.workflowId) ?? 0; }
    const prRuns = (w.events.pull_request ?? 0) + (w.events.pull_request_target ?? 0);
    if (w.critical) {
      w.recommendations.push("Critical workflow: keep it running and alert if it stops, rather than cancelling it.");
      const quiet = w.lastRunAt ? (now - Date.parse(w.lastRunAt)) / 86400000 : undefined;
      if (w.hints?.scheduled && quiet === undefined) w.recommendations.push(`Scheduled, but it did not run in the last ${history.days} days. Check that it still runs.`);
      else if (w.hints?.scheduled && quiet !== undefined && quiet > 2) w.recommendations.push(`Scheduled, but its last run was ${Math.floor(quiet)} days ago. Check that it still runs.`);
    } else if (w.supersededMinutes > 0 && w.hints?.cancelsConditionally && !w.hints.cancelsInProgress) {
      w.recommendations.push(`\`cancel-in-progress\` is set by an expression: check that it is true for these runs. About ${Math.round(w.supersededMinutes * scale)} minutes a month were spent after a newer run started.`);
    } else if (w.supersededMinutes > 0 && !w.hints?.cancelsInProgress) {
      w.recommendations.push(`Add \`concurrency\` with \`cancel-in-progress: true\`: saves about ${Math.round(w.supersededMinutes * scale)} minutes a month.`);
    }
    if (!w.critical && prRuns > 0 && w.hints && !w.hints.draftGuard) w.recommendations.push("Skip heavy jobs on draft pull requests (`if: github.event.pull_request.draft == false`).");
    if (!w.critical && prRuns > 0 && w.hints && !w.hints.pathFilters) w.recommendations.push("Consider `paths` filters so changes that cannot affect this workflow skip it.");
    w.minutes = Math.round(w.minutes); w.cost = round2(w.cost); w.cancelledMinutes = Math.round(w.cancelledMinutes); w.supersededMinutes = Math.round(w.supersededMinutes);
  }

  const sampledRuns = history.runs.filter((r) => history.jobs[r.id]).length;
  const notes = [...(history.truncated ?? [])];
  if (sampledRuns < history.runs.length) notes.push(`Job minutes were fetched for ${sampledRuns} of ${history.runs.length} runs; the rest are estimated from each workflow's average.`);
  if (!history.private) notes.push("Public repository: GitHub-hosted standard runners are free here. Costs show what the same minutes would cost in a private repository.");
  notes.push("Costs use list prices per runner minute and do not subtract a plan's included minutes.");
  const unread = history.workflows.filter((w) => !w.content && w.path.startsWith(".github/workflows/") && byWorkflow.has(w.id)).map((w) => w.path);
  if (unread.length) notes.push(`Not on the default branch or unreadable, so fixes were not checked: ${unread.join(", ")}.`);

  return {
    repository: history.repository, private: history.private, days: history.days, from: history.from, to: history.to,
    runs: history.runs.length, sampledRuns, estimated: sampledRuns < history.runs.length,
    minutes: { total: Math.round(totals.minutes), cancelled: Math.round(totals.cancelled), superseded: Math.round(totals.superseded), failed: Math.round(totals.failed), wasted: Math.round(totals.wasted) },
    cost: { total: round2(totals.cost), cancelled: round2(totals.cancelledCost), superseded: round2(totals.supersededCost) },
    runners: Object.fromEntries(Object.entries(runners).map(([k, m]) => [k, Math.round(m)])),
    monthly: {
      runs: Math.round(history.runs.length * scale), minutes: Math.round(totals.minutes * scale), cost: round2(totals.cost * scale),
      savingMinutes: Math.round(totals.saving * scale), savingCost: round2(totals.savingCost * scale),
    },
    workflows, notes,
  };
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "0%");

// Plain-text report for the CLI and for pasting into an issue or chat.
export function formatCiAudit(a: CiAudit): string {
  const lines = [
    `CI audit: ${a.repository} (${a.private ? "private" : "public"}), last ${a.days} days (${a.from.slice(0, 10)} to ${a.to.slice(0, 10)})`,
    "",
    `Runs: ${a.runs}${a.estimated ? ` (job minutes measured on ${a.sampledRuns})` : ""}`,
    `Billable minutes: ${a.minutes.total}, estimated ${usd(a.cost.total)}`,
    `Cancelled part-way: ${a.minutes.cancelled} min (${pct(a.minutes.cancelled, a.minutes.total)})`,
    `Spent after a newer commit's run started: ${a.minutes.superseded} min (${pct(a.minutes.superseded, a.minutes.total)})`,
    `Failed runs: ${a.minutes.failed} min`,
    "",
    `At this pace, a month: ${a.monthly.runs} runs, ${a.monthly.minutes} min, about ${usd(a.monthly.cost)}`,
    `Cancelling superseded runs would save about ${a.monthly.savingMinutes} min (${usd(a.monthly.savingCost)}) a month`,
    "",
    "Workflows (most expensive first):",
  ];
  for (const w of a.workflows) {
    lines.push(`- ${w.name} (${w.path}): ${w.runs} runs, ${w.minutes} min, ${usd(w.cost)}; cancelled ${w.cancelledMinutes} min, superseded ${w.supersededMinutes} min${w.critical ? "; critical" : ""}`);
    for (const r of w.recommendations) lines.push(`    • ${r}`);
  }
  if (a.notes.length) lines.push("", "Notes:", ...a.notes.map((n) => `- ${n}`));
  return lines.join("\n");
}
