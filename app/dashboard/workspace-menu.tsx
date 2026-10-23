"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Icon } from "../ui/icons";
import { createWorkspace, switchTeam, switchWorkspace } from "./actions";
import { PortalDisclosure } from "./portal-disclosure";

// Workspace and team switcher in the app header. It lives in the persistent portal layout, so the
// selected team and the return path come from the URL rather than from page params.
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
  return <PortalDisclosure className="scope-selector" label={<><span className="scope-name">{name}{selected && " / " + selected.name}</span><span className="badge">{role[0].toUpperCase() + role.slice(1)}</span><Icon name="caretUpDown" /></>}>
    <div className="scope-menu">
      <form action={switchWorkspace}><label className="sr-only" htmlFor="workspace">Workspace</label><select key={organizationId} id="workspace" name="organizationId" defaultValue={organizationId}>{organizations.map(o => <option key={o._id} value={o._id}>{o.name}</option>)}</select><button className="small">Switch workspace</button></form>
      <form action={switchTeam}><label htmlFor="scope-team">Team</label><select key={organizationId+":"+(selected?._id??"")} id="scope-team" name="teamId" defaultValue={selected?._id??""}><option value="">All accessible teams</option>{teams.map(t=><option key={t._id} value={t._id}>{t.name}</option>)}</select><input type="hidden" name="returnTo" value={returnTo}/><button className="small">Apply team</button></form>
      <p className="muted">Team selection filters repository activity. Workspace administration applies across the workspace.</p>
      <form action={createWorkspace}><label>New workspace name<input name="name" required maxLength={100}/></label><button>Create workspace</button></form>
    </div>
  </PortalDisclosure>;
}
