import { test } from "node:test";
import assert from "node:assert/strict";
import { auditActions, formatCiAudit, jobMinutes, runnerFor, workflowHints, type ActionsHistory, type ActionsJob, type ActionsRun } from "../src/ci-audit";
import { fetchActionsHistory } from "../src/ci-audit-github";

const t0 = Date.parse("2026-11-20T10:00:00Z");
const at = (minutes: number) => new Date(t0 + minutes * 60000).toISOString();
const run = (id: number, o: Partial<ActionsRun> & { start: number; end: number }): ActionsRun => ({
  id, workflowId: 1, name: "CI", path: ".github/workflows/ci.yml", event: "pull_request", branch: "feature", headSha: `sha${id}`,
  status: "completed", conclusion: "success", createdAt: at(o.start), startedAt: at(o.start), updatedAt: at(o.end), ...o,
});
const job = (runId: number, start: number, end: number, labels = ["ubuntu-latest"], conclusion = "success"): ActionsJob => ({ runId, name: "test", conclusion, startedAt: at(start), completedAt: at(end), labels });
const history = (runs: ActionsRun[], jobs: Record<number, ActionsJob[]>, content = "on: pull_request\njobs: {}\n", extra: Partial<ActionsHistory> = {}): ActionsHistory => ({
  repository: "acme/app", private: true, defaultBranch: "main", days: 30, from: at(-30 * 1440), to: at(60), runs, jobs,
  workflows: [{ id: 1, name: "CI", path: ".github/workflows/ci.yml", content }], ...extra,
});

test("job minutes round each job up and skip jobs that did not run", () => {
  assert.equal(jobMinutes(job(1, 0, 0.5)), 1);
  assert.equal(jobMinutes(job(1, 0, 10)), 10);
  assert.equal(jobMinutes({ ...job(1, 0, 10), conclusion: "skipped" }), 0);
  assert.equal(jobMinutes({ ...job(1, 0, 10), startedAt: null }), 0);
  assert.equal(jobMinutes(job(1, 0, 10), t0 + 4 * 60000), 6);
});

test("runner class and larger-runner multiplier come from labels", () => {
  assert.deepEqual(runnerFor(["ubuntu-latest"]), { runner: "linux", multiplier: 1 });
  assert.deepEqual(runnerFor(["macos-15"]), { runner: "macos", multiplier: 1 });
  assert.deepEqual(runnerFor(["windows-2025"]), { runner: "windows", multiplier: 1 });
  assert.deepEqual(runnerFor(["self-hosted", "linux", "x64"]), { runner: "self-hosted", multiplier: 1 });
  assert.deepEqual(runnerFor(["ubuntu-24.04-8-cores"]), { runner: "linux", multiplier: 4 });
});

test("workflow hints find concurrency, cancel-in-progress, path filters and draft guards", () => {
  const plain = workflowHints("on:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n");
  assert.deepEqual(plain, { pullRequest: true, scheduled: false, concurrency: false, cancelsInProgress: false, cancelsConditionally: false, pathFilters: false, draftGuard: false });
  const conditional = workflowHints("concurrency:\n  group: x\n  cancel-in-progress: ${{ github.event_name == 'push' }}\n");
  assert.equal(conditional.cancelsInProgress, false);
  assert.equal(conditional.cancelsConditionally, true);
  const tuned = workflowHints("on:\n  pull_request:\n    paths:\n      - 'src/**'\nconcurrency:\n  group: ci-${{ github.ref }}\n  cancel-in-progress: true\njobs:\n  test:\n    if: github.event.pull_request.draft == false\n");
  assert.equal(tuned.concurrency && tuned.cancelsInProgress && tuned.pathFilters && tuned.draftGuard, true);
  assert.equal(workflowHints("on:\n  schedule:\n    - cron: '0 3 * * *'\n").scheduled, true);
});

