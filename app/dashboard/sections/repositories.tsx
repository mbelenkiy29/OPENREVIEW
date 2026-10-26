import { providerDisplay } from "../../../src/provider-display";
import Link from "next/link";
import { api } from "../../../convex/_generated/api";
import { backend } from "../../../src/server";
import { Dialog } from "../../ui/dialog";
import { Icon, type IconName } from "../../ui/icons";
import { PortalDisclosure } from "../portal-disclosure";
import { ManageRepos, RepoPulls } from "../repositories-client";
import { configureRepository, reindex } from "../actions";
import { when } from "./shared";
import type { DashboardContext } from "../load";

type Repo = DashboardContext["data"]["repositories"][number];
const metrics = { merge: "Avg. Time to Merge", bugs: "# of Bugs Caught", addressed: "Addressed rate" };
const ranges = { "7": "Last 7 days", "30": "Last 30 days" };
const pageSize = 10;
/** The provider's mark for a repository or connection kind. */
export const brandIcon = (kind?: string): IconName => !kind || kind.startsWith("github") ? "githubLogo" : kind === "gitlab" ? "gitlabLogo" : kind === "perforce" ? "database" : "gitBranch";
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const duration = (ms: number) => { const m = Math.round(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24); return d >= 2 ? `${d}d ${h % 24}h` : h ? `${h}h ${m % 60}m` : `${m}m`; };
const day = (at: number) => new Date(at).toLocaleDateString("en-US", { timeZone: "UTC" });

/** Index state as a status chip; none for an enabled, indexed repository. */
export function repositoryChip(r: Pick<Repo, "indexStatus" | "enabled" | "knowledgeStatus">) {
  if (r.indexStatus === "unavailable") return <span className="status-chip failed"><Icon name="prohibit" />Unavailable</span>;
  if (!r.enabled) return <span className="status-chip">Disabled</span>;
  if (["queued", "indexing"].includes(r.indexStatus)) return <span className="status-chip pending"><Icon name="circleNotch" />{r.indexStatus === "queued" ? "Queued" : "Indexing"}</span>;
  if (r.indexStatus === "failed") return <span className="status-chip failed"><Icon name="warningCircle" />Failed</span>;
  if (["queued", "generating"].includes(r.knowledgeStatus ?? "")) return <span className="status-chip pending"><Icon name="circleNotch" />Building knowledge</span>;
  return r.indexStatus === "ready" ? null : <span className="status-chip">{r.indexStatus.replaceAll("_", " ")}</span>;
}

