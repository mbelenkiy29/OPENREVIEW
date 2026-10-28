import Link from "next/link";
import type { ReactNode } from "react";
import type { Id } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { backend } from "../../src/server";
import { repositoryDisplay } from "../../src/provider-display";
import { analyticsPeriod, chartBuckets, periodPresets, presetPeriod } from "../../src/analytics-period";
import { historyFloor, type Entitlement } from "../../src/plans";
import { Icon, type IconName } from "../ui/icons";
import { ChartCard, type ChartView } from "./analytics-chart";
import { FilterMenu, HiddenFilters, filterHref } from "./filter-menu";
import { setMinutesPerFinding } from "./actions";
import { Locked } from "./locked";
import type { DashboardContext } from "./load";

type Row = { key: string; label: ReactNode; value: ReactNode; detail?: string; icon: IconName };
const hours = (ms: number | null) => ms === null ? "–" : `${(ms / 3600000).toFixed(1)} h`;
const percent = (x: number | null | undefined) => `${Math.round((x ?? 0) * 100)}%`;
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const providerMark = (kind?: string): IconName => kind?.startsWith("github") ? "githubLogo" : kind === "gitlab" ? "gitlabLogo" : "code";
const shortDate = (date: string) => new Date(date + "T00:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
// A chart card's leaderboard: a caption, then RepoCell rows with a right-aligned value.
const Board = ({ caption, rows, empty, action }: { caption: string; rows: Row[]; empty: string; action?: ReactNode }) => <footer className="chart-board">
  <div className="chart-board-head"><h3>{caption}</h3>{action}</div>
  {rows.length ? <ol>{rows.map((r) => <li key={r.key}><Icon name={r.icon} /><span className="chart-board-name">{r.label}{r.detail && <small>{r.detail}</small>}</span><span className="chart-board-value">{r.value}</span></li>)}</ol> : <p className="muted">{empty}</p>}
</footer>;
const Stats = ({ items }: { items: [string, ReactNode, string?][] }) => <dl className="stat-summary">{items.map(([label, value, suffix]) => <div key={label}><dt>{label}</dt><dd><strong>{value}</strong>{suffix && <span>{suffix}</span>}</dd></div>)}</dl>;

// Greptile's Analytics tab: the filter row on the title line, four summary stats, then chart cards each
// paired with a leaderboard; our contributors, follow-up fixes and cost and impact numbers follow.
export async function AnalyticsView({ token, organizationId, repositories, teams, filters, locked, live, children }: { token: string; organizationId: Id<"organizations">; repositories: DashboardContext["data"]["repositories"]; teams: { _id: string; name: string }[]; filters: Record<string, string | undefined>; locked: readonly Entitlement[]; live?: ReactNode; children?: ReactNode }) {
  const now = new Date(), start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  // Links that carry only dates (older bookmarks, the Findings page) mean a custom period.
  const preset = filters.period ?? (filters.since || filters.until ? "custom" : "month"), range = presetPeriod(preset, now.getTime());
  const since = range?.since ?? filters.since ?? start, until = range?.until ?? filters.until ?? now.toISOString().slice(0, 10);
  const period = analyticsPeriod(since, until), floor = locked.includes("analytics.history") ? new Date(historyFloor(Date.now())).toISOString().slice(0, 10) : undefined;
  const accessible = !filters.repository || repositories.some((r) => r._id === filters.repository);
  const scope = { ...(filters.team ? { team: filters.team } : {}), ...(filters.repository ? { repository: filters.repository } : {}), ...(filters.author ? { author: filters.author } : {}) };
  const query = new URLSearchParams({ since, until, ...scope });
  const exportable = !("error" in period) && accessible && !(floor && since < floor);
  // The page's own filters; "" for team keeps an explicit "all teams" over the saved team.
  const current = { team: filters.team, repository: filters.repository || undefined, author: filters.author || undefined, period: filters.period, since: preset === "custom" ? since : undefined, until: preset === "custom" ? until : undefined };
  const href = (patch: Record<string, string | undefined>) => filterHref("/dashboard/analytics", current, patch);
  const team = teams.find((t) => t._id === filters.team), repository = repositories.find((r) => r._id === filters.repository);
  const timeframe = preset === "custom" || !range ? `${shortDate(since)} – ${shortDate(until)}` : periodPresets.find(([value]) => value === preset)![1];
  const header = (authors: string[]) => <header className="page-header analytics-header">
    <h1>Analytics</h1>
    {live}
    {/* Keyed by the URL so an open menu closes once its choice has loaded. */}
    <div className="analytics-filters" key={href({})}>
      <FilterMenu icon="users" title="Teams" value={team?.name ?? "All teams"} options={[{ label: "All teams", href: href({ team: "" }), current: !team }, ...teams.map((t) => ({ label: t.name, href: href({ team: t._id }), current: t._id === team?._id }))]} />
      <FilterMenu icon="code" title="Repositories" value={repository?.fullName ?? "All repositories"} options={[{ label: "All repositories", href: href({ repository: undefined }), current: !repository }, ...repositories.map((r) => ({ label: r.fullName, hint: repositoryDisplay(r), href: href({ repository: r._id }), current: r._id === repository?._id }))]} />
      <FilterMenu icon="user" title="Authors" value={filters.author ? "@" + filters.author.replace(/^@/, "") : "All authors"} options={[{ label: "All authors", href: href({ author: undefined }), current: !filters.author }, ...authors.map((a) => ({ label: "@" + a, href: href({ author: a }), current: a === filters.author?.replace(/^@/, "") }))]}>
        <form className="menu-form stack" action="/dashboard/analytics"><HiddenFilters current={current} omit={["author"]} /><label className="search-field"><Icon name="magnifyingGlass" /><span className="sr-only">Author</span><input name="author" defaultValue={filters.author} placeholder="Search by author" /></label></form>
      </FilterMenu>
      <FilterMenu icon="calendarBlank" title="Timeframe" value={timeframe} fit options={periodPresets.filter(([value]) => value !== "custom").map(([value, label]) => ({ label, href: href({ period: value, since: undefined, until: undefined }), current: value === preset }))}>
        <hr />
        <form className="menu-form range stack" action="/dashboard/analytics">
          <p className="menu-label">Custom range</p>
          <HiddenFilters current={current} omit={["period", "since", "until"]} /><input type="hidden" name="period" value="custom" />
          <label>From<input type="date" name="since" defaultValue={since} min={floor} required /></label>
          <label>Through<input type="date" name="until" defaultValue={until} required /></label>
          <button className="primary">Apply</button>
        </form>
      </FilterMenu>
      {exportable ? <a className="button primary" href={`/api/analytics?${query}`} title="Download these analytics as CSV"><Icon name="arrowSquareOut" />Export</a> : <button type="button" className="primary" disabled title="Choose valid filters to export"><Icon name="arrowSquareOut" />Export</button>}
    </div>
  </header>;
  const problem = (title: string, body: ReactNode) => <>{header([])}{children}<section className="analytics-alert" role="alert"><h2>{title}</h2>{body}</section></>;
  if ("error" in period) return problem("Analytics unavailable", <><p>{period.error}</p><p>Choose another timeframe to retry.</p></>);
  if (!accessible) return problem("Analytics unavailable", <p>Select a repository accessible in the current workspace and team.</p>);
  if (floor && since < floor) return problem("Older analytics", <><Locked feature="analytics.history" locked={locked} /><p>Choose a From date on or after {floor}.</p></>);
  const args = { token, organizationId, ...period, ...(filters.repository ? { repositoryId: filters.repository as Id<"repositories"> } : {}), ...(filters.author ? { author: filters.author } : {}), ...(filters.team ? { teamId: filters.team as Id<"teams"> } : {}) };
  const [loaded, rolled] = await Promise.allSettled([backend().query(api.analytics.report, args), backend().query(api.analytics.trends, args)]);
  if (loaded.status === "rejected") return problem("Analytics unavailable", <p>Could not load the selected analytics. Choose a shorter timeframe or check repository and team access, then retry.</p>);
  const report = loaded.value, t = rolled.status === "fulfilled" ? rolled.value : null;
  const days: string[] = [];
  for (let at = period.since; at <= period.until && days.length < 367; at += 86400000) days.push(new Date(at).toISOString().slice(0, 10));
  // Every chart shares the buckets: days, or weeks past 90 days.
  const buckets = chartBuckets(days), labels = buckets.map((b) => b.label), byDate = new Map(report.daily.map((d) => [d.date, d])), mergeByDate = new Map(report.mergeTime.daily.map((d) => [d.date, d])), trendDays = new Map((t?.days ?? []).map((d) => [d.day, d]));
  const sum = (value: (day: string) => number) => buckets.map((b) => Math.round(b.days.reduce((n, d) => n + value(d), 0) * 100) / 100), tsum = (key: "findings" | "addressed" | "useful" | "notUseful" | "commitAddressed" | "ignored") => sum((d) => trendDays.get(d)?.[key] ?? 0);
  const cumulativeRate = (part: number[], whole: number[]) => { let p = 0, w = 0; return part.map((x, i) => { p += x; w += whole[i]; return w ? Math.round(p / w * 100) : null; }); };
  const fixed = tsum("commitAddressed"), ignored = tsum("ignored"), useful = tsum("useful"), notUseful = tsum("notUseful");
  // Merge time per bucket is weighted by merged PRs. shortcut: a weekly bucket's median averages its daily medians; exact per day.
  const merge = (key: "meanMs" | "medianMs") => buckets.map((b) => { let ms = 0, n = 0; for (const d of b.days) { const m = mergeByDate.get(d); if (m) { ms += m[key] * m.count; n += m.count; } } return n ? Math.round(ms / n / 360000) / 10 : null; });
  const repos = t?.byRepository ?? [], top = (value: (r: (typeof repos)[number]) => number) => repos.filter((r) => value(r) > 0).sort((p, q) => value(q) - value(p)).slice(0, 5);
  const mark = (id: string) => providerMark(repositories.find((r) => r._id === id || r.fullName === id)?.provider?.kind);
  const trendsMissing = <p className="analytics-missing" role="alert"><strong>Trends unavailable.</strong> Daily trends could not be loaded for these filters.</p>;
  const addressed = t?.addressedRate ?? report.addressedRate, votes = report.reactions.up + report.reactions.down;
  const bugsLink = <Link href={`/dashboard/analytics/findings?${new URLSearchParams({ since, until, ...scope })}`}>View all bugs</Link>;
  const counts = (label: string, yTitle: string, values: number[]): ChartView => ({ label, kind: "bar", series: [{ label, values }], yTitle });
  const severities = (["critical", "high", "medium", "low"] as const).map((s) => ({ label: s[0].toUpperCase() + s.slice(1), values: sum((d) => byDate.get(d)?.[s] ?? 0) }));
  return <>
    {header(report.contributors.map((c) => c.author))}
    {children}
    {report.capped && <p className="notice-banner" role="status">This period has more activity than one view can total, so these numbers cover its most recent part. Choose a shorter period for exact totals.</p>}
    {t?.capped && <p className="notice-banner" role="status">Trends cover the most recent days of this period only. Choose a shorter period to see all of it.</p>}
    <Stats items={[
      ["Total Reviews", report.totalReviews, report.totalReviews ? `on ${plural(report.totalPRs, "PR")}` : undefined],
      ["Avg Merge Time", hours(report.mergeTime.meanMs), report.mergeTime.count ? `${report.mergeTime.count} merged` : undefined],
      ["Addressed rate", percent(addressed)],
      ["# of bugs caught", report.findings, report.findings ? `in ${plural(report.bugRepositories, "repo")}` : undefined],
    ]} />
    <div className="analytics-grid">
      <ChartCard icon="gitPullRequest" title="Reviews by OpenReview" labels={labels} views={[counts("Reviews", "Reviews", sum((d) => byDate.get(d)?.reviews ?? 0)), { label: "Model cost", kind: "bar", unit: "$", series: [{ label: "Model cost", values: sum((d) => byDate.get(d)?.cost ?? 0) }], yTitle: "Model cost" }]}
        footer={t ? <Board caption="Top Repos by Review Count" rows={top((r) => r.reviews).map((r) => ({ key: r.key, icon: mark(r.key), label: r.label, value: r.reviews }))} empty="No reviews in this period." /> : null} />
      <ChartCard icon="bug" title="Bugs caught" labels={labels} views={[{ label: "All Severity", kind: "bar", series: severities, yTitle: "Bugs caught" }, ...severities.map((s) => counts(s.label, `${s.label} bugs`, s.values))]}
        footer={<Board caption="Repos with most bugs" action={bugsLink} rows={top((r) => r.findings).map((r) => ({ key: r.key, icon: mark(r.key), label: r.label, detail: `${r.high} critical or high`, value: r.findings }))} empty={t ? "No bugs caught in this period." : "Trends could not be loaded for these filters."} />} />
      <ChartCard icon="check" title="Addressed rate" info="Share of the bugs caught in this period that were addressed, cumulative from its first day." labels={labels}
        views={t ? [{ label: "Addressed rate", kind: "line", unit: "%", average: true, series: [{ label: "Addressed", values: cumulativeRate(tsum("addressed"), tsum("findings")) }], yTitle: "Addressed rate" }] : []}
        summary={t ? <p className="chart-big"><strong>{percent(t.addressedRate)}</strong><span>{t.totals.addressed} of {plural(t.totals.findings, "bug")}</span></p> : trendsMissing}
        footer={t ? <Board caption="Top repos by addressed rate" rows={top((r) => r.findings ? r.addressed / r.findings : 0).map((r) => ({ key: r.key, icon: mark(r.key), label: r.label, detail: `${r.addressed} of ${r.findings}`, value: percent(r.addressed / r.findings) }))} empty="No addressed bugs in this period." /> : null} />
      <ChartCard icon="gitMerge" title="Average time to merge" labels={labels}
        views={[{ label: "Mean", kind: "line", unit: "h", average: true, series: [{ label: "Mean", values: merge("meanMs") }], yTitle: "Average time" }, { label: "Median", kind: "line", unit: "h", average: true, series: [{ label: "Median", values: merge("medianMs") }], yTitle: "Median time" }]}
        footer={<Board caption="Top Repos by Merge Time" rows={report.mergeTime.byRepository.slice(0, 5).map((r) => ({ key: r.repository, icon: mark(r.repository), label: r.repository, detail: `${r.count} merged`, value: hours(r.meanMs) }))} empty="Merge time runs from when OpenReview first sees a pull request to its merge, recorded for pull requests merged from now on." />} />
      <ChartCard wide icon="chatCircleDots" title="OpenReview comments" labels={labels}
        views={t ? [{ label: "Helpful/Not Helpful Ratio", kind: "line", unit: "%", average: true, series: [{ label: "Helpful", values: useful.map((u, i) => u + notUseful[i] ? Math.round(u / (u + notUseful[i]) * 100) : null) }], yTitle: "Helpful ratio" }, { label: "Ratings", kind: "bar", series: [{ label: "Helpful", values: useful }, { label: "Not helpful", values: notUseful }], yTitle: "Ratings" }] : []}
        summary={<><dl className="vote-stats"><div><dt><Icon name="thumbsUp" />Upvotes</dt><dd className="up">{percent(votes ? report.reactions.up / votes : 0)}</dd></div><div><dt><Icon name="thumbsDown" />Downvotes</dt><dd className="down">{percent(votes ? report.reactions.down / votes : 0)}</dd></div></dl>{!t && trendsMissing}</>}
        footer={<Board caption="Most Upvoted Comments" rows={report.topComments.map((c) => ({ key: c.findingId, icon: mark(c.repository), label: <Link href={`/dashboard/pulls/${c.reviewId}`}>{c.title}</Link>, detail: `${c.repository} #${c.prNumber}`, value: <><Icon name="thumbsUp" />{c.upvotes}</> }))} empty="No upvoted comments in this period." />} />
      <ChartCard icon="users" title="Top contributors" footer={<Board caption="PRs reviewed per author" rows={report.contributors.map((c) => ({ key: c.author, icon: "user", label: "@" + c.author, detail: c.repositories.join(", "), value: plural(c.prs, "PR") }))} empty="No reviewed pull requests in this period." />} />
      {t ? <ChartCard icon="arrowsClockwise" title="Fixed by a follow-up commit" labels={labels}
        views={[{ label: "Outcomes", kind: "bar", series: [{ label: "Fixed by commit", values: fixed }, { label: "Merged unaddressed", values: ignored }], yTitle: "Findings" }, { label: "Fixed before merge", kind: "line", unit: "%", average: true, series: [{ label: "Fixed before merge", values: cumulativeRate(fixed, fixed.map((x, i) => x + ignored[i])) }], yTitle: "Fixed before merge" }]} />
        : <ChartCard icon="arrowsClockwise" title="Fixed by a follow-up commit" summary={trendsMissing} />}
    </div>
    <section className="analytics-impact" aria-labelledby="impact-heading">
      <div className="section-heading"><h2 id="impact-heading">Cost &amp; impact</h2></div>
      <Stats items={[
        ["Model cost", `$${report.cost.toFixed(2)}`, report.tokens ? `${report.tokens.toLocaleString()} tokens` : undefined],
        ["Average review duration", report.averageDuration === null ? "–" : `${Math.round(report.averageDuration / 1000)}s`],
        ["Comment usefulness", report.usefulness === null ? "–" : percent(report.usefulness), report.usefulness === null ? "awaiting feedback" : undefined],
        ["Comment reactions", report.reactions.up, `up · ${report.reactions.down} down`],
        ...(t ? [["Estimated time saved", `${t.hoursSaved} h`], ["Fixed before merge", t.fixRate === null ? "–" : percent(t.fixRate)]] as [string, ReactNode][] : []),
      ]} />
      {t && <>
        <p className="analytics-note">Time saved = addressed findings × {t.minutesPerFinding} minutes per finding. “Fixed before merge” counts findings a later commit fixed against findings merged while still open with no feedback. Reactions come from provider comments (GitHub polled hourly and on close; GitLab via emoji webhooks). Trends come from a daily rollup refreshed hourly{t.updatedAt ? `, last updated ${new Date(t.updatedAt).toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC` : ""}.</p>
        <form action={setMinutesPerFinding} className="setting-row analytics-estimate stack">
          <input type="hidden" name="organizationId" value={organizationId} />
          <div><label htmlFor="minutes-per-finding"><strong>Minutes saved per addressed finding</strong></label><p id="minutes-help">Used for the estimated time saved.</p></div>
          <div className="page-actions"><input id="minutes-per-finding" aria-describedby="minutes-help" type="number" name="minutes" min={1} max={480} defaultValue={t.minutesPerFinding} required /><button>Update estimate</button></div>
        </form>
      </>}
    </section>
  </>;
}