test("a run still going when a newer commit's run starts counts its remaining minutes as superseded", () => {
  const runs = [run(1, { start: 0, end: 20 }), run(2, { start: 5, end: 25 }), run(3, { start: 30, end: 40 })];
  const audit = auditActions(history(runs, { 1: [job(1, 0, 20)], 2: [job(2, 5, 25)], 3: [job(3, 30, 40)] }));
  assert.equal(audit.minutes.total, 50);
  assert.equal(audit.minutes.superseded, 15); // run 1 kept going for 15 minutes after run 2 started
  assert.equal(audit.workflows[0].supersededRuns, 1);
  assert.equal(audit.cost.total, 0.3);
  // 30 days observed, so the month equals the window.
  assert.equal(audit.monthly.savingMinutes, 15);
  assert.match(audit.workflows[0].recommendations.join("\n"), /cancel-in-progress: true`: saves about 15 minutes a month/);
  assert.match(audit.workflows[0].recommendations.join("\n"), /draft pull requests/);
});

test("same commit, other branches and other events never supersede each other", () => {
  const runs = [
    run(1, { start: 0, end: 20 }),
    run(2, { start: 5, end: 25, headSha: "sha1" }),
    run(3, { start: 6, end: 25, branch: "other" }),
    run(4, { start: 7, end: 25, event: "push" }),
  ];
  const audit = auditActions(history(runs, Object.fromEntries(runs.map((r) => [r.id, [job(r.id, 0, 5)]]))));
  assert.equal(audit.minutes.superseded, 0);
});

test("workflows that already cancel in progress, and critical ones, do not count toward the saving", () => {
  const runs = [run(1, { start: 0, end: 20 }), run(2, { start: 5, end: 25 })];
  const jobs = { 1: [job(1, 0, 20)], 2: [job(2, 5, 25)] };
  const tuned = auditActions(history(runs, jobs, "on: pull_request\nconcurrency:\n  group: x\n  cancel-in-progress: true\n"));
  assert.equal(tuned.minutes.superseded, 15);
  assert.equal(tuned.monthly.savingMinutes, 0);
  const deploy = auditActions(history(runs.map((r) => ({ ...r, name: "Deploy", path: ".github/workflows/deploy.yml" })), jobs, undefined, { workflows: [{ id: 1, name: "Deploy", path: ".github/workflows/deploy.yml" }] }));
  assert.equal(deploy.monthly.savingMinutes, 0);
  assert.equal(deploy.workflows[0].critical, true);
  assert.match(deploy.workflows[0].recommendations[0], /Critical workflow/);
});

test("cancelled minutes, runner split, prices and the monthly projection", () => {
  const runs = [run(1, { start: 0, end: 10, conclusion: "cancelled" }), run(2, { start: 100, end: 110, branch: "main", event: "push" })];
  const audit = auditActions(history(runs, { 1: [job(1, 0, 10)], 2: [job(2, 100, 110, ["macos-15"])] }, undefined, { days: 15 }));
  assert.equal(audit.minutes.cancelled, 10);
  assert.deepEqual(audit.runners, { linux: 10, macos: 10 });
  assert.equal(audit.cost.total, 0.68);
  assert.equal(audit.monthly.minutes, 40);
  assert.equal(audit.monthly.runs, 4);
});

test("runs without fetched jobs are estimated from their workflow's average and the report says so", () => {
  const runs = [run(1, { start: 0, end: 10 }), run(2, { start: 100, end: 110 }), run(3, { start: 200, end: 210 })];
  const audit = auditActions(history(runs, { 1: [job(1, 0, 10), job(1, 0, 10)] }));
  assert.equal(audit.minutes.total, 60);
  assert.equal(audit.estimated, true);
  assert.equal(audit.sampledRuns, 1);
  assert.match(audit.notes.join("\n"), /fetched for 1 of 3 runs/);
});

test("a scheduled workflow that stopped running is flagged", () => {
  const runs = [run(1, { start: -10 * 1440, end: -10 * 1440 + 5, event: "schedule", branch: "main", name: "Backup", path: ".github/workflows/backup.yml" })];
  const audit = auditActions(history(runs, { 1: [job(1, -10 * 1440, -10 * 1440 + 5)] }, "on:\n  schedule:\n    - cron: '0 3 * * *'\n", { workflows: [{ id: 1, name: "Backup", path: ".github/workflows/backup.yml", content: "on:\n  schedule:\n    - cron: '0 3 * * *'\n" }] }));
  assert.match(audit.workflows[0].recommendations.join("\n"), /last run was 10 days ago/);
});

test("public repositories are labelled free, and the text report covers the totals", () => {
  const audit = auditActions(history([run(1, { start: 0, end: 10 })], { 1: [job(1, 0, 10)] }, undefined, { private: false }));
  assert.match(audit.notes.join("\n"), /Public repository/);
  const text = formatCiAudit(audit);
  assert.match(text, /CI audit: acme\/app \(public\)/);
  assert.match(text, /Billable minutes: 10, estimated \$0\.06/);
  assert.match(text, /- CI \(\.github\/workflows\/ci\.yml\): 1 runs/);
});

test("fetchActionsHistory reads a day at a time, samples jobs, reads workflow files and sends the token", async () => {
  const calls: string[] = [];
  const now = Date.parse("2026-11-27T00:00:00Z");
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer tok");
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "x-ratelimit-remaining": "4000" } });
    const u = new URL(url);
    if (u.pathname === "/repos/acme/app") return json({ private: true, default_branch: "main", full_name: "acme/app" });
    if (u.pathname === "/repos/acme/app/actions/workflows") return json({ workflows: [{ id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" }] });
    if (u.pathname === "/repos/acme/app/actions/runs") {
      const created = u.searchParams.get("created")!;
      if (!created.startsWith("2026-11-26")) return json({ total_count: 0, workflow_runs: [] });
      return json({ total_count: 2, workflow_runs: [1, 2].map((id) => ({ id, workflow_id: 1, name: "CI", path: ".github/workflows/ci.yml", event: "push", head_branch: "main", head_sha: `s${id}`, status: "completed", conclusion: "success", created_at: "2026-11-26T10:00:00Z", run_started_at: "2026-11-26T10:00:00Z", updated_at: "2026-11-26T10:05:00Z" })) });
    }
    if (/\/actions\/runs\/\d+\/jobs$/.test(u.pathname)) return json({ total_count: 1, jobs: [{ name: "t", conclusion: "success", started_at: "2026-11-26T10:00:00Z", completed_at: "2026-11-26T10:05:00Z", labels: ["ubuntu-latest"] }] });
    if (u.pathname === "/repos/acme/app/contents/.github/workflows/ci.yml") return json({ encoding: "base64", content: Buffer.from("on: push\nconcurrency: x\n").toString("base64") });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const result = await fetchActionsHistory({ repository: "acme/app", token: "tok", days: 3, maxJobRuns: 1, fetch: fake, now });
  assert.equal(calls.filter((c) => c.includes("/actions/runs?")).length, 3);
  assert.equal(result.runs.length, 2);
  assert.equal(Object.keys(result.jobs).length, 1);
  assert.equal(result.workflows[0].content, "on: push\nconcurrency: x\n");
  assert.equal(auditActions(result).minutes.total, 10);
});

test("fetchActionsHistory rejects malformed repository names before any request", async () => {
  await assert.rejects(fetchActionsHistory({ repository: "../etc", fetch: (() => { throw new Error("no request"); }) as unknown as typeof fetch }), /owner\/name/);
});

test("an expression-valued cancel-in-progress still counts the saving and asks to check the expression", () => {
  const runs = [run(1, { start: 0, end: 20 }), run(2, { start: 5, end: 25 })];
  const audit = auditActions(history(runs, { 1: [job(1, 0, 20)], 2: [job(2, 5, 25)] }, "on: pull_request\nconcurrency:\n  group: x\n  cancel-in-progress: ${{ github.event_name == 'push' }}\n"));
  assert.equal(audit.monthly.savingMinutes, 15);
  assert.match(audit.workflows[0].recommendations.join("\n"), /set by an expression/);
});

test("pull requests from different forks with the same branch name never supersede each other", () => {
  const runs = [run(1, { start: 0, end: 20, headRepository: "alice/app", branch: "patch-1" }), run(2, { start: 5, end: 25, headRepository: "bob/app", branch: "patch-1" })];
  const audit = auditActions(history(runs, { 1: [job(1, 0, 20)], 2: [job(2, 5, 25)] }));
  assert.equal(audit.minutes.superseded, 0);
});

test("queued runs cost nothing and running ones only their time so far", () => {
  const runs = [run(1, { start: 0, end: 20 }), run(2, { start: 100, end: 100, status: "queued", startedAt: null, branch: "other" }), run(3, { start: 200, end: 204, status: "in_progress", branch: "third" })];
  const audit = auditActions(history(runs, { 1: [job(1, 0, 20)] }));
  assert.equal(audit.minutes.total, 24);
});

test("an observed schedule run makes a workflow critical even when its file was not read", () => {
  const runs = [run(1, { start: 0, end: 20, event: "schedule", branch: "main", name: "Nightly", path: ".github/workflows/nightly.yml" }), run(2, { start: 5, end: 25, event: "schedule", branch: "main", name: "Nightly", path: ".github/workflows/nightly.yml" })];
  const audit = auditActions(history(runs, { 1: [job(1, 0, 20)], 2: [job(2, 5, 25)] }, undefined, { workflows: [{ id: 1, name: "Nightly", path: ".github/workflows/nightly.yml" }] }));
  assert.equal(audit.workflows[0].critical, true);
  assert.equal(audit.monthly.savingMinutes, 0);
  assert.doesNotMatch(audit.workflows[0].recommendations.join("\n"), /cancel-in-progress: true/);
});

test("an active scheduled workflow with no runs in the window is reported as stopped", () => {
  const audit = auditActions(history([], {}, undefined, { workflows: [{ id: 9, name: "Backup", path: ".github/workflows/backup.yml", state: "active", content: "on:\n  schedule:\n    - cron: '0 3 * * *'\n" }] }));
  assert.equal(audit.workflows.length, 1);
  assert.equal(audit.workflows[0].runs, 0);
  assert.match(audit.workflows[0].recommendations.join("\n"), /did not run in the last 30 days/);
});

test("fetchActionsHistory keeps the reserve with requests in flight, reads every workflow page, and reports only complete days", async () => {
  const now = Date.parse("2026-11-27T00:00:00Z");
  let remaining = 108, listed = 0;
  const fake = (async (url: string) => {
    const u = new URL(url), json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "x-ratelimit-remaining": String(--remaining) } });
    if (u.pathname === "/repos/acme/app") return json({ private: false, default_branch: "main", full_name: "acme/app" });
    if (u.pathname === "/repos/acme/app/actions/workflows") {
      const page = Number(u.searchParams.get("page"));
      return json({ total_count: 101, workflows: page === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: `W${i}`, path: `.github/workflows/w${i}.yml`, state: "disabled_manually" })) : [{ id: 101, name: "Backup", path: ".github/workflows/backup.yml", state: "active" }] });
    }
    if (u.pathname === "/repos/acme/app/actions/runs") { listed++; return json({ total_count: 0, workflow_runs: [] }); }
    if (u.pathname.endsWith("/backup.yml")) return json({ encoding: "base64", content: Buffer.from("on:\n  schedule:\n    - cron: '0 3 * * *'\n").toString("base64") });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const result = await fetchActionsHistory({ repository: "acme/app", token: "t", days: 30, fetch: fake, now, reserve: 100 });
  assert.equal(result.workflows.length, 101);
  assert.ok(result.workflows.find((w) => w.id === 101)?.content, "the active workflow on page two was read");
  assert.ok(listed < 30, "listing stopped at the reserve");
  assert.equal(result.days, listed);
  assert.match(result.truncated?.join("\n") ?? "", /Stopped listing runs before/);
});

test("fetchActionsHistory leaves out a run whose job pages were cut short", async () => {
  const now = Date.parse("2026-11-27T00:00:00Z");
  let remaining = 1000;
  const fake = (async (url: string) => {
    const u = new URL(url), json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "x-ratelimit-remaining": String(remaining) } });
    if (u.pathname === "/repos/acme/app") return json({ private: true, default_branch: "main", full_name: "acme/app" });
    if (u.pathname === "/repos/acme/app/actions/workflows") return json({ total_count: 0, workflows: [] });
    if (u.pathname === "/repos/acme/app/actions/runs") {
      const day = u.searchParams.get("created")?.slice(0, 10);
      return json({ total_count: day === "2026-11-26" ? 1 : 0, workflow_runs: day === "2026-11-26" ? [{ id: 7, workflow_id: 1, name: "CI", path: ".github/workflows/ci.yml", event: "push", head_branch: "main", head_sha: "a", status: "completed", conclusion: "success", created_at: "2026-11-26T10:00:00Z", run_started_at: "2026-11-26T10:00:00Z", updated_at: "2026-11-26T10:30:00Z" }] : [] });
    }
    if (u.pathname === "/repos/acme/app/actions/runs/7/jobs") {
      remaining = 100; // the reserve is reached after the first page
      return json({ total_count: 150, jobs: Array.from({ length: 100 }, (_, i) => ({ name: `j${i}`, conclusion: "success", started_at: "2026-11-26T10:00:00Z", completed_at: "2026-11-26T10:01:00Z", labels: ["ubuntu-latest"] })) });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const result = await fetchActionsHistory({ repository: "acme/app", token: "t", days: 3, fetch: fake, now, reserve: 100 });
  assert.equal(result.runs.length, 1);
  assert.equal(result.jobs[7], undefined);
  assert.match(result.truncated?.join("\n") ?? "", /left out because not all of its jobs could be read/);
});

test("an audit cut short carries its truncation notes separately", () => {
  const audit = auditActions(history([run(1, { start: 0, end: 10 })], { 1: [job(1, 0, 10)] }, undefined, { truncated: ["Stopped listing runs before 2026-11-20 at the time limit."] }));
  assert.deepEqual(audit.truncated, ["Stopped listing runs before 2026-11-20 at the time limit."]);
  assert.ok(audit.notes.includes(audit.truncated![0]));
});
