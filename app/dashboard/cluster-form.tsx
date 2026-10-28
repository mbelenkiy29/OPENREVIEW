"use client";
import {repositoryDisplay} from "../../src/provider-display";
import type {ProviderDisplayIdentity} from "../../src/provider-display";
import {startTransition,useActionState,useState} from "react";
import type {Id} from "../../convex/_generated/dataModel";
import {DialogClose,useCloseDialog} from "../ui/dialog";
import {saveClusterForm} from "./actions";

type Repository={_id:Id<"repositories">;fullName:string;provider:ProviderDisplayIdentity|null;indexedSha?:string;indexStatus:string;enabled:boolean};
// The repo-cluster form inside the Create / Edit cluster dialogs; it closes its dialog once saved.
export function ClusterForm({organizationId,repositories,cluster}:{organizationId:Id<"organizations">;repositories:Repository[];cluster?:{_id:Id<"repositoryClusters">;name:string;repositoryIds:Id<"repositories">[]}}){
 const close=useCloseDialog();
 const [name,setName]=useState(cluster?.name??""),[selected,setSelected]=useState(cluster?.repositoryIds??[] as Id<"repositories">[]);
 const [state,action,pending]=useActionState(async(previous:{error?:string;saved?:boolean},form:FormData)=>{
  const result=await saveClusterForm(previous,form);
  if(result.saved){if(!cluster){setName("");setSelected([]);}close();}
  return result;
 },{});
 return <form onSubmit={event=>{event.preventDefault();const form=new FormData(event.currentTarget);startTransition(()=>action(form));}} className="modal-body ctx-form cluster-form" key={JSON.stringify(cluster)}>
  <input type="hidden" name="organizationId" value={organizationId}/>{cluster&&<input type="hidden" name="id" value={cluster._id}/>}
  <label>Name<input name="name" required maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></label>
  <fieldset><legend>Select 2–20 repositories · {selected.length} selected</legend>{repositories.map(r=><div key={r._id} className="repository-choice-row">
   <label className="check repository-choice"><input type="checkbox" name="repositoryIds" value={r._id} checked={selected.includes(r._id)} onChange={e=>setSelected(e.target.checked?[...selected,r._id]:selected.filter(id=>id!==r._id))}/><span>{repositoryDisplay(r)}</span></label>
   <details><summary className="repository-identity">Indexing details · {repositoryDisplay(r)}</summary><p>Status: {r.indexStatus} · {r.enabled?"Reviews enabled":"Reviews disabled"}</p><p>Current indexed revision: <code>{r.indexedSha??"Not indexed"}</code></p></details>
  </div>)}{!repositories.length&&<p className="muted">No repositories are connected yet.</p>}</fieldset>
  <p className="hint">Reviews record the exact source revisions fetched. A selected repository may be omitted if indexing or current author access is unavailable.</p>
  {state.error&&<p role="alert" className="integration-error">{state.error}</p>}{state.saved&&<p role="status" className="hint">Cluster saved.</p>}
  <div className="modal-footer"><DialogClose>Cancel</DialogClose><button className="primary" disabled={pending}>{pending?"Saving…":cluster?"Save cluster":"Create cluster"}</button></div>
 </form>;
}
