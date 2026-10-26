"use client";
import {useActionState} from "react";
import type {ReactNode} from "react";
import type {Id} from "../../convex/_generated/dataModel";
import {acceptInvitation,revokeInvitation} from "./actions";

// `text` shortens the visible label (a menu item); `label` stays the accessible name.
export function InvitationForm({id,label,text,className,revoke=false,children}:{id:Id<"invitations">;label:string;text?:string;className?:string;revoke?:boolean;children?:ReactNode}) {
 const [state,action,pending]=useActionState(revoke?revokeInvitation:acceptInvitation,{});
 return <form action={action} className={className?undefined:"toolbar"}>
  <input type="hidden" name="invitationId" value={id}/>{children}
  <button disabled={pending} className={className} aria-label={text?label:undefined}>{pending?(revoke?"Revoking…":"Joining…"):text??label}</button>
  {state.error&&<p role="alert">{state.error}</p>}
 </form>;
}
