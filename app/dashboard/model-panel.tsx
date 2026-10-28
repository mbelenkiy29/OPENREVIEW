import Link from "next/link";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend } from "../../src/server";
import { Icon } from "../ui/icons";
import { setWorkspaceModel } from "./actions";
import { ModelSelect } from "./model-select";
import { Row, SettingsHeading } from "./settings-ui";

// Code Review Settings → AI Model: which model the membership pays for. Admins pick; everyone sees the choice.
export async function ModelPanel({ token, organizationId, admin }: { token: string; organizationId: Id<"organizations">; admin: boolean }) {
  const c = await backend().query(api.scopes.modelChoice, { token, organizationId });
  const fallback = `OpenReview default${c.defaultModel ? ` (${c.defaultModel})` : ""}`;
  const help = <>Pricier models use the monthly usage faster. Teams and repositories can override it under <Link href="/dashboard/organization/teams">Teams &amp; Inheritance</Link> and <Link href="/dashboard/code-review">Code Review</Link>.</>;
  return <div className="review-settings" role="region" aria-labelledby="model-heading">
    <SettingsHeading id="model-heading" icon="cpu" title="Workspace Model" sub="Reviews, chat, Slack answers and fixes use this model, paid from the workspace’s monthly usage." />
    {c.ownKey
      ? <p className="notice-banner"><Icon name="key" /><span>This workspace uses its own model provider key, so its model is set with the key in <Link href="/dashboard/organization/api-keys">Organization Settings → API Keys</Link> and its usage is billed by that provider.</span></p>
      : admin
        ? <form action={setWorkspaceModel} className="stack settings-card"><input type="hidden" name="organizationId" value={organizationId} />
          <Row id="workspace-model" title="Model" help={help}><ModelSelect id="workspace-model" name="model" value={c.model ?? ""} models={c.models} empty={fallback} /></Row>
          <div className="card-footer"><button className="primary">Save model</button></div>
        </form>
        : <div className="settings-card"><Row title="Model" help="Only workspace owners and admins can change it."><strong className="row-value">{c.model ?? fallback}</strong></Row></div>}
  </div>;
}
