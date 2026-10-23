"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Icon, type IconName } from "../ui/icons";
import { setRepositoriesEnabled } from "./actions-repositories";

type Repo = { id: string; name: string; icon: IconName; enabled: boolean; unavailable: boolean };
const pageSize = 8;

// Repo Settings (Manage Repos): Enabled | Disabled tabs, a checkbox table and bulk enable/disable.
export function ManageRepos({ repos }: { repos: Repo[] }) {
  const [tab, setTab] = useState<"enabled" | "disabled">("enabled"), [query, setQuery] = useState(""), [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const inTab = repos.filter((r) => r.enabled === (tab === "enabled"));
  const shown = inTab.filter((r) => r.name.toLowerCase().includes(query.trim().toLowerCase()));
  const pages = Math.max(1, Math.ceil(shown.length / pageSize)), current = Math.min(page, pages);
  const rows = shown.slice((current - 1) * pageSize, current * pageSize);
  const selectable = shown.filter((r) => !r.unavailable), chosen = inTab.filter((r) => selected.has(r.id));
  const all = selectable.length > 0 && selectable.every((r) => selected.has(r.id)), some = !all && selectable.some((r) => selected.has(r.id));
  const verb = tab === "enabled" ? "Disable" : "Enable";
  const toggle = (ids: string[], on: boolean) => setSelected((prev) => { const next = new Set(prev); for (const id of ids) if (on) next.add(id); else next.delete(id); return next; });
  const switchTab = (next: typeof tab) => { setTab(next); setSelected(new Set()); setPage(1); };
  // Real forms, so the toaster sees the submit; the new counts arrive with the revalidated page.
  const act = async (form: FormData) => { await setRepositoriesEnabled(form); setSelected(new Set()); };
  const usable = inTab.filter((r) => !r.unavailable), enabled = String(tab === "disabled");
  return <div className="modal-body manage-repos">
    <div className="search-field"><Icon name="magnifyingGlass" /><input type="search" aria-label="Search repositories" placeholder="Search repositories..." value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} /></div>
    <div className="segmented" role="group" aria-label="Repository status">
      <button type="button" aria-pressed={tab === "enabled"} onClick={() => switchTab("enabled")}>Enabled ({repos.filter((r) => r.enabled).length})</button>
      <button type="button" aria-pressed={tab === "disabled"} onClick={() => switchTab("disabled")}>Disabled ({repos.filter((r) => !r.enabled).length})</button>
    </div>
    <div className="table-box">
      <table>
        <thead><tr>
          <th className="check-col"><input type="checkbox" aria-label="Select all repositories" checked={all} ref={(el) => { if (el) el.indeterminate = some; }} disabled={!selectable.length} onChange={(e) => toggle(selectable.map((r) => r.id), e.target.checked)} /></th>
          <th scope="col">Repository</th>
        </tr></thead>
        <tbody>
          {rows.map((r) => <tr key={r.id}>
            <td className="check-col"><input type="checkbox" aria-label={`Select ${r.name}`} checked={selected.has(r.id)} disabled={r.unavailable} onChange={(e) => toggle([r.id], e.target.checked)} /></td>
            <td><span className="repo-title"><Icon name={r.icon} /><span className="repo-link">{r.name}</span>{r.unavailable && <span className="status-chip">Unavailable</span>}</span></td>
          </tr>)}
          {!rows.length && <tr><td colSpan={2} className="no-results">{query ? "No results." : `No ${tab} repositories.`}</td></tr>}
        </tbody>
      </table>
    </div>
    {pages > 1 && <nav className="pagination modal-pager" aria-label="Repository pages">
      <button type="button" aria-label="Previous page" disabled={current === 1} onClick={() => setPage(current - 1)}><Icon name="caretLeft" /></button>
      <span>{Array.from({ length: pages }, (_, i) => i + 1).map((n) => <button type="button" key={n} aria-current={n === current ? "page" : undefined} onClick={() => setPage(n)}>{n}</button>)}</span>
      <button type="button" aria-label="Next page" disabled={current === pages} onClick={() => setPage(current + 1)}><Icon name="caretRight" /></button>
    </nav>}
    <div className="modal-footer">
      <form action={act}><input type="hidden" name="enabled" value={enabled} />{chosen.map((r) => <input key={r.id} type="hidden" name="repositoryId" value={r.id} />)}<Submit primary disabled={!chosen.length}>{chosen.length ? `${verb} ${chosen.length} ${chosen.length === 1 ? "Repo" : "Repos"}` : `${verb} Repos`}</Submit></form>
      <form action={act}><input type="hidden" name="enabled" value={enabled} />{usable.map((r) => <input key={r.id} type="hidden" name="repositoryId" value={r.id} />)}<Submit disabled={!usable.length}>{verb} All</Submit></form>
    </div>
  </div>;
}

function Submit({ primary, disabled, children }: { primary?: boolean; disabled: boolean; children: ReactNode }) {
  const { pending } = useFormStatus();
  return <button className={primary ? "primary" : undefined} disabled={disabled || pending}>{pending ? "Saving…" : children}</button>;
}

type Pull = { number: number; title: string; created: string; updated: string; href: string };
// "Pull Requests for owner/repo": the repository's reviewed pull requests, searchable in place.
export function RepoPulls({ pulls, all }: { pulls: Pull[]; all: string }) {
  const [query, setQuery] = useState(""), q = query.trim().toLowerCase().replace(/^#/, "");
  const shown = pulls.filter((p) => !q || p.title.toLowerCase().includes(q) || String(p.number).startsWith(q));
  return <div className="modal-body repo-pulls">
    <div className="search-field"><Icon name="magnifyingGlass" /><input type="search" aria-label="Search Pull Requests" placeholder="Search Pull Requests" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
    <ul className="pr-list">
      {shown.map((p) => <li key={p.number}><Link href={p.href}><strong><span>#{p.number}</span>{p.title}</strong><small><span>Created: {p.created}</span><span>Updated: {p.updated}</span></small></Link></li>)}
    </ul>
    {!shown.length && <p className="no-results">{pulls.length ? "No results." : "OpenReview hasn’t reviewed a pull request in this repository yet."}</p>}
    <div className="pr-footer"><Link href={all}>View in Pull Requests<Icon name="arrowRight" /></Link><span>{shown.length} reviewed pull {shown.length === 1 ? "request" : "requests"} found</span></div>
  </div>;
}
