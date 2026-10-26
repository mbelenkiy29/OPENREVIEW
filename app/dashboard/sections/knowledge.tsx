import { repositoryDisplay, providerDisplay } from "../../../src/provider-display";
import Link from "next/link";
import { Icon } from "../../ui/icons";
import { brandIcon } from "./repositories";
import type { DashboardContext } from "../load";

// Knowledge Base: a search toolbar, then one card per learned subsystem.
export function KnowledgeSection({ ctx }: { ctx: DashboardContext }) {
  const { data, filters, knowledge, knowledgeState, requestedRepository } = ctx;
  const filtered = Boolean(filters.q || requestedRepository);
  return <>
    <form className="toolbar-row knowledge-toolbar" role="search">
      {filters.team !== undefined && <input type="hidden" name="team" value={filters.team} />}
      <div className="search-field"><Icon name="magnifyingGlass" /><input type="search" name="q" defaultValue={filters.q} maxLength={200} aria-label="Search knowledge" placeholder="Search subsystems, files, risks or conventions" /></div>
      <select name="repository" defaultValue={requestedRepository ?? ""} aria-label="Repository"><option value="">All accessible repositories</option>{data.repositories.map((r) => <option key={r._id} value={r._id}>{repositoryDisplay(r)}</option>)}</select>
      <button>Apply</button>
    </form>
    {knowledgeState.searchError && <p role="alert" className="notice-inline"><Icon name="warning" /><span>Search must contain at most 200 characters. Shorten it and apply the filters again.</span></p>}
    {!knowledgeState.searchError && <p className="knowledge-count">{knowledgeState.count} matching {knowledgeState.count === 1 ? "entry" : "entries"}{knowledgeState.incomplete ? " from repositories successfully loaded · Results are incomplete." : ""} · Search covers subsystems, descriptions, files, dependencies, risks and conventions. Related findings show the latest 100 findings per repository.</p>}
    {knowledge.filter((k) => k.failed).map((k) => <div key={k.repo._id} role="alert" className="notice-banner"><Icon name="warning" /><span><strong>{k.repo.fullName}</strong> · {providerDisplay(k.repo.provider)}. Knowledge could not be loaded. Retry the request; if access changed, choose an accessible repository. <a href={knowledgeState.retryUrl}>Retry knowledge</a></span></div>)}
    {knowledgeState.empty && <div className="empty-state knowledge-empty">
      <Icon name="bookOpen" />
      <strong>{filtered ? "No matching knowledge" : "No knowledge base yet"}</strong>
      <p>{filtered ? "Adjust the search or repository filter. Knowledge is generated after repository indexing." : "OpenReview hasn't built a knowledge base for these repositories yet. It's generated after a repository is indexed, and what it learns from reviews shows up here."}</p>
      {filtered && <div className="actions"><Link className="button" href="/dashboard/repositories/knowledge">Clear filters</Link></div>}
    </div>}
    <div className="knowledge-list">
      {knowledge.flatMap((k) => k.entries.map((e) => <article className="knowledge-card" key={e._id}>
        <header>
          <h2>{e.subsystem}</h2>
          <span className="knowledge-repo" title={repositoryDisplay(k.repo)}><Icon name={brandIcon(k.repo.provider?.kind)} />{k.repo.fullName}<code title={e.sha}>{e.sha.slice(0, 7)}</code></span>
        </header>
        <div className="knowledge-body">
          <p>{e.description}</p>
          <dl>
            <div><dt>Dependencies</dt><dd>{e.dependencies.join(", ") || "None recorded"}</dd></div>
            <div><dt>Risks</dt><dd>{e.risks.join("; ") || "None recorded"}</dd></div>
          </dl>
          {e.pastFindings.length > 0 && <div className="knowledge-findings"><span className="mono-label">Related findings</span><ul>
            {e.pastFindings.map((finding) => <li key={finding.id}><Link href={`/dashboard/pulls/${finding.reviewId}`}>{finding.title}</Link><span className="muted"> · PR #{finding.prNumber} · {finding.status}</span></li>)}
          </ul></div>}
          <details>
            <summary>Related files and conventions</summary>
            <ul>{e.sources.map((source) => <li key={source.path}>{source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.path}</a> : <>{source.path} <span className="muted">· Source link unavailable</span></>}</li>)}</ul>
            <pre>{e.conventions.join("\n")}</pre>
          </details>
        </div>
      </article>))}
    </div>
  </>;
}
