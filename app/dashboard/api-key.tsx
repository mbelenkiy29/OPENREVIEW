"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import { Dialog, DialogClose } from "../ui/dialog";
import { Icon } from "../ui/icons";
import { createApiKey, revokeApiKey } from "./actions";
import { ScrollTable } from "./scroll-table";
import { Confirm, CopyButton, RowMenu } from "./org-ui";

export type ApiKeyRow = { _id: string; name: string; prefix: string; revoked: boolean; createdAt: number; scopes: string[]; legacy: boolean; perforce: boolean };
const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { timeZone: "UTC", dateStyle: "medium" });
const scope = (k: ApiKeyRow) => k.perforce ? "Perforce only" : k.legacy ? "All scopes (created before scopes)" : k.scopes.join(", ");

// Organization Settings → API Keys, as on Greptile: search + Create API Key over a NAME / ID / CREATED table.
// perforceOnly: the plan lacks API access, so only a Perforce key (which works on every plan) can be created.
export function ApiKeys({ keys, organizationId, perforceOnly = false }: { keys: ApiKeyRow[]; organizationId: string; perforceOnly?: boolean }) {
  const [query, setQuery] = useState(""), [sort, setSort] = useState<"name" | "-name" | "created" | "-created">("-created");
  const shown = keys.filter((k) => k.name.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) =>
    sort.endsWith("name") ? a.name.localeCompare(b.name) * (sort === "name" ? 1 : -1) : (a.createdAt - b.createdAt) * (sort === "created" ? 1 : -1));
  const header = (key: "name" | "created", label: string) => {
    const active = sort.endsWith(key), descending = sort === "-" + key;
    return <th aria-sort={active ? (descending ? "descending" : "ascending") : undefined}><button type="button" className="sort-button" onClick={() => setSort(active && descending ? key : `-${key}`)}>{label}<span className="sort-caret"><Icon name={active ? (descending ? "arrowDown" : "caretUp") : "caretUpDown"} /></span></button></th>;
  };
  return <>
    <div className="toolbar-row">
      <label className="search-field upright"><Icon name="magnifyingGlass" /><span className="sr-only">Search API keys</span><input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name…" /></label>
      <Dialog trigger={<><Icon name="plus" />Create API Key</>} triggerClassName="primary" title="Create API Key"><CreateKey organizationId={organizationId} perforceOnly={perforceOnly} /></Dialog>
    </div>
    <ScrollTable label="API keys table" className="table-box keys-table">
      <table>
        <thead><tr>{header("name", "Name")}<th>ID</th><th>Scope</th>{header("created", "Created")}<th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {shown.map((k) => <tr key={k._id} className={k.revoked ? "revoked" : undefined}>
            <td>{k.name}{k.revoked && <span className="role-badge">Revoked</span>}</td>
            <td><code>{k.prefix}…</code></td>
            <td>{scope(k)}</td>
            <td>{day(k.createdAt)}</td>
            <td>{!k.revoked && <RowMenu label={`Actions for ${k.name}`}>
              <Confirm trigger="Revoke key" title="Revoke API key" action={revokeApiKey} fields={{ keyId: k._id }} confirm="Revoke key">
                Revoke <strong>{k.name}</strong> (<code>{k.prefix}…</code>)? Anything using it stops working right away. This cannot be undone.
              </Confirm>
            </RowMenu>}</td>
          </tr>)}
          {!shown.length && <tr><td colSpan={5} className="table-empty">No results.</td></tr>}
        </tbody>
      </table>
    </ScrollTable>
  </>;
}

// The Create API Key modal: a name and scope, then the one-time reveal with Copy API Key.
function CreateKey({ organizationId, perforceOnly }: { organizationId: string; perforceOnly: boolean }) {
  const [value, action, pending] = useActionState(createApiKey, "");
  // A key shown once stays hidden after the modal closes, so reopening starts a new key.
  const [closed, setClosed] = useState(""), ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dialog = ref.current?.closest("dialog"), hide = () => setClosed(value);
    dialog?.addEventListener("close", hide);
    return () => dialog?.removeEventListener("close", hide);
  }, [value]);
  const key = value !== closed ? value : "";
  return <div ref={ref}>{key ? <div className="modal-body" role="status">
    <label>API Key<input readOnly value={key} onFocus={(e) => e.currentTarget.select()} /></label>
    <p className="muted">Copy this key now — it won’t be shown again.</p>
    <footer className="modal-footer split"><CopyButton key={key} value={key} label="Copy API Key" /></footer>
  </div> : <form action={action} className="modal-body">
    <input type="hidden" name="organizationId" value={organizationId} />
    <label>Name<input name="name" required maxLength={100} autoComplete="off" /></label>
    <label>Scope
      <select name="scope" defaultValue={perforceOnly ? "perforce" : "read"}>
        {!perforceOnly && <>
          <option value="read">Read: query, search, repositories and reviews</option>
          <option value="write">Write: also request reviews, feedback and enable repositories</option>
          <option value="admin">Admin: also administrator endpoints such as Perforce indexing</option>
        </>}
        <option value="perforce">Perforce only: the P4 watcher and uploads, on every plan</option>
      </select>
    </label>
    <footer className="modal-footer"><DialogClose>Cancel</DialogClose><button disabled={pending}>{pending ? "Creating…" : "Create"}</button></footer>
  </form>}</div>;
}
