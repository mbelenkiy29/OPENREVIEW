import {repositoryDisplay,type ProviderDisplayIdentity} from "../../src/provider-display";
import Link from "next/link";
import {api} from "../../convex/_generated/api";
import type {Id,Doc} from "../../convex/_generated/dataModel";
import {backend} from "../../src/server";
import {deleteLearnedRule,editLearnedRule,editPreference,resetPreference,setPreferenceEnabled} from "./actions";
import {ContextTable,DialogForm,type ContextRow} from "./context-client";
import {Dialog,DialogClose} from "../ui/dialog";
import {Icon,type IconName} from "../ui/icons";
import {ago,when} from "./sections/shared";

type Repository=Doc<"repositories">&{provider?:ProviderDisplayIdentity|null};
// Learned preferences and team conventions in Custom Context's table language: filters in the toolbar,
// rows that expand to their evidence, and edit / delete in dialogs.
export async function PreferencesPanel({token,organizationId,repositories,admin,filters}:{token:string;organizationId:Id<"organizations">;repositories:Repository[];admin:boolean;filters:Record<string,string|undefined>}){
 const status=filters.status==="enabled"||filters.status==="disabled"?filters.status:undefined;
 const convention=["suggested","approved","rejected","disabled"].includes(filters.convention??"")?filters.convention:undefined;
 const conventions=await backend().query(api.memory.rules,{token,organizationId,...(filters.team?{teamId:filters.team as Id<"teams">}:{}),...(filters.repository?{repositoryId:filters.repository as Id<"repositories">}:{}),search:filters.q,...(convention?{status:convention}:{})});
 const rows=await backend().query(api.settings.preferences,{token,organizationId,...(filters.team?{teamId:filters.team as Id<"teams">}:{}),...(filters.repository?{repositoryId:filters.repository as Id<"repositories">}:{}),search:filters.q,status});
 const scopeCell=(scope:string|undefined,repositoryName:string)=>{
  const repo=repositories.find(r=>r.fullName===repositoryName),icon:IconName=scope==="workspace"?"buildings":scope==="team"?"usersThree":repo?.provider?.kind?.startsWith("github")?"githubLogo":repo?.provider?.kind==="gitlab"?"gitlabLogo":"gitBranch";
  return <span className="scope-cell" title={scope==="workspace"?"Every repository in the workspace":scope==="team"?"Repositories in the team of "+repositoryName:repositoryDisplay(repo)}><Icon name={icon}/><span>{scope==="workspace"?"Workspace":scope==="team"?"Team":repositoryName}</span></span>;
 };
 const scopeSelect=(value:string|undefined,hasTeam:boolean)=><label>Scope<select name="scope" defaultValue={value??"repo"}><option value="repo">This repository</option>{hasTeam&&<option value="team">Team</option>}<option value="workspace">Workspace</option></select></label>;
 const preferenceRows=rows.map((p):ContextRow=>({id:p._id,name:p.instruction,badge:p.category,cells:[scopeCell(p.scope,p.repositoryName),p.sourceReview?`PR #${p.sourceReview.prNumber}`:p.source.startsWith("commits:")?"Commit outcomes":p.conversation?"Developer request":"Feedback",<span key="u" title={when(p.updatedAt??p.createdAt)}>{ago(p.updatedAt??p.createdAt)}</span>,<span key="s" className="mono-status">{p.enabled?"Enabled":"Disabled"}</span>],detail:<div className="ctx-expansion">
  <p className="pre">{p.instruction}</p>
  <p className="muted">{p.repositoryName} · Created {when(p.createdAt)}{p.updatedAt&&<> · Updated {when(p.updatedAt)}</>}</p>
  {p.sourceReview?<p><Link href={"/dashboard/pulls/"+p.sourceReview.id}>Review at learning · #{p.sourceReview.prNumber} · {p.sourceReview.revision.slice(0,12)}</Link></p>:p.source.startsWith("commits:")?<p className="muted">Learned from commit outcomes in this repository: findings fixed by a follow-up commit versus findings merged while still open. The counts update as pull requests merge, and security findings are never narrowed.</p>:<p className="muted">Original review revision was not recorded for this legacy preference.</p>}
  {p.finding&&<p>Current finding: <Link href={"/dashboard/pulls/"+p.finding.reviewId}>{p.finding.title}</Link> · {p.finding.status} · <code>{p.finding.filePath}:{p.finding.startLine}</code></p>}
  {p.conversation?<details><summary>Developer request · @{p.conversation.author} · PR #{p.conversation.prNumber}</summary><p>{p.conversation.question}</p><p className="muted">{when(p.conversation.createdAt)}</p></details>:!p.finding&&!p.source.startsWith("commits:")&&<p>Recorded source: {p.source}</p>}
  {p.feedbackCount>0&&<details><summary>Finding feedback · showing {p.feedback.length} of {p.feedbackCount}</summary>{p.feedback.map(f=><div key={f.id}><p><strong>{f.value}</strong> · @{f.author} · {when(f.createdAt)}{f.generatedPreference&&" · Generated this preference"}</p><p>{f.comment||"No explanation supplied."}</p></div>)}</details>}
  <p className="muted">Scope: {p.scope==="workspace"?"every repository in the workspace":p.scope==="team"?"repositories in this team":"this repository"}</p>
  {admin&&<div className="form-actions">
   <form action={setPreferenceEnabled}><input type="hidden" name="preferenceId" value={p._id}/><input type="hidden" name="enabled" value={p.enabled?"false":"true"}/><button className="primary">{p.enabled?"Disable preference":"Enable preference"}</button></form>
   <Dialog trigger="Edit preference" title="Edit preference" description={`Learned from ${p.repositoryName}`}>
    <DialogForm action={editPreference} className="modal-body"><input type="hidden" name="preferenceId" value={p._id}/><label>Guidance<textarea name="instruction" defaultValue={p.instruction} maxLength={2000} rows={4}/></label>{scopeSelect(p.scope,p.hasTeam)}<div className="modal-footer"><DialogClose>Cancel</DialogClose><button className="primary">Save preference</button></div></DialogForm>
   </Dialog>
   <Dialog trigger="Delete preference" triggerClassName="danger" title="Delete preference?" size="confirm">
    <DialogForm action={resetPreference}><input type="hidden" name="preferenceId" value={p._id}/><div className="modal-body"><p>Future reviews of {p.repositoryName} stop following this preference. Disable it instead to keep it.</p></div><div className="modal-footer"><DialogClose>Cancel</DialogClose><button className="danger solid">Delete preference</button></div></DialogForm>
   </Dialog>
  </div>}
 </div>}));
 const conventionRows=conventions.map((r):ContextRow=>({id:r._id,name:r.text,badge:r.category,cells:[scopeCell(r.scope,r.repositoryName),`${r.frequency}×`,<span key="u" title={when(r.updatedAt)}>{ago(r.updatedAt)}</span>,<span key="s" className="mono-status">{r.status}</span>],detail:<div className="ctx-expansion">
  <p className="pre">{r.text}</p>
  <p className="muted">{r.repositoryName} · seen {r.frequency}× · scope {r.scope??"repo"} · updated {when(r.updatedAt)}</p>
  <p className="muted">Evidence: {r.evidence.map((e,i)=><a key={e.url} href={e.url} rel="noreferrer">{i?", ":""}@{e.author}</a>)}</p>
  {admin&&<div className="form-actions">
   <form action={editLearnedRule} className="form-actions"><input type="hidden" name="ruleId" value={r._id}/>{r.status!=="approved"&&<button className="primary" name="status" value="approved">Approve</button>}{r.status!=="rejected"&&<button name="status" value="rejected">Reject</button>}{r.status==="approved"&&<button name="status" value="disabled">Disable</button>}</form>
   <Dialog trigger="Edit convention" title="Edit convention" description={`Learned from ${r.repositoryName}`}>
    <DialogForm action={editLearnedRule} className="modal-body"><input type="hidden" name="ruleId" value={r._id}/><label>Guidance<textarea name="text" defaultValue={r.text} maxLength={300} rows={3}/></label>{scopeSelect(r.scope,r.hasTeam)}<div className="modal-footer"><DialogClose>Cancel</DialogClose><button className="primary">Save convention</button></div></DialogForm>
   </Dialog>
   <Dialog trigger="Delete convention" triggerClassName="danger" title="Delete convention?" size="confirm">
    <DialogForm action={deleteLearnedRule}><input type="hidden" name="ruleId" value={r._id}/><div className="modal-body"><p>Reviews stop using this convention. Disable it instead to keep it.</p></div><div className="modal-footer"><DialogClose>Cancel</DialogClose><button className="danger solid">Delete convention</button></div></DialogForm>
   </Dialog>
  </div>}
 </div>}));
 return <>
  <p className="ctx-intro">Preferences learned from developer feedback guide future reviews of the named repository. They do not change custom rules or establish that a finding was resolved. Workspace admins can edit, scope (repository, team or workspace), disable or delete preferences and conventions; every change is audit-logged. Viewers have read-only access.</p>
  <form className="toolbar-row ctx-filters stack" role="search">
   {filters.team!==undefined&&<input type="hidden" name="team" value={filters.team}/>}
   <div className="search-field"><Icon name="magnifyingGlass"/><label className="sr-only" htmlFor="memory-search">Search memory</label><input id="memory-search" type="search" name="q" defaultValue={filters.q} maxLength={200} placeholder="Search preferences and conventions"/></div>
   <label className="sr-only" htmlFor="memory-repository">Repository</label><select id="memory-repository" name="repository" defaultValue={filters.repository??""}><option value="">All repositories</option>{repositories.map(r=><option key={r._id} value={r._id}>{repositoryDisplay(r)}</option>)}</select>
   <label className="sr-only" htmlFor="memory-status">Status</label><select id="memory-status" name="status" defaultValue={status??""}><option value="">All statuses</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select>
   <label className="sr-only" htmlFor="memory-convention">Convention status</label><select id="memory-convention" name="convention" defaultValue={convention??""}><option value="">All conventions</option><option value="suggested">Suggested</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="disabled">Disabled</option></select>
   <button>Apply</button>
  </form>
  <div className="ctx-heading"><div><h2>Learned preferences</h2><p>{rows.length} matching preferences</p></div></div>
  <ContextTable label="Learned preferences" columns={["Preferences","Scope","Source","Last updated","Status"]} rows={preferenceRows} empty={<div className="empty-state"><strong>No matching preferences</strong><p>Feedback and explicit “ignore this pattern” requests create preferences. Adjust filters to inspect another repository or status.</p></div>}/>
  <div className="ctx-heading" id="conventions"><div><h2>Learned team conventions</h2><p>Conventions learned from human review comments add review guidance only. {conventions.length} matching conventions.</p></div></div>
  <ContextTable label="Learned team conventions" columns={["Conventions","Scope","Seen","Last updated","Status"]} rows={conventionRows} empty="No matching conventions."/>
 </>;
}
