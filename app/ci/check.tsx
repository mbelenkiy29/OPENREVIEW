"use client";
import { useState, type FormEvent } from "react";
import type { CiAudit } from "../../src/ci-audit";

// The /ci page's repository check: sends one public repository to /api/ci/audit and shows the result.
const usd = (n: number) => `$${n.toFixed(2)}`;
const share = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "0%");

export function CiCheck({ enabled }: { enabled: boolean }) {
  const [repo, setRepo] = useState("");
  const [state, setState] = useState<{ status: "idle" | "loading" } | { status: "error"; message: string } | { status: "done"; audit: CiAudit }>({ status: "idle" });

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = repo.trim();
    if (!value) return;
    setState({ status: "loading" });
    try {
      const response = await fetch(`/api/ci/audit?repo=${encodeURIComponent(value.toLowerCase())}`);
      const body = await response.json().catch(() => ({}));
      setState(response.ok ? { status: "done", audit: body as CiAudit } : { status: "error", message: (body as { error?: string }).error ?? "The check could not finish." });
    } catch {
      setState({ status: "error", message: "The check could not reach the server. Try again." });
    }
  }

  if (!enabled) return <p className="ci-check-off">The live check is not switched on for this site yet. You can run the same audit yourself with <code>pnpm ci:audit owner/repo</code>.</p>;
  return <div className="ci-check">
    <form onSubmit={submit} className="ci-check-form">
      <label htmlFor="ci-repo">Public GitHub repository</label>
      <div className="ci-check-row">
        <input id="ci-repo" name="repo" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name or https://github.com/owner/name" autoComplete="off" spellCheck={false} required maxLength={200} />
        <button className="button primary" type="submit" disabled={state.status === "loading"}>{state.status === "loading" ? "Checking…" : "Check CI waste"}</button>
      </div>
      <p className="ci-check-hint">Reads the last 30 days of GitHub Actions runs. Nothing is written to the repository. A busy repository can take up to a minute.</p>
    </form>
    <div aria-live="polite">
      {state.status === "error" && <p className="ci-check-error" role="alert">{state.message}</p>}
      {state.status === "done" && <CiResult audit={state.audit} />}
    </div>
  </div>;
}

function CiResult({ audit: a }: { audit: CiAudit }) {
  return <div className="ci-result">
    <h3>{a.repository}: {share(a.minutes.wasted, a.minutes.total)} of its CI minutes bought nothing</h3>
    <div className="metrics">
      <div><span>Runs, last {a.days} days</span><strong>{a.runs}</strong></div>
      <div><span>Billable minutes</span><strong>{a.minutes.total}</strong></div>
      <div><span>Cancelled or superseded</span><strong>{a.minutes.wasted} min</strong></div>
      <div><span>A month at list price</span><strong>{usd(a.monthly.cost)}</strong></div>
    </div>
    <p>{a.monthly.savingMinutes > 0
      ? `Cancelling superseded runs would save about ${a.monthly.savingMinutes} minutes (${usd(a.monthly.savingCost)}) a month.`
      : "Superseded runs are already cancelled, or there were none to cancel."}</p>
    <ul className="ci-workflows">
      {a.workflows.slice(0, 6).map((w) => <li key={w.workflowId}>
        <strong>{w.name}</strong> <span className="muted">{w.path}</span>
        <div>{w.runs} runs, {w.minutes} min, {usd(w.cost)}; cancelled {w.cancelledMinutes} min, superseded {w.supersededMinutes} min</div>
        {w.recommendations.length > 0 && <ul>{w.recommendations.map((r) => <li key={r}>{r}</li>)}</ul>}
      </li>)}
    </ul>
    {a.notes.length > 0 && <ul className="ci-notes">{a.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
  </div>;
}
