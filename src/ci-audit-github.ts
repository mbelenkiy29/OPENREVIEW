import type { ActionsHistory, ActionsJob, ActionsRun, WorkflowFile } from "./ci-audit";

// Reads a repository's GitHub Actions history for src/ci-audit.ts with read-only REST calls:
// the repository, its workflows and workflow files, runs created in the window, and jobs for up to
// `maxJobRuns` runs. A token needs read access to Actions and contents (a fine-grained token with
// "Actions: read" and "Contents: read", or a classic token's `repo` scope for private repositories).
// Public repositories also work without a token, at GitHub's anonymous limit of 60 requests an hour.

export class GithubAuditError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export type ActionsHistoryOptions = {
  repository: string;
  token?: string;
  days?: number;
  /** Runs whose jobs are fetched; the rest are estimated from their workflow's average. */
  maxJobRuns?: number;
  /** Requests kept back from the rate limit, so one audit cannot use up a token. */
  reserve?: number;
  base?: string;
  fetch?: typeof fetch;
  now?: number;
  /** Waits at most this long (ms) for a rate limit to reset before stopping with what it has. */
  maxWait?: number;
  /** Refuse private repositories (the public /ci check, whose token must never expose one). */
  publicOnly?: boolean;
  /** Stop at this time (ms since epoch) and return what was read; requests in flight are aborted then. */
  deadline?: number;
  /** Start of the window (ms since epoch), in place of `days` before now: the spend guard's month to date. */
  since?: number;
  onProgress?: (message: string) => void;
};