// Repositories: search, Manage Repos, a REPO / REVIEWS / metric table with sort, metric and timeframe
// menus (all in the URL), pagination, and per-repository pull requests, details and actions.
export async function RepositoriesSection({ ctx }: { ctx: DashboardContext }) {
  const { data, filters, isAdmin, organization, selectedTeam, user } = ctx;
  if (!data.repositories.length) return <div className="empty-state repos-empty">
    <span className="brand-marks" aria-hidden="true"><Icon name="githubLogo" /><Icon name="gitlabLogo" /></span>
    <strong>No repositories connected</strong>
    <p>{isAdmin ? "Connect a code provider to sync repositories and start reviews." : "A workspace admin connects a code provider to sync repositories."}</p>
    {isAdmin && <div className="actions"><Link className="button" href="/dashboard/providers"><Icon name="plugs" />Go to Code Providers</Link></div>}
  </div>;
  const metric = (filters.metric && filters.metric in metrics ? filters.metric : "merge") as keyof typeof metrics;
  const range = filters.range === "30" ? "30" : "7", since = Date.now() - Number(range) * 86400000;
  const sort = filters.sort ?? "", sortKey = sort.replace(/-asc$/, ""), asc = sort.endsWith("-asc");
  const q = (filters.q ?? "").trim().toLowerCase();
  const mergeTimes: Record<string, number> = metric === "merge"
    ? await backend().query(api.repositoryMetrics.mergeTimes, { token: user.token, organizationId: organization._id, ...(selectedTeam ? { teamId: selectedTeam._id } : {}), since }).catch(() => ({}))
    : {};
  // shortcut: counts come from the dashboard's newest 100 reviews and 200 findings; move them to a query when busy workspaces need exact counts.
  const stats = new Map(data.repositories.map((r) => [r._id as string, { reviews: 0, bugs: 0, resolved: 0 }]));
  for (const r of data.reviews) { const s = stats.get(r.repositoryId); if (s && r.createdAt >= since) s.reviews++; }
  for (const f of data.findings) { const s = stats.get(f.repositoryId); if (s && f.createdAt >= since) { s.bugs++; if (f.status === "resolved") s.resolved++; } }
  const value = (r: Repo) => { const s = stats.get(r._id)!; return metric === "merge" ? mergeTimes[r._id] : metric === "bugs" ? s.bugs || undefined : s.bugs ? s.resolved / s.bugs : undefined; };
  const shownValue = (v: number | undefined) => v === undefined ? "—" : metric === "merge" ? duration(v) : metric === "bugs" ? plural(v, "bug") : `${Math.round(v * 100)}%`;
  const key = (r: Repo) => sortKey === "reviews" ? stats.get(r._id)!.reviews : sortKey === "metric" ? value(r) ?? -1 : 0;
  const matching = data.repositories.filter((r) => !q || r.fullName.toLowerCase().includes(q))
    .sort((a, b) => (asc ? key(a) - key(b) : key(b) - key(a)) || a.fullName.localeCompare(b.fullName));
  const pages = Math.max(1, Math.ceil(matching.length / pageSize)), page = Math.min(pages, Math.max(1, Number.parseInt(filters.page ?? "1") || 1));
  const rows = matching.slice((page - 1) * pageSize, page * pageSize);
  const href = (change: Record<string, string | undefined>) => {
    const next: Record<string, string | undefined> = { q: filters.q, sort: filters.sort, metric: filters.metric, range: filters.range, ...change }, params = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v) params.set(k, v);
    return `/dashboard/repositories${params.size ? `?${params}` : ""}`;
  };
  const sortHref = (k: string) => href({ sort: sortKey === k && !asc ? `${k}-asc` : k, page: undefined });
  const caret = (k: string): IconName => sortKey === k ? (asc ? "caretUp" : "caretDown") : "caretUpDown";
  const pulls = (r: Repo) => {
    const byNumber = new Map<number, (typeof data.reviews)[number][]>();
    for (const review of data.reviews) if (review.repositoryId === r._id) byNumber.set(review.prNumber, [...(byNumber.get(review.prNumber) ?? []), review]);
    return [...byNumber].map(([number, list]) => ({ number, title: list.find((x) => x.title)?.title ?? `Pull request #${number}`, created: day(Math.min(...list.map((x) => x.createdAt))), updated: day(Math.max(...list.map((x) => x.updatedAt))), href: `/dashboard/pulls/${list[0]._id}` }));
  };
  return <>
    <div className="toolbar-row repos-toolbar">
      <form role="search">
        {(["sort", "metric", "range"] as const).map((k) => filters[k] && <input key={k} type="hidden" name={k} value={filters[k]} />)}
        <div className="search-field"><Icon name="magnifyingGlass" /><input type="search" name="q" defaultValue={filters.q} maxLength={200} aria-label="Search repositories" placeholder="Search for repos by name" /></div>
      </form>
      {isAdmin && <Dialog trigger="Manage Repos" triggerClassName="primary" size="wide" title={<><Icon name="code" />Repo Settings</>}>
        <ManageRepos repos={data.repositories.map((r) => ({ id: r._id, name: r.fullName, icon: brandIcon(r.provider?.kind), enabled: r.enabled, unavailable: r.indexStatus === "unavailable" }))} />
      </Dialog>}
    </div>
    <div className="table-box repos-table">
      <table>
        <thead><tr>
          <th scope="col">Repo</th>
          <th scope="col" aria-sort={sortKey === "reviews" ? (asc ? "ascending" : "descending") : undefined}><Link className="th-sort" href={sortHref("reviews")}>Reviews<span className="sort-caret"><Icon name={caret("reviews")} /></span></Link></th>
          <th scope="col" aria-sort={sortKey === "metric" ? (asc ? "ascending" : "descending") : undefined}><div className="metric-head">
            <span className="metric-pick">
              <PortalDisclosure className="th-menu" label={<>{metrics[metric]}<Icon name="caretDown" /><span className="sr-only">: choose the metric</span></>}>
                <div className="menu">{Object.entries(metrics).map(([k, label]) => <Link key={k} className="menu-item" href={href({ metric: k === "merge" ? undefined : k, sort: sortKey === "metric" ? undefined : filters.sort, page: undefined })} aria-current={k === metric ? "true" : undefined}><span>{label}</span>{k === metric && <Icon name="check" />}</Link>)}</div>
              </PortalDisclosure>
              {(metric !== "merge" || sortKey === "metric") && <Link className="sort-caret" href={sortHref("metric")} aria-label={`Sort by ${metrics[metric]}`}><Icon name={caret("metric")} /></Link>}
            </span>
            <PortalDisclosure className="th-menu timeframe" label={<>{ranges[range]}<Icon name="caretDown" /><span className="sr-only">: choose the timeframe</span></>}>
              <div className="menu">{Object.entries(ranges).map(([k, label]) => <Link key={k} className="menu-item" href={href({ range: k === "7" ? undefined : k, page: undefined })} aria-current={k === range ? "true" : undefined}><span>{label}</span>{k === range && <Icon name="check" />}</Link>)}</div>
            </PortalDisclosure>
          </div></th>
        </tr></thead>
        <tbody>
          {rows.map((r) => {
            const job = data.indexJobs.find((j) => j?.repositoryId === r._id), unavailable = r.indexStatus === "unavailable";
            const indexing = job && ["queued", "indexing"].includes(r.indexStatus), reviews = stats.get(r._id)!.reviews;
            return [<tr key={r._id} className={indexing || r.error || r.knowledgeError ? "has-notice" : undefined}>
              <td><div className="repo-title">
                <Icon name={brandIcon(r.provider?.kind)} />
                <Dialog trigger={r.fullName} triggerClassName="repo-link" title={<><Icon name="gitPullRequest" />Pull Requests for {r.fullName}</>}>
                  <RepoPulls pulls={pulls(r)} all={`/dashboard/pulls?repository=${r._id}`} />
                </Dialog>
                {repositoryChip(r)}
              </div></td>
              <td>{plural(reviews, "review")}</td>
              <td><div className="metric-cell">
                <span className={value(r) === undefined ? "muted" : undefined}>{shownValue(value(r))}</span>
                <PortalDisclosure className="item-menu" label={<><Icon name="dotsThree" /><span className="sr-only">Actions for {r.fullName}</span></>}>
                  <div className="menu">
                    {isAdmin && <Link className="menu-item" href={`/dashboard/code-review?repository=${r._id}`}><Icon name="gear" />Review settings</Link>}
                    <Link className="menu-item" href={`/dashboard/repositories/knowledge?repository=${r._id}`}><Icon name="bookOpen" />Knowledge Base</Link>
                    <Dialog trigger={<><Icon name="info" />Repository details</>} triggerClassName="menu-item" title={r.fullName} description={providerDisplay(r.provider)}>
                      <div className="modal-body repo-details">
                        <dl>
                          <div><dt>Reviews</dt><dd>{r.enabled ? "Enabled" : "Disabled"}</dd></div>
                          <div><dt>Index</dt><dd>{repositoryChip(r) ?? <span className="status-chip completed"><Icon name="check" />Ready</span>}</dd></div>
                          <div><dt>Default branch</dt><dd>{r.defaultBranch}</dd></div>
                          <div><dt>Indexed commit</dt><dd>{r.indexedSha ? <code>{r.indexedSha}</code> : "—"}</dd></div>
                          <div><dt>Last indexed</dt><dd>{r.indexedAt ? when(r.indexedAt) : "Never"}</dd></div>
                          {r.knowledgeStatus && <div><dt>Knowledge</dt><dd>{r.knowledgeStatus}</dd></div>}
                        </dl>
                        {r.indexStatus === "ready" && <p className="muted">Ready for review. Open a change in your connected code provider or select an existing change from Pull Requests to request a review.</p>}
                        {job && <p className="muted">Processed {job.processed} of {job.total} eligible files · Attempt {job.attempts}</p>}
                        {!!job?.skippedTotal && <details><summary>{job.skippedTotal} skipped files</summary><ul>{job.skipped?.map((f) => <li key={f.path}><code>{f.path}</code> — {f.reason}</li>)}</ul>{job.skippedTotal > (job.skipped?.length ?? 0) && <p>Showing the first {job.skipped?.length ?? 0} exclusions.</p>}</details>}
                        {r.branches && <details><summary>Branches ({r.branches.length}{r.branchesLimited ? "+" : ""})</summary><ul>{r.branches.map((branch) => <li key={branch.name}>{branch.name} · {branch.sha.slice(0, 8)}{branch.protected ? " · Protected" : ""}</li>)}</ul>{r.branchesLimited && <p className="muted">Showing the first 200 branches. Reviews use the exact PR head commit.</p>}</details>}
                      </div>
                    </Dialog>
                    {isAdmin && <>
                      <form action={reindex}><input type="hidden" name="repositoryId" value={r._id} /><button className="menu-item" disabled={unavailable || !r.enabled}><Icon name="arrowsClockwise" />Re-index changed files</button></form>
                      <hr />
                      <form action={configureRepository}>
                        <input type="hidden" name="repositoryId" value={r._id} /><input type="hidden" name="enabled" value={String(!r.enabled)} />
                        <button className={r.enabled ? "menu-item danger" : "menu-item"} disabled={unavailable}><Icon name={r.enabled ? "prohibit" : "checkCircle"} />{unavailable ? "Indexing unavailable" : r.enabled ? "Disable reviews" : "Enable and index"}</button>
                      </form>
                    </>}
                  </div>
                </PortalDisclosure>
              </div></td>
            </tr>,
            (indexing || r.error || r.knowledgeError) && <tr key={r._id + "-notice"} className="repo-notice"><td colSpan={3}>
              {indexing && <div className="repo-progress"><span>Processed {job.processed} of {job.total} eligible files · Attempt {job.attempts}</span><progress aria-label={`Indexing ${r.fullName}`} value={job.processed} max={Math.max(1, job.total)} /></div>}
              {r.error && <div role="alert" className="notice-inline"><Icon name="warning" /><span>{r.indexStatus === "failed" ? "Indexing failed: " : ""}{r.error}</span>
                {isAdmin && r.enabled && !unavailable && <form action={reindex}><input type="hidden" name="repositoryId" value={r._id} /><button className="small">Retry indexing</button></form>}</div>}
              {r.knowledgeError && <div role="alert" className="notice-inline"><Icon name="warning" /><span>Knowledge generation: {r.knowledgeError}</span></div>}
            </td></tr>];
          })}
          {!rows.length && <tr><td colSpan={3} className="no-results">No results.</td></tr>}
        </tbody>
      </table>
    </div>
    {pages > 1 && <div className="pagination repos-pagination">
      <span>{rows.length} of {matching.length}</span>
      <nav aria-label="Repository pages">
        {page > 1 ? <Link className="page-step" href={href({ page: String(page - 1) })} aria-label="Previous page"><Icon name="caretLeft" /></Link> : <span className="page-step" aria-disabled="true"><Icon name="caretLeft" /></span>}
        <span className="page-nums">{Array.from({ length: pages }, (_, i) => i + 1).filter((n) => n === 1 || n === pages || Math.abs(n - page) <= 2).map((n) => <Link key={n} href={href({ page: n === 1 ? undefined : String(n) })} aria-current={n === page ? "page" : undefined}>{n}</Link>)}</span>
        {page < pages ? <Link className="page-step" href={href({ page: String(page + 1) })} aria-label="Next page"><Icon name="caretRight" /></Link> : <span className="page-step" aria-disabled="true"><Icon name="caretRight" /></span>}
      </nav>
    </div>}
  </>;
}
