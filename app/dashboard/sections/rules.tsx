import { repositoryDisplay } from "../../../src/provider-display";
import Link from "next/link";
import { decideRuleSuggestion, requestRuleAssistant, saveRule } from "../actions";
import { AddContext, ContextTable, ScopeEditor, TypeChip, type ContextRow } from "../context-client";
import { PortalDisclosure } from "../portal-disclosure";
import { Dialog, DialogClose } from "../../ui/dialog";
import { Icon, type IconName } from "../../ui/icons";
import { ago, when } from "./shared";
import type { DashboardContext } from "../load";

type Rule = DashboardContext["visibleRules"][number];
type Scoped = { repositoryId?: string; teamId?: string; repositoryPattern?: string };
const pct = (n: number, d: number) => d ? `${Math.round((n / d) * 100)}%` : "0%";
const providerIcon = (kind?: string): IconName => kind?.startsWith("github") ? "githubLogo" : kind === "gitlab" ? "gitlabLogo" : "gitBranch";
const scopeValue = (r: Scoped) => r.repositoryId ? "repo:" + r.repositoryId : r.teamId ? "team:" + r.teamId : r.repositoryPattern ? "pattern" : "";

// Greptile's Custom Context: search + Add Context, a rules table (bulk Delete / Deactivate, rows that expand),
// a Details drawer docked right (?rule=, edit mode ?edit=, delete confirm ?remove=) and the Add Context
// stepper (?add=1). Rule-assistant suggestions lead the first page as rows an admin approves.
export function RulesSection({ ctx }: { ctx: DashboardContext }) {
  const { data, filters, isAdmin, organization, requestedRepository, rulesPage, ruleAssistant, ruleUsage, scopes, selectedTeam, visibleRules } = ctx;
  const keep = { ...(filters.q ? { q: filters.q } : {}), ...(requestedRepository ? { repository: requestedRepository } : {}), ...(selectedTeam ? { team: selectedTeam._id } : {}) };
  const href = (extra: Record<string, string> = {}, cursor = filters.cursor) => `/dashboard/context?${new URLSearchParams({ ...keep, ...(cursor ? { cursor } : {}), ...extra })}`;
  const scopeOf = (r: Scoped): { icon: IconName; label: string; title?: string } => {
    if (r.repositoryId) { const repo = data.repositories.find((x) => x._id === r.repositoryId); return { icon: providerIcon(repo?.provider?.kind), label: repo?.fullName ?? r.repositoryId, title: repositoryDisplay(repo) }; }
    if (r.repositoryPattern) return { icon: "folders", label: r.repositoryPattern, title: "Repositories matching " + r.repositoryPattern };
    if (r.teamId) return { icon: "usersThree", label: scopes.teams.find((t) => t._id === r.teamId)?.name ?? "Team", title: "Team" };
    return { icon: "buildings", label: organization.name ?? "Workspace", title: "Entire workspace" };
  };
  const scopeCell = (r: Scoped) => { const s = scopeOf(r); return <span className="scope-cell" title={s.title}><Icon name={s.icon} /><span>{s.label}</span></span>; };
  const open = visibleRules.find((r) => r._id === filters.rule), editing = isAdmin ? visibleRules.find((r) => r._id === filters.edit) : undefined, removing = isAdmin ? visibleRules.find((r) => r._id === filters.remove) : undefined;
  const drawer = open ?? editing ?? removing;
  // Suggested rows lead the unfiltered first page only.
  const suggestions = filters.q || filters.cursor ? [] : ruleAssistant?.suggestions ?? [];
  const busy = Boolean(ruleAssistant?.runs.some((r) => r.status === "pending")), last = ruleAssistant?.runs[0];
  const teams = scopes.teams.map((t) => ({ id: t._id, label: t.name })), repositories = data.repositories.map((r) => ({ id: r._id, label: repositoryDisplay(r), name: r.fullName }));
  const rows: ContextRow[] = [
    ...suggestions.map((s): ContextRow => ({ id: s._id, name: `${assistantKinds[s.kind] ?? s.kind}: ${s.title}`, cells: [scopeCell(s), <TypeChip key="t" type={s.kind === "import" ? "file" : "rule"} />, "—", <span key="u" title={when(s.createdAt)}>{ago(s.createdAt)}</span>, <span key="s" className="mono-status">Suggested</span>], detail: <SuggestionReview s={s} /> })),
    ...visibleRules.map((r): ContextRow => {
      const uses = r.stats.capped ? `${r.stats.uses}+` : String(r.stats.uses), updated = r.updatedAt ?? r.createdAt;
      return {
        id: r._id, name: r.title, href: href({ rule: r._id }), badge: r.globs.length ? `${r.globs.length} ${r.globs.length === 1 ? "pattern" : "patterns"}` : undefined, selectable: isAdmin, enabled: r.enabled, current: drawer?._id === r._id,
        cells: [scopeCell(r), <TypeChip key="t" type="rule" />, `${uses} ${uses === "1" ? "use" : "uses"}`, <span key="u" title={when(updated)}>{ago(updated)}</span>, <span key="s" className="mono-status">{r.enabled ? "Active" : "Inactive"}</span>],
        detail: <div className="ctx-expansion"><p className="pre">{r.instructions}</p><div className="chip-box inline"><span className="mono-chip">severity: {r.severity}</span>{(r.globs.length ? r.globs : ["all files"]).map((g) => <span key={g} className="mono-chip">{g}</span>)}</div></div>,
      };
    }),
  ];
  return (
    <div className={drawer ? "ctx-page with-drawer" : "ctx-page"}>
      <div className="toolbar-row ctx-toolbar">
        <form method="get" action="/dashboard/context" role="search" className="search-field stack">
          {selectedTeam && <input type="hidden" name="team" value={selectedTeam._id} />}
          {requestedRepository && <input type="hidden" name="repository" value={requestedRepository} />}
          <Icon name="magnifyingGlass" />
          <label className="sr-only" htmlFor="context-search">Search context</label>
          <input id="context-search" type="search" name="q" list="rule-filters" defaultValue={filters.q} placeholder="Search context or click to add filters" maxLength={200} />
          <datalist id="rule-filters"><option value="status:active" /><option value="status:disabled" />{data.repositories.slice(0, 20).map((r) => <option key={r._id} value={`repository:${r.fullName}`} />)}</datalist>
        </form>
        {isAdmin && ruleAssistant && <PortalDisclosure className="ctx-menu" label={<><Icon name="magicWand" />Assistant<Icon name="caretDown" /></>}>
          <div className="menu">
            <p className="menu-label">Rule assistant</p>
            <form action={requestRuleAssistant} className="stack">
              <input type="hidden" name="organizationId" value={organization._id} />
              <input type="hidden" name="returnTo" value={href()} />
              <button className="menu-item" name="kind" value="refine" disabled={busy}><Icon name="listChecks" /><span>Review existing rules</span></button>
              <button className="menu-item" name="kind" value="suggest" disabled={busy}><Icon name="lightbulb" /><span>Suggest rules from findings</span></button>
            </form>
            <hr />
            <p className="menu-note">Results appear in the table as suggestions to approve.{last && <> Last run: {runKinds[last.kind] ?? last.kind} · {last.status === "pending" ? "working…" : last.status === "failed" ? last.error ?? "failed" : `${last.suggestions ?? 0} suggestion${last.suggestions === 1 ? "" : "s"}`}{(last.rejected ?? []).map((x, i) => <span key={i}> · discarded “{x.title}” ({x.reason})</span>)}</>}</p>
          </div>
        </PortalDisclosure>}
        {isAdmin && <AddContext organizationId={organization._id} returnTo={href()} open={Boolean(filters.add)} teams={teams} repositories={repositories} initialScope={requestedRepository ? "repo:" + requestedRepository : ""} busy={busy} />}
      </div>
      {busy && <p className="ctx-note" role="status"><Icon name="circleNotch" />The rule assistant is working. Refresh in a moment to review its suggestions.</p>}
      {last?.status === "failed" && !busy && <p className="ctx-note error" role="status">The last rule assistant run failed: {last.error ?? "unknown error"}</p>}
      {requestedRepository && <p className="ctx-note">Showing rules that apply to {ctx.repoName(requestedRepository)}, including inherited workspace, team and pattern rules.</p>}
      <ContextTable label="Custom rules" columns={["Rules", "Scope", "Type", "Usage", "Last updated", "Status"]} rows={rows} bulk={isAdmin ? { organizationId: organization._id } : undefined}
        empty={filters.q || filters.cursor ? "No rules match this search." : <div className="empty-state"><strong>Your codebase, your conventions</strong><p>Add specific rules such as requiring organization membership validation in API endpoints.</p></div>} />
      {rulesPage && (filters.cursor || !rulesPage.isDone) && <div className="pagination">
        <span>{visibleRules.length} {visibleRules.length === 1 ? "rule" : "rules"} on this page</span>
        <nav aria-label="Rules pagination">{filters.cursor && <Link href={href({}, "")}>Newest</Link>}{!rulesPage.isDone && <Link href={href({}, rulesPage.continueCursor)}>Older<Icon name="caretRight" /></Link>}</nav>
      </div>}
      {filters.rule && !open && <p className="ctx-note">That rule isn’t on this page. <Link href={href()}>Back to rules</Link></p>}
      {drawer && <RuleDrawer rule={drawer} edit={Boolean(editing || removing)} removing={Boolean(removing)} usage={ctx.ruleUsage} href={href} scope={scopeOf(drawer)} admin={isAdmin} organizationId={organization._id} teams={teams} repositories={repositories} repoName={ctx.repoName} usageLoaded={Boolean(open) && ruleUsage !== undefined} />}
    </div>
  );
}

