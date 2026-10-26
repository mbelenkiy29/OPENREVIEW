"use client";
import {repositoryDisplay} from "../../src/provider-display";
import { useActionState,useId,useState } from "react";
import { saveRuntimePolicy,createRuntimeWorker } from "./actions";
import { runtimeDefaults } from "../../src/review-settings";
import { Row,Switch } from "./settings-ui";
import { Stepper } from "./review-controls";
type Policy=Omit<typeof runtimeDefaults,"generatedTests"|"testCommand">&{generatedTests?:boolean;testCommand?:string};
export function RuntimePolicyForm({organizationId,policies,teams,repositories,reproLocked}:{organizationId:string;policies:{teamId?:string;repositoryId?:string;policy:Policy}[];teams:{_id:string;name:string}[];repositories:{_id:string;fullName:string;teamId?:string}[];reproLocked?:boolean}){
 const [scope,setScope]=useState("organization"),[state,action,pending]=useActionState(saveRuntimePolicy,{}),u=useId();
 const repoId=scope.startsWith("repository:")?scope.slice(11):undefined,teamId=scope.startsWith("team:")?scope.slice(5):undefined,repo=repositories.find(r=>r._id===repoId);
 const own=policies.find(p=>p.repositoryId===repoId&&p.teamId===teamId);
 const parent=policies.find(p=>!p.repositoryId&&p.teamId===(repo?.teamId??teamId)&&p.teamId)?.policy??policies.find(p=>!p.repositoryId&&!p.teamId)?.policy??runtimeDefaults;
 const value=own?.policy??parent;
 return <form className="stack settings-card policy-card" action={action}><input type="hidden" name="organizationId" value={organizationId}/>
  <Row id={u+"scope"} title="Policy scope" help="Teams and repositories inherit the organization policy until they save their own."><select id={u+"scope"} name="scope" value={scope} onChange={e=>setScope(e.target.value)}><option value="organization">Organization defaults</option>{teams.map(t=><option value={"team:"+t._id} key={t._id}>{t.name} · team</option>)}{repositories.map(r=><option value={"repository:"+r._id} key={r._id}>{repositoryDisplay(r)} · repository</option>)}</select></Row>
  <fieldset key={scope} className="plain"><legend className="policy-source"><span className="badge">{own?"Explicit policy":"Inherited policy"}</span></legend>
   <Row id={u+"enabled"} title="Automatically validate reviewed revisions"><Switch id={u+"enabled"} name="enabled" on={value.enabled} help={false}/></Row>
   <Row id={u+"image"} title="Approved image digest" className="field-row"><input id={u+"image"} name="image" defaultValue={value.image} placeholder="node@sha256:…" maxLength={300}/></Row>
   <Row id={u+"command"} title="Approved test command" className="field-row"><input id={u+"command"} name="command" defaultValue={value.command} placeholder="node --test tests/*.test.js" maxLength={2000}/></Row>
   <Row id={u+"timeout"} title="Timeout in seconds"><Stepper id={u+"timeout"} name="timeout" min={1} max={600} value={value.timeout}/></Row>
   <Row id={u+"required"} title="Require successful runtime validation before automatic approval"><Switch id={u+"required"} name="requiredForApproval" value="true" on={value.requiredForApproval} help={false}/></Row>
   <Row id={u+"generated"} title="Generate reproduction tests" help={"Write tests for up to three verified findings and run them in this sandbox. They are never committed."+(reproLocked?" Generated reproduction tests are on the Pro plan; until then each review says why none ran.":"")}><Switch id={u+"generated"} name="generatedTests" value="true" on={!!value.generatedTests}/></Row>
   <Row id={u+"testCommand"} title="Test command template" className="field-row" help={<>{"{test}"} is replaced with the generated test file&apos;s path. The same image, timeout and isolation apply; dependencies must already be in the image.</>}><input id={u+"testCommand"} name="testCommand" maxLength={500} defaultValue={value.testCommand??""} placeholder="node --test {test}" aria-describedby={u+"testCommand-help"}/></Row>
   <p className="card-note">Approving this policy allows repository code to run in the selected container. Execution has no network or application secrets, a read-only root, and bounded CPU, memory, time and output. Dependencies must already exist in the approved image.</p>
   {/* Save comes first so Enter in a field saves; the footer shows it on the right. */}
   <div className="card-footer"><button className="primary" disabled={pending}>{pending?"Saving…":"Save runtime policy"}</button>{scope!=="organization"&&<button name="inherit" value="true" disabled={pending}>Sync from parent</button>}</div>
  </fieldset>{state.error&&<p className="form-message" role="alert">{state.error}</p>}{state.saved&&<p className="form-message" role="status">Runtime policy saved.</p>}</form>;
}
export function RuntimeWorkerForm({organizationId}:{organizationId:string}){
 const [state,action,pending]=useActionState(createRuntimeWorker,{}),u=useId();
 return <form className="stack settings-card policy-card" action={action}><input type="hidden" name="organizationId" value={organizationId}/>
  <Row id={u+"name"} title="Worker name" className="field-row" help="Creates a revocable 90-day credential scoped to this workspace’s approved runtime jobs. It can retrieve the exact source snapshot for jobs it claims. Run the worker on an isolated machine with Docker, separately from the web/backend services."><input id={u+"name"} name="name" maxLength={100} required placeholder="Isolated runtime worker" aria-describedby={u+"name-help"}/></Row>
  <div className="card-footer"><button className="primary" disabled={pending}>{pending?"Creating…":"Create worker credential"}</button></div>
  {state.error&&<p className="form-message" role="alert">{state.error}</p>}
  {state.credential&&<div className="secret-reveal" role="status"><p>Copy once and store securely. The credential is not stored in plaintext by OpenReview.</p><code>{state.credential}</code><p>Start the worker with OPENREVIEW_WORKER_TOKEN set in its private environment:</p><pre>pnpm runtime:worker --url {state.url}</pre></div>}
 </form>;
}
