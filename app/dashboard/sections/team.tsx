import { api } from "../../../convex/_generated/api";
import { backend } from "../../../src/server";
import { emailOnWeb } from "../../../src/email";
import { revokeEmailInvitation, updateMember } from "../actions";
import { answerJoinRequest } from "../actions-organization";
import { InvitationForm } from "../invitation-form";
import { Dialog } from "../../ui/dialog";
import { Confirm, DialogForm, InvitePeople, MemberLink, MiniSelect, PeopleTable, RowMenu, type PersonRow } from "../org-ui";
import type { DashboardContext } from "../load";

const expires = (ms: number) => `Expires ${new Date(ms).toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC`;
// Organization Settings → People: Greptile's toolbar and one table of join requests, members, GitHub-login
// invitations and email invitations (pending first). Admins get Member link, Invite people and a ⋯ menu per row;
// team admins see and answer their teams' join requests.
export async function TeamSection({ ctx }: { ctx: DashboardContext }) {
  const { data, filters, isAdmin, joinRequests, organization, pendingInvitations, user } = ctx;
  const [emails, memberLink] = isAdmin ? await Promise.all([backend().query(api.identity.emailInvitations, { token: user.token, organizationId: organization._id }), backend().query(api.identity.memberLink, { token: user.token, organizationId: organization._id })]) : [[], null];
  const rows: PersonRow[] = [
    ...joinRequests.map((r) => ({ key: r._id, name: "@" + r.login, role: "member", badges: [`Requested ${r.team}`], actions: <RowMenu label={`Answer @${r.login}’s request to join ${r.team}`}><p className="menu-label">Asked to join {r.team}</p><form action={answerJoinRequest} className="stack"><input type="hidden" name="requestId" value={r._id} /><button className="menu-item" name="approve" value="true">Approve as Member</button><button className="menu-item danger" name="approve" value="false">Decline</button></form></RowMenu> })),
    ...pendingInvitations.map((i) => ({ key: i._id, name: "@" + i.githubLogin, role: i.role, badges: ["Pending"], actions: <RowMenu label={`Actions for the invitation to @${i.githubLogin}`}><p className="menu-label">{expires(i.expiresAt)}</p><InvitationForm id={i._id} label={`Revoke invitation for ${i.githubLogin}`} text="Revoke invitation" className="menu-item danger" revoke /></RowMenu> })),
    ...emails.map((i) => ({ key: i._id, name: i.email, role: i.role, badges: ["Pending"], actions: <RowMenu label={`Actions for the invitation to ${i.email}`}><p className="menu-label">{expires(i.expiresAt)}</p><form action={revokeEmailInvitation}><input type="hidden" name="invitationId" value={i._id} /><button className="menu-item danger" aria-label={`Revoke invitation for ${i.email}`}>Revoke invitation</button></form></RowMenu> })),
    ...data.members.map((m) => {
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
    }),
  ];
  return <>
    {filters.emailInvite === "sent" && <p role="status" className="notice-banner">Invitation sent.</p>}
    {filters.emailInvite === "error" && <p role="alert" className="notice-banner">The invitation could not be sent. Check the address and email configuration.</p>}
    <PeopleTable rows={rows} invite={isAdmin && <><MemberLink organizationId={organization._id} active={Boolean(memberLink)} /><InvitePeople organizationId={organization._id} email={emailOnWeb()} /></>} />
    {isAdmin && <p className="muted table-note">Invitees see GitHub-login invitations when they sign in with that GitHub identity; inviting a login again replaces its previous invitation. Email invitations are single-use links that expire in 7 days.</p>}
  </>;
}
