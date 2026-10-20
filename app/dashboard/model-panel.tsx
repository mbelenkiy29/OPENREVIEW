import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend } from "../../src/server";
import { setWorkspaceModel } from "./actions";
import { ModelSelect } from "./model-select";

// Settings → AI Model: which model the membership pays for. Admins pick; everyone sees the choice.
export async function ModelPanel({ token, organizationId, admin }: { token: string; organizationId: Id<"organizations">; admin: boolean }) {
  const c = await backend().query(api.scopes.modelChoice, { token, organizationId });
  const fallback = `OpenReview default${c.defaultModel ? ` (${c.defaultModel})` : ""}`;
  return <section aria-labelledby="model-heading">
    <h2 id="model-heading">AI model</h2>
    {c.ownKey
      ? <p>This workspace uses its own model provider key, so its model is set with the key in Settings → API Keys and its usage is billed by that provider.</p>
      : <>
        <p>Reviews, chat, Slack answers and fixes use this model, paid from the workspace&apos;s monthly usage. Pricier models use it faster. Teams and repositories can override it under Teams &amp; Inheritance and Code Review.</p>
        {admin
          ? <form action={setWorkspaceModel} className="filter-bar"><input type="hidden" name="organizationId" value={organizationId} /><label>Model<ModelSelect name="model" value={c.model ?? ""} models={c.models} empty={fallback} /></label><button className="primary">Save model</button></form>
          : <p>Current model: <strong>{c.model ?? fallback}</strong>. Only workspace owners and admins can change it.</p>}
      </>}
  </section>;
}
