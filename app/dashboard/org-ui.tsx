"use client";
import { useActionState, useState, type ComponentProps, type ReactNode } from "react";
import { ConfirmPhrase, Dialog, DialogClose, useCloseDialog } from "../ui/dialog";
import { Icon } from "../ui/icons";
import { PortalDisclosure } from "./portal-disclosure";
import { ScrollTable } from "./scroll-table";
import { changeMemberLink, inviteMember, type InviteState, type MemberLinkState } from "./actions-organization";

// Client pieces of the Organization and Personal Settings pages (Greptile's settings screens on Mobbin).

/** A ⋯ button opening a small menu of row actions. */
export function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  return <PortalDisclosure className="row-menu" label={<><Icon name="dotsThree" /><span className="sr-only">{label}</span></>}><div className="menu">{children}</div></PortalDisclosure>;
}

/** Greptile's ConfirmDialog: title, a sentence, Cancel and a solid red button that posts `action`. */
export function Confirm({ trigger, triggerClassName = "menu-item danger", title, children, action, fields, confirm }: {
  trigger: ReactNode; triggerClassName?: string; title: string; children: ReactNode;
  action: (form: FormData) => Promise<void>; fields: Record<string, string>; confirm: string;
}) {
  return <Dialog size="confirm" trigger={trigger} triggerClassName={triggerClassName} title={title}>
    <div className="modal-body"><p className="confirm-text">{children}</p></div>
    <DialogForm action={action} className="modal-footer">
      {Object.entries(fields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      <DialogClose>Cancel</DialogClose><button className="danger solid">{confirm}</button>
    </DialogForm>
  </Dialog>;
}

/** Type-to-confirm footer: the red button stays disabled until `phrase` is typed. */
export function ConfirmFooter({ phrase, name, confirm }: { phrase: string; name: string; confirm: string }) {
  return <ConfirmPhrase phrase={phrase} name={name}>{(matches) => <footer className="modal-footer"><DialogClose>Cancel</DialogClose><button className="danger solid" disabled={!matches}>{confirm}</button></footer>}</ConfirmPhrase>;
}

/** A form inside a Dialog that closes it once its server action finishes. */
export function DialogForm({ action, className, children }: { action: (form: FormData) => Promise<void>; className?: string; children: ReactNode }) {
  const close = useCloseDialog();
  return <form className={className} action={async (form) => { await action(form); close(); }}>{children}</form>;
}

/** A native select drawn as Greptile's MiniSelect (label + ⌃⌄). */
export function MiniSelect(props: ComponentProps<"select">) {
  return <span className="role-select"><select {...props} /><Icon name="caretUpDown" /></span>;
}

/** Copies `value`; the label then reads `done` (Greptile: "Copied!"). */
export function CopyButton({ value, label, done = "Copied!", className }: { value: string; label: string; done?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return <button type="button" className={`${className ?? ""}${state === "copied" ? " pressed" : ""}`} onClick={async () => { try { await navigator.clipboard.writeText(value); setState("copied"); } catch { setState("failed"); } }}>
    <Icon name={state === "copied" ? "check" : "copy"} />{state === "copied" ? done : state === "failed" ? "Copy failed; select the text" : label}
  </button>;
}

// People: the toolbar (search, role filter, Invite people) over one table of members and pending invitations.
export type PersonRow = { key: string; name: string; role: string; badges: string[]; actions?: ReactNode };
const roles = ["owner", "admin", "member", "viewer"];
const title = (role: string) => role[0].toUpperCase() + role.slice(1);
export function PeopleTable({ rows, invite }: { rows: PersonRow[]; invite?: ReactNode }) {
  const [query, setQuery] = useState(""), [role, setRole] = useState("");
  const shown = rows.filter((r) => (!role || r.role === role) && r.name.toLowerCase().includes(query.trim().toLowerCase()));
  return <>
    <div className="toolbar-row">
      <label className="search-field upright"><Icon name="magnifyingGlass" /><span className="sr-only">Search people</span><input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by email or login" /></label>
      <MiniSelect aria-label="Filter by role" value={role} onChange={(e) => setRole(e.target.value)}><option value="">All roles</option>{roles.map((r) => <option key={r} value={r}>{title(r)}</option>)}</MiniSelect>
      {invite}
    </div>
    <ScrollTable label="Workspace members table" className="table-box people-table">
      <table>
        <thead><tr><th>Member</th><th>Role</th><th>Actions</th></tr></thead>
        <tbody>
          {shown.map((r) => <tr key={r.key}>
            <td><span className="member-cell"><span className="member-initial" aria-hidden="true">{r.name.replace(/^@/, "")[0]?.toUpperCase()}</span><span className="member-name">{r.name}</span>{r.badges.map((b) => <span key={b} className="role-badge">{b}</span>)}</span></td>
            <td>{title(r.role)}</td>
            <td>{r.actions}</td>
          </tr>)}
          {!shown.length && <tr><td colSpan={3} className="table-empty">No results.</td></tr>}
        </tbody>
      </table>
    </ScrollTable>
  </>;
}

/** Greptile's "Invite people" popover: an email address or GitHub login, a role, Invite → ✓ Sent. From a team's
 *  People page the invitee also joins that team, and the role is their team role. */
export function InvitePeople({ organizationId, email, team }: { organizationId: string; email: boolean; team?: { id: string; name: string } }) {
  const [value, setValue] = useState("");
  const [state, action, pending] = useActionState(async (previous: InviteState, form: FormData) => {
    const next = await inviteMember(previous, form);
    if (next.sent) setValue("");
    return next;
  }, {});
  const sent = Boolean(state.sent) && !value;
  return <PortalDisclosure className="invite-people" label={<><Icon name="plus" />Invite people</>}>
    <div className="menu invite-panel">
      <header><h3>{team ? `Invite people to ${team.name}` : "Invite people"}</h3></header>
      <form action={action}>
        <input type="hidden" name="organizationId" value={organizationId} />
        {team && <input type="hidden" name="teamId" value={team.id} />}
        <input name="who" aria-label="Email address or GitHub login" value={value} onChange={(e) => setValue(e.target.value)} placeholder={email ? "Email address or GitHub login" : "GitHub login"} autoComplete="off" spellCheck={false} required maxLength={254} />
        <MiniSelect name="role" aria-label="Role" defaultValue="member"><option value="member">Member</option><option value="viewer">Viewer</option><option value="admin">Admin</option></MiniSelect>
        <button disabled={pending || sent || !value.trim()}>{sent ? <><Icon name="check" />Sent</> : pending ? "Inviting…" : "Invite"}</button>
      </form>
      {state.error && !pending && <p role="alert">{state.error}</p>}
      {sent && <p role="status">{state.note ?? "Invitation sent. It is listed as Pending."}</p>}
      <p className="muted">{team ? `They join ${team.name} with this team role, and the organization as a Member (a Viewer for a team Viewer). ` : ""}{email ? "An email address gets a single-use link that expires in 7 days. A GitHub login sees the invitation when that person signs in." : "The person sees the invitation when they sign in with that GitHub login. Email invitations need email delivery on this deployment."}</p>
    </div>
  </PortalDisclosure>;
}

/** Greptile's "Member link": one shareable link that joins as Member for 30 days. Only its hash is stored, so the URL
 *  shows once after Create or Reset; Reset also stops the old link. */
export function MemberLink({ organizationId, expiresAt }: { organizationId: string; expiresAt?: number }) {
  const [state, action, pending] = useActionState(changeMemberLink, {} as MemberLinkState);
  const until = state.expiresAt ?? (state.off ? undefined : expiresAt), on = Boolean(until);
  return <PortalDisclosure className="invite-people" label={<><Icon name="linkSimple" />Member link</>}>
    <div className="menu invite-panel">
      <header><h3>Member link</h3></header>
      {state.url && <p className="member-link"><input readOnly value={state.url} aria-label="Member link" onFocus={(e) => e.target.select()} /><CopyButton value={state.url} label="Copy" /></p>}
      <form action={action}>
        <input type="hidden" name="organizationId" value={organizationId} />
        <button name="op" value="create" disabled={pending}>{on ? "Reset link" : "Create link"}</button>
        {on && <button name="op" value="disable" className="danger" disabled={pending}>Disable</button>}
      </form>
      {state.error && !pending && <p role="alert">{state.error}</p>}
      <p className="muted">{state.url ? "Copy it now: the link is shown only once. " : on ? "A link is active. Reset it to get a new copy; the old one stops working. " : ""}{until ? `It expires ${new Date(until).toLocaleDateString("en-US", { timeZone: "UTC", dateStyle: "medium" })}. ` : "A new link lasts 30 days. "}Anyone with the link can join this organization as a Member, which uses a seat.</p>
    </div>
  </PortalDisclosure>;
}
