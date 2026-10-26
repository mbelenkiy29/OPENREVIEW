import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { api } from "../../../../convex/_generated/api";
import { backend } from "../../../../src/server";
import { usdText } from "../../../../src/billing";
import { planCatalog, type Plan } from "../../../../src/plans";
import { ChartCard } from "../../analytics-chart";
import { ScrollTable } from "../../scroll-table";
import { viewer } from "../../load";

export const metadata = { title: "Operator" };

const when = (at: number | null) => at === null ? "–" : new Date(at).toISOString().slice(0, 16).replace("T", " ");
const dollars = (n: number) => `$${n.toFixed(2)}`;
const counted = (n: number, capped: boolean) => capped ? `${n}+` : String(n);
const Tiles = ({ label, items }: { label: string; items: [string, ReactNode][] }) => <div className="metrics usage-tiles" role="group" aria-label={label}>{items.map(([name, value]) => <div key={name}><span>{name}</span><strong>{value}</strong></div>)}</div>;
const Heading = ({ id, title, children }: { id: string; title: string; children?: ReactNode }) => <div className="section-heading"><div><h2 id={id}>{title}</h2>{children && <p>{children}</p>}</div></div>;

// Operator analytics across every workspace: metadata and counts only (convex/operator.ts). Anyone who is not an
// operator gets a 404; the backend checks OPERATOR_GITHUB_IDS again and records each visit.
export default async function OperatorPage() {
  const user = await viewer();
  if (!user.operator) notFound();
  const r = await backend().action(api.operator.overview, { token: user.token });
  const plan = (w: (typeof r.workspaces)[number]) => !r.billing ? "Billing off" : w.exempt ? "Operator" : w.choosingPlan ? "Choosing a plan" : planCatalog[w.plan as Plan].name;
  const series = (key: "spend" | "calls") => r.series.map((label, i) => ({ label, values: r.chart[key][i] }));
  return <>
    <span className="page-top" aria-hidden="true" />
    <main className="content page">
      <header className="page-header"><div><h1>Operator</h1><p>Every workspace on this deployment: metadata and counts, never code, review text or chat.</p></div></header>
      <Tiles label="Totals" items={[
        ["Users", counted(r.totals.users, r.capped.users)],
        ["Workspaces", counted(r.totals.workspaces, r.capped.workspaces)],
        ["Model spend, 30 days", dollars(r.totals.spend)],
        ["Inference budget", r.budget ? `${usdText(r.budget.usedMicros)} of ${usdText(r.budget.limitMicros)}` : "Not set"],
      ]} />
      <Tiles label="This month" items={[
        ["Reviews this month", r.totals.reviews],
        ["Blocked this month", r.totals.blocked],
        ["Agent fixes this month", r.totals.fixes],
        ["Free · Starter · Pro", `${r.totals.plans.free} · ${r.totals.plans.starter} · ${r.totals.plans.pro}`],
      ]} />
      <ChartCard wide icon="chartBar" title="Model usage, last 30 days" labels={r.days} info="Estimated model cost per UTC day, for the three workspaces that spent most and everyone else."
        views={[{ label: "Spend", kind: "bar", unit: "$", yTitle: "USD", series: series("spend") }, { label: "Model calls", kind: "bar", yTitle: "Calls", series: series("calls") }]} />
      {r.capped.usage && <p className="muted table-note">More than 10,000 model calls in 30 days: spend counts the newest 10,000.</p>}

      <Heading id="operator-workspaces" title="Workspaces">Counters are this month&apos;s (UTC). Last activity is the latest model call: a review, chat, fix or indexing.</Heading>
      <ScrollTable label="Workspaces table" className="table-box">
        <table aria-labelledby="operator-workspaces">
          <thead><tr><th>Workspace</th><th>Plan</th><th>Seats</th><th>Spend, 30 days</th><th>Billed usage</th><th>Reviews</th><th>Blocked</th><th>Fixes</th><th>Last activity (UTC)</th><th>Created (UTC)</th></tr></thead>
          <tbody>
            {r.workspaces.map((w) => <tr key={w.id}>
              <td>{w.name}</td>
              <td>{plan(w)}{w.status && w.status !== "active" && <> <span className="badge">{w.status.replaceAll("_", " ")}</span></>}</td>
              <td>{w.seats}{w.billedSeats !== null && w.billedSeats !== w.seats && ` (${w.billedSeats} billed)`}</td>
              <td>{dollars(w.spend)}</td>
              <td>{w.exempt ? "Unlimited" : w.limitMicros === null ? "–" : `${usdText(w.usedMicros)} of ${usdText(w.limitMicros)}`}</td>
              <td>{w.reviews}</td><td>{w.blocked}</td><td>{w.fixes}</td>
              <td>{when(w.lastActivity)}</td><td>{when(w.createdAt)}</td>
            </tr>)}
            {!r.workspaces.length && <tr><td colSpan={10} className="table-empty">No workspaces yet</td></tr>}
          </tbody>
        </table>
      </ScrollTable>

      <Heading id="operator-users" title="Users">{r.capped.users ? "The newest 500 accounts." : undefined}</Heading>
      <ScrollTable label="Users table" className="table-box">
        <table aria-labelledby="operator-users">
          <thead><tr><th>User</th><th>Sign-in</th><th>Workspaces</th><th>Joined (UTC)</th><th>Last sign-in (UTC)</th></tr></thead>
          <tbody>
            {r.users.map((u) => <tr key={u.id}>
              <td>{u.login}{u.operator && <> <span className="badge">operator</span></>}</td>
              <td>{u.providers.join(", ") || "–"}</td>
              <td>{u.workspaces}{u.owned > 0 && ` (owns ${u.owned})`}</td>
              <td>{when(u.createdAt)}</td><td>{when(u.lastSignIn)}</td>
            </tr>)}
            {!r.users.length && <tr><td colSpan={5} className="table-empty">No users yet</td></tr>}
          </tbody>
        </table>
      </ScrollTable>

      <Heading id="operator-activity" title="Recent activity">Sign-ins, reviews, agent fixes and plan changes, newest first.</Heading>
      <ScrollTable label="Recent activity table" className="table-box">
        <table aria-labelledby="operator-activity">
          <thead><tr><th>When (UTC)</th><th>Activity</th><th>User</th><th>Workspace</th></tr></thead>
          <tbody>
            {r.activity.map((e, i) => <tr key={i}><td>{when(e.at)}</td><td>{e.label}</td><td>{e.user ?? "–"}</td><td>{e.workspace ?? "–"}</td></tr>)}
            {!r.activity.length && <tr><td colSpan={4} className="table-empty">No activity yet</td></tr>}
          </tbody>
        </table>
      </ScrollTable>

      <Heading id="operator-access" title="Operator access">Every visit to this page is recorded.</Heading>
      <ScrollTable label="Operator access table" className="table-box">
        <table aria-labelledby="operator-access">
          <thead><tr><th>When (UTC)</th><th>Operator</th><th>Action</th></tr></thead>
          <tbody>{r.access.map((e) => <tr key={e.id}><td>{when(e.at)}</td><td>{e.user ?? "–"}</td><td>{e.action}</td></tr>)}</tbody>
        </table>
      </ScrollTable>
    </main>
  </>;
}
