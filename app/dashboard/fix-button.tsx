"use client";
import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { launchFix } from "./actions";
import { defaultLocalAgent, localAgentLabels, localAgents } from "../../src/fix-agents";
const bridgeFinal=["finished","failed","expired"],bridgeUnavailable="Unable to read bridge status. Check your local bridge terminal.";
// Polls /api/fixes/<id> every 2 seconds until the request reaches one of the final statuses.
export function useFixStatus(id:string|undefined,final:string[],unavailable:string){
 const [status,setStatus]=useState<{status:string;error?:string;pullRequestUrl?:string}>({status:"pending"});
 useEffect(()=>{
  if(!id)return;
  let stopped=false;
  const poll=async()=>{
   try{const response=await fetch("/api/fixes/"+id,{cache:"no-store"});if(!response.ok)throw new Error("Status unavailable");const result=await response.json();if(!stopped){setStatus(result);if(final.includes(result.status))clearInterval(timer);}}
   catch{if(!stopped){setStatus({status:"unavailable",error:unavailable});clearInterval(timer);}}
  };
  const timer=setInterval(poll,2000);void poll();
  return ()=>{stopped=true;clearInterval(timer);};
 },[id,final,unavailable]);
 return status;
}
export function FixButton({reviewId,findingId,label="Fix with AI",agent=defaultLocalAgent,compact}: {reviewId:string;findingId?:string;label?:string;agent?:string;compact?:boolean}) {
 const [state,action,pending]=useActionState(launchFix,{});
 useEffect(()=>{if(state.url)window.location.assign(state.url);},[state.url]);
 const launch=useFixStatus(state.url?new URL(state.url).searchParams.get("request")??undefined:undefined,bridgeFinal,bridgeUnavailable);
 return <div className="fix-control"><form action={action}><input type="hidden" name="reviewId" value={reviewId}/>{findingId&&<input type="hidden" name="findingId" value={findingId}/>}{compact?<input type="hidden" name="agent" value={agent}/>:<><label className="sr-only" htmlFor={`agent-${findingId??reviewId}`}>Coding agent</label><select id={`agent-${findingId??reviewId}`} name="agent" defaultValue={agent}>{localAgents.map(a=><option key={a} value={a}>{localAgentLabels[a]}</option>)}</select></>}<button className="primary" disabled={pending}>{pending?"Preparing…":label}</button></form>{state.error&&<p role="alert" className="error">{state.error}</p>}{state.url&&<p role="status">{launch.status === "finished" ? "Agent exited successfully. Review its diff and test output." : launch.status === "launched" ? "Agent launched." : launch.status === "claimed" ? "Bridge claimed the request; waiting for launch confirmation. Check the local terminal before retrying." : launch.status === "failed" ? "Agent failed: "+launch.error : launch.status === "expired" ? "Request expired. Click Fix to create another." : launch.status === "unavailable" ? launch.error : "Waiting for your local bridge."} <a href={state.url}>Open your agent</a>. <Link href="/dashboard/account/review">Bridge setup</Link> if no window opens. This does not mark the issue resolved.</p>}</div>;
}
