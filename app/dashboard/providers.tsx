import Link from "next/link";
import { cache } from "react";
import {P4WatcherSetup} from "./p4-watcher";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { backend } from "../../src/server";
import { installHref, linkHref } from "../../src/github-install";
import { providerName } from "../../src/provider-display";
import type {P4Project,P4Review,P4ApprovalInspection} from "../../src/perforce";
import { AddProvider,GitlabNetworkForm,GitCredentialRefreshForm,P4TicketRefreshForm,BitbucketActivationForm } from "./provider-form";
import { retryProviderEvent,disconnectProvider,selectProviderRepos,reviewP4Shelf,configureP4Polling } from "./actions";
import { Dialog, DialogClose } from "../ui/dialog";
import { Icon } from "../ui/icons";
import { PortalDisclosure } from "./portal-disclosure";
import { brandIcon, repositoryChip } from "./sections/repositories";
import { ago, when } from "./sections/shared";

// One read per request for the header's Add Provider button and the panel.
const load=cache(async(token:string,organizationId:Id<"organizations">)=>{
 const [connections,installations,repositories]=await Promise.all([backend().query(api.providerConnections.list,{token,organizationId}),backend().query(api.repositories.githubInstallations,{token,organizationId}),backend().query(api.repositories.list,{token,organizationId})]);
 return {connections,installations,repositories};
});
const addProps=(organizationId:string)=>({organizationId,githubHref:installHref(organizationId,"/dashboard/providers"),linkHref:linkHref(organizationId,"/dashboard/providers"),bitbucket:Boolean(process.env.BITBUCKET_FORGE_APP_ID&&process.env.BITBUCKET_FORGE_ENVIRONMENT_ID),origin:Boolean(process.env.ORIGIN_APP_ID&&process.env.ORIGIN_APP_PRIVATE_KEY)});
const host=(url:string)=>{try{return new URL(url).host;}catch{return url;}};
const plural=(n:number,word:string)=>`${n} ${n===1?word:word.replace(/y$/,"ie")+"s"}`;
const hookHelp:Record<string,string>={"bitbucket-cloud":"Deploy the OpenReview Forge manifest with its native event subscriptions and hourly token refresh. Forge signs invocations; no repository webhook secret is used. Source commits arrive through the pull request updated event.",origin:"Subscribe the Origin App to repository.pushed and pull request lifecycle events; Origin signs deliveries with its published Ed25519 keys.",gitlab:"Enable merge request, push, and comment events; enter the GitLab secret token from setup. Comment events enable @openreview follow-ups and re-review commands.","azure-devops":"In Project settings → Service hooks, add Web Hooks subscriptions for Pull request created, Pull request updated and Code pushed with this URL. Send the webhook secret from setup as the HTTP header X-OpenReview-Token, or as the Basic authentication password.","bitbucket-dc":"Enable repository Push and pull request Opened, Source branch updated, Modified, Reopened, Merged, Declined, Deleted, and Comment added events. Use the saved webhook secret with HMAC SHA-256 and keep TLS verification enabled.","github-enterprise":"Subscribe the GitHub App to pull_request, pull_request_review, pull_request_review_comment, issue_comment, and push. Use the saved signature secret. PR and review events recheck existing approvals even when automatic reviews are off."};

/** "+ Add Provider" in the page header; the empty state offers its own connect buttons instead. */
export async function ProvidersAction({token,organizationId}:{token:string;organizationId:Id<"organizations">}){
 const {connections,installations}=await load(token,organizationId);
 if(!installations.length&&!connections.some(c=>c.active))return null;
 return <AddProvider {...addProps(organizationId)} trigger={<><Icon name="plus"/>Add Provider</>} triggerClassName="primary"/>;
}

