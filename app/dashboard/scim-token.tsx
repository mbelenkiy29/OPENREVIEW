"use client";
import { useActionState } from "react";
import { createScimToken } from "./actions";
import { CopyButton } from "./org-ui";

// Creates a SCIM token and shows it once, like an API key.
export function CreateScimToken({ organizationId }: { organizationId: string }) {
  const [value, action, pending] = useActionState(createScimToken, "");
  return value ? <div role="status" className="form-grid">
    <label className="wide">SCIM token<input readOnly value={value} onFocus={(e) => e.currentTarget.select()} /></label>
    <p className="muted wide">Copy this token now — it won’t be shown again.</p>
    <div className="wide setting-actions"><CopyButton value={value} label="Copy SCIM token" /></div>
  </div> : <form action={action}><input type="hidden" name="organizationId" value={organizationId} /><button disabled={pending}>Create SCIM token</button></form>;
}