/** Whether the in-app CI cost report is switched on for this deployment (operator setting). */
export const ciCostEnabled = (env: Record<string, string | undefined> = process.env) => env.CI_COST_ENABLED === "true";
/** Whether the public /ci check has a token to read GitHub with. */
export const ciCheckEnabled = (env: Record<string, string | undefined> = process.env) => Boolean(env.CI_AUDIT_GITHUB_TOKEN?.trim());

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** "owner/name" from what a visitor pastes: owner/name, or a github.com URL to the repository or a page in it. */
export function parseRepository(input: string): string | null {
  const value = input.trim().replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "").replace(/\.git$/i, "");
  const [owner, name] = value.split(/[/?#]/);
  const repository = owner && name ? `${owner}/${name.replace(/\.git$/i, "")}` : "";
  return repositoryPattern.test(repository) && !repository.split("/").some((part) => /^\.+$/.test(part)) ? repository : null;
}

/** Thrown inside the fetcher when the deadline passes; callers stop and keep what was read. */
class DeadlineReached extends Error {}
const day = 86400000;

export async function fetchActionsHistory(options: ActionsHistoryOptions): Promise<ActionsHistory> {
  const { repository, token } = options;
  if (parseRepository(repository) !== repository) throw new Error("Repository must look like owner/name");
  const days = Math.min(90, Math.max(1, Math.floor(options.days ?? 30)));
  const base = options.base ?? "https://api.github.com", http = options.fetch ?? fetch, now = options.now ?? Date.now();
  const reserve = options.reserve ?? (token ? 100 : 5), maxWait = options.maxWait ?? 60000;
  const maxJobRuns = Math.max(0, Math.floor(options.maxJobRuns ?? (token ? 600 : 25)));
  const progress = options.onProgress ?? (() => {});
  const truncated: string[] = [];
  let remaining = Infinity, inFlight = 0;

  async function get<T>(path: string, optional = false): Promise<T | undefined> {
    for (let attempt = 0; ; attempt++) {
      const msLeft = options.deadline ? options.deadline - Date.now() : Infinity;
      if (msLeft <= 0) throw new DeadlineReached();
      inFlight++;
      const response = await http(base + path, {
        ...(Number.isFinite(msLeft) ? { signal: AbortSignal.timeout(msLeft) } : {}),
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "openreview-ci-audit",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      }).catch((error) => {
        if (options.deadline && Date.now() >= options.deadline - 50) throw new DeadlineReached();
        throw error;
      }).finally(() => { inFlight--; });
      const left = response.headers.get("x-ratelimit-remaining");
      if (left !== null) remaining = Number(left);
      if (response.ok) return (await response.json()) as T;
      if (optional && response.status === 404) return undefined;
      const limited = response.status === 429 || (response.status === 403 && left === "0");
      if (limited && attempt < 2) {
        const reset = Number(response.headers.get("x-ratelimit-reset") ?? 0) * 1000;
        const wait = Number(response.headers.get("retry-after") ?? 0) * 1000 || Math.max(0, reset - Date.now()) || 2000 * (attempt + 1);
        if (wait <= maxWait) { await new Promise((r) => setTimeout(r, wait)); continue; }
      }
      if (response.status >= 500 && attempt < 2) { await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); continue; }
      const detail = limited ? "GitHub's rate limit was reached; try again later or with a token" : response.status === 404 ? "Repository not found, or the token cannot read it" : `GitHub returned ${response.status}`;
      throw new GithubAuditError(detail, response.status);
    }
  }
  // Requests still in flight count as spent, so parallel workers cannot overrun the reserve.
  const budgetLeft = () => remaining - inFlight > reserve && (!options.deadline || Date.now() < options.deadline);
  // Runs a step that may hit the deadline; returns false when it did, so the caller stops and keeps what it has.
  const beforeDeadline = async (step: () => Promise<unknown>) => {
    try { await step(); return true; } catch (error) { if (error instanceof DeadlineReached) return false; throw error; }
  };

  const repo = (await get<{ private: boolean; default_branch: string; full_name: string }>(`/repos/${repository}`))!;
  if (options.publicOnly && repo.private) throw new GithubAuditError("Repository not found, or it is not public", 404);
  const workflowList: { id: number; name: string; path: string; state: string }[] = [];
  for (let page = 1; page <= 10; page++) {
    const result = (await get<{ total_count: number; workflows: { id: number; name: string; path: string; state: string }[] }>(`/repos/${repository}/actions/workflows?per_page=100&page=${page}`))!;
    workflowList.push(...result.workflows);
    if (result.workflows.length < 100 || workflowList.length >= result.total_count) break;
  }

  // Workflow files at the default branch, to see which fixes are already in place. Every active workflow is
  // read, not only those that ran (a scheduled job that stopped has no runs), and before the runs, so the
  // checks survive a run listing that uses up the request budget.
  const workflows: WorkflowFile[] = [];
  let filesRead = 0;
  for (const w of workflowList) {
    const file: WorkflowFile = { id: w.id, name: w.name, path: w.path, state: w.state };
    if (w.state === "active" && w.path.startsWith(".github/workflows/") && filesRead < 50 && budgetLeft()) {
      filesRead++;
      await beforeDeadline(async () => {
        const content = await get<{ content?: string; encoding?: string }>(`/repos/${repository}/contents/${w.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(repo.default_branch)}`, true);
        if (content?.content && content.encoding === "base64") file.content = decodeBase64(content.content);
      });
    }
    workflows.push(file);
  }

  // The runs list returns at most 1,000 results for one query, so the window is read a day at a time,
  // and a day with more runs than that is split into smaller windows.
  const runs: ActionsRun[] = [];
  const from = options.since !== undefined ? Math.max(now - 90 * day, Math.min(now - 60000, options.since)) : now - days * day;
  async function readWindow(start: number, end: number): Promise<boolean> {
    const range = `${new Date(start).toISOString().replace(/\.\d{3}Z$/, "Z")}..${new Date(end - 1000).toISOString().replace(/\.\d{3}Z$/, "Z")}`;
    for (let page = 1; ; page++) {
      if (!budgetLeft()) { truncated.push(`Stopped listing runs at ${range.split("..")[0]} to stay within the GitHub rate limit or time limit.`); return false; }
      let result: { total_count: number; workflow_runs: RawRun[] } | undefined;
      if (!await beforeDeadline(async () => { result = await get(`/repos/${repository}/actions/runs?per_page=100&page=${page}&created=${encodeURIComponent(range)}`); }) || !result) { truncated.push(`Stopped listing runs at ${range.split("..")[0]} at the time limit.`); return false; }
      if (page === 1 && result.total_count >= 1000 && end - start > 3600000) {
        const middle = start + Math.floor((end - start) / 2);
        // Newer half first, matching the newest-first order of the days.
        const later = await readWindow(middle, end);
        return (await readWindow(start, middle)) && later;
      }
      runs.push(...result.workflow_runs.map(toRun));
      if (page === 1 && result.total_count > 1000) truncated.push(`More than 1,000 runs started in the hour from ${range.split("..")[0]}; only the first 1,000 were read.`);
      if (result.workflow_runs.length < 100 || page * 100 >= Math.min(1000, result.total_count)) return true;
    }
  }
  // Newest day first, so a run that stops early still covers the most recent days. Only days read in full
  // count toward the window, so a shortened window is not projected as if it were the whole one.
  let covered = now;
  for (let end = now; end > from; end -= day) {
    if (!budgetLeft()) { truncated.push(`Stopped listing runs before ${new Date(end).toISOString().slice(0, 10)} to stay within the GitHub rate limit or time limit.`); break; }
    const before = runs.length, start = Math.max(from, end - day);
    const complete = await readWindow(start, end);
    if (runs.length > before) progress(`Listed ${runs.length} runs`);
    if (!complete) break;
    covered = start;
  }
  const unique = [...new Map(runs.map((r) => [r.id, r])).values()].filter((r) => Date.parse(r.createdAt) >= covered);

  // Jobs for an even spread of runs across the window, so averages are not skewed toward one day.
  const completed = unique.filter((r) => r.status === "completed").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const step = completed.length > maxJobRuns ? completed.length / maxJobRuns : 1;
  const sample = maxJobRuns ? Array.from({ length: Math.min(maxJobRuns, completed.length) }, (_, i) => completed[Math.floor(i * step)]) : [];
  const jobs: Record<number, ActionsJob[]> = {};
  let next = 0, incomplete = 0;
  async function worker() {
    while (next < sample.length && budgetLeft()) {
      const run = sample[next++];
      const list: ActionsJob[] = [];
      let complete = false;
      for (let page = 1; page <= 5; page++) {
        if (page > 1 && !budgetLeft()) break;
        let result: { total_count: number; jobs: RawJob[] } | undefined;
        if (!await beforeDeadline(async () => { result = await get(`/repos/${repository}/actions/runs/${run.id}/jobs?per_page=100&page=${page}`, true); })) { if (list.length) incomplete++; return; }
        if (!result) break;
        list.push(...result.jobs.map((j) => toJob(run.id, j)));
        if (list.length >= result.total_count || result.jobs.length < 100) { complete = true; break; }
      }
      // Only a run's full job list is a measurement; a partial one would understate it and every run estimated from it.
      if (complete) jobs[run.id] = list;
      else if (list.length) incomplete++;
      if (Object.keys(jobs).length % 50 === 0) progress(`Read jobs for ${Object.keys(jobs).length} of ${sample.length} runs`);
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  if (Object.keys(jobs).length < sample.length) truncated.push(`Read jobs for ${Object.keys(jobs).length} of ${sample.length} sampled runs before reaching the rate-limit reserve or time limit.`);
  if (incomplete) truncated.push(`${incomplete} sampled ${incomplete === 1 ? "run was" : "runs were"} left out because not all of ${incomplete === 1 ? "its" : "their"} jobs could be read; ${incomplete === 1 ? "it is" : "they are"} estimated like unsampled runs.`);

  // Workflow files at the default branch, to see which fixes are already in place.
  return {
    repository: repo.full_name, private: repo.private, defaultBranch: repo.default_branch, days: Math.max(1, Math.round((now - covered) / day)),
    from: new Date(covered).toISOString(), to: new Date(now).toISOString(), runs: unique, jobs, workflows,
    ...(truncated.length ? { truncated } : {}),
  };
}

type RawRun = {
  id: number; workflow_id: number; name: string | null; path: string; event: string; head_branch: string | null; head_sha: string;
  status: string | null; conclusion: string | null; created_at: string; run_started_at?: string | null; updated_at: string; run_attempt?: number;
  head_repository?: { full_name: string } | null;
};
type RawJob = { name: string; conclusion: string | null; started_at: string | null; completed_at: string | null; labels: string[] };
const toRun = (r: RawRun): ActionsRun => ({
  id: r.id, workflowId: r.workflow_id, name: r.name ?? r.path, path: r.path.replace(/@.*$/, ""), event: r.event, branch: r.head_branch,
  headSha: r.head_sha, status: r.status ?? "unknown", conclusion: r.conclusion, createdAt: r.created_at, startedAt: r.run_started_at ?? null,
  updatedAt: r.updated_at, attempt: r.run_attempt, headRepository: r.head_repository?.full_name ?? null,
});
const toJob = (runId: number, j: RawJob): ActionsJob => ({ runId, name: j.name, conclusion: j.conclusion, startedAt: j.started_at, completedAt: j.completed_at, labels: j.labels ?? [] });

function decodeBase64(value: string) {
  const binary = atob(value.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}
