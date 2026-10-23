import Link from "next/link";
import { cookies } from "next/headers";
import { api } from "../../convex/_generated/api";
import { backend } from "../../src/server";
import { referralConfig } from "../../src/referrals";
import { Icon, type IconName } from "../ui/icons";
import { revokeSession, signOutEverywhere } from "./actions";
import { openWorkspaceSettings } from "./actions-organization";
import { activeWorkspace, viewer } from "./load";
import { Confirm } from "./org-ui";
import { PortalDisclosure } from "./portal-disclosure";
import { ScrollTable } from "./scroll-table";

const when = (ms: number) => new Date(ms).toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC";
const providers: Record<string, [label: string, icon: IconName]> = { github: ["GitHub", "githubLogo"], gitlab: ["GitLab", "gitlabLogo"], google: ["Google", "googleLogo"], email: ["Email", "envelopeSimple"], sso: ["Single sign-on", "lockSimple"] };
const provider = (p: string) => providers[p] ?? [p, "user"];
const title = (role: string) => role[0].toUpperCase() + role.slice(1);
// Personal Settings → Account Settings, as on Greptile: Profile, Roles & Access, Linked Accounts (our sign-in
// methods; linking only, there is no unlink), then active sessions (revoke one, or everywhere).
export async function AccountPanel({ token }: { token: string }) {
  const [data, me, jar] = await Promise.all([backend().query(api.identity.sessions, { token }), viewer(), cookies()]);
  const current = activeWorkspace(me, jar)?._id, linked = new Set(data.identities.map((i) => i.provider));
  const links = ([["github", "/api/auth/login?link=1&next=/dashboard/account", true], ["gitlab", "/api/auth/gitlab/login?link=1&next=/dashboard/account", Boolean(process.env.GITLAB_OAUTH_CLIENT_ID)], ["google", "/api/auth/google/login?link=1&next=/dashboard/account", Boolean(process.env.GOOGLE_CLIENT_ID)]] as const).filter(([p, , on]) => on && !linked.has(p));
  return <>
    <div className="section-heading"><h2 id="profile-heading">Profile</h2></div>
    <section aria-labelledby="profile-heading" className="profile-card">
      <label>Name<input readOnly value={me.user.login} /></label>
      <label>Email<input readOnly value={me.email ?? "No verified email"} /></label>
    </section>
    <div className="section-heading"><h2 id="roles-heading">Roles &amp; Access</h2></div>
    {me.organizations.length ? <ScrollTable label="Roles and access" className="table-box roles-table">
      <table>
        <thead><tr><th>Name</th><th>Role</th><th>Actions</th></tr></thead>
        <tbody>{me.organizations.map((o) => <tr key={o._id}>
          <td>{o.name}{o._id === current && <span className="role-badge">Current</span>}</td>
          <td className="muted">{title(o.role)}</td>
          <td>{o._id === current ? <Link className="button icon-button" href="/dashboard/organization" aria-label={`Settings for ${o.name}`}><Icon name="gear" /></Link>
            : <form action={openWorkspaceSettings}><input type="hidden" name="organizationId" value={o._id} /><button className="icon-button" aria-label={`Switch to ${o.name} and open its settings`}><Icon name="gear" /></button></form>}</td>
        </tr>)}</tbody>
      </table>
    </ScrollTable> : <section aria-labelledby="roles-heading"><p className="card-line">You are not a member of any organizations.</p></section>}
    <div className="section-heading"><h2 id="methods-heading">Linked Accounts</h2>
      {links.length > 0 && <PortalDisclosure className="add-account" label={<><Icon name="plus" />Add Account</>}>
        <div className="menu">{links.map(([p, href]) => <a key={p} className="menu-item" href={href}><Icon name={provider(p)[1]} />Link {provider(p)[0]}</a>)}</div>
      </PortalDisclosure>}</div>
    {data.identities.length ? <ScrollTable label="Linked accounts" className="table-box">
      <table aria-labelledby="methods-heading">
        <thead><tr><th>Provider</th><th>Account</th><th>Last used</th></tr></thead>
        <tbody>{data.identities.map((i) => <tr key={i.provider + (i.email ?? "")}>
          <td><span className="provider-cell"><Icon name={provider(i.provider)[1]} />{provider(i.provider)[0]}</span></td>
          <td>{i.email ? <>{i.email}{i.emailVerified && <span className="role-badge">Verified</span>}</> : <span className="muted">—</span>}</td>
          <td>{when(i.lastLoginAt)}</td>
        </tr>)}</tbody>
      </table>
    </ScrollTable> : <section aria-labelledby="methods-heading" className="empty-state">
      <span className="provider-icons"><Icon name="githubLogo" /><Icon name="gitlabLogo" /></span>
      <strong>No accounts linked</strong>
      <p>Connect a GitHub or GitLab account for review settings to take effect.</p>
      <div className="actions">{links.map(([p, href]) => <a key={p} className="button" href={href}><Icon name={provider(p)[1]} />Connect {provider(p)[0]}</a>)}</div>
    </section>}
    <p className="muted table-note">Accounts join automatically only when both sides have the same verified email. To add another method to this account, link it {referralConfig().payoutsEnabled ? "within 15 minutes of signing in (sign out and back in first if it’s been longer)" : "while signed in"}.</p>
    <div className="section-heading"><h2 id="sessions-heading">Active sessions</h2>
      <Confirm trigger={<><Icon name="signOut" />Sign out everywhere</>} triggerClassName="danger" title="Sign out everywhere" action={signOutEverywhere} fields={{}} confirm="Sign out everywhere">This ends every OpenReview session for your account, including this browser.</Confirm></div>
    <ScrollTable label="Active sessions" className="table-box">
      <table aria-labelledby="sessions-heading">
        <thead><tr><th>Session</th><th>Started</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {data.sessions.map((s) => <tr key={s._id}>
            <td className="wrap">{provider(s.provider)[0]} sign-in<span className="cell-detail">{s.userAgent ?? "Unknown browser"}</span></td>
            <td>{when(s.createdAt)}</td>
            <td>{s.current ? <span className="role-badge">This browser</span> : <form action={revokeSession}><input type="hidden" name="sessionId" value={s._id} /><button className="small">Sign out</button></form>}</td>
          </tr>)}
          {!data.sessions.length && <tr><td colSpan={3} className="table-empty">This browser uses a session from before session tracking; sign out everywhere to end it.</td></tr>}
        </tbody>
      </table>
    </ScrollTable>
    <p className="muted table-note">Removal from a workspace also signs you out everywhere and revokes your API keys and bridges for that workspace.</p>
  </>;
}
