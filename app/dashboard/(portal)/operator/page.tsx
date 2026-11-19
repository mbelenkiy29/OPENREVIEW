import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { backend } from "../../../../src/server";
import { contractPreview, usdText } from "../../../../src/billing";
import { createEnterpriseContract } from "../../actions";
import { planCatalog, type Plan } from "../../../../src/plans";
import { ChartCard } from "../../analytics-chart";
import { ScrollTable } from "../../scroll-table";
import { viewer } from "../../load";

export const metadata = { title: "Operator" };

const when = (at: number | null) => at === null ? "–" : new Date(at).toISOString().slice(0, 16).replace("T", " ");
const dollars = (n: number) => `$${n.toFixed(2)}`;
const counted = (n: number, capped: boolean) => capped ? `${n}+` : String(n);
const Tiles = ({ label, items }: { label: string; items: [string, ReactNode][] }) => <div className="metrics usage-tiles" role="group" aria-label={label}>{items.map(([name, value]) => <div key={name}><span>{name}</span><strong>{value}</strong></div>)}</div>;
const funnelLabels: Record<string, string> = { signup_verified: "Sign-ups", first_repository_connected: "Repository connected", first_review_completed: "First review", checkout_started: "Checkout started", subscribed: "Card added (subscribed)", first_paid: "First payment", upgrade_requested: "Member asked to upgrade" };
const featureLabels: Record<string, string> = { "review.deep": "deep reviews", "review.reproTests": "reproduction tests", "fix.pullRequests": "fix pull requests", "context.requirements": "linked requirements" };
const Heading = ({ id, title, children }: { id: string; title: string; children?: ReactNode }) => <div className="section-heading"><div><h2 id={id}>{title}</h2>{children && <p>{children}</p>}</div></div>;

