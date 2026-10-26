import Link from "next/link";
import type { ReactNode } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend } from "../../src/server";
import { Icon, type IconName } from "../ui/icons";
import { saveAgent, revokeBridge, saveWorkspaceAgent, saveDevinKey, removeDevinKey } from "./actions";
import {ProviderIdentities} from "./provider-identities";
import {BridgePairing} from "./bridge-pairing";
import {P4Identities} from "./p4-identities";
import { ScrollTable } from "./scroll-table";
import { cloudAgentIds, cloudAgents, localAgentLabels, localAgents } from "../../src/fix-agents";

const linkGithub = "/api/auth/login?link=1&next=/dashboard/account/review";
// Personal Settings → Review Settings, laid out like Greptile's: the amber notice while GitHub is unlinked, a
// "Fix with AI" card with the "Fix with your Agent" stepper, then our fix-agent choices, cloud agents, Devin and devices.
export async function AgentSettings({token,organizationId}:{token:string;organizationId:Id<"organizations">}) {
 const [personal,p4Identities,providerIdentities,credentials]=await Promise.all([backend().query(api.bridge.personal,{token,organizationId}),backend().query(api.p4Identities.list,{token,organizationId}),backend().query(api.providerIdentities.list,{token,organizationId}),backend().query(api.personalCredentials.status,{token})]);
 const paired=personal.devices.some(d=>!d.revoked&&d.expiresAt>=Date.now());
 const now=personal.handoff==="cloud"?`${cloudAgents[personal.cloudAgent].label} with a pull request comment posted as you`:`${localAgentLabels[personal.agent]} through your bridge`;
 const step=(done:boolean,icon:IconName,label:string,detail:ReactNode,action?:ReactNode)=><li className={done?"done":undefined}><span className="step-icon"><Icon name={done?"check":icon}/></span><strong>{label}</strong>{action}<p>{detail}</p></li>;
 const ways:[IconName,string,ReactNode][]=[["robot","Cloud agent",<>Fixes the GitHub pull request in the agent vendor’s infrastructure. Set one up under <a href="#cloud-agent-setup">Cloud agents</a>, then choose it as your fix agent.</>],["terminalWindow","Open in your agent app","A finding’s Fix page links to Claude Code, Codex, Cursor and Conductor. Each opens the app with the fix prompt filled in, and nothing is sent until you send it."],["puzzlePiece","Agent plugin",<>The OpenReview plugin for Claude Code and Codex fixes a pull request’s open findings and asks for a re-review until it is clean. <Link href="/docs/agent-plugins">Install the plugin</Link></>]];
 return <>
  {!personal.githubLinked&&<p className="notice-banner"><Icon name="warning"/><span>Link your GitHub account so cloud agents can fix pull requests as you, and your review preferences follow your pull requests. <a href={linkGithub}>Link now →</a></span></p>}
  <div className="section-heading"><h2 id="fix-ai-heading">Fix with AI</h2></div>
  <section aria-labelledby="fix-ai-heading">
   <div className="fix-intro"><strong>Fix with your agent</strong><p>{personal.githubLinked?"Your GitHub profile is linked. ":""}Fix findings with a cloud agent, an agent app on your machine, or the agent plugin. None of them needs the OpenReview command-line tool.</p></div>
   <ol className="agent-stepper">
    {step(personal.githubLinked,"info","1. Link your GitHub profile",personal.githubLinked?"Linked. Cloud agents post the fix request as you, from your GitHub account.":"Link your GitHub account so cloud agents can act as you on your pull requests.",!personal.githubLinked&&<a className="button primary" href={linkGithub}>Link account</a>)}
    {step(Boolean(personal.personalHandoff||personal.personalAgent||personal.personalCloudAgent),"code","2. Choose your fix agent",<>Right now the Fix page starts {now}. <a href="#personal-agent">Change it below</a>.</>)}
    {step(paired,"desktop","3. Pair a local bridge (optional)",paired?"A bridge is paired; see Paired devices.":"Only needed to fix in your own checkout. See Local bridge below.")}
   </ol>
   <div className="fix-ways">{ways.map(([icon,label,text])=><div key={label} className="option-card"><Icon name={icon}/><div><strong>{label}</strong><p>{text}</p></div></div>)}</div>
   <details className="config-details"><summary>Local bridge (Fix on your machine)</summary><p className="muted">Fix can also start a coding task in your own checkout through the <Link href="/docs/cli">OpenReview CLI</Link>. Inspect the resulting diff before committing.</p><ol className="setup-steps"><li><strong>Install the CLI and the bridge</strong><pre>npm install -g openreview-cli<br/>openreview bridge install</pre><p className="muted">Supports macOS, Windows, and Linux native protocol handlers. Running OpenReview from a checkout? Use <code>npm link</code> there instead of installing the package.</p></li><li><strong>Pair this workspace</strong><pre>openreview bridge pair --url {process.env.APP_URL??"http://localhost:3000"}</pre>{personal.canPair?<BridgePairing key={organizationId+":"+personal.account} organizationId={organizationId}/>:<p>Workspace viewers cannot pair a bridge or launch fixes.</p>}</li><li><strong>Register the repository</strong><pre>openreview bridge register /path/to/your/repository<br/>openreview bridge status</pre><p className="muted">The checkout must match the repository and reviewed commit. Existing uncommitted changes are preserved.</p><details><summary>Perforce client setup</summary><pre>openreview bridge register-p4 /path/to/client --server ssl:HOST:1666 --client CLIENT --user USER --instance https://code-review.example.com --project PROJECT</pre><p>Prepare the client at the reviewed archived shelf over its indexed submitted baseline. Use noallwrite and Unix line endings. Your existing P4 login and SSL trust must work locally. If the desktop handler cannot find them, add --p4 /absolute/path/to/p4 --tickets /absolute/path/to/tickets --trust /absolute/path/to/trust. These files stay on your computer.</p></details></li></ol></details>
  </section>
  <div className="section-heading"><div><h2 id="personal-agent">Personal fix agent</h2><p>Use the workspace default or choose your own. Your choice applies across workspaces and decides what the Fix page offers first.</p></div></div>
  <section aria-labelledby="personal-agent"><form action={saveAgent} key={`${personal.personalAgent??"inherit"}:${personal.personalHandoff??"inherit"}:${personal.personalCloudAgent??"inherit"}`} className="stack">
   <div className="setting-row"><div><strong id="p-handoff">How fixes start</strong></div><select name="handoff" aria-labelledby="p-handoff" defaultValue={personal.personalHandoff??""}><option value="">Use workspace default ({personal.workspaceHandoff==="cloud"?"cloud agent":"local agent"})</option><option value="bridge">Local agent on my machine</option><option value="cloud">Cloud agent on the pull request</option></select></div>
   <div className="setting-row"><div><strong id="p-agent">Local agent</strong></div><select name="agent" aria-labelledby="p-agent" defaultValue={personal.personalAgent??""}><option value="">Use workspace default ({localAgentLabels[personal.workspaceAgent]})</option>{localAgents.map(a=><option key={a} value={a}>{localAgentLabels[a]}</option>)}</select></div>
   <div className="setting-row"><div><strong id="p-cloud">Cloud agent</strong></div><select name="cloudAgent" aria-labelledby="p-cloud" defaultValue={personal.personalCloudAgent??""}><option value="">Use workspace default ({cloudAgents[personal.workspaceCloudAgent].label})</option>{cloudAgentIds.map(a=><option key={a} value={a}>{cloudAgents[a].label}</option>)}</select></div>
   <div className="setting-actions"><p className="muted">Right now the Fix page starts {now}. Every other way to fix stays available there.</p><button>Save preference</button></div>
  </form></section>
  {personal.canManageWorkspace&&<><div className="section-heading"><div><h2 id="workspace-agent">Workspace fix agent default</h2><p>Applies to people who have not chosen their own. The inline <strong>Fix with …</strong> link under each finding in pull requests is named after the workspace’s cloud agent when cloud agents are the default.</p></div></div>
  <section aria-labelledby="workspace-agent"><form action={saveWorkspaceAgent} key={`${personal.workspaceAgent}:${personal.workspaceHandoff}:${personal.workspaceCloudAgent}`} className="stack"><input type="hidden" name="organizationId" value={organizationId}/>
   <div className="setting-row"><div><strong id="w-handoff">How fixes start</strong></div><select name="handoff" aria-labelledby="w-handoff" defaultValue={personal.workspaceHandoff}><option value="bridge">Local agent</option><option value="cloud">Cloud agent</option></select></div>
   <div className="setting-row"><div><strong id="w-agent">Local agent</strong></div><select name="agent" aria-labelledby="w-agent" defaultValue={personal.workspaceAgent}>{localAgents.map(a=><option key={a} value={a}>{localAgentLabels[a]}</option>)}</select></div>
   <div className="setting-row"><div><strong id="w-cloud">Cloud agent</strong></div><select name="cloudAgent" aria-labelledby="w-cloud" defaultValue={personal.workspaceCloudAgent}>{cloudAgentIds.map(a=><option key={a} value={a}>{cloudAgents[a].label}</option>)}</select></div>
   <div className="setting-actions"><button>Save workspace default</button></div>
  </form></section></>}
  <div className="section-heading"><div><h2 id="cloud-agent-setup">Cloud agents</h2><p>A cloud agent works in its vendor’s infrastructure and starts from a GitHub pull request comment that mentions it. OpenReview posts that comment as you, with your GitHub account, because these agents ignore comments from bots and check that the person asking can push. Set each agent up once per repository or organization:</p></div></div>
  <ScrollTable label="Cloud agents" className="table-box agents-table"><table aria-labelledby="cloud-agent-setup"><thead><tr><th>Agent</th><th>Mention</th><th>Setup</th></tr></thead><tbody>
   {cloudAgentIds.map(a=><tr key={a}><td>{cloudAgents[a].label}</td><td><code>{cloudAgents[a].mention}</code></td><td className="wrap">{cloudAgents[a].setup} {cloudAgents[a].note} <a href={cloudAgents[a].docs} target="_blank" rel="noreferrer">Setup guide</a></td></tr>)}
  </tbody></table></ScrollTable>
  <p className="muted table-note">GitHub repositories on the OpenReview GitHub App only. Each hand-off asks GitHub for a fresh sign-in token, which is used for that one comment and never stored.</p>
  <DevinSettings configured={credentials.devin.configured}/>
  <div className="section-heading"><h2 id="devices-heading">Paired devices</h2></div>
  <ScrollTable label="Paired devices" className="table-box"><table aria-labelledby="devices-heading"><thead><tr><th>Device</th><th>Status</th><th>Last seen</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
   {personal.devices.map(d=><tr key={d._id}><td>{d.name}</td><td>{d.revoked?"Revoked":d.expiresAt<Date.now()?"Expired":"Paired"}</td><td>{d.lastSeen?new Date(d.lastSeen).toLocaleString():"Not connected yet"}</td><td>{!d.revoked&&<form action={revokeBridge}><input type="hidden" name="deviceId" value={d._id}/><button className="small" aria-label={`Revoke ${d.name}`}>Revoke</button></form>}</td></tr>)}
   {!personal.devices.length&&<tr><td colSpan={4} className="table-empty">No bridge paired yet.</td></tr>}
  </tbody></table></ScrollTable>
  <ProviderIdentities entries={providerIdentities} asOf={Date.now()}/><P4Identities entries={p4Identities} asOf={Date.now()}/>
 </>;
}

// Devin has no documented deep link, so it is an opt-in API handoff with the developer's own key.
function DevinSettings({configured}:{configured:boolean}) {
 return <><div className="section-heading"><div><h2 id="devin-settings">Devin (optional)</h2><p>Add your Devin API key (personal <code>apk_user_…</code> or service <code>apk_…</code>) to show <strong>Send to Devin</strong> on findings. The key is encrypted on the server and used only when you click that button; each finding starts an unlisted Devin session.</p></div></div>
 <section aria-labelledby="devin-settings">{configured?<form action={removeDevinKey} className="setting-row stack"><div><strong>A Devin API key is saved.</strong></div><button>Remove key</button></form>
  :<form action={saveDevinKey} className="setting-row stack"><div><strong id="devin-key">Devin API key</strong></div><span className="days-field"><input name="devinKey" type="password" autoComplete="off" required minLength={14} maxLength={304} aria-labelledby="devin-key" className="email-input"/><button>Save key</button></span></form>}</section></>;
}
