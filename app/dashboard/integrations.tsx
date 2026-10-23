import {repositoryDisplay} from "../../src/provider-display";
import Link from "next/link";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend, origin } from "../../src/server";
import { configureLinear, configureAtlassian, configureNotion, disconnectLinear, refreshLinear } from "./actions";
import { ResourcePicker } from "./resource-picker";
import { offline } from "../../src/egress";
import { Locked } from "./locked";
import type { Entitlement } from "../../src/plans";

export async function IntegrationsPanel({token,organizationId,admin,repositories,selected,error,saved,locked}:{locked:readonly Entitlement[];token:string;organizationId:Id<"organizations">;admin:boolean;repositories:{_id:Id<"repositories">;fullName:string}[];selected?:string;error?:string;saved?:string}) {
 const connections=await backend().query(api.integrations.list,{token,organizationId}),isOffline=offline();
 let atlassianResources:{projects:{id:string;name:string}[];spaces:{id:string;name:string}[]}|undefined;
 const connection=connections.find(c=>c._id===selected&&c.active);
 let resources:{teams:{id:string;name:string;key:string}[];projects:{id:string;name:string}[]}|undefined,notionPages:{id:string;title:string;url:string}[]|undefined,discoveryFailed=false;
 if(admin&&connection&&!isOffline)try {if(connection.kind==="linear")resources=await backend().action(api.integrationJobs.discover,{token,id:connection._id});else if(connection.kind==="notion")notionPages=(await backend().action(api.notionJobs.discover,{token,id:connection._id})).pages;else atlassianResources=await backend().action(api.atlassianJobs.discover,{token,id:connection._id});}catch{discoveryFailed=true;}
 const label=(kind:string)=>kind==="linear"?"Linear":kind==="notion"?"Notion":"Atlassian";
 return <>
  <section><h2>Requirements integrations</h2><p>Connect Linear, Atlassian or Notion with read-only access. Select resources and the repositories allowed to use their requirements.</p>
   {error&&<p role="alert" className="error">{error==="disconnect"?"Disconnect failed. Check workspace admin access and retry.":error==="linear-refresh"?"Connection refresh failed. Retry after any refresh in progress finishes, or reconnect if Linear access was revoked.":error.endsWith("-connect")?"Authorization failed or expired. Reconnect and approve read-only access.":"Scope could not be saved. Check your permissions and refresh the resource list before retrying."}</p>}
   {saved&&(saved!=="linear-refresh"||Boolean(connection))&&<p role="status">{saved==="disconnected"?"Connection disconnected. Requirements access removed.":saved==="linear-refresh"?"Linear connection refreshed.":"Resource scope saved."}</p>}
   {isOffline&&<p role="status" className="muted">Offline mode is on (OPENREVIEW_OFFLINE=true): requirements integrations are turned off, and reviews do not fetch tickets or documents.</p>}
   <h3>Connected</h3>
   <table className="memory-table"><thead><tr><th scope="col">Providers</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead><tbody>
   {!connections.length&&<tr><td colSpan={3}><p className="memory-empty">No integrations connected. Connect a data source to enrich reviews with requirements context.</p></td></tr>}
   {connections.map(c=><tr key={c._id}><td><span className="row-title">{label(c.kind)} · {c.name}</span>
    <p className="row-meta">{c.kind==="linear"?<>{c.teamIds.length} teams · {c.projectIds.length?c.projectIds.length+" selected projects":"All projects in selected teams"} · {c.repositoryIds.length} repositories</>:c.kind==="notion"?<>Pages shared with OpenReview in Notion · {c.repositoryIds.length} repositories</>:<>{c.jiraProjectIds.length} Jira projects · {c.confluenceSpaceIds.length} Confluence spaces · {c.repositoryIds.length} repositories</>}</p>
    {(c.kind==="notion"?!c.repositoryIds.length:!(c.teamIds.length||c.jiraProjectIds.length||c.confluenceSpaceIds.length))&&c.active&&<p className="muted">Select resources and repositories to authorize retrieval.</p>}
    {c.error&&<p role="alert">{c.error}</p>}{c.kind==="atlassian"&&!c.active&&<a href="https://id.atlassian.com/manage-profile/apps" target="_blank" rel="noreferrer">Revoke in Atlassian Connected Apps</a>}</td>
    <td><span className="badge">{c.active?"Connected":"Disconnected"}</span></td>
    <td>{admin&&<div className="row-actions">{c.kind==="notion"&&c.active&&c.error&&<a className="button small" href={"/api/integrations/notion/connect?organization="+organizationId}>Reconnect Notion</a>}{c.active&&<><Link className="button small" href={"/dashboard/memory/integrations?integration="+c._id}>Select resources</Link>{c.kind==="linear"&&<form action={refreshLinear}><input type="hidden" name="integrationId" value={c._id}/><button className="small">Refresh Linear connection</button></form>}<form action={disconnectLinear}><input type="hidden" name="integrationId" value={c._id}/><button className="small">Disconnect {label(c.kind)}</button></form></>}</div>}</td>
   </tr>)}
   </tbody></table>
   <h3>Available</h3>
   <Locked feature="context.requirements" locked={locked}>
   <table className="memory-table"><thead><tr><th scope="col">Providers</th><th scope="col">Actions</th></tr></thead><tbody>
   <tr><td><span className="row-title">Atlassian</span><p className="row-meta">Jira issues and Confluence pages linked from a pull request</p></td><td>{admin&&!isOffline&&(process.env.ATLASSIAN_CLIENT_ID&&process.env.ATLASSIAN_CLIENT_SECRET?<a className="button small" href={"/api/integrations/atlassian/connect?organization="+organizationId} aria-label="Connect Atlassian sites">+ Connect</a>:<details><summary>Setup required</summary><p>The OpenReview operator registers a distributable OAuth 3LO app with read-only Jira and Confluence scopes and offline access. Set <code>ATLASSIAN_CLIENT_ID</code> and server-only <code>ATLASSIAN_CLIENT_SECRET</code> on the web application and Convex backend. Register this callback:</p><code className="integration-callback">{origin()+"/api/integrations/atlassian/callback"}</code></details>)}</td></tr>
   <tr><td><span className="row-title">Linear</span><p className="row-meta">Issues from selected teams and projects</p></td><td>{admin&&!isOffline&&(process.env.LINEAR_CLIENT_ID?<a className="button small" href={"/api/integrations/linear/connect?organization="+organizationId} aria-label="Connect Linear workspace">+ Connect</a>:<details><summary>Setup required</summary><p>Create a Linear OAuth application with read scope and PKCE. Set <code>LINEAR_CLIENT_ID</code> on the web application and Convex backend. Register this callback:</p><code className="integration-callback">{origin()+"/api/integrations/linear/callback"}</code></details>)}</td></tr>
   <tr><td><span className="row-title">Notion</span><p className="row-meta">Pages shared with OpenReview and linked from a pull request</p></td><td>{admin&&!isOffline&&(process.env.NOTION_CLIENT_ID&&process.env.NOTION_CLIENT_SECRET?<a className="button small" href={"/api/integrations/notion/connect?organization="+organizationId} aria-label="Connect Notion workspace">+ Connect</a>:<details><summary>Setup required</summary><p>The OpenReview operator creates a public Notion integration with read content capability only. Set <code>NOTION_CLIENT_ID</code> and server-only <code>NOTION_CLIENT_SECRET</code> on the web application and Convex backend. Register this redirect URI:</p><code className="integration-callback">{origin()+"/api/integrations/notion/callback"}</code></details>)}</td></tr>
   </tbody></table>
   </Locked>
  </section>
  {discoveryFailed&&<section><p role="alert">Integration resources could not be loaded. Access may have expired, or another request is refreshing the token.</p><Link className="button" href={"/dashboard/memory/integrations?integration="+selected}>Retry resource discovery</Link></section>}
  {connection&&resources&&<section><h2>Select resources · {connection.name}</h2><form action={configureLinear} className="form-grid policy-form">
   <input type="hidden" name="integrationId" value={connection._id}/>
   <fieldset><legend>Linear teams</legend>{resources.teams.length?resources.teams.map(t=><label className="check" key={t.id}><input type="checkbox" name="teamIds" value={t.id} defaultChecked={connection.teamIds.includes(t.id)}/>{t.name} · {t.key}</label>):<p>No authorized teams found.</p>}</fieldset>
   <fieldset><legend>Optional project restriction</legend><p className="muted">With no projects selected, all issues in selected teams are allowed, including issues without a project. Selecting projects excludes issues without a selected project.</p>{resources.projects.map(p=><label className="check" key={p.id}><input type="checkbox" name="projectIds" value={p.id} defaultChecked={connection.projectIds.includes(p.id)}/>{p.name}</label>)}</fieldset>
   <fieldset><legend>Repositories allowed to retrieve requirements</legend>{repositories.map(r=><label className="check repository-choice" key={r._id}><input type="checkbox" name="repositoryIds" value={r._id} defaultChecked={connection.repositoryIds.includes(r._id)}/><span>{repositoryDisplay(r)}</span></label>)}</fieldset>
   <button className="primary">Save resource scope</button>
  </form></section>}
  {connection&&atlassianResources&&<section><h2>Select resources · {connection.name}</h2><form action={configureAtlassian} className="form-grid policy-form">
   <input type="hidden" name="integrationId" value={connection._id}/>
   <ResourcePicker name="jiraProjectIds" legend="Jira projects" items={atlassianResources.projects} selected={connection.jiraProjectIds} empty="No authorized Jira projects found."/>
   <ResourcePicker name="confluenceSpaceIds" legend="Confluence spaces" items={atlassianResources.spaces} selected={connection.confluenceSpaceIds} empty="No authorized Confluence spaces found."/>
   <fieldset><legend>Repositories allowed to retrieve requirements</legend>{repositories.map(r=><label className="check repository-choice" key={r._id}><input type="checkbox" name="repositoryIds" value={r._id} defaultChecked={connection.repositoryIds.includes(r._id)}/><span>{repositoryDisplay(r)}</span></label>)}</fieldset>
   <p className="muted">Only Jira keys and Confluence page links explicitly referenced in the PR title, description, or branch are fetched. Selecting no resources disables retrieval.</p>
   <button className="primary">Save resource scope</button>
  </form></section>}
  {connection&&notionPages&&<section><h2>Select repositories · {connection.name}</h2><form action={configureNotion} className="form-grid policy-form">
   <input type="hidden" name="integrationId" value={connection._id}/>
   <div className="wide"><p>OpenReview can read only the pages shared with it in Notion (page menu → Connections). It fetches a page only when a pull request links to it.</p>{notionPages.length?<ul>{notionPages.slice(0,50).map(p=><li key={p.id}>{p.url?<a href={p.url} target="_blank" rel="noreferrer">{p.title}</a>:p.title}</li>)}</ul>:<p className="muted">No pages are shared with OpenReview yet.</p>}{notionPages.length>50&&<p className="muted">Showing 50 of {notionPages.length} shared pages.</p>}</div>
   <fieldset><legend>Repositories allowed to retrieve requirements</legend>{repositories.map(r=><label className="check repository-choice" key={r._id}><input type="checkbox" name="repositoryIds" value={r._id} defaultChecked={connection.repositoryIds.includes(r._id)}/><span>{repositoryDisplay(r)}</span></label>)}</fieldset>
   <button className="primary">Save repositories</button>
  </form></section>}
 </>;
}
