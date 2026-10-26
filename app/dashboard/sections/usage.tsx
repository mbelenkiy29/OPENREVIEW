import { repositoryDisplay } from "../../../src/provider-display";
import { ScrollTable } from "../scroll-table";
import type { DashboardContext } from "../load";

const usd = (n: number) => `$${n.toFixed(4)}`;
// Billing & Usage → Usage: Greptile's stat summary card over a usage table, from the most recent 1,000 usage events.
export function UsageSection({ ctx }: { ctx: DashboardContext }) {
  const { data } = ctx, cost = (events: typeof data.usage) => events.reduce((sum, e) => sum + e.estimatedCost, 0);
  const completed = data.reviews.filter((r) => r.status === "completed"), ids = new Set(completed.map((r) => r._id)), timed = completed.filter((r) => r.finishedAt);
  const tiles: [string, string][] = [
    ["Workspace cost", usd(cost(data.usage))],
    ["Indexing embeddings", usd(cost(data.usage.filter((e) => e.kind === "embedding")))],
    ["Average completed review", ids.size ? usd(cost(data.usage.filter((e) => e.reviewId && ids.has(e.reviewId))) / ids.size) : usd(0)],
    ["Duration", timed.length ? `${Math.round(timed.reduce((sum, r) => sum + (r.finishedAt! - r.createdAt), 0) / timed.length / 1000)} seconds` : "Awaiting reviews"],
  ];
  return <>
    <div className="section-heading"><div><h2 id="usage-heading">Usage</h2><p>Most recent 1,000 usage events.</p></div></div>
    <div className="metrics usage-tiles" role="group" aria-labelledby="usage-heading">{tiles.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    <ScrollTable label="Repository usage table" className="table-box">
      <table>
        <thead><tr><th>Repository</th><th>Model calls</th><th>Input tokens</th><th>Output tokens</th><th>Estimated cost</th></tr></thead>
        <tbody>
          {data.repositories.map((r) => {
            const usage = data.usage.filter((u) => u.repositoryId === r._id);
            return <tr key={r._id}><td>{repositoryDisplay(r)}</td><td>{usage.length}</td><td>{usage.reduce((s, u) => s + u.inputTokens, 0).toLocaleString()}</td><td>{usage.reduce((s, u) => s + u.outputTokens, 0).toLocaleString()}</td><td>{usd(cost(usage))}</td></tr>;
          })}
          {!data.repositories.length && <tr><td colSpan={5} className="table-empty">No recent usage available</td></tr>}
        </tbody>
      </table>
    </ScrollTable>
    <p className="muted table-note">Estimated costs use your configured input and output token prices. A zero cost means pricing has not been configured or the call was cached.</p>
  </>;
}
