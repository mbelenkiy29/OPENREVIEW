import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend } from "../../src/server";
import type { CiAudit } from "../../src/ci-audit";
import { requestCiAudit, saveCiSpendGuard } from "./actions";

// Organization Settings → CI Cost (CI_COST_ENABLED): the latest 30-day CI audit of each GitHub App repository.
const usd = (n: number) => `$${n.toFixed(2)}`;
const share = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "0%");
const parse = (report?: string) => { try { return report ? JSON.parse(report) as CiAudit : null; } catch { return null; } };

export async function CiCostPanel({ token, organizationId, admin }: { token: string; organizationId: Id<"organizations">; admin: boolean }) {
  const rows = await backend().query(api.ciAudits.list, { token, organizationId });
  if (!rows.length) return <section className="empty-state"><strong>No GitHub repositories yet</strong><p>CI audits read GitHub Actions history for repositories connected through the GitHub App.</p></section>;
  return <section aria-labelledby="ci-heading">
    <div className="section-heading"><h2 id="ci-heading">GitHub Actions, last 30 days</h2></div>
    <p className="muted">Read-only: OpenReview reads Actions runs, jobs and workflow files and changes nothing. The GitHub App needs the optional <strong>Actions: Read</strong> permission. Costs are estimates at list price per runner minute.</p>
    <ul className="ci-cost-list">{rows.map((row) => {
      const report = row.latest?.status === "done" ? parse(row.latest.report) : null;
      return <li key={row.repositoryId} className="setting-row stack">
        <div>
          <strong>{row.fullName}</strong>
          {!row.latest && <p className="muted">Not audited yet.</p>}
          {row.latest && ["queued", "running"].includes(row.latest.status) && <p role="status">Audit running. Refresh in a minute.</p>}
          {row.latest?.status === "failed" && <p className="error">Last audit failed: {row.latest.error ?? "unknown error"}</p>}
          {report && row.latest && <>
            <p>{report.runs} runs, {report.minutes.total} billable minutes, about {usd(report.monthly.cost)} a month. <strong>{share(report.minutes.wasted, report.minutes.total)}</strong> of the minutes were cancelled or superseded.
              {report.monthly.savingMinutes > 0 ? ` Cancelling superseded runs would save about ${report.monthly.savingMinutes} minutes (${usd(report.monthly.savingCost)}) a month.` : ""}</p>
            <details><summary>Workflows and fixes</summary>
              <ul>{report.workflows.map((w) => <li key={w.workflowId}><strong>{w.name}</strong> ({w.path}): {w.runs} runs, {w.minutes} min, {usd(w.cost)}; cancelled {w.cancelledMinutes} min, superseded {w.supersededMinutes} min
                {w.recommendations.length > 0 && <ul>{w.recommendations.map((r) => <li key={r}>{r}</li>)}</ul>}</li>)}</ul>
              {report.notes.length > 0 && <ul className="muted">{report.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
            </details>
            <p className="muted">Audited {new Date(row.latest.updatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC.</p>
          </>}
        </div>
        {admin && <form action={requestCiAudit}><input type="hidden" name="repositoryId" value={row.repositoryId} /><button className="button small" type="submit">{row.latest ? "Run again" : "Run audit"}</button></form>}
      </li>;
    })}</ul>
  </section>;
}

// Spend guard v1: a monthly budget, the workflows that must keep running, and where alerts go.
export async function SpendGuardPanel({ token, organizationId }: { token: string; organizationId: Id<"organizations"> }) {
  const { guard, channels, workflows } = await backend().query(api.ciSpendGuards.guard, { token, organizationId });
  const critical = new Set((guard?.critical ?? []).map((c) => `${c.repositoryId}|${c.path}`));
  const check = guard?.lastCheck;
  return <section aria-labelledby="guard-heading">
    <div className="section-heading"><h2 id="guard-heading">Spend guard</h2></div>
    <p className="muted">Once a day OpenReview estimates this month&apos;s GitHub Actions spend, emails admins with a verified address (and posts to the Slack channel you pick) at 50%, 80% and 100% of the budget, and warns when a critical workflow stops running or fails. It cannot keep GitHub running jobs past a spending limit you set on GitHub.</p>
    {check && <p>Last check {new Date(check.at).toISOString().slice(0, 16).replace("T", " ")} UTC: about <strong>{usd(check.total)}</strong> in {check.period}{guard?.monthlyBudget ? ` of ${usd(guard.monthlyBudget)}` : ""}.
      {check.problems.length > 0 && <> {check.problems.map((p) => `${p.repository} ${p.name} ${p.problem}`).join("; ")}.</>}
      {check.repositories.some((r) => r.error) && <> Not read: {check.repositories.filter((r) => r.error).map((r) => `${r.fullName} (${r.error})`).join("; ")}.</>}</p>}
    <form action={saveCiSpendGuard} className="stack">
      <input type="hidden" name="organizationId" value={organizationId} />
      <label>Monthly budget (USD)<input type="number" name="monthlyBudget" min="1" max="1000000" step="1" defaultValue={guard?.monthlyBudget ?? ""} placeholder="No budget" /></label>
      <label className="checkbox"><input type="checkbox" name="dailySummary" defaultChecked={guard?.dailySummary ?? false} /> Send a daily spend summary</label>
      <label>Slack channel<select name="channelId" defaultValue={guard?.channelId ?? ""}><option value="">Email only</option>{channels.map((c) => <option key={c._id} value={c._id}>{c.channelId}</option>)}</select></label>
      <fieldset><legend>Critical workflows</legend>
        {workflows.length === 0 ? <p className="muted">Run an audit first to choose from each repository&apos;s workflows.</p>
          : workflows.map((w) => <label key={`${w.repositoryId}|${w.path}`} className="checkbox"><input type="checkbox" name="critical" value={`${w.repositoryId}|${w.path}`} defaultChecked={critical.has(`${w.repositoryId}|${w.path}`)} /> {w.fullName}: {w.name} <span className="muted">({w.path})</span></label>)}
      </fieldset>
      <button className="button primary" type="submit">Save spend guard</button>
    </form>
  </section>;
}
