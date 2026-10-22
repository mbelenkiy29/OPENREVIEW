"use client";
import { useActionState } from "react";
import { createApiKey } from "./actions";
// perforceOnly: the plan lacks API access, so only a Perforce key (which works on every plan) can be created.
export function ApiKeyForm({ organizationId, perforceOnly = false }: { organizationId: string; perforceOnly?: boolean }) {
  const [value, action, pending] = useActionState(createApiKey, "");
  return (
    <>
      <form action={action}>
        <input type="hidden" name="organizationId" value={organizationId} />
        <label>
          API key name
          <input name="name" required maxLength={100} />
        </label>
        <label>
          Scope
          <select name="scope" defaultValue={perforceOnly ? "perforce" : "read"}>
            {!perforceOnly && <>
              <option value="read">Read: query, search, repositories and reviews</option>
              <option value="write">Write: also request reviews, feedback and enable repositories</option>
              <option value="admin">Admin: also administrator endpoints such as Perforce indexing</option>
            </>}
            <option value="perforce">Perforce only: the P4 watcher and uploads, on every plan</option>
          </select>
        </label>
        <button disabled={pending}>Generate API key</button>
      </form>
      {value && (
        <div role="status">
          <p>Copy this key now. It will not be shown again.</p>
          <pre>{value}</pre>
        </div>
      )}
    </>
  );
}
