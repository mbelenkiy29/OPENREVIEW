import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend } from "../../src/server";
import type { CiAudit } from "../../src/ci-audit";
import { requestCiAudit } from "./actions";

// Organization Settings → CI Cost (CI_COST_ENABLED): the latest CI audit (up to 30 days) of each GitHub App repository.
const usd = (n: number) => `$${n.toFixed(2)}`;
const share = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "0%");
const parse = (report?: string) => { try { return report ? JSON.parse(report) as CiAudit : null; } catch { return null; } };

export async function CiCostPanel({ token, organizationId, admin }: { token: string; organizationId: Id<"organizations">; admin: boolean }) {
  const rows = await backend().query(api.ciAudits.list, { token, organizationId });
  if (!rows.length) return <section className="empty-state"><strong>No GitHub repositories yet</strong><p>CI audits read GitHub Actions history for repositories connected through the GitHub App.</p></section>;
  return <section aria-labelledby="ci-heading">
    <div className="section-heading"><h2 id="ci-heading">GitHub Actions cost</h2></div>
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
            <p className="muted">Covers {report.from.slice(0, 10)} to {report.to.slice(0, 10)} ({report.days} {report.days === 1 ? "day" : "days"}).</p>
            {report.truncated && report.truncated.length > 0 && <ul className="error">{report.truncated.map((t) => <li key={t}>{t}</li>)}</ul>}
            <p>{report.runs} runs, {report.minutes.total} billable minutes, about {usd(report.monthly.cost)} a month. <strong>{share(report.minutes.wasted, report.minutes.total)}</strong> of the minutes were cancelled or superseded.
              {report.monthly.savingMinutes > 0 ? ` Cancelling superseded runs would save about ${report.monthly.savingMinutes} minutes (${usd(report.monthly.savingCost)}) a month.` : ""}</p>
            <details><summary>Workflows and fixes</summary>
              <ul>{report.workflows.map((w) => <li key={w.workflowId}><strong>{w.name}</strong> ({w.path}): {w.runs} runs, {w.minutes} min, {usd(w.cost)}; cancelled {w.cancelledMinutes} min, superseded {w.supersededMinutes} min
                {w.recommendations.length > 0 && <ul>{w.recommendations.map((r) => <li key={r}>{r}</li>)}</ul>}</li>)}</ul>
              {report.notes.filter((n) => !report.truncated?.includes(n)).length > 0 && <ul className="muted">{report.notes.filter((n) => !report.truncated?.includes(n)).map((n) => <li key={n}>{n}</li>)}</ul>}
            </details>
            <p className="muted">Audited {new Date(row.latest.updatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC.</p>
          </>}
        </div>
        {admin && <form action={requestCiAudit}><input type="hidden" name="repositoryId" value={row.repositoryId} /><button className="button small" type="submit">{row.latest ? "Run again" : "Run audit"}</button></form>}
      </li>;
    })}</ul>
  </section>;
}