function Sync({at,fallback="Never"}:{at:number;fallback?:string}){
 return <span className="provider-sync"><span><Icon name="clock"/>Last Sync:</span><strong title={at?when(at):undefined}>{at?ago(at):fallback}</strong></span>;
}
function RepoList({repos,kind}:{repos:Doc<"repositories">[];kind:string}){
 return repos.length?<ul className="provider-repos">{repos.map(r=><li key={r._id}><Icon name={brandIcon(kind)}/><span>{r.fullName}</span>{repositoryChip(r)}</li>)}<li><Link href="/dashboard/repositories">Manage in Repositories<Icon name="arrowRight"/></Link></li></ul>:<p className="muted">No repositories selected yet.</p>;
}

export async function ProvidersPanel({token,organizationId,connectionId,projectId,after,inspect}:{token:string;organizationId:Id<"organizations">;connectionId?:string;projectId?:string;after?:string;inspect?:string}){
 const {connections,installations,repositories:connected}=await load(token,organizationId);
 let projects:P4Project[]=[],reviewPage:{project:P4Project;reviews:P4Review[];cursor:number|null}|undefined;
 let inspection:P4ApprovalInspection|undefined;
 let inspectionError="";
 let repositories:{externalId:string;fullName:string;defaultBranch:string;remoteUrl:string}[]=[],error="";
 if(connectionId){try{if(!connections.some(c=>c._id===connectionId&&c.active&&!c.suspended))throw new Error("Select an active workspace connection");if(connections.find(c=>c._id===connectionId)?.kind==="perforce")projects=await backend().action(api.providerJobs.p4Projects,{token,connectionId:connectionId as Id<"providerConnections">});else repositories=await backend().action(api.providerJobs.discover,{token,connectionId:connectionId as Id<"providerConnections">});}catch(e){error=e instanceof Error?e.message:"Discovery failed";}}
 if(connectionId&&projectId&&!error){try{
  if(!projects.some(p=>p.id===projectId))throw new Error("Select an accessible P4 project");
  if(after!==undefined&&!/^[1-9]\d*$/.test(after))throw new Error("Invalid P4 review cursor");
  reviewPage=await backend().action(api.providerJobs.p4Reviews,{token,connectionId:connectionId as Id<"providerConnections">,projectId,...(after!==undefined?{after:Number(after)}:{})});
  projects=projects.map(p=>p.id===reviewPage!.project.id?reviewPage!.project:p);
 }catch(e){error=e instanceof Error?e.message:"Review inspection failed";}}
 if(connectionId&&projectId&&inspect&&!error){try{
  if(!/^[1-9]\d*$/.test(inspect)||!Number.isSafeInteger(Number(inspect)))throw new Error("Invalid P4 review number");
  inspection=await backend().action(api.providerJobs.p4ApprovalInspection,{token,connectionId:connectionId as Id<"providerConnections">,projectId,nativeNumber:Number(inspect)});
 }catch(e){inspectionError=e instanceof Error?e.message:"Approval inspection failed";}}
 const selected=connections.find(c=>c._id===connectionId);
 const events=selected?await backend().query(api.providerConnections.events,{token,connectionId:selected._id}):[];
 const polling=await backend().query(api.p4Polling.list,{token,organizationId});
 const indexedProject=connected.find(r=>r.connectionId===connectionId&&r.externalId===projectId&&r.indexStatus==="ready");
 const reviewLink=(project:string,cursor?:number)=>"/dashboard/providers?"+new URLSearchParams({connection:connectionId??"",project,...(cursor!==undefined?{after:String(cursor)}:{})});
 const active=connections.filter(c=>c.active),add=addProps(organizationId);
 return <>
  {!installations.length&&!active.length?<div className="empty-state providers-empty">
   <span className="brand-marks" aria-hidden="true"><Icon name="githubLogo"/><Icon name="gitlabLogo"/></span>
   <strong>No code providers connected</strong>
   <p>Connect GitHub or GitLab to sync repositories and start reviews.</p>
   <div className="actions"><AddProvider {...add} initial="gitlab" trigger={<><Icon name="gitlabLogo"/>Connect GitLab</>}/><a className="button" href={add.githubHref}><Icon name="githubLogo"/>Connect GitHub</a></div>
   <p className="providers-more">Already installed the App on GitHub? <Link href={add.linkHref}>Link an existing installation</Link> · <AddProvider {...add} trigger="More providers" triggerClassName="link-button"/></p>
  </div>:<div className="provider-list">
   {installations.map(i=>{const repos=connected.filter(r=>r.installationId===i.installationId),sync=Math.max(i.checkedAt??0,...repos.map(r=>r.indexedAt??0));
    return <article className="provider-card" key={i.installationId} aria-label={`GitHub ${i.account}`}>
     <div className="provider-head">
      <span className="provider-name"><Icon name="githubLogo"/><span><strong>GitHub</strong></span></span>
      <Sync at={sync}/>
      {!i.active&&<span className="status-chip failed"><Icon name="warningCircle"/>Inactive</span>}
      <PortalDisclosure className="item-menu" label={<><Icon name="dotsThreeVertical"/><span className="sr-only">Actions for GitHub {i.account}</span></>}>
       <div className="menu">
        <a className="menu-item" href={add.githubHref}>Edit Configuration</a>
        <Link className="menu-item" href={add.linkHref}>Manage Organizations</Link>
        <a className="menu-item danger" href={i.accountType==="Organization"?`https://github.com/organizations/${i.account}/settings/installations/${i.installationId}`:`https://github.com/settings/installations/${i.installationId}`} target="_blank" rel="noreferrer"><span>Uninstall on GitHub</span><Icon name="arrowSquareOut"/></a>
       </div>
      </PortalDisclosure>
     </div>
     <details className="provider-foot">
      <summary><span>{i.account}{i.accountType?` · ${i.accountType}`:""}</span><span>{plural(repos.length,"Repository")}<Icon name="caretDown"/></span></summary>
      <div className="provider-more">
       <p className="provider-chips"><span className={`status-chip${i.contents==="write"?" completed":""}`}><Icon name={i.contents==="write"?"check":"info"}/>Contents: {i.contents??"not checked yet"}</span><span className={`status-chip${i.checks==="write"?" completed":""}`}><Icon name={i.checks==="write"?"check":"info"}/>Checks: {i.checks??"not checked yet"}</span></p>
       {i.contents!=="write"&&<p className="muted">Fix pull requests need Contents: Read and write. The App must request it, then an owner of {i.account} accepts it under GitHub → Settings → Applications → Installed GitHub Apps.</p>}
       <RepoList repos={repos} kind="github"/>
      </div>
     </details>
    </article>;})}
   {active.map(c=>{const repos=connected.filter(r=>r.connectionId===c._id),usable=!c.suspended,hook=(process.env.APP_URL??"http://localhost:3000")+(c.kind==="origin"?"/api/origin/webhook":c.kind==="bitbucket-cloud"?"/api/bitbucket/forge/events":`/api/providers/${c._id}/webhook`);
    return <article className="provider-card" key={c._id} id={`provider-${c._id}`} aria-label={c.name}>
     <div className="provider-head">
      <span className="provider-name"><Icon name={brandIcon(c.kind)}/><span><strong>{c.name}</strong><small>{providerName(c.kind)}</small></span></span>
      <Sync at={c.lastEventAt??0} fallback={c.kind==="perforce"?"Manual upload":"Awaiting first event"}/>
      {c.suspended&&<span className="status-chip">Suspended</span>}
      {c.error&&<span className="status-chip failed"><Icon name="warningCircle"/>Error</span>}
      <PortalDisclosure className="item-menu" label={<><Icon name="dotsThreeVertical"/><span className="sr-only">Actions for {c.name}</span></>}>
       <div className="menu">
        {usable&&<Dialog trigger="Edit Configuration" triggerClassName="menu-item" title="Edit Configuration" description={`${c.name} · ${providerName(c.kind)} · ${host(c.instance)}`}>
         <div className="modal-body provider-config">
          {["gitlab","gitea","github-enterprise","bitbucket-dc"].includes(c.kind)&&<GitCredentialRefreshForm connectionId={c._id} kind={c.kind}/>}
          {c.kind==="perforce"&&<P4TicketRefreshForm connectionId={c._id}/>}
          {c.kind==="gitlab"&&<GitlabNetworkForm connectionId={c._id} apiUrl={c.apiUrl} proxyUrl={c.proxyUrl} caCertificates={c.caCertificates}/>}
          {!["gitlab","gitea","github-enterprise","bitbucket-dc","perforce"].includes(c.kind)&&<p className="muted">{providerName(c.kind)} manages this connection’s credentials; reinstall it from the provider to change them.</p>}
         </div>
        </Dialog>}
        {usable&&<Link className="menu-item" href={`/dashboard/providers?connection=${c._id}#provider-panel`}>{c.kind==="perforce"?"Select projects":"Select repositories"}</Link>}
        <Link className="menu-item" href={`/dashboard/providers?connection=${c._id}#deliveries`}>Recent deliveries</Link>
        <hr/>
        <Dialog trigger="Disconnect" triggerClassName="menu-item danger" size="confirm" title="Disconnect Provider">
         <div className="modal-body"><p>Are you sure you want to disconnect this provider? This action cannot be undone.{repos.length?` Reviews stop for its ${plural(repos.length,"repository")}.`:""}</p></div>
         <form action={disconnectProvider} className="modal-footer"><input type="hidden" name="connectionId" value={c._id}/><input type="hidden" name="name" value={c.name}/><DialogClose className="">Cancel</DialogClose><button className="danger solid">Disconnect</button></form>
        </Dialog>
       </div>
      </PortalDisclosure>
     </div>
     {c.error&&<div role="alert" className="notice-inline"><Icon name="warning"/><span>{c.error}</span></div>}
     {c.kind==="bitbucket-cloud"&&c.suspended&&<div className="provider-activation"><p>Native event: {c.forgeEventAt?new Date(c.forgeEventAt).toLocaleString():"Awaiting delivery"}. Scheduled renewal: {c.forgeRefreshAt?new Date(c.forgeRefreshAt).toLocaleString():"Awaiting hourly trigger"}.</p><p className="muted">Make a test change in your Bitbucket workspace and wait for scheduled renewal. Activation checks current native repository access; then select repositories. Setup events do not run reviews.</p><BitbucketActivationForm connectionId={c._id} ready={!!c.forgeEventAt&&!!c.forgeRefreshAt}/></div>}
     <details className="provider-foot" open={usable&&c.kind!=="perforce"&&!c.lastEventAt}>
      <summary><span>{host(c.instance)} · {usable?"Connected":"Suspended"}</span><span>{plural(repos.length,"Repository")}<Icon name="caretDown"/></span></summary>
      <div className="provider-more">
       {usable&&(c.kind==="perforce"?<p className="muted">Connection and native project access are available. Use openreview p4 index followed by openreview p4 upload to index a submitted project revision. Upload uses your OpenReview API login and requires workspace admin access. After indexing completes, inspect a native archived shelf and request a manual review. Optional review polling is configured below after indexing completes.</p>
        :<div className="provider-hook"><span className="mono-label">{c.kind==="bitbucket-cloud"?"Forge event endpoint":"Webhook URL"}</span><code>{hook}</code><p className="muted">{hookHelp[c.kind]??"Enable pull request and push events; enter the signature secret from setup."} Keep automatic reviews off until event delivery is verified.</p><p>Last event: {c.lastEventAt?new Date(c.lastEventAt).toLocaleString():"Awaiting verified event"}</p></div>)}
       <RepoList repos={repos} kind={c.kind}/>
       {c.kind==="perforce"&&repos.map(r=>{const poll=polling.find(p=>p.repositoryId===r._id);return <div className="provider-poll" key={r._id}><h3>P4 review polling · {r.fullName}</h3><p className="muted">Requires a completed submitted baseline. Polling walks the bot’s review inventory, including older updated shelves, every cycle. A full cycle restarts after five minutes. Your Automatic review and Re-review settings apply; native project branch IDs use your review branch filters. Submitted indexing supports a manual upload or an opt-in CLI watcher. Completed refreshes update enabled polling automatically; disabled polling stays off.</p><P4WatcherSetup repositoryId={r._id} projectId={r.externalId??r.fullName} instance={c.instance}/><p>State: {poll?.status??"Disabled"} · scanned {poll?.scanned??0} · skipped {poll?.skipped??0}</p>{poll&&<p>Current inventory: {poll.pages} pages · next review cursor {poll.cursor??"start"} · page position {poll.position}/{poll.pending}</p>}{poll?.lastCompleteAt&&<p>Last complete inventory: {new Date(poll.lastCompleteAt).toISOString()}</p>}{poll?.nextAt&&<p>Next step: {new Date(poll.nextAt).toISOString()}</p>}{poll?.error&&<p role="alert">{poll.error} · attempt {poll.attempts}/3</p>}{poll?.diagnostics.length? <details><summary>Recent skipped shelves ({poll.skipped} total)</summary><ul>{poll.diagnostics.map((d,i)=><li key={i}>Review {d.nativeNumber}: {d.reason}</li>)}</ul></details>:null}<p className="muted">Native protections may hide reviews or files. Each inventory is limited to 10,000 visible reviews; exceeding the limit fails visibly. P4 agent fixes require a registered native client matching the reviewed files. Runtime validation requires a separately paired worker and an approved policy. Automatic approval remains unavailable for Perforce.</p><div className="row-start">{r.indexStatus==="ready"&&<form action={configureP4Polling}><input type="hidden" name="repositoryId" value={r._id}/><input type="hidden" name="enabled" value="true"/><button>{poll?.enabled?"Restart / retry polling":"Enable review polling"}</button></form>}{poll?.enabled&&<form action={configureP4Polling}><input type="hidden" name="repositoryId" value={r._id}/><input type="hidden" name="enabled" value="false"/><button>Disable polling</button></form>}</div></div>;})}
      </div>
     </details>
    </article>;})}
  </div>}
  {connectionId&&<section className="provider-panel" id="provider-panel" aria-labelledby="provider-panel-title">
   <div className="provider-panel-head"><h2 id="provider-panel-title">{selected?`${selected.name} · ${selected.kind==="perforce"?"Projects":"Repositories"}`:"Provider connection"}</h2><Link className="button small" href="/dashboard/providers">Close</Link></div>
   {error&&<div role="alert" className="notice-inline"><Icon name="warning"/><span>{error}</span></div>}
   {projects.length>0&&<div><h3>Accessible P4 projects</h3><p className="muted">These are the bot’s currently visible projects and depot views. Server protections can hide files; this inventory does not establish indexing coverage.</p><form action={selectProviderRepos} className="stack"><input type="hidden" name="connectionId" value={connectionId}/>{projects.map(p=><article key={p.id}><label className="check"><input type="checkbox" name="externalIds" value={p.id}/>Connect {p.name}</label><h4>{p.name} · {p.id}</h4><Link href={reviewLink(p.id)}>Inspect native reviews</Link>{p.branches.map(b=><div key={b.id}><p>{b.name} · {b.id}</p><ul>{b.paths.map((path,i)=><li key={i}><code>{path}</code></li>)}</ul></div>)}{!p.branches.length&&<p>Inspect native reviews to load the project’s current branch views.</p>}</article>)}<p className="muted">Connecting creates a project scope for team access and rules. Manual indexing uses the CLI inventory upload. Enable review polling below after indexing completes.</p><button className="primary">Connect selected projects</button></form></div>}
   {selected&&!error&&selected.kind==="perforce"&&!projects.length&&<p role="status">No P4 projects visible to the bot. Check ticket expiry, project membership and depot protections.</p>}
   {reviewPage&&<div><h3>Native P4 reviews · {projectId}</h3><p className="muted">These are reviews currently visible to the bot. Manual review requires a completed submitted baseline and an open archived shelf. The bot publishes the summary and verified comments at the exact archived shelf revision.</p>{reviewPage.reviews.map(r=><article key={r.id}><h4>Review {r.id}</h4><p>{r.description}</p><p>{r.author} · {r.state} · {r.pending?"Shelved":"Submitted"}</p><p>Updated {new Date(r.updated*1000).toISOString()}</p><Link href={reviewLink(projectId!)+"&inspect="+r.id+"#p4-approval-inspection"}>Inspect approval blockers</Link>{indexedProject&&r.pending&&["needsReview","needsRevision"].includes(r.state)&&<form action={reviewP4Shelf}><input type="hidden" name="organizationId" value={organizationId}/><input type="hidden" name="repositoryId" value={indexedProject._id}/><input type="hidden" name="nativeNumber" value={r.id}/><button>Review archived shelf</button></form>}</article>)}{!reviewPage.reviews.length&&<p role="status">No more visible reviews.</p>}<p className="row-start">{reviewPage.cursor!==null&&<Link href={reviewLink(projectId!,reviewPage.cursor)}>Older reviews</Link>}{after&&<Link href={reviewLink(projectId!)}>Latest reviews</Link>}</p></div>}
   {inspectionError&&<p role="alert">{inspectionError}</p>}
   {inspection&&<div id="p4-approval-inspection"><h3>Native approval inspection · Review {inspection.reviewNumber}</h3><p>Version {inspection.version} · {inspection.state} · {inspection.pending?"Shelved":"Submitted"}</p><p>Inspected {new Date(inspection.inspectedAt).toISOString()}. Refresh this inspection after any change.</p><p>Reviewed inventory revision: <code>{inspection.revision}</code></p><p>{inspection.nativeApprovalAvailable?"The native server currently offers an approval transition to this account.":"Native approval is currently blocked for this account."}</p>{inspection.nativeBlockers.length>0&&<ul>{inspection.nativeBlockers.map(reason=><li key={reason}>{reason}</li>)}</ul>}<p>OpenReview automatic approval remains unavailable for Perforce. Native transition availability does not establish complete coverage, passing checks, or absence of human objections.</p><ul>{inspection.coverage.map(reason=><li key={reason}>{reason}</li>)}</ul></div>}
   {repositories.length>0&&<form action={selectProviderRepos} className="stack"><h3>Select repositories</h3><input type="hidden" name="connectionId" value={connectionId}/><div className="select-list">{repositories.map(r=><label className="check" key={r.externalId}><input type="checkbox" name="externalIds" value={r.externalId}/>{r.fullName} · {r.defaultBranch}</label>)}</div><button className="primary">Connect selected repositories</button></form>}
   {selected&&<div id="deliveries"><h3>Recent deliveries</h3><p className="muted">Latest 50 deliveries. Retrying uses the original verified payload and rechecks current repository access and revision.</p>{events.length>0&&<ul className="provider-events">{events.map(e=><li key={e._id}><span>{e.eventType??"Provider event"}</span><span className={`status-chip${e.status==="failed"?" failed":e.status==="completed"?" completed":""}`}>{e.status}</span><span className="muted">{e.attempts} attempts · {new Date(e.createdAt).toLocaleString()}</span>{e.payloadDeleted&&<span className="muted">Payload deleted 14 days after processing.</span>}{e.status==="failed"&&!e.payloadDeleted&&<form action={retryProviderEvent}><input type="hidden" name="eventId" value={e._id}/><button className="small">Retry failed delivery</button></form>}</li>)}</ul>}{!events.length&&<p className="no-results">No deliveries received.</p>}</div>}
  </section>}
 </>;
}
