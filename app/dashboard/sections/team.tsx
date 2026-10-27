import { api } from "../../../convex/_generated/api";
import { backend } from "../../../src/server";
import { emailOnWeb } from "../../../src/email";
import { revokeEmailInvitation, teamMember, updateMember } from "../actions";
import { answerJoinRequest } from "../actions-organization";
import { InvitationForm } from "../invitation-form";
import { Dialog } from "../../ui/dialog";
import { Icon } from "../../ui/icons";
import { PortalDisclosure } from "../portal-disclosure";
import { Confirm, DialogForm, InvitePeople, MemberLink, MiniSelect, PeopleTable, RowMenu, type PersonRow } from "../org-ui";
import type { DashboardContext } from "../load";

const expires = (ms: number) => `Expires ${new Date(ms).toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC`;
const teamRoles = <><option value="member">Member</option><option value="viewer">Viewer</option><option value="admin">Admin</option></>;
// Organization Settings → People: Greptile's toolbar and one table of join requests, members, GitHub-login
// invitations and email invitations (pending first). Admins get Member link, Invite people and a ⋯ menu per row;
// team admins see and answer their teams' join requests. With a team picked in the switcher (Greptile: Settings
// follow the breadcrumb's team) the table is that team's: team roles, Add to team, and invites that join the team,
// managed by org admins and that team's admins.
export async function TeamSection({ ctx }: { ctx: DashboardContext }) {
  const { data, filters, isAdmin, joinRequests, organization, pendingInvitations, scopes, selectedTeam: team, user } = ctx;
  const [emails, memberLink] = isAdmin ? await Promise.all([backend().query(api.identity.emailInvitations, { token: user.token, organizationId: organization._id }), backend().query(api.identity.memberLink, { token: user.token, organizationId: organization._id })]) : [[], null];
  const inTeam = <T extends { teamId?: string }>(rows: T[]) => team ? rows.filter((r) => r.teamId === team._id) : rows;
  const login = (userId: string) => data.members.find((m) => m.userId === userId)?.user?.login ?? userId;
  const crew = team ? scopes.members.find((m) => m.teamId === team._id)?.members ?? [] : [];
  const teamAdmin = isAdmin || crew.some((m) => m.userId === user.user._id && m.role === "admin");
  const rows: PersonRow[] = [
    ...inTeam(joinRequests).map((r) => ({ key: r._id, name: "@" + r.login, role: "member", badges: [`Requested ${r.team}`], actions: <RowMenu label={`Answer @${r.login}’s request to join ${r.team}`}><p className="menu-label">Asked to join {r.team}</p><form action={answerJoinRequest} className="stack"><input type="hidden" name="requestId" value={r._id} /><button className="menu-item" name="approve" value="true">Approve as Member</button><button className="menu-item danger" name="approve" value="false">Decline</button></form></RowMenu> })),
    ...inTeam(pendingInvitations).map((i) => ({ key: i._id, name: "@" + i.githubLogin, role: i.role, badges: ["Pending"], actions: <RowMenu label={`Actions for the invitation to @${i.githubLogin}`}><p className="menu-label">{expires(i.expiresAt)}</p><InvitationForm id={i._id} label={`Revoke invitation for ${i.githubLogin}`} text="Revoke invitation" className="menu-item danger" revoke /></RowMenu> })),
    ...inTeam(emails).map((i) => ({ key: i._id, name: i.email, role: i.role, badges: ["Pending"], actions: <RowMenu label={`Actions for the invitation to ${i.email}`}><p className="menu-label">{expires(i.expiresAt)}</p><form action={revokeEmailInvitation}><input type="hidden" name="invitationId" value={i._id} /><button className="menu-item danger" aria-label={`Revoke invitation for ${i.email}`}>Revoke invitation</button></form></RowMenu> })),
    ...(team ? crew.map((m) => ({ key: m._id, name: "@" + login(m.userId), role: m.role, badges: m.userId === user.user._id ? ["You"] : [], actions: teamAdmin && <RowMenu label={`Actions for @${login(m.userId)} in ${team.name}`}>
      <Dialog size="confirm" trigger="Change team role" triggerClassName="menu-item" title={`Change @${login(m.userId)}’s role in ${team.name}`}>
        <DialogForm action={teamMember} className="modal-body confirm-form">
          <input type="hidden" name="teamId" value={team._id} /><input type="hidden" name="userId" value={m.userId} />
          <label>Team role<MiniSelect name="role" defaultValue={m.role} aria-label={`Team role for ${login(m.userId)}`}>{teamRoles}</MiniSelect></label>
          <p className="muted">Team admins manage this team’s people. Team viewers can read its repositories but not change them.</p>
          <footer className="modal-footer"><button className="primary">Save role</button></footer>
        </DialogForm>
      </Dialog>
      <Confirm trigger="Remove from team" title="Remove from team" action={teamMember} fields={{ teamId: team._id, userId: m.userId, role: m.role, remove: "true" }} confirm="Remove from team">
        Remove <strong>@{login(m.userId)}</strong> from {team.name}? They stay in {organization.name} but lose access to this team’s repositories.
      </Confirm>
    </RowMenu> }))
    : data.members.map((m) => {
      const login = m.user?.login ?? m.userId;
      return { key: m._id, name: "@" + login, role: m.role, badges: m.userId === user.user._id ? ["You"] : [], actions: isAdmin && <RowMenu label={`Actions for @${login}`}>
        <Dialog size="confirm" trigger="Change role" triggerClassName="menu-item" title={`Change role for @${login}`}>
          <DialogForm action={updateMember} className="modal-body confirm-form">
            <input type="hidden" name="memberId" value={m._id} />
            <label>Role<MiniSelect name="role" defaultValue={m.role} aria-label={`Role for ${login}`}><option value="member">Member</option><option value="viewer">Viewer</option><option value="admin">Admin</option>{organization.role === "owner" && <option value="owner">Owner</option>}</MiniSelect></label>
            <p className="muted">Viewers are free and can’t change settings or start fixes. Admins manage members, billing and settings.</p>
            <footer className="modal-footer"><button className="primary">Save role</button></footer>
          </DialogForm>
        </Dialog>
        <Confirm trigger="Remove member" title="Remove member" action={updateMember} fields={{ memberId: m._id, role: m.role, remove: "true" }} confirm="Remove member">
          Remove <strong>@{login}</strong> from {organization.name}? They lose access right away, are signed out everywhere, and their API keys and bridges for this workspace are revoked.
        </Confirm>
      </RowMenu> };
    })),
  ];
  const outside = team ? data.members.filter((m) => !crew.some((c) => c.userId === m.userId)) : [];
  const addToTeam = team && teamAdmin && outside.length > 0 && <PortalDisclosure className="invite-people" label={<><Icon name="plus" />Add to team</>}>
    <div className="menu invite-panel">
      <header><h3>Add to {team.name}</h3></header>
      <form action={teamMember}>
        <input type="hidden" name="teamId" value={team._id} />
        <MiniSelect name="userId" aria-label="Organization member">{outside.map((m) => <option key={m.userId} value={m.userId}>@{m.user?.login ?? m.userId}</option>)}</MiniSelect>
        <MiniSelect name="role" aria-label="Team role" defaultValue="member">{teamRoles}</MiniSelect>
        <button>Add</button>
      </form>
      <p className="muted">People already in {organization.name}. Invite someone new to add them to the organization and this team.</p>
    </div>
  </PortalDisclosure>;
  return <>
    {filters.emailInvite === "sent" && <p role="status" className="notice-banner">Invitation sent.</p>}
    {filters.emailInvite === "error" && <p role="alert" className="notice-banner">The invitation could not be sent. Check the address and email configuration.</p>}
    {team && <p className="muted table-note">Showing <strong>{team.name}</strong> with team roles; organization admins see every team. Pick All accessible teams in the organization menu for everyone in {organization.name}.</p>}
    <PeopleTable rows={rows} invite={team ? <>{addToTeam}{isAdmin && <InvitePeople organizationId={organization._id} email={emailOnWeb()} team={{ id: team._id, name: team.name }} />}</>
      : isAdmin && <><MemberLink organizationId={organization._id} expiresAt={memberLink?.expiresAt} /><InvitePeople organizationId={organization._id} email={emailOnWeb()} /></>} />
    {isAdmin && <p className="muted table-note">Invitees see GitHub-login invitations when they sign in with that GitHub identity; inviting a login again replaces its previous invitation. Email invitations are single-use links that expire in 7 days.</p>}
  </>;
}
