import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend } from "../../src/server";
import { proGatesAt, type Entitlement } from "../../src/plans";
import { Icon } from "../ui/icons";
import { Locked } from "./locked";
import { addSsoDomain, removeSsoDomain, saveSsoConnection, setSsoEnforcement, verifySsoDomain } from "./actions";

// Organization Settings → Organization → Enterprise SSO (admins only): Greptile's one-line card, with our
// SAML / OIDC connection behind "Set up SSO", then the verified domains and the requirement switch.
export async function SsoSettings({ token, organizationId, locked }: { token: string; organizationId: Id<"organizations">; locked: readonly Entitlement[] }) {
  const { connection: c, domains } = await backend().query(api.sso.settings, { token, organizationId });
  const base = (process.env.APP_URL ?? "").replace(/\/+$/, "");
  const verified = domains.filter((d) => d.verified).length;
  // A connection made since the Pro gates, on a plan without SSO: it keeps signing people in, and can only be turned off.
  const lapsed = Boolean(c && c.createdAt >= proGatesAt && locked.includes("auth.sso"));
  return <section aria-labelledby="sso-heading" className="sso-card">
    <p className="card-line">{c ? <><strong>{c.name}</strong> · {c.protocol === "saml" ? "SAML 2.0" : "OpenID Connect"} · {c.active ? "Active" : "Off"}{c.enforce ? " · Required" : ""}</> : "Connect your identity provider with SAML 2.0 or OpenID Connect. People sign in with their work email; an address counts as verified only on a domain you prove with a DNS TXT record."}</p>
    {c?.protocol === "saml" && base && <p className="muted">Service provider entity ID and metadata: <code>{`${base}/api/sso/saml/${c._id}`}</code> · ACS URL: <code>{`${base}/api/sso/saml/${c._id}/acs`}</code></p>}
    {c?.protocol === "oidc" && base && <p className="muted">Redirect URI: <code>{`${base}/api/sso/oidc/callback`}</code></p>}
    {lapsed && <><Locked feature="auth.sso" locked={locked} /><p className="muted">Sign-in keeps working. Without Pro you can still turn the connection off or stop requiring SSO.</p></>}
    <Locked feature="auth.sso" locked={c ? [] : locked}><details className="config-details">
      <summary className="button">{c ? "Edit connection" : "Set up SSO"}</summary>
      <form action={saveSsoConnection} className="form-grid">
        <input type="hidden" name="organizationId" value={organizationId} />
        <label>Protocol<select name="protocol" defaultValue={c?.protocol ?? "saml"}><option value="saml">SAML 2.0</option><option value="oidc">OpenID Connect</option></select></label>
        <label>Name<input name="name" required maxLength={100} defaultValue={c?.name ?? "Company SSO"} /></label>
        <label>SAML sign-in URL<input name="samlEntryPoint" type="url" defaultValue={c?.samlEntryPoint ?? ""} placeholder="https://idp.example.com/sso/saml" /></label>
        <label>SAML IdP entity ID (optional)<input name="samlIdpIssuer" defaultValue={c?.samlIdpIssuer ?? ""} /></label>
        <label className="wide">SAML signing certificate (PEM)<textarea name="samlIdpCert" rows={3} defaultValue={c?.samlIdpCert ?? ""} /></label>
        <label>OIDC issuer<input name="oidcIssuer" type="url" defaultValue={c?.oidcIssuer ?? ""} placeholder="https://login.example.com" /></label>
        <label>OIDC client ID<input name="oidcClientId" defaultValue={c?.oidcClientId ?? ""} /></label>
        <label>OIDC client secret<input name="oidcClientSecret" type="password" autoComplete="off" placeholder={c?.hasClientSecret ? "Saved; leave blank to keep" : ""} /></label>
        <label>New members from SSO<select name="jitRole" defaultValue={c?.jitRole ?? "none"}><option value="none">Invite only</option><option value="member">Join as member</option><option value="viewer">Join as viewer</option></select></label>
        <label className="check wide"><input type="checkbox" name="active" defaultChecked={c?.active ?? true} />Connection active</label>
        <div className="wide setting-actions"><button className="primary">Save SSO connection</button></div>
      </form>
    </details></Locked>
    {c && <>
      <h3 className="card-subheading">Domains</h3>
      <div className="table-box"><table>
        <thead><tr><th>Domain</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
          {domains.map((d) => <tr key={d._id}>
            <td>{d.domain}</td>
            <td>{d.verified ? <span className="status-chip completed"><Icon name="check" />Verified</span> : <span className="muted">Add TXT <code>{d.txtName}</code> = <code>{d.txtValue}</code></span>}</td>
            <td><div className="cell-actions">{!d.verified && <form action={verifySsoDomain}><input type="hidden" name="domainId" value={d._id} /><button className="small">Check DNS</button></form>}
              <form action={removeSsoDomain}><input type="hidden" name="domainId" value={d._id} /><button className="small" aria-label={`Remove ${d.domain}`}>Remove</button></form></div></td>
          </tr>)}
          {!domains.length && <tr><td colSpan={3} className="table-empty">No domains yet.</td></tr>}
        </tbody>
      </table></div>
      <form action={addSsoDomain} className="toolbar-row"><input type="hidden" name="organizationId" value={organizationId} /><label className="grow"><span className="sr-only">Domain</span><input name="domain" required placeholder="example.com" aria-label="Domain" /></label><button>Add domain</button></form>
      <form action={setSsoEnforcement} className="setting-row stack"><input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="enforce" value={c.enforce ? "false" : "true"} />
        <div><strong>Require SSO</strong><p>{c.enforce ? "SSO is required for this workspace (owners can still use other sign-in methods)." : verified ? "SSO is optional." : "Verify a domain to require SSO."}</p></div>
        {(c.enforce || (verified > 0 && c.active)) && <button>{c.enforce ? "Stop requiring SSO" : "Require SSO"}</button>}
      </form>
    </>}
  </section>;
}