// Operator analytics across every workspace: metadata and counts only (convex/operator.ts). Anyone who is not an
// operator gets a 404; the backend checks OPERATOR_GITHUB_IDS again and records each visit.
export default async function OperatorPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await viewer(), q = await searchParams;
  if (!user.operator) notFound();
  const r = await backend().action(api.operator.overview, { token: user.token });
  const plan = (w: (typeof r.workspaces)[number]) => !r.billing ? "Billing off" : w.exempt ? "Operator" : w.choosingPlan ? "Choosing a plan" : planCatalog[w.plan as Plan].name;
  // Enterprise contract form: the entered terms come back in the URL after Preview or a refused Create.
  const d = r.contractDefaults, nextMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toISOString().slice(0, 7);
  const f = { organizationId: q.organizationId ?? "", mode: q.mode === "ownKey" ? "ownKey" as const : "managed" as const, start: q.start ?? nextMonth, committed: q.committed ?? String(d.minContributors), price: q.price ?? "", included: q.included ?? String(d.includedUsageUsd), multiplier: q.multiplier ?? "1.15", usagePriceId: q.usagePriceId ?? "", netDays: q.netDays ?? String(d.netDays), graceDays: q.graceDays ?? String(d.graceDays), nonBillable: q.nonBillable ?? "", notes: q.notes ?? "" };
  const committed = Number(f.committed), priceCents = Math.round(Number(f.price) * 100), included = Number(f.included);
  const preview = q.preview && committed > 0 && priceCents > 0 && included >= 0 ? contractPreview({ mode: f.mode, committedContributors: committed, contributorPriceCents: priceCents, includedUsagePerContributorUsd: included }) : null;
  // The chosen workspace's current subscription and its billable contributors, so the commitment is set from data, not seats.
  const history = q.preview && q.organizationId ? await backend().action(api.enterpriseJobs.contributorHistory, { token: user.token, organizationId: q.organizationId as Id<"organizations"> }).catch(() => null) : null;
  const contracts = r.workspaces.filter((w) => w.contract), month = (at: number) => new Date(at).toISOString().slice(0, 7);
  const series = (key: "spend" | "calls") => r.series.map((label, i) => ({ label, values: r.chart[key][i] }));
  return <>
    <span className="page-top" aria-hidden="true" />
    <main id="main" className="content page">
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
        ["Free · Starter · Pro · Enterprise", `${r.totals.plans.free} · ${r.totals.plans.starter} · ${r.totals.plans.pro} · ${r.totals.plans.enterprise}`],
      ]} />
      <ChartCard wide icon="chartBar" title="Model usage, last 30 days" labels={r.days} info="Estimated model cost per UTC day, for the three workspaces that spent most and everyone else."
        views={[{ label: "Spend", kind: "bar", unit: "$", yTitle: "USD", series: series("spend") }, { label: "Model calls", kind: "bar", yTitle: "Calls", series: series("calls") }]} />
      {r.capped.usage && <p className="muted table-note">More than 10,000 model calls in 30 days: spend counts the newest 10,000.</p>}

      <Heading id="operator-funnel" title="Conversion, last 30 days">Each step counts a user or workspace once. &ldquo;Card added&rdquo; includes trials; &ldquo;First payment&rdquo; is the first invoice with money in it. Wanted features are times something asked for a feature the plan lacks, once per workspace.</Heading>
      <ScrollTable label="Conversion table" className="table-box">
        <table aria-labelledby="operator-funnel">
          <thead><tr><th>Step</th><th>Count</th></tr></thead>
          <tbody>
            {r.funnel.steps.map((s) => <tr key={s.name}><td>{funnelLabels[s.name]}</td><td>{s.count}</td></tr>)}
            {r.funnel.wanted.map((w) => <tr key={w.feature}><td>Wanted: {featureLabels[w.feature] ?? w.feature}</td><td>{w.count}</td></tr>)}
          </tbody>
        </table>
      </ScrollTable>

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

      {r.billing && <>
        <Heading id="operator-contracts" title="Enterprise contracts">Billed per active contributor: authors of pull requests reviewed in a month. Creating a contract makes its Stripe prices and a one-year invoiced subscription; the workspace moves to Enterprise when Stripe confirms it. For a workspace with a contract in force, the form creates its renewal, which starts the day the term ends.</Heading>
        {q.contract === "created" && <p className="notice-banner" role="status">Contract created. The workspace moves to Enterprise on the contract&apos;s first day.</p>}
        {q.contractError && <p className="error" role="alert">{q.contractError}</p>}
        <ScrollTable label="Enterprise contracts table" className="table-box">
          <table aria-labelledby="operator-contracts">
            <thead><tr><th>Workspace</th><th>Mode</th><th>Committed</th><th>Active this month</th><th>Per contributor</th><th>Term (UTC)</th><th>Stripe</th></tr></thead>
            <tbody>
              {contracts.map((w) => <tr key={w.id}>
                <td>{w.name}</td><td>{w.contract!.mode === "ownKey" ? "Own key" : "Managed"}</td><td>{w.contract!.committed}</td><td>{w.contributors}</td>
                <td>{dollars(w.contract!.priceCents / 100)} / month</td><td>{month(w.contract!.startsAt)} to {month(w.contract!.endsAt)}</td>
                <td>{w.contract!.inStripe ? w.plan === "enterprise" ? "Active" : "Scheduled" : <span className="badge">draft</span>}</td>
              </tr>)}
              {!contracts.length && <tr><td colSpan={7} className="table-empty">No contracts yet</td></tr>}
            </tbody>
          </table>
        </ScrollTable>
        {preview && <p className="notice-banner" role="status">First invoice: <strong>{dollars(preview.firstInvoiceCents / 100)}</strong> before tax ({committed} contributors × {dollars(priceCents / 100)} × 12 months), due {f.netDays} days after it is sent. Each month after: {dollars(preview.perExtraContributorCents / 100)} for every active contributor above {committed}{f.mode === "managed" ? <>, and model usage past {dollars(preview.includedUsageUsd)} a month at cost × {f.multiplier}</> : <>; model usage runs on the customer&apos;s own key and is not billed</>}. Nothing has been created.</p>}
        {history && <p className="muted table-note">{history.plan ? `Now on ${planCatalog[history.plan as Plan]?.name ?? history.plan} with ${history.seats} billed ${history.plan === "enterprise" ? "contributors" : "seats"}. ` : "No subscription now. "}Billable contributors: {history.months.map((m) => `${m.period}: ${m.contributors}`).join(", ")}.{history.plan && history.plan !== "enterprise" && " Creating the contract ends that subscription when the contract starts."}</p>}
        <form action={createEnterpriseContract} className="form-grid">
          <label>Workspace<select name="organizationId" required defaultValue={f.organizationId}><option value="">Choose a workspace</option>{r.workspaces.filter((w) => !w.exempt).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
          <label>Mode<select name="mode" defaultValue={f.mode}><option value="managed">Managed (our model, metered)</option><option value="ownKey">Own key (nothing metered)</option></select></label>
          <label>Start month (UTC)<input name="start" type="month" required defaultValue={f.start} /></label>
          <label>Committed contributors<input name="committed" type="number" required min={d.minContributors} step={1} defaultValue={f.committed} /></label>
          <label>Price per contributor per month (USD)<input name="price" type="number" required min={0.01} step={0.01} defaultValue={f.price} /></label>
          <label>Included usage per contributor (USD)<input name="included" type="number" required min={0} step={0.01} defaultValue={f.included} /></label>
          <label>Overage multiplier<input name="multiplier" type="number" required min={1} max={5} step={0.01} defaultValue={f.multiplier} /></label>
          <label>Custom overage price (optional)<input name="usagePriceId" placeholder="price_… (blank uses the shared one)" defaultValue={f.usagePriceId} /></label>
          <label>Net days<input name="netDays" type="number" required min={0} max={365} step={1} defaultValue={f.netDays} /></label>
          <label>Grace days after due<input name="graceDays" type="number" required min={0} max={365} step={1} defaultValue={f.graceDays} /></label>
          <label className="wide">Non-billable authors (logins, separated by commas or spaces)<input name="nonBillable" defaultValue={f.nonBillable} /></label>
          <label className="wide">Notes<textarea name="notes" rows={2} maxLength={2000} defaultValue={f.notes} /></label>
          <div className="wide setting-actions"><button name="intent" value="preview">Preview</button><button name="intent" value="create" className="primary">Create contract</button></div>
        </form>
      </>}

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
