import {repositoryDisplay} from "../../src/provider-display";
import Link from "next/link";
import {api} from "../../convex/_generated/api";
import type {Id} from "../../convex/_generated/dataModel";
import {backend} from "../../src/server";
import {ClusterForm} from "./cluster-form";
import {saveCluster,requestClusterSuggestions,decideClusterSuggestion} from "./actions";
import {ContextTable,DialogForm,type ContextRow} from "./context-client";
import {Dialog,DialogClose} from "../ui/dialog";
import {Icon} from "../ui/icons";

// Cross-repo context: repository clusters whose source informs one another's reviews, in Custom Context's
// table language. Suggested clusters lead the table; rows expand to each source's index state.
export async function ClustersPanel({token,organizationId,admin}:{token:string;organizationId:Id<"organizations">;admin:boolean}) {
 const data=await backend().query(api.scopes.list,{token,organizationId});
 const people=await backend().query(api.dashboard.overview,{token,organizationId});
 const suggestions=admin?await backend().query(api.repositoryOnboarding.clusterSuggestionsPage,{token,organizationId}):[];
 const name=(id:string)=>data.repositories.find(r=>r._id===id)?.fullName??"Repository unavailable",label=(id:string)=>repositoryDisplay(data.repositories.find(r=>r._id===id));
 const repos=(ids:string[])=><span className="scope-cell" title={ids.map(label).join("\n")}><Icon name="folders"/><span>{ids.map(name).join(", ")}</span></span>;
 const create=admin&&<Dialog trigger={<><Icon name="plus"/>Create repo cluster</>} triggerClassName="primary" title="Create repo cluster" description="Choose repositories whose source can inform one another’s reviews." size="wide"><ClusterForm organizationId={organizationId} repositories={data.repositories}/></Dialog>;
 const rows:ContextRow[]=[
  ...suggestions.map((s):ContextRow=>({id:s._id,name:s.name,badge:`${s.repositoryIds.length} repos`,cells:[repos(s.repositoryIds),"—",<span key="s" className="mono-status">Suggested</span>],detail:<div className="ctx-expansion">
   <p>{s.repositoryIds.map(label).join(", ")}</p>
   <ul>{s.reasons.map((r,i)=><li key={i}><span className="badge tag">{r.kind}</span> {r.detail}</li>)}</ul>
   <form action={decideClusterSuggestion} className="ctx-form stack"><input type="hidden" name="suggestionId" value={s._id}/><label>Cluster name<input name="name" defaultValue={s.name} required maxLength={100}/></label><div className="form-actions"><button className="primary" name="decision" value="approved">Create cluster</button><button name="decision" value="dismissed" formNoValidate>Dismiss</button></div></form>
  </div>})),
  ...data.clusters.map((c):ContextRow=>{
   const indexed=c.repositoryIds.filter(id=>data.repositories.find(r=>r._id===id)?.indexedSha).length;
   return {id:c._id,name:c.name,badge:`${c.repositoryIds.length} repos`,cells:[repos(c.repositoryIds),`${indexed} of ${c.repositoryIds.length} indexed`,<span key="s" className="mono-status">Active</span>],detail:<div className="ctx-expansion">
    {c.repositoryIds.map(id=>{
     const repo=data.repositories.find(r=>r._id===id),job=people.indexJobs.find(j=>j?.repositoryId===id);
     return <div key={id} className="cluster-source"><p className="repository-identity"><strong>{repositoryDisplay(repo)}</strong></p>
      {repo&&<><p>Index status: {repo.indexStatus} · {repo.enabled?"Reviews enabled":"Reviews disabled"}</p>
      <p>Current indexed revision: {repo.indexedSha?<code>{repo.indexedSha}</code>:"No indexed revision"}{repo.indexedAt&&` · ${new Date(repo.indexedAt).toLocaleString("en-US",{timeZone:"UTC"})} UTC`}</p>
      {repo.error&&<p role="alert">{repo.error}</p>}
      {job?<details><summary>Latest indexing attempt · {job.status}</summary><p>Attempt revision: <code>{job.sha}</code></p><p>Processed {job.processed} of {job.total} eligible files · Attempt {job.attempts}</p>{job.error&&<p role="alert">{job.error}</p>}{job.sha!==repo.indexedSha&&<p>This attempt differs from the current indexed revision; its progress does not describe coverage of that index.</p>}{job.skippedTotal!==undefined?<><p>{job.skippedTotal} skipped files</p><ul>{job.skipped?.map(f=><li key={f.path}><code>{f.path}</code> — {f.reason}</li>)}</ul>{job.skippedTotal>(job.skipped?.length??0)&&<p>Showing the first {job.skipped?.length??0} exclusions.</p>}</>:<p>Skipped-file coverage was not recorded for this attempt.</p>}</details>:<p className="muted">No indexing attempt is recorded.</p>}
      <Link href="/dashboard/repositories">Inspect indexing and recovery</Link></>}
     </div>;
    })}
    {admin&&<div className="form-actions">
     <Dialog trigger={`Edit cluster · ${c.name}`} title="Edit repo cluster" description={c.name} size="wide"><ClusterForm organizationId={organizationId} repositories={data.repositories} cluster={c}/></Dialog>
     <Dialog trigger="Remove cluster" triggerClassName="danger" title="Remove cluster?" size="confirm">
      <DialogForm action={saveCluster}><input type="hidden" name="organizationId" value={organizationId}/><input type="hidden" name="id" value={c._id}/><input type="hidden" name="remove" value="true"/><div className="modal-body"><p>Reviews in {c.name} stop reading one another’s source. The repositories themselves are not changed.</p></div><div className="modal-footer"><DialogClose>Cancel</DialogClose><button className="danger solid">Remove cluster</button></div></DialogForm>
     </Dialog>
    </div>}
   </div>};
  }),
 ];
 return <>
  <div className="ctx-heading">
   <div><h2>Cross-repository context</h2><p>Choose repositories whose source can inform one another’s reviews.</p></div>
   {admin&&<div className="page-actions"><form action={requestClusterSuggestions}><input type="hidden" name="organizationId" value={organizationId}/><button><Icon name="magicWand"/>Suggest clusters</button></form>{create}</div>}
  </div>
  <ContextTable label="Repository clusters" columns={["Clusters","Repositories","Index","Status"]} rows={rows} empty={<div className="empty-state"><strong>Review related repos together</strong><p>Group repos that depend on each other so reviews catch changes that break across them.</p></div>}/>
  <p className="ctx-count">Context is read-only and shared only when the review author has access to every source. Each review pins the source revision it retrieves; the revisions in each row show the current index, not a past review’s evidence.</p>
  <p className="ctx-count">Retrieval selects at most 10 files per repository and 100 KB across the retrieved context. Sources can be omitted when indexing, provider access, or the review author’s personal provider identity is unavailable. Inspect a completed review for its actual evidence and coverage limits.</p>
  {admin&&<p className="ctx-count">Suggested clusters come from indexed root manifests (package.json, go.mod, pyproject.toml, requirements.txt, Cargo.toml): one repository using a package another publishes, uncommon shared dependencies, and shared name stems. Nothing is applied until you approve it.</p>}
 </>;
}
