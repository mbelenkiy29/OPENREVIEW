import {repositoryDisplay} from "../../src/provider-display";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend, origin } from "../../src/server";
import { configureLinear, configureAtlassian, configureNotion, disconnectLinear, refreshLinear } from "./actions";
import { ResourcePicker } from "./resource-picker";
import { offline } from "../../src/egress";
import { Locked } from "./locked";
import type { Entitlement } from "../../src/plans";
import { DialogForm } from "./context-client";
import { Dialog, DialogClose } from "../ui/dialog";
import { Icon } from "../ui/icons";

// Integrations, in the language of Greptile's integration table (INTEGRATION / STATUS / ACTIONS with an orange
// "NOT CONFIGURED" dot): one row per provider, its connections below it, Configure and Disconnect in dialogs.
// ?integration=<id> opens Configure (OAuth callbacks land there); ?error= and ?saved= show as banners.
export async function IntegrationsPanel({token,organizationId,admin,repositories,selected,error,saved,locked}:{locked:readonly Entitlement[];token:string;organizationId:Id<"organizations">;admin:boolean;repositories:{_id:Id<"repositories">;fullName:string}[];selected?:string;error?:string;saved?:string}) {
 const connections=await backend().query(api.integrations.list,{token,organizationId}),isOffline=offline();
 let atlassianResources:{projects:{id:string;name:string}[];spaces:{id:string;name:string}[]}|undefined;
 const connection=connections.find(c=>c._id===selected&&c.active);
 let resources:{teams:{id:string;name:string;key:string}[];projects:{id:string;name:string}[]}|undefined,notionPages:{id:string;title:string;url:string}[]|undefined,discoveryFailed=false;
 if(admin&&connection&&!isOffline)try {if(connection.kind==="linear")resources=await backend().action(api.integrationJobs.discover,{token,id:connection._id});else if(connection.kind==="notion")notionPages=(await backend().action(api.notionJobs.discover,{token,id:connection._id})).pages;else atlassianResources=await backend().action(api.atlassianJobs.discover,{token,id:connection._id});}catch{discoveryFailed=true;}
 const label=(kind:string)=>kind==="linear"?"Linear":kind==="notion"?"Notion":"Atlassian";
 const lockedOut=locked.includes("context.requirements");
 const repositoryChoices=(c:{repositoryIds:string[]})=><fieldset><legend>Repositories allowed to retrieve requirements</legend>{repositories.map(r=><label className="check repository-choice" key={r._id}><input type="checkbox" name="repositoryIds" value={r._id} defaultChecked={c.repositoryIds.includes(r._id)}/><span>{repositoryDisplay(r)}</span></label>)}</fieldset>;
 const footer=(text:string)=><div className="modal-footer"><DialogClose>Cancel</DialogClose><button className="primary">{text}</button></div>;
 // The Configure dialog's form for the connection opened with ?integration=, once its resources are discovered.
 const configure=connection&&(resources?<DialogForm action={configureLinear} className="modal-body ctx-form">
   <input type="hidden" name="integrationId" value={connection._id}/>
   <fieldset><legend>Linear teams</legend>{resources.teams.length?resources.teams.map(t=><label className="check" key={t.id}><input type="checkbox" name="teamIds" value={t.id} defaultChecked={connection.teamIds.includes(t.id)}/>{t.name} · {t.key}</label>):<p className="muted">No authorized teams found.</p>}</fieldset>
   <fieldset><legend>Optional project restriction</legend><p className="hint">With no projects selected, all issues in selected teams are allowed, including issues without a project. Selecting projects excludes issues without a selected project.</p>{resources.projects.map(p=><label className="check" key={p.id}><input type="checkbox" name="projectIds" value={p.id} defaultChecked={connection.projectIds.includes(p.id)}/>{p.name}</label>)}</fieldset>
   {repositoryChoices(connection)}{footer("Save resource scope")}
  </DialogForm>:atlassianResources?<DialogForm action={configureAtlassian} className="modal-body ctx-form">
   <input type="hidden" name="integrationId" value={connection._id}/>
   <ResourcePicker name="jiraProjectIds" legend="Jira projects" items={atlassianResources.projects} selected={connection.jiraProjectIds} empty="No authorized Jira projects found."/>
   <ResourcePicker name="confluenceSpaceIds" legend="Confluence spaces" items={atlassianResources.spaces} selected={connection.confluenceSpaceIds} empty="No authorized Confluence spaces found."/>
   {repositoryChoices(connection)}
   <p className="hint">Only Jira keys and Confluence page links explicitly referenced in the PR title, description, or branch are fetched. Selecting no resources disables retrieval.</p>
   {footer("Save resource scope")}
  </DialogForm>:notionPages?<DialogForm action={configureNotion} className="modal-body ctx-form">
   <input type="hidden" name="integrationId" value={connection._id}/>
   <div><p>OpenReview can read only the pages shared with it in Notion (page menu → Connections). It fetches a page only when a pull request links to it.</p>{notionPages.length?<ul>{notionPages.slice(0,50).map(p=><li key={p.id}>{p.url?<a href={p.url} target="_blank" rel="noreferrer">{p.title}</a>:p.title}</li>)}</ul>:<p className="muted">No pages are shared with OpenReview yet.</p>}{notionPages.length>50&&<p className="muted">Showing 50 of {notionPages.length} shared pages.</p>}</div>
   {repositoryChoices(connection)}{footer("Save repositories")}
  </DialogForm>:undefined);
 const providers:{kind:string;description:string;ready:boolean;connect:string;aria:string;setup:ReactNode}[]=[
  {kind:"atlassian",description:"Jira issues and Confluence pages linked from a pull request",ready:Boolean(process.env.ATLASSIAN_CLIENT_ID&&process.env.ATLASSIAN_CLIENT_SECRET),connect:"/api/integrations/atlassian/connect?organization="+organizationId,aria:"Connect Atlassian sites",
   setup:<><p>The OpenReview operator registers a distributable OAuth 3LO app with read-only Jira and Confluence scopes and offline access. Set <code>ATLASSIAN_CLIENT_ID</code> and server-only <code>ATLASSIAN_CLIENT_SECRET</code> on the web application and Convex backend. Register this callback:</p><code className="integration-callback">{origin()+"/api/integrations/atlassian/callback"}</code></>},
  {kind:"linear",description:"Issues from selected teams and projects",ready:Boolean(process.env.LINEAR_CLIENT_ID),connect:"/api/integrations/linear/connect?organization="+organizationId,aria:"Connect Linear workspace",
   setup:<><p>Create a Linear OAuth application with read scope and PKCE. Set <code>LINEAR_CLIENT_ID</code> on the web application and Convex backend. Register this callback:</p><code className="integration-callback">{origin()+"/api/integrations/linear/callback"}</code></>},
  {kind:"notion",description:"Pages shared with OpenReview and linked from a pull request",ready:Boolean(process.env.NOTION_CLIENT_ID&&process.env.NOTION_CLIENT_SECRET),connect:"/api/integrations/notion/connect?organization="+organizationId,aria:"Connect Notion workspace",
   setup:<><p>The OpenReview operator creates a public Notion integration with read content capability only. Set <code>NOTION_CLIENT_ID</code> and server-only <code>NOTION_CLIENT_SECRET</code> on the web application and Convex backend. Register this redirect URI:</p><code className="integration-callback">{origin()+"/api/integrations/notion/callback"}</code></>},
 ];
 return <div className="ctx-locked">
  {error&&<p role="alert" className="notice-banner error"><Icon name="warningCircle"/><span>{error==="disconnect"?"Disconnect failed. Check workspace admin access and retry.":error==="linear-refresh"?"Connection refresh failed. Retry after any refresh in progress finishes, or reconnect if Linear access was revoked.":error.endsWith("-connect")?"Authorization failed or expired. Reconnect and approve read-only access.":"Scope could not be saved. Check your permissions and refresh the resource list before retrying."}</span></p>}
  {saved&&(saved!=="linear-refresh"||Boolean(connection))&&<p role="status" className="success-banner"><Icon name="checkCircle"/><span>{saved==="disconnected"?"Connection disconnected. Requirements access removed.":saved==="linear-refresh"?"Linear connection refreshed.":"Resource scope saved."}</span></p>}
  {isOffline&&<p role="status" className="notice-banner"><Icon name="info"/><span>Offline mode is on (OPENREVIEW_OFFLINE=true): requirements integrations are turned off, and reviews do not fetch tickets or documents.</span></p>}
  {discoveryFailed&&<div role="alert" className="notice-banner error"><Icon name="warningCircle"/><span>Integration resources could not be loaded. Access may have expired, or another request is refreshing the token. <Link href={"/dashboard/integrations?integration="+selected}>Retry resource discovery</Link></span></div>}
  <div className="ctx-heading"><div><h2>Requirements integrations</h2><p>Connect Linear, Atlassian or Notion with read-only access. Select resources and the repositories allowed to use their requirements.</p></div></div>
  <Locked feature="context.requirements" locked={locked} note="Requirements integrations (Linear, Jira, Confluence and Notion) are on the Pro plan."/>
  <div className="table-box">
   <table className="integration-table" aria-label="Integrations">
    <thead><tr><th scope="col">Integration</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
    <tbody>{providers.map(p=>{
     const mine=connections.filter(c=>c.kind===p.kind),active=mine.filter(c=>c.active).length;
     return <Fragment key={p.kind}>
      <tr>
       <td><div className="integration-cell"><span className="brand-mark" aria-hidden="true">{label(p.kind)[0]}</span><div><strong>{label(p.kind)}</strong><small>{p.description}</small></div></div></td>
       <td>{active?<span className="status-dot ok mono-status">Connected{active>1?` · ${active}`:""}</span>:<span className="status-dot mono-status">{p.ready||!admin?"Not configured":"Setup required"}</span>}</td>
       <td>{admin&&!isOffline&&(lockedOut?<button disabled title="Requirements integrations are on the Pro plan">{active?"Connect another":"Connect"}</button>:p.ready?<a className="button" href={p.connect} aria-label={p.aria}><Icon name="plus"/>{active?"Connect another":"Connect"}</a>
        :<Dialog trigger="Set up" title={`Set up ${label(p.kind)}`} description="An OpenReview operator step before workspaces can connect.">{<div className="modal-body">{p.setup}<div className="modal-footer"><DialogClose>Close</DialogClose></div></div>}</Dialog>)}</td>
      </tr>
      {mine.map(c=>{
       const unscoped=c.kind==="notion"?!c.repositoryIds.length:!(c.teamIds.length||c.jiraProjectIds.length||c.confluenceSpaceIds.length);
       return <tr key={c._id} className="connection">
        <td>
         <strong>{c.name}</strong>
         <p className="hint">{c.kind==="linear"?<>{c.teamIds.length} teams · {c.projectIds.length?c.projectIds.length+" selected projects":"All projects in selected teams"} · {c.repositoryIds.length} repositories</>:c.kind==="notion"?<>Pages shared with OpenReview in Notion · {c.repositoryIds.length} repositories</>:<>{c.jiraProjectIds.length} Jira projects · {c.confluenceSpaceIds.length} Confluence spaces · {c.repositoryIds.length} repositories</>}</p>
         {unscoped&&c.active&&<p className="hint">Select resources and repositories to authorize retrieval.</p>}
         {c.error&&<p role="alert" className="integration-error">{c.error}</p>}
         {c.kind==="atlassian"&&!c.active&&<a href="https://id.atlassian.com/manage-profile/apps" target="_blank" rel="noreferrer">Revoke in Atlassian Connected Apps</a>}
        </td>
        <td>{!c.active?<span className="status-dot off mono-status">Disconnected</span>:c.error?<span className="status-dot error mono-status">Needs attention</span>:unscoped?<span className="status-dot mono-status">Not configured</span>:<span className="status-dot ok mono-status">Connected</span>}</td>
        <td>{admin&&<div className="form-actions">
         {c.kind==="notion"&&c.active&&c.error&&<a className="button" href={"/api/integrations/notion/connect?organization="+organizationId}>Reconnect Notion</a>}
         {c.active&&<>
          {connection?._id===c._id&&configure?<Dialog trigger="Configure" triggerClassName="primary" triggerLabel={`Configure ${c.name}`} title={`Configure ${label(c.kind)}`} description={c.name} size="wide" open={!saved}>{configure}</Dialog>
           :<Link className="button" href={"/dashboard/integrations?integration="+c._id} aria-label={`Configure ${c.name}`}>Configure</Link>}
          {c.kind==="linear"&&<form action={refreshLinear}><input type="hidden" name="integrationId" value={c._id}/><button aria-label="Refresh Linear connection" title="Refresh Linear connection"><Icon name="arrowsClockwise"/>Refresh</button></form>}
          <Dialog trigger="Disconnect" triggerClassName="danger" triggerLabel={`Disconnect ${label(c.kind)} · ${c.name}`} title={`Disconnect ${label(c.kind)}?`} size="confirm">
           <DialogForm action={disconnectLinear}><input type="hidden" name="integrationId" value={c._id}/><div className="modal-body"><p>Reviews stop reading requirements from <strong>{c.name}</strong>. You can connect it again later.</p></div><div className="modal-footer"><DialogClose>Cancel</DialogClose><button className="danger solid">Disconnect {label(c.kind)}</button></div></DialogForm>
          </Dialog>
         </>}
        </div>}</td>
       </tr>;
      })}
     </Fragment>;
    })}</tbody>
   </table>
  </div>
  {!connections.length&&<p className="ctx-count">No integrations connected. Connect a data source to enrich reviews with requirements context.</p>}
 </div>;
}
