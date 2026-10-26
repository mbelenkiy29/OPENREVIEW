import type { Id } from "../../convex/_generated/dataModel";
import { InvitationForm } from "./invitation-form";

// Invitations to other workspaces, above every dashboard page until accepted or expired.
export function WorkspaceInvitations({invitations}:{invitations:{_id:Id<"invitations">;workspaceName:string;role:string;expiresAt:number}[]}) {
  if(!invitations.length)return null;
  return <section aria-label="Workspace invitations" className="workspace-invitations"><h2 className="sr-only">Workspace invitations</h2>{invitations.map(i=><InvitationForm id={i._id} label={`Accept invitation to ${i.workspaceName}`} className="primary small" key={i._id}>
    <p><strong>You’re invited to {i.workspaceName}</strong> as {i.role} · Expires {new Date(i.expiresAt).toLocaleString("en-US",{timeZone:"UTC"})} UTC</p>
  </InvitationForm>)}</section>;
}
