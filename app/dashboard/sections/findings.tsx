import { findingSchema } from "../../../src/engine/types";
import { repositoryDisplay } from "../../../src/provider-display";
import Link from "next/link";

import { fixPrompt } from "../../../src/fix-prompt";
import { feedback } from "../actions";
import { Copy } from "../live";
import { FixButton } from "../fix-button";
import { AgentLinks } from "../agent-links";
import { devinHandoff } from "../../../src/agent-links";
import { Icon, type IconName } from "../../ui/icons";
import { FilterMenu, HiddenFilters, filterHref } from "../filter-menu";
import { priority, ago, when } from "./shared";
import type { DashboardContext } from "../load";

const path = "/dashboard/analytics/findings";
const words = (v: string) => v[0].toUpperCase() + v.slice(1).replaceAll("_", " ");
const chips: Record<string, [IconName, string]> = { open: ["warningCircle", ""], resolved: ["check", "completed"], wont_fix: ["x", ""], false_positive: ["x", "failed"] };
const chip = (value: string) => { const [icon, tone] = chips[value] ?? ["info", ""]; return <span className={`status-chip ${tone}`}><Icon name={icon} />{value.replaceAll("_", " ")}</span>; };

// Analytics → Bugs Caught: Greptile's toolbar (author search and filter menus) over a DataTable whose rows
// expand into the full finding with its fix, agent hand-offs and feedback.
export function FindingsSection({ ctx }: { ctx: DashboardContext }) {
  const { data, devinConfigured, filters, findingsPage, personalAgent, repoName, visibleFindings } = ctx;
  const keys = ["team", "repository", "severity", "category", "status", "usefulness", "author", "since", "until"];
  const current = Object.fromEntries(keys.map((k) => [k, k === "team" ? filters.team : filters[k] || undefined]));
  const href = (patch: Record<string, string | undefined> = {}) => filterHref(path, current, patch);
  const menu = (key: string, icon: IconName, title: string, all: string, options: string[]) => <FilterMenu icon={icon} title={title} value={filters[key] ? words(filters[key]!) : all} fit
    options={[{ label: all, href: href({ [key]: undefined }), current: !filters[key] }, ...options.map((v) => ({ label: words(v), href: href({ [key]: v }), current: filters[key] === v }))]} />;
  const repository = data.repositories.find((r) => r._id === filters.repository);
  const eligible = visibleFindings.filter((f) => f.canFix);
  return <>
    <div className="toolbar-row findings-toolbar" key={href()}>
      <form method="get" className="findings-search">
        <HiddenFilters current={current} omit={["author"]} />
        <label className="search-field"><Icon name="magnifyingGlass" /><span className="sr-only">PR author</span><input name="author" defaultValue={filters.author ?? ""} placeholder="Search by PR author" /></label>
        <button>Filter findings</button>
      </form>
      {keys.some((k) => k !== "team" && current[k]) && <Link className="button ghost" href={href(Object.fromEntries(keys.filter((k) => k !== "team").map((k) => [k, undefined])))}>Reset filters</Link>}
      {eligible.length > 0 && <Copy label="Copy eligible tasks on this page" value={eligible.map((f) => fixPrompt(repoName(f.repositoryId), `PR #${f.prNumber}`, [{ ...findingSchema.parse(f), agent: f.agent, fingerprint: f.fingerprint, commitSha: f.commitSha }])).join("\n\n--- Next finding task: use its named repository, PR and revision ---\n\n")} />}
    </div>
    <div className="findings-filters" key={`menus ${href()}`}>
      <FilterMenu icon="code" title="Repository" value={repository?.fullName ?? "All repositories"} fit options={[{ label: "All repositories", href: href({ repository: undefined }), current: !repository }, ...data.repositories.map((r) => ({ label: r.fullName, hint: repositoryDisplay(r), href: href({ repository: r._id }), current: r._id === repository?._id }))]} />
      {menu("severity", "warning", "Severity", "All severities", ["critical", "high", "medium", "low"])}
      {menu("status", "checkCircle", "Status", "All statuses", ["open", "resolved", "wont_fix", "false_positive"])}
      {menu("category", "tag", "Category", "All categories", ["correctness", "security", "data", "compatibility", "testing", "performance", "rules"])}
      {menu("usefulness", "thumbsUp", "Feedback", "All feedback", ["useful", "not_useful", "false_positive"])}
      <FilterMenu icon="calendarBlank" title="Date" value={filters.since || filters.until ? `${filters.since ?? "…"} – ${filters.until ?? "…"}` : "Any date"} fit options={[{ label: "Any date", href: href({ since: undefined, until: undefined }), current: !filters.since && !filters.until }]}>
        <hr />
        <form method="get" className="menu-form range stack">
          <HiddenFilters current={current} omit={["since", "until"]} />
          <label>Since<input name="since" type="date" defaultValue={filters.since ?? ""} /></label>
          <label>Until<input name="until" type="date" defaultValue={filters.until ?? ""} /></label>
          <button className="primary">Apply</button>
        </form>
      </FilterMenu>
    </div>
    <div className="table-box findings-table">
      <div className="findings-head" aria-hidden="true"><span>Finding</span><span>Priority</span><span>Status</span><span>Confidence</span><span>Found</span></div>
      {!visibleFindings.length && <div className="empty-state" role="status">{findingsPage && !findingsPage.isDone
        // Reads per page are capped, so a rare filter can come back empty before the end of the list.
        ? <><strong>No matches in this part of the list</strong><p>Choose Next findings to keep searching older findings.</p></>
        : <><strong>No findings yet</strong><p>Open a pull request in an enabled repository. Verified findings will appear here.</p></>}</div>}
      {visibleFindings.map((f) => {
        const prompt = fixPrompt(repoName(f.repositoryId), `PR #${f.prNumber}`, [{ ...findingSchema.parse(f), agent: f.agent, fingerprint: f.fingerprint, commitSha: f.commitSha }]);
        return <details className="finding" key={f._id}>
          <summary>
            <span className="finding-name"><Icon name="caretRight" /><span><strong>{f.title}</strong><small>{repoName(f.repositoryId)} #{f.prNumber} · {f.filePath}:{f.startLine}</small></span></span>
            <span>{priority(f)}</span>
            <span>{chip(f.status)}</span>
            <span className="finding-mono">{Math.round(f.confidence * 100)}%<span className="sr-only"> confidence</span></span>
            <span className="finding-mono" title={when(f.createdAt)}>{ago(f.createdAt)}</span>
          </summary>
          <div className="finding-detail">
            <p>{f.description}</p>
            {f.ruleId && <p className="muted">Rule: {data.rules.find((rule) => rule._id === f.ruleId)?.title ?? f.ruleId}</p>}
            <p><strong>Impact:</strong> {f.impact}</p>
            {f.evidence.map((e, i) => <div key={i} className="finding-evidence">
              {e.sourceUrl && <a href={e.sourceUrl} target="_blank" rel="noreferrer">{e.repository} · {e.revision?.slice(0, 8)} · source</a>}
              <p className="muted">{e.filePath}:{e.startLine}</p>
              <pre><code>{e.quote}</code></pre>
            </div>)}
            <p><strong>Suggested fix:</strong> {f.suggestedFix}</p>
            {f.canFix && <FixButton reviewId={f.reviewId} agent={personalAgent} findingId={f._id} />}
            {f.status === "open" && !f.canFix && data.writableRepositoryIds.includes(f.repositoryId) && <p className="muted">Fix requires this finding to belong to the latest completed review, meet the current confidence threshold, and have current repository access.</p>}
            <div className="page-actions"><Copy value={prompt} />{f.status === "open" && <AgentLinks prompt={prompt} repo={data.repositories.find((r) => r._id === f.repositoryId)} devin={devinHandoff(devinConfigured, f.canFix, f.reviewId, f.fingerprint)} />}</div>
            <details><summary>Portable prompt for Codex, Claude Code, or Cursor</summary><pre>{prompt}</pre></details>
            {data.writableRepositoryIds.includes(f.repositoryId) && <form action={feedback} className="feedback">
              <input type="hidden" name="findingId" value={f._id} />
              <label>Feedback<select name="value"><option value="useful">Useful</option><option value="not_useful">Not useful</option><option value="resolved">Resolved</option><option value="wont_fix">Won’t fix</option><option value="false_positive">False positive</option></select></label>
              <label>Reason<input name="comment" maxLength={5000} /></label>
              <button>Save feedback</button>
            </form>}
          </div>
        </details>;
      })}
    </div>
    {(visibleFindings.length > 0 || filters.cursor) && <div className="pagination">
      <span>{visibleFindings.length} {visibleFindings.length === 1 ? "finding" : "findings"} on this page</span>
      <nav aria-label="Findings pages">
        {filters.cursor && <Link href={href()}><Icon name="caretLeft" />First page</Link>}
        {findingsPage && !findingsPage.isDone && <Link href={href({ cursor: findingsPage.continueCursor })}>Next findings<Icon name="caretRight" /></Link>}
      </nav>
    </div>}
  </>;
}
