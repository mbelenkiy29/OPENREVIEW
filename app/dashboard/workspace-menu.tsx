"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Icon } from "../ui/icons";
import { Dialog, DialogClose } from "../ui/dialog";
import { createWorkspace, switchTeam, switchWorkspace } from "./actions";
import { PortalDisclosure } from "./portal-disclosure";

// Greptile's organization switcher: the name (and "/ team"), a role badge and ⇅; its menu lists the organizations,
// the teams (GitHub organizations) that scope every page, "Join a team" and "Add organization". It lives in the
// persistent portal layout, so the selected team and the return path come from the URL rather than from page params.
export function WorkspaceMenu({ organizationId, name, role, organizations, teams, savedTeam }: {
  organizationId: string;
  name: string;
  role: string;
  organizations: { _id: string; name: string }[];
  teams: { _id: string; name: string }[];
  savedTeam?: string;
}) {
  const pathname = usePathname(), team = useSearchParams().get("team");
  const selected = teams.find((t) => t._id === (team ?? savedTeam));
  // A review page returns to the pull request list; the server accepts only known dashboard paths.
  const returnTo = pathname.startsWith("/dashboard/pulls/") ? "/dashboard/pulls" : pathname;
  return <PortalDisclosure className="scope-selector" label={<><span className="scope-name">{name}{selected && " / " + selected.name}</span><span className="role-badge">{role[0].toUpperCase() + role.slice(1)}</span><Icon name="caretUpDown" /><span className="sr-only">Switch organization or team</span></>}>
    <div className="menu org-menu">
      {organizations.map((o) => <form key={o._id} action={switchWorkspace}>
        <input type="hidden" name="organizationId" value={o._id} />
        <button className="menu-item" aria-current={o._id === organizationId ? "true" : undefined}><Icon name="buildings" /><span>{o.name}</span>{o._id === organizationId && <Icon name="check" />}</button>
      </form>)}
      {teams.length > 0 && <form action={switchTeam} aria-label="Team" className="stack">
        <hr />
        <p className="menu-label">Team</p>
        <input type="hidden" name="returnTo" value={returnTo} />
        {[{ _id: "", name: "All accessible teams" }, ...teams].map((t) => <button key={t._id} className="menu-item" name="teamId" value={t._id} aria-current={(selected?._id ?? "") === t._id ? "true" : undefined}><Icon name="usersThree" /><span>{t.name}</span>{(selected?._id ?? "") === t._id && <Icon name="check" />}</button>)}
      </form>}
      <hr />
      <Link className="menu-item muted" href="/dashboard/account#join-a-team"><Icon name="usersThree" /><span>Join a team</span></Link>
      <Dialog trigger={<><Icon name="plus" /><span>Add organization</span></>} triggerClassName="menu-item muted" title="Create Organization" description="A new organization is a separate workspace with its own plan and billing. Members, teams, repositories and settings from this organization don’t carry over.">
        <form action={createWorkspace} className="modal-body">
          <label>Organization name<input name="name" required maxLength={100} placeholder="Acme" autoComplete="organization" /></label>
          <footer className="modal-footer"><DialogClose>Cancel</DialogClose><button className="primary">Create Organization</button></footer>
        </form>
      </Dialog>
    </div>
  </PortalDisclosure>;
}
