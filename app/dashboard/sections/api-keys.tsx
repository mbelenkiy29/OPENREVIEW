import { revokeMcpConnection, saveModelKey, removeModelKey } from "../actions";
import { ApiKeys } from "../api-key";
import { Locked } from "../locked";
import { Confirm, RowMenu } from "../org-ui";
import { ScrollTable } from "../scroll-table";
import type { DashboardContext } from "../load";

const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { timeZone: "UTC", dateStyle: "medium" });
const providers = { anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter" };
// Organization Settings → API Keys: developer API keys, the workspace's own model key and MCP clients.
export function ApiKeysSection({ ctx }: { ctx: DashboardContext }) {
  const { apiKeys, isAdmin, locked, mcpConnections, modelKey, organization } = ctx;
  return <>
    {isAdmin ? <>
      <Locked feature="api.access" locked={locked} className="notice-banner" />
      <ApiKeys keys={apiKeys} organizationId={organization._id} perforceOnly={locked.includes("api.access")} />
      <div className="section-heading"><div><h2 id="model-key">Model provider key</h2><p>Run this workspace&apos;s reviews, chat and fixes on your own Anthropic, OpenAI or OpenRouter account. Your provider bills that usage. The key is encrypted and never shown again.</p></div></div>
      <section aria-labelledby="model-key">
        <div className="setting-row">
          <div><strong>{modelKey ? `${providers[modelKey.provider]} key` : "OpenReview’s model"}</strong><p>{modelKey ? locked.includes("model.ownKey") ? "Saved, but not used on this plan: reviews, chat and fixes run on OpenReview’s model." : <>Used{modelKey.model ? <> with <code>{modelKey.model}</code></> : ""} since {day(modelKey.updatedAt)}.</> : "This workspace uses OpenReview's model."}</p></div>
          {modelKey && <Confirm trigger="Remove key" triggerClassName="danger" title="Remove model key" action={removeModelKey} fields={{ organizationId: organization._id }} confirm="Remove key">This workspace goes back to OpenReview&apos;s model. The saved key is deleted.</Confirm>}
        </div>
        <Locked feature="model.ownKey" locked={locked}><form action={saveModelKey} className="form-grid model-key-form">
          <input type="hidden" name="organizationId" value={organization._id} />
          <label>Provider<select name="provider" defaultValue={modelKey?.provider ?? "anthropic"}><option value="anthropic">Anthropic</option><option value="openai">OpenAI</option><option value="openrouter">OpenRouter</option></select></label>
          <label>API key<input name="key" type="password" autoComplete="off" required maxLength={500} /></label>
          <label>Model (required for OpenRouter)<input name="model" maxLength={200} placeholder="Provider default" /></label>
          <div className="setting-actions"><button className="primary">{modelKey ? "Replace key" : "Save key"}</button></div>
        </form></Locked>
      </section>
    </> : <section><p className="card-line">Workspace admin access required.</p></section>}
    <div className="section-heading"><div><h2 id="mcp-connections">Connected MCP clients</h2><p>Clients connected to <code>/api/mcp</code> with OAuth. Their access is limited to one workspace, the scopes approved at sign-in and your role. Revoking a client ends its access and refresh tokens immediately.</p></div></div>
    <ScrollTable label="Connected MCP clients" className="table-box">
      <table>
        <thead><tr><th>Client</th><th>Scopes</th><th>Connected</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {mcpConnections.map((c) => <tr key={c._id}>
            <td>{c.clientName}<span className="cell-detail"><code>{c.clientId.slice(0, 80)}</code></span></td>
            <td>{c.scopes.join(", ")}</td>
            <td>{day(c.createdAt)}{c.mine ? "" : ` · by @${c.owner}`}</td>
            <td><RowMenu label={`Actions for ${c.clientName}`}><Confirm trigger="Revoke" title="Revoke MCP client" action={revokeMcpConnection} fields={{ grantId: c._id }} confirm="Revoke">Revoke <strong>{c.clientName}</strong>? Its access and refresh tokens end immediately.</Confirm></RowMenu></td>
          </tr>)}
          {!mcpConnections.length && <tr><td colSpan={4} className="table-empty">No MCP clients are connected.</td></tr>}
        </tbody>
      </table>
    </ScrollTable>
  </>;
}