// Greptile's Details drawer: read-only grey fields with Edit, or an edit form with delete / Cancel / Save;
// then Snapshot Analytics (2×2 tiles) and Recent Usage.
function RuleDrawer({ rule: r, edit, removing, usage, href, scope, admin, organizationId, teams, repositories, repoName, usageLoaded }: {
  rule: Rule; edit: boolean; removing: boolean; usage: DashboardContext["ruleUsage"]; href: (extra?: Record<string, string>) => string; scope: { icon: IconName; label: string; title?: string };
  admin: boolean; organizationId: string; teams: { id: string; label: string }[]; repositories: { id: string; label: string; name: string }[]; repoName: (id: string) => string; usageLoaded: boolean;
}) {
  const s = r.stats, rated = s.useful + s.notUseful, view = href({ rule: r._id });
  const globs = r.globs.length ? r.globs : ["auto"];
  return (
    <aside className="drawer ctx-drawer" aria-labelledby="rule-drawer-title">
      <header className="drawer-header">
        <h2 id="rule-drawer-title">Details</h2>
        {edit ? <>
          <Dialog trigger={<Icon name="trash" />} triggerLabel={`Delete ${r.title}`} triggerClassName="danger icon-only" title="Delete rule?" size="confirm" open={removing}>
            <div className="modal-body"><p>“{r.title}” stops applying to reviews. This can’t be undone; deactivate it instead to keep it.</p></div>
            <div className="modal-footer"><DialogClose>Cancel</DialogClose><RuleForm rule={r} organizationId={organizationId} returnTo={href()} remove /></div>
          </Dialog>
          <Link className="button" href={view} scroll={false}>Cancel</Link>
          <button className="primary" form="rule-edit-form">Save</button>
        </> : admin && <Link className="button primary" href={href({ rule: r._id, edit: r._id })} scroll={false}>Edit</Link>}
        <Link className="button ghost icon-only" href={href()} scroll={false} aria-label="Close details"><Icon name="x" /></Link>
      </header>
      {edit ? (
        <form id="rule-edit-form" action={saveRule} className="drawer-block ctx-fields stack">
          <input type="hidden" name="organizationId" value={organizationId} />
          <input type="hidden" name="returnTo" value={view} />
          <input type="hidden" name="id" value={r._id} />
          <input type="hidden" name="category" value={r.category} />
          <label>Title<input name="title" required maxLength={120} defaultValue={r.title} /></label>
          <div className="field-inline"><span className="field-label">Type</span><TypeChip type="rule" label /></div>
          <label>Description<textarea name="instructions" rows={6} required maxLength={10000} defaultValue={r.instructions} /></label>
          <div className="field-inline"><label htmlFor="rule-edit-severity">Severity</label><select id="rule-edit-severity" name="severity" defaultValue={r.severity}>{["critical", "high", "medium", "low"].map((v) => <option key={v}>{v}</option>)}</select></div>
          <div className="field"><span className="field-label">Scope</span><ScopeEditor id="rule-edit" initial={{ scope: scopeValue(r), pattern: r.repositoryPattern ?? "", globs: r.globs }} teams={teams} repositories={repositories} /></div>
          <div className="field-inline"><label htmlFor="rule-edit-enabled">Status</label><span className="switch-label"><input id="rule-edit-enabled" type="checkbox" className="toggle" name="enabled" value="true" defaultChecked={r.enabled} />Active</span><input type="hidden" name="enabled" value="false" /></div>
        </form>
      ) : (
        <div className="drawer-block ctx-fields">
          <div className="field"><span className="field-label">Title</span><div className="ro-field">{r.title}</div></div>
          <div className="field-inline"><span className="field-label">Type</span><TypeChip type="rule" label /></div>
          <div className="field"><span className="field-label">Description</span><div className="ro-field ro-area">{r.instructions}</div></div>
          <div className="field-inline"><span className="field-label">Severity</span><span className="badge tag">{r.severity}</span></div>
          <div className="field">
            <div className="field-inline"><span className="field-label">Scope</span><span className="badge tag">1 scope</span></div>
            <div className="scope-grid">
              <div className="field"><span className="field-sub">Repository</span><div className="ro-field" title={scope.title}><span className="value-chip">{scope.icon === "buildings" ? "all" : scope.label}</span></div></div>
              <div className="field"><span className="field-sub">File pattern</span><div className="ro-field">{globs.map((g) => <span key={g} className="value-chip">{g}</span>)}</div></div>
            </div>
          </div>
          <div className="field-inline"><span className="field-label">Status</span>{admin ? <RuleForm rule={r} organizationId={organizationId} returnTo={view} toggle /> : <span className="switch-label"><input type="checkbox" className="toggle" role="switch" checked={r.enabled} disabled readOnly aria-label="Status" />{r.enabled ? "Active" : "Inactive"}</span>}</div>
        </div>
      )}
      <div className="drawer-block">
        <h3>Snapshot Analytics</h3>
        <div className="stat-tiles">
          <div><span><Icon name="chartLine" />Acceptance rate</span><strong className="good">{pct(s.addressed, s.uses)}</strong></div>
          <div><span><Icon name="clock" />Uses this month</span><strong>{s.usesThisMonth}</strong></div>
          <div><span><Icon name="thumbsUp" />Upvote ratio</span><strong className="good">{pct(s.useful, rated)}</strong></div>
          <div><span><Icon name="thumbsDown" />Downvote ratio</span><strong className="bad">{pct(s.notUseful, rated)}</strong></div>
        </div>
      </div>
      <div className="drawer-block">
        <h3>Recent Usage</h3>
        {usageLoaded && usage.length ? <ul className="usage-list">{usage.map((f) => <li key={f._id}><Link href={`/dashboard/pulls/${f.reviewId}`}>{f.title}</Link><span>{repoName(f.repositoryId)} #{f.prNumber} · {ago(f.createdAt)} · {f.status}</span></li>)}</ul> : <p className="usage-empty">No recent usage available</p>}
      </div>
    </aside>
  );
}

// The hidden-field forms behind Delete and the Status switch: saveRule needs the whole rule.
function RuleForm({ rule: r, organizationId, returnTo, remove, toggle }: { rule: Rule; organizationId: string; returnTo: string; remove?: boolean; toggle?: boolean }) {
  return (
    <form action={saveRule} className={toggle ? "switch-label" : undefined}>
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
      {toggle && <><button className="switch" role="switch" aria-checked={r.enabled} aria-label={r.enabled ? "Deactivate rule" : "Activate rule"} />{r.enabled ? "Active" : "Inactive"}</>}
      {remove && <><input type="hidden" name="remove" value="true" /><button className="danger solid">Delete rule</button></>}
    </form>
  );
}

const assistantKinds: Record<string, string> = { draft: "Drafted rule", refine: "Tighter wording", suggest: "Suggested rule", flag: "Rule overlap", import: "Imported rule", context: "Suggested from an MCP client" };
const runKinds: Record<string, string> = { draft: "Draft", refine: "Review of existing rules", suggest: "Suggestions from fixed findings and conventions", import: "Import from AI rule files", context: "Suggestion from an MCP client" };

// A rule-assistant suggestion, expanded inline: why it was suggested, the editable rule, Approve / Dismiss.
type Suggestion = NonNullable<DashboardContext["ruleAssistant"]>["suggestions"][number];
function SuggestionReview({ s }: { s: Suggestion }) {
  return (
    <div className="ctx-expansion">
      {s.kind === "refine" && s.base && <p className="muted">Currently: <strong>{s.base.title}</strong>: {s.base.instructions}</p>}
      <p>{s.rationale}</p>
      {s.issues.length > 0 && <ul>{s.issues.map((i, n) => <li key={n}><span className="badge tag">{i.kind}</span> {i.detail}</li>)}</ul>}
      <p className="muted">Based on: {s.sources.map((x, n) => <span key={n}>{n ? "; " : ""}{x.kind === "description" ? "your description" : x.kind === "rule" ? `rule “${x.label}”` : x.kind === "file" ? <code>{x.label}</code> : `“${x.label}”`}{x.detail ? ` (${x.detail})` : ""}</span>)}</p>
      <form action={decideRuleSuggestion} className="ctx-form stack">
        <input type="hidden" name="suggestionId" value={s._id} />
        {s.kind !== "flag" && <>
          <label>Title<input name="title" required defaultValue={s.title} maxLength={120} /></label>
          <label>Instructions<textarea name="instructions" required defaultValue={s.instructions} rows={3} /></label>
          <label>Severity<select name="severity" defaultValue={s.severity}>{["critical", "high", "medium", "low"].map((v) => <option key={v}>{v}</option>)}</select></label>
        </>}
        <div className="form-actions">
          <button className="primary" name="decision" value="approved">{s.kind === "flag" ? "Disable newer" : s.kind === "refine" ? "Apply" : "Approve"}</button>
          <button name="decision" value="rejected" formNoValidate>Dismiss</button>
        </div>
      </form>
    </div>
  );
}
