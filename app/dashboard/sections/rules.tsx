import { repositoryDisplay } from "../../../src/provider-display";
import Link from "next/link";
import { decideRuleSuggestion, requestRuleAssistant, saveRule } from "../actions";
import { Empty } from "./shared";
import type { ReactNode } from "react";
import type { DashboardContext } from "../load";

type Rule = DashboardContext["visibleRules"][number];
const pct = (n: number, d: number) => d ? `${Math.round((n / d) * 100)}%` : "—";
const units: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31536e6], ["month", 2592e6], ["day", 864e5], ["hour", 36e5], ["minute", 6e4]];
const ago = (t: number) => { const ms = Date.now() - t, [unit, size] = units.find(([, s]) => ms >= s) ?? ["minute", 6e4]; return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(-Math.round(ms / size), unit); };
const icon = (d: ReactNode) => <svg className="tab-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{d}</svg>;

// Laid out like Greptile's Memory → Custom rules: a search box, an Add button, a table of rules with usage, and a
// per-rule analytics panel (?rule=). Adding and editing happen in a dialog (?add=1, ?edit=<id>).
export function RulesSection({ ctx }: { ctx: DashboardContext }) {
  const { data, filters, isAdmin, organization, repoName, requestedRepository, rulesPage, ruleAssistant, ruleUsage, scopes, selectedTeam, visibleRules } = ctx;
  const keep = { ...(filters.q ? { q: filters.q } : {}), ...(requestedRepository ? { repository: requestedRepository } : {}), ...(selectedTeam ? { team: selectedTeam._id } : {}) };
  const href = (extra: Record<string, string> = {}, cursor = filters.cursor) => `/dashboard/memory/rules?${new URLSearchParams({ ...keep, ...(cursor ? { cursor } : {}), ...extra })}`;
  const scopeLabel = (r: { repositoryId?: string; teamId?: string; repositoryPattern?: string }) => r.repositoryId ? repoName(r.repositoryId) : r.repositoryPattern ? r.repositoryPattern : r.teamId ? `Team: ${scopes.teams.find((t) => t._id === r.teamId)?.name ?? "team"}` : "Workspace";
  const open = visibleRules.find((r) => r._id === filters.rule), editing = isAdmin ? visibleRules.find((r) => r._id === filters.edit) : undefined, removing = isAdmin ? visibleRules.find((r) => r._id === filters.remove) : undefined;
  // Suggested rows lead the unfiltered first page only.
  const suggestions = filters.q || filters.cursor ? [] : ruleAssistant?.suggestions ?? [];
  return (
    <>
      <div className="memory-toolbar">
        <form method="get" action="/dashboard/memory/rules" role="search">
          {selectedTeam && <input type="hidden" name="team" value={selectedTeam._id} />}
          {requestedRepository && <input type="hidden" name="repository" value={requestedRepository} />}
          <label><span className="sr-only">Search rules</span><input type="search" name="q" list="rule-filters" defaultValue={filters.q} placeholder="Search rules or filter with repository: status:" maxLength={200} /></label>
          <datalist id="rule-filters"><option value="status:active" /><option value="status:disabled" />{data.repositories.slice(0, 20).map((r) => <option key={r._id} value={`repository:${r.fullName}`} />)}</datalist>
        </form>
        {isAdmin && <Link className="button primary" href={href({ add: "1" })}>+ Add rule</Link>}
      </div>
      {requestedRepository && <p className="muted">Showing rules that apply to {repoName(requestedRepository)}, including inherited workspace, team and pattern rules.</p>}
      {!visibleRules.length && !suggestions.length ? (
        filters.q || filters.cursor ? <p className="memory-empty">No rules match this search.</p> : <Empty title="Your codebase, your conventions" text="Add specific rules such as requiring organization membership validation in API endpoints." />
      ) : (
        <div className={open ? "memory-split" : undefined}>
          <div className="memory-table-wrap">
            <table className="memory-table">
              <thead><tr><th scope="col">Description</th><th scope="col" className="type-col">Type</th>{!open && <><th scope="col" className="usage-col">Usage</th><th scope="col" className="usage-col">Addressed rate</th></>}<th scope="col">Actions</th></tr></thead>
              <tbody>
                {suggestions.map((s) => <SuggestionRow key={s._id} s={s} scope={scopeLabel(s)} wide={!open} />)}
                {visibleRules.map((r) => {
                  const uses = r.stats.capped ? `${r.stats.uses}+` : String(r.stats.uses);
                  return (
                    <tr key={r._id} aria-current={open?._id === r._id ? "true" : undefined}>
                      <td>
                        <Link className="row-title" href={href({ rule: r._id })}>{r.title}</Link>
                        <p className="row-meta">{scopeLabel(r)} · {ago(r.createdAt)} · {r.enabled ? "Active" : "Disabled"}<span className={open ? undefined : "meta-stats"}> · {uses} uses · {pct(r.stats.addressed, r.stats.uses)} addressed</span></p>
                      </td>
                      <td className="type-col"><span className="type-chip">{icon(<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />)}Rule</span></td>
                      {!open && <><td className="usage-col">{uses}</td><td className="usage-col">{pct(r.stats.addressed, r.stats.uses)}</td></>}
                      <td>
                        <div className="row-actions">
                          <Link className="icon-button" href={href({ rule: r._id })} aria-label={`Analytics for ${r.title}`} title="Analytics">{icon(<path d="M3 3v18h18M8 17v-5M13 17V8M18 17v-9" />)}</Link>
                          {isAdmin && <Link className="icon-button" href={href({ edit: r._id })} aria-label={`Edit ${r.title}`} title="Edit">{icon(<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />)}</Link>}
                          {isAdmin && <Link className="icon-button" href={href({ remove: r._id })} aria-label={`Delete ${r.title}`} title="Delete">{icon(<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />)}</Link>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rulesPage && (filters.cursor || !rulesPage.isDone) && <nav className="memory-pager" aria-label="Rules pagination">
              {filters.cursor ? <Link href={href({}, "")}>Newest</Link> : <span />}
              {!rulesPage.isDone && <Link href={href({}, rulesPage.continueCursor)}>Older</Link>}
            </nav>}
          </div>
          {open && <RulePanel rule={open} scope={scopeLabel(open)} usage={ruleUsage} close={href()} edit={isAdmin ? href({ edit: open._id }) : undefined} admin={isAdmin} organizationId={organization._id} repoName={repoName} />}
        </div>
      )}
      {filters.rule && !open && <p className="muted">That rule isn’t on this page. <Link href={href()}>Back to rules</Link></p>}
      {removing && (
        <div className="memory-dialog" role="alertdialog" aria-modal="true" aria-labelledby="rule-remove-title">
          <div className="memory-dialog-card">
            <header><h2 id="rule-remove-title">Delete rule?</h2><Link className="icon-button" href={href()} aria-label="Close">×</Link></header>
            <p>“{removing.title}” stops applying to reviews. This can’t be undone; disable it instead to keep it.</p>
            <div className="dialog-actions"><Link className="button" href={href()}>Cancel</Link><RuleForm rule={removing} organizationId={organization._id} returnTo={href()} remove /></div>
          </div>
        </div>
      )}
      {isAdmin && (filters.add || editing) && (
        <div className="memory-dialog" role="dialog" aria-modal="true" aria-labelledby="rule-dialog-title">
          <div className="memory-dialog-card">
            <header><h2 id="rule-dialog-title">{editing ? "Edit rule" : "Add rule"}</h2><Link className="icon-button" href={href()} aria-label="Close">×</Link></header>
            <p className="muted">Define a custom rule for OpenReview to apply in reviews.</p>
            <form action={saveRule} className="memory-steps">
              <input type="hidden" name="organizationId" value={organization._id} />
              <input type="hidden" name="returnTo" value={href()} />
              {editing && <><input type="hidden" name="id" value={editing._id} /><input type="hidden" name="enabled" value={String(editing.enabled)} /><input type="hidden" name="category" value={editing.category} /></>}
              <fieldset><legend><span className="step-number">1</span> Describe your rule</legend>
                <label>Title<input name="title" required maxLength={120} defaultValue={editing?.title} /></label>
                <label>Instructions<textarea name="instructions" rows={4} required defaultValue={editing?.instructions} placeholder={"What: Use logging instead of printing log messages\nWhy: We can't filter printed messages\nGood: logger.error(\"message\")"} /></label>
                <label>Severity<select name="severity" defaultValue={editing?.severity ?? "medium"}>{["critical", "high", "medium", "low"].map((v) => <option key={v}>{v}</option>)}</select></label>
              </fieldset>
              <fieldset><legend><span className="step-number">2</span> Scope: where should this rule apply?</legend>
                <RuleScopeFields teams={scopes.teams} repositories={data.repositories} scope={editing ? scopeValue(editing) : requestedRepository ? "repo:" + requestedRepository : ""} pattern={editing?.repositoryPattern} />
                <label>File pattern<input name="globs" defaultValue={editing?.globs.join(",")} placeholder="e.g. src/**/*.tsx (comma separated; empty = all files)" /></label>
              </fieldset>
              <div className="dialog-actions"><Link className="button" href={href()}>Cancel</Link><button className="primary">{editing ? "Save rule" : "Create rule"}</button></div>
            </form>
            {!editing && <DraftWithAI ctx={ctx} returnTo={href()} />}
          </div>
        </div>
      )}
    </>
  );
}

// The analytics side panel for one rule, like Greptile's: overview, performance tiles and recent usage.
function RulePanel({ rule, scope, usage, close, edit, admin, organizationId, repoName }: { rule: Rule; scope: string; usage: DashboardContext["ruleUsage"]; close: string; edit?: string; admin: boolean; organizationId: string; repoName: (id: string) => string }) {
  const s = rule.stats, rated = s.useful + s.notUseful;
  return (
    <aside className="memory-panel" aria-labelledby="rule-panel-title">
      <header><h2 id="rule-panel-title">Analytics</h2><Link className="icon-button" href={close} aria-label="Close analytics">×</Link></header>
      <section>
        <div className="panel-heading"><h3>Overview</h3>{edit && <Link className="button small" href={edit}>Edit</Link>}</div>
        <p className="panel-title">{rule.title}</p>
        <p className="panel-body">{rule.instructions}</p>
        <dl className="panel-facts"><dt>Type</dt><dd>Rule</dd><dt>Scope</dt><dd>{scope}</dd><dt>Severity</dt><dd>{rule.severity}</dd><dt>Files</dt><dd>{rule.globs.length ? rule.globs.join(", ") : "All files"}</dd><dt>Status</dt><dd>{rule.enabled ? "Active" : "Disabled"}</dd></dl>
        {admin && <RuleForm rule={rule} organizationId={organizationId} returnTo={close + (close.includes("?") ? "&" : "?") + "rule=" + rule._id} toggle />}
      </section>
      <section>
        <h3>Performance</h3>
        <div className="panel-tiles">
          <div><span>Acceptance rate</span><strong>{pct(s.addressed, s.uses)}</strong></div>
          <div><span>Uses this month</span><strong>{s.usesThisMonth}</strong></div>
          <div><span>Upvote ratio</span><strong className="good">{pct(s.useful, rated)}</strong></div>
          <div><span>Downvote ratio</span><strong className="bad">{pct(s.notUseful, rated)}</strong></div>
        </div>
      </section>
      <section>
        <h3>Recent usage</h3>
        {usage.length ? <ul className="panel-usage">{usage.map((f) => <li key={f._id}><Link href={`/dashboard/pulls/${f.reviewId}`}>{f.title}</Link><span className="row-meta">{repoName(f.repositoryId)} #{f.prNumber} · {ago(f.createdAt)} · {f.status}</span></li>)}</ul> : <p className="memory-empty">No recent usage available</p>}
      </section>
    </aside>
  );
}

// The hidden-field forms behind Delete and Enable/Disable: saveRule needs the whole rule.
function RuleForm({ rule: r, organizationId, returnTo, remove, toggle }: { rule: Rule; organizationId: string; returnTo: string; remove?: boolean; toggle?: boolean }) {
  return (
    <form action={saveRule}>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <input type="hidden" name="id" value={r._id} />
      <input type="hidden" name="title" value={r.title} />
      <input type="hidden" name="instructions" value={r.instructions} />
      <input type="hidden" name="severity" value={r.severity} />
      <input type="hidden" name="scope" value={scopeValue(r)} />
      <input type="hidden" name="repositoryPattern" value={r.repositoryPattern ?? ""} />
      <input type="hidden" name="globs" value={r.globs.join(",")} />
      <input type="hidden" name="category" value={r.category} />
      <input type="hidden" name="enabled" value={String(toggle ? !r.enabled : r.enabled)} />
      {toggle && <button className="small">{r.enabled ? "Disable rule" : "Enable rule"}</button>}
      {remove && <><input type="hidden" name="remove" value="true" /><button className="danger">Delete rule</button></>}
    </form>
  );
}

const scopeValue = (r: { repositoryId?: string; teamId?: string; repositoryPattern?: string }) => r.repositoryId ? "repo:" + r.repositoryId : r.teamId ? "team:" + r.teamId : r.repositoryPattern ? "pattern" : "";
// Scope picker: workspace, a team, a repository-name pattern or one repository. A more specific rule
// with the same title replaces a broader one for the repositories it covers.
function RuleScopeFields({ teams, repositories, scope, pattern }: { teams: { _id: string; name: string }[]; repositories: (NonNullable<Parameters<typeof repositoryDisplay>[0]> & { _id: string })[]; scope: string; pattern?: string }) {
  return <>
    <label>
      Scope
      <select name="scope" defaultValue={scope}>
        <option value="">Entire workspace</option>
        {teams.map((t) => <option key={t._id} value={"team:" + t._id}>Team: {t.name}</option>)}
        <option value="pattern">Repositories matching a pattern</option>
        {repositories.map((r) => <option key={r._id} value={"repo:" + r._id}>{repositoryDisplay(r)}</option>)}
      </select>
    </label>
    <label>
      Repository pattern (for pattern scope)
      <input name="repositoryPattern" defaultValue={pattern ?? ""} placeholder="acme/*-service" maxLength={200} />
    </label>
  </>;
}

const assistantKinds: Record<string, string> = { draft: "Drafted rule", refine: "Tighter wording", suggest: "Suggested rule", flag: "Rule overlap", import: "Imported rule", context: "Suggested from an MCP client" };
const runKinds: Record<string, string> = { draft: "Draft", refine: "Review of existing rules", suggest: "Suggestions from fixed findings and conventions", import: "Import from AI rule files", context: "Suggestion from an MCP client" };
// "Draft with AI" in the Add dialog: the rule assistant. Every result is a suggestion an admin approves
// (optionally after editing) or dismisses from the Suggested rows in the table.
function DraftWithAI({ ctx, returnTo }: { ctx: DashboardContext; returnTo: string }) {
  const { ruleAssistant, organization, scopes, data } = ctx;
  if (!ruleAssistant) return null;
  const busy = ruleAssistant.runs.some((r) => r.status === "pending"), last = ruleAssistant.runs[0];
  return (
    <section className="draft-ai" aria-labelledby="draft-ai">
      <h3 id="draft-ai">Draft with AI</h3>
      <p className="muted">Describe the rule, or let the assistant review existing rules or suggest rules from findings your team fixed. Results appear as Suggested rows for an admin to approve.</p>
      <form action={requestRuleAssistant} className="memory-steps">
        <input type="hidden" name="organizationId" value={organization._id} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <input type="hidden" name="kind" value="draft" />
        <label>Describe the rule<textarea name="description" rows={2} required minLength={10} maxLength={2000} placeholder="Payment code keeps amounts in integer cents, never floating-point dollars." /></label>
        <RuleScopeFields teams={scopes.teams} repositories={data.repositories} scope={ctx.requestedRepository ? "repo:" + ctx.requestedRepository : ""} />
        <button disabled={busy}>Draft rule</button>
      </form>
      <form action={requestRuleAssistant} className="row">
        <input type="hidden" name="organizationId" value={organization._id} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <button className="small" name="kind" value="refine" disabled={busy}>Review existing rules</button>
        <button className="small" name="kind" value="suggest" disabled={busy}>Suggest rules from findings</button>
      </form>
      {last && <p className="muted">Last run: {runKinds[last.kind] ?? last.kind} · {last.status === "pending" ? "working…" : last.status === "failed" ? last.error ?? "failed" : `${last.suggestions ?? 0} suggestion${last.suggestions === 1 ? "" : "s"}`}{(last.rejected ?? []).map((x, i) => <span key={i}> · discarded “{x.title}” ({x.reason})</span>)}</p>}
    </section>
  );
}

type Suggestion = NonNullable<DashboardContext["ruleAssistant"]>["suggestions"][number];
function SuggestionRow({ s, scope, wide }: { s: Suggestion; scope: string; wide: boolean }) {
  return (
    <tr className="suggested-row">
      <td colSpan={wide ? 4 : 2}>
        <span className="row-title">{assistantKinds[s.kind] ?? s.kind}: {s.title}</span>
        <p className="row-meta">{s.kind !== "flag" ? `${scope} · ${s.severity} · ` : ""}Suggested</p>
        <details>
          <summary>Review suggestion</summary>
          {s.kind === "refine" && s.base && <p className="muted">Currently: <strong>{s.base.title}</strong>: {s.base.instructions}</p>}
          <p>{s.rationale}</p>
          {s.issues.length > 0 && <ul>{s.issues.map((i, n) => <li key={n}><span className="badge">{i.kind}</span> {i.detail}</li>)}</ul>}
          <p className="muted">Based on: {s.sources.map((x, n) => <span key={n}>{n ? "; " : ""}{x.kind === "description" ? "your description" : x.kind === "rule" ? `rule “${x.label}”` : x.kind === "file" ? <code>{x.label}</code> : `“${x.label}”`}{x.detail ? ` (${x.detail})` : ""}</span>)}</p>
          <form action={decideRuleSuggestion} className="memory-steps" id={`suggestion-${s._id}`}>
            <input type="hidden" name="suggestionId" value={s._id} />
            {s.kind !== "flag" && (
              <>
                <label>Title<input name="title" required defaultValue={s.title} maxLength={120} /></label>
                <label>Instructions<textarea name="instructions" required defaultValue={s.instructions} rows={3} /></label>
                <label>Severity<select name="severity" defaultValue={s.severity}>{["critical", "high", "medium", "low"].map((v) => <option key={v}>{v}</option>)}</select></label>
              </>
            )}
          </form>
        </details>
      </td>
      <td>
        <div className="row-actions">
          <button className="primary small" form={`suggestion-${s._id}`} name="decision" value="approved">{s.kind === "flag" ? "Disable newer" : s.kind === "refine" ? "Apply" : "Approve"}</button>
          <button className="small" form={`suggestion-${s._id}`} name="decision" value="rejected" formNoValidate>Dismiss</button>
        </div>
      </td>
    </tr>
  );
}
