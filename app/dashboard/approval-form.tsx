"use client";
import {repositoryDisplay} from "../../src/provider-display";
import {useActionState,useId,useState} from "react";
import {approvalDefaults} from "../../src/review-settings";
import {saveApprovalPolicy} from "./actions";
import {Row,Switch} from "./settings-ui";
import {LevelSlider} from "./review-controls";
type Policy=typeof approvalDefaults;
const risks=[{value:"low",label:"Low",help:"Approve only low-risk revisions."},{value:"medium",label:"Medium",help:"Approve low- and medium-risk revisions."},{value:"high",label:"High",help:"Approve revisions up to high risk."}];
export function ApprovalPolicyForm({organizationId,policies,teams,repositories}:{organizationId:string;policies:{teamId?:string;repositoryId?:string;policy:Policy}[];teams:{_id:string;name:string}[];repositories:{_id:string;fullName:string;teamId?:string}[]}){
 const [scope,setScope]=useState("organization"),[state,action,pending]=useActionState(saveApprovalPolicy,{}),u=useId();
 const repositoryId=scope.startsWith("repository:")?scope.slice(11):undefined,teamId=scope.startsWith("team:")?scope.slice(5):undefined,repo=repositories.find(r=>r._id===repositoryId);
 const own=policies.find(p=>p.repositoryId===repositoryId&&p.teamId===teamId);
 const parent=policies.find(p=>!p.repositoryId&&p.teamId===repo?.teamId&&p.teamId)?.policy??policies.find(p=>!p.repositoryId&&!p.teamId)?.policy??approvalDefaults;
 const value=own?.policy??parent;
 return <form className="stack settings-card policy-card" action={action}>
  <input name="organizationId" type="hidden" value={organizationId}/>
  <Row id={u+"scope"} title="Approval scope" help="Teams and repositories inherit the organization policy until they save their own."><select id={u+"scope"} name="scope" value={scope} onChange={e=>setScope(e.target.value)}><option value="organization">Organization defaults</option>{teams.map(t=><option key={t._id} value={"team:"+t._id}>{t.name} · team</option>)}{repositories.map(r=><option key={r._id} value={"repository:"+r._id}>{repositoryDisplay(r)} · repository</option>)}</select></Row>
  <fieldset key={scope} className="plain"><legend className="policy-source"><span className="badge">{own?"Explicit policy":"Inherited policy"}</span></legend>
   <Row id={u+"enabled"} title="Automatically approve eligible revisions"><Switch id={u+"enabled"} name="enabled" on={value.enabled} help={false}/></Row>
   <LevelSlider id={u+"risk"} name="maximumRisk" title="Maximum risk" stops={risks} value={value.maximumRisk}/>
   <Row id={u+"paths"} title="Excluded file globs, one per line" className="field-row"><textarea id={u+"paths"} name="excludedPaths" defaultValue={value.excludedPaths.join("\n")} maxLength={30000}/></Row>
   <Row id={u+"authors"} title="Excluded authors, one per line" className="field-row"><textarea id={u+"authors"} name="excludedAuthors" defaultValue={value.excludedAuthors.join("\n")} maxLength={10000}/></Row>
   <Row id={u+"checks"} title="Additional required checks, one per line" className="field-row" help="Use a check name and optional GitHub App ID separated by |. Native provider requirements are always checked. Approval adapters support GitHub Cloud/Enterprise, GitLab, Gitea, Cursor Origin and Bitbucket Cloud/Data Center; each connection requires its native approval permissions. Missing permissions or unsupported provider rules block approval."><textarea id={u+"checks"} name="requiredChecks" placeholder="regression | 12345" defaultValue={value.requiredChecks.map(c=>c.name+(c.appId?" | "+c.appId:"")).join("\n")} maxLength={22000} aria-describedby={u+"checks-help"}/></Row>
   <p className="card-note">Enabling this policy authorizes OpenReview to publish approvals after a complete current-revision review, maximum confidence, zero unresolved findings, passing required checks, and no human change request. New revisions and policy changes invalidate prior approvals. OpenReview never merges.</p>
   {/* Save comes first so Enter in a field saves; the footer shows it on the right. */}
   <div className="card-footer"><button className="primary" disabled={pending}>{pending?"Saving…":"Save approval policy"}</button>{scope!=="organization"&&<button name="inherit" value="true" disabled={pending}>Sync from parent</button>}</div>
  </fieldset>{state.error&&<p className="form-message" role="alert">{state.error}</p>}{state.saved&&<p className="form-message" role="status">Approval policy saved.</p>}
 </form>;
}
