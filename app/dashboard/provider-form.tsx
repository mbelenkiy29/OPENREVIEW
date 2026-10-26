"use client";
import { useActionState,useEffect,useRef,useState,startTransition,type ReactNode } from "react";
import { Dialog,useCloseDialog } from "../ui/dialog";
import { Icon,type IconName } from "../ui/icons";
import { connectProvider,refreshP4Ticket,replaceGitCredentials,activateBitbucket,authorizeBitbucket,revokeBitbucketAuthorization,updateProviderNetwork } from "./actions";
const permissions:Record<string,string>={
 gitlab:"Use a dedicated bot token with api scope and Developer-or-higher project access. Enable merge request, push, and comment webhooks for reviews and follow-ups.",
 gitea:"Use a dedicated bot token with repository and issue write, organization and user read. Grant repository admin for follow-ups: Gitea requires it to verify another author's permissions. Enable pull request, review, comment, and push webhooks.",
 "github-enterprise":"Supply JSON with appId, privateKey, and installationId for your GitHub App installation. Grant contents read, pull requests write, issues read, and checks read. Subscribe to pull request, review, review comment, issue comment, and push events for reviews and follow-ups. Use the instance root for Enterprise Server. For GHE.com, use your dedicated subdomain; the operator must authorize both its web host and api.SUBDOMAIN.ghe.com in SCM_ALLOWED_HOSTS. Link your personal author identity separately in Personal agents.",
 "bitbucket-dc":'Supply JSON with token and username for a dedicated bot with repository write: {"token":"<HTTP access token>","username":"<bot username>"}. Follow-ups check the author’s current repository write access through Bitbucket’s native permission filter, including inherited access. Authors link their personal HTTP access token in Personal agents for cross-repository context. That link requires the native authenticated X-AUSERNAME response header and read-only user lookup.',
 "azure-devops":'Use a PAT for a dedicated service account with Code (Read & write), Code (Status) and Pull Request Threads (Read & write) scopes, or JSON for a Microsoft Entra service principal added to the organization: {"tenantId":"…","clientId":"…","clientSecret":"…"}. Instance URL is your organization, e.g. https://dev.azure.com/your-organization. Create service hooks (Web Hooks) for "Pull request created", "Pull request updated" and "Code pushed" pointing at the webhook URL shown after connecting, with HTTP header X-OpenReview-Token: <webhook secret> (or Basic authentication with the secret as password). Follow-up @openreview commands are not yet supported on Azure DevOps.',
 perforce:'Supply JSON with username and a P4 login ticket: {"username":"<bot username>","ticket":"<P4 ticket>"}. Use a dedicated bot with read access only to the selected project depot paths and permission to comment on the selected native reviews. Enter the HTTPS P4 Code Review (Swarm) URL, not the P4 server address. Ticket expiry and revocation are managed by P4. Hosted indexing uses openreview p4 index/upload or the opt-in openreview p4 watch worker with an OpenReview admin API key. After indexing finishes, inspect native reviews and choose Review archived shelf to analyze and publish at its exact revision. Optional review polling can be enabled after indexing. Personal bridge setup supports P4 agent fixes. Opt-in runtime validation requires an approved Docker worker and command using depot-relative paths. Automatic approval remains unavailable.',
};
export function GitCredentialRefreshForm({connectionId,kind}:{connectionId:string;kind:string}){
 const [state,action,pending]=useActionState(replaceGitCredentials,{});
 return <details><summary>Replace provider credential</summary><form action={action} className="form-grid policy-form"><input type="hidden" name="connectionId" value={connectionId}/><p>{permissions[kind]}</p><p>OpenReview verifies access to every selected repository before saving. The existing connection and webhook remain configured.</p><label>Replacement provider credential<input name="credential" type="password" minLength={10} maxLength={20000} autoComplete="new-password" required/></label><button disabled={pending}>{pending?"Verifying access…":"Verify and replace credential"}</button>{state.error&&<p role="alert">{state.error}</p>}{state.saved&&<p role="status">Credential replaced. Retry the failed import, discovery or review when ready.</p>}</form></details>;
}
// Self-managed GitLab behind corporate networks: internal API URL, extra CA certificates, HTTPS proxy.
function NetworkFields({apiUrl,proxyUrl}:{apiUrl?:string;proxyUrl?:string}){
 return <>
  <p className="muted">Leave these empty unless OpenReview must reach the GitLab API at a different address than the one people use, through a private certificate authority, or through a proxy. The instance URL above stays the address used in links.</p>
  <label>Internal API URL (optional)<input name="apiUrl" type="url" defaultValue={apiUrl} placeholder="https://gitlab.internal.example"/></label>
  <label>Custom CA certificates, PEM (optional; added to the public roots)<textarea name="caBundle" autoComplete="off" spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----"/></label>
  <label>HTTPS proxy (optional; the operator must allow it in SCM_ALLOWED_PROXIES)<input name="proxyUrl" type="url" defaultValue={proxyUrl} placeholder="http://proxy.internal.example:3128"/></label>
 </>;
}
export function GitlabNetworkForm({connectionId,apiUrl,proxyUrl,caCertificates}:{connectionId:string;apiUrl?:string;proxyUrl?:string;caCertificates:number}){
 const [state,action,pending]=useActionState(updateProviderNetwork,{});
 return <details><summary>Network settings</summary><p>{apiUrl?"API URL "+apiUrl:"API calls use the instance URL"} · {caCertificates?caCertificates+" custom CA certificate"+(caCertificates===1?"":"s"):"Public certificate authorities only"} · {proxyUrl?"Proxy "+proxyUrl:"No proxy"}</p><form action={action} className="form-grid policy-form"><input type="hidden" name="connectionId" value={connectionId}/><NetworkFields apiUrl={apiUrl} proxyUrl={proxyUrl}/><p className="muted">Saving replaces all three settings; paste the CA certificates again to keep them. OpenReview checks every selected repository with the new settings first.</p><button disabled={pending}>{pending?"Checking repositories…":"Save network settings"}</button>{state.error&&<p role="alert">{state.error}</p>}{state.saved&&<p role="status">Network settings saved.</p>}</form></details>;
}
export function ProviderForm({organizationId,kind}:{organizationId:string;kind:string}){
 const [state,action,pending]=useActionState(connectProvider,{});
 // Close the Add Provider dialog once a submission finishes without an error.
 const close=useCloseDialog(),sent=useRef(false);
 useEffect(()=>{if(pending)sent.current=true;else if(sent.current){sent.current=false;if(!state.error)close();}},[pending,state,close]);
 return <form action={action} onSubmit={e=>{e.preventDefault();const data=new FormData(e.currentTarget);startTransition(()=>action(data));}} className="form-grid policy-form">
  <input type="hidden" name="organizationId" value={organizationId}/>
  <input type="hidden" name="kind" value={kind}/>
  <label>Connection name<input name="name" maxLength={100} required/></label>
  <label>Instance URL<input name="instance" type="url" placeholder={kind==="gitlab"?"https://gitlab.com":kind==="bitbucket-dc"?"https://bitbucket.example/bitbucket":kind==="azure-devops"?"https://dev.azure.com/your-organization":"https://git.example"} required/></label>
  <p className="muted" id="provider-permissions">{permissions[kind]} Credentials are encrypted on the server. Self-managed hosts must be authorized by the operator in SCM_ALLOWED_HOSTS.</p>
  <label>Credential<textarea name="credential" required autoComplete="off" spellCheck={false} aria-describedby="provider-permissions"/></label>
  {kind==="gitlab"&&<details><summary>Network: internal API URL, CA certificates, proxy</summary><NetworkFields/></details>}
  {kind!=="perforce"&&<label>Webhook secret (keep a copy for provider setup)<input name="webhookSecret" type="password" minLength={32} required autoComplete="new-password"/></label>}
  <button className="primary" disabled={pending}>{pending?"Checking provider…":"Connect provider"}</button>
  {state.error&&<p role="alert">{state.error}</p>}
 </form>;
}
export function BitbucketAuthorizationForm({organizationId}:{organizationId:string}){
 const [state,action,pending]=useActionState(authorizeBitbucket,{}),[revoked,setRevoked]=useState("");
 return <><form action={action}><input type="hidden" name="organizationId" value={organizationId}/><button disabled={pending}>{pending?"Authorizing…":"Create installation authorization"}</button></form>
 {state.error&&<p role="alert">{state.error}</p>}
 {state.code&&state.id!==revoked&&<><p>Paste this single-use code into OpenReview’s settings page in your Bitbucket workspace. It expires at {new Date(state.expiresAt!).toISOString()}. Keep it private.</p><label>Installation authorization code<input readOnly value={state.code} autoComplete="off" spellCheck={false}/></label><form action={async form=>{await revokeBitbucketAuthorization(form);setRevoked(state.id!);}}><input type="hidden" name="id" value={state.id}/><button>Revoke authorization</button></form></>}
 {revoked===state.id&&revoked&&<p role="status">Installation authorization revoked.</p>}</>;
}

export function BitbucketActivationForm({connectionId,ready}:{connectionId:string;ready:boolean}){
 const [state,action,pending]=useActionState(activateBitbucket,{});
 return <form action={action}><input type="hidden" name="connectionId" value={connectionId}/><button disabled={!ready||pending}>{pending?"Verifying native access…":"Verify access and activate"}</button>{state.error&&<p role="alert">{state.error}</p>}</form>;
}

export function P4TicketRefreshForm({connectionId}:{connectionId:string}){
 const [state,action,pending]=useActionState(refreshP4Ticket,{});
 return <details><summary>Renew existing P4 bot ticket</summary><p>Generate a new P4 login ticket for the same bot account, then enter it here. OpenReview verifies that account and every selected project before replacing its encrypted ticket. Renewal stops review polling and requires a fresh submitted baseline; re-enable polling after indexing completes.</p><form action={action}><input type="hidden" name="connectionId" value={connectionId}/><label>Renewed P4 bot ticket<input name="ticket" type="password" autoComplete="off" required minLength={10} maxLength={10000}/></label><button disabled={pending}>{pending?"Verifying ticket…":"Verify and renew bot ticket"}</button></form>{state.error&&<p role="alert">{state.error}</p>}{state.saved&&<p role="status">Bot ticket verified. Upload a current submitted baseline before reviewing; existing native permission limits still apply.</p>}</details>;
}

const providers:{kind:string;label:string;icon:IconName}[]=[
 {kind:"github",label:"GitHub",icon:"githubLogo"},{kind:"gitlab",label:"GitLab",icon:"gitlabLogo"},{kind:"bitbucket-cloud",label:"Bitbucket Cloud",icon:"gitBranch"},
 {kind:"bitbucket-dc",label:"Bitbucket Data Center",icon:"gitBranch"},{kind:"azure-devops",label:"Azure DevOps",icon:"gitBranch"},{kind:"github-enterprise",label:"GitHub Enterprise",icon:"githubLogo"},
 {kind:"gitea",label:"Gitea",icon:"gitBranch"},{kind:"perforce",label:"Perforce",icon:"database"},{kind:"origin",label:"Cursor Origin",icon:"code"},
];
// Add Provider: every provider OpenReview supports, and the selected one's connect form.
export function AddProvider({organizationId,githubHref,linkHref,bitbucket,origin,initial="github",trigger,triggerClassName}:{organizationId:string;githubHref:string;linkHref:string;bitbucket:boolean;origin:boolean;initial?:string;trigger:ReactNode;triggerClassName?:string}){
 const [kind,setKind]=useState(initial);
 return <Dialog trigger={trigger} triggerClassName={triggerClassName} size="wide" title="Add Provider" description="Choose where your code lives, then connect it.">
  <div className="modal-body add-provider">
   <div className="provider-picker" role="group" aria-label="Provider">{providers.map(p=><button key={p.kind} type="button" aria-pressed={kind===p.kind} onClick={()=>setKind(p.kind)}><Icon name={p.icon}/>{p.label}</button>)}</div>
   {kind==="github"?<div className="provider-connect"><p>Install the OpenReview GitHub App and choose which repositories it can access.</p><p className="row-start"><a className="button primary" href={githubHref}><Icon name="githubLogo"/>Install GitHub App</a><a href={linkHref}>Link an existing installation</a></p></div>
   :kind==="bitbucket-cloud"?<div className="provider-connect"><p>Connect the OpenReview Forge installation from a Bitbucket workspace you own. Automatic reviews require verified event delivery and token refresh.</p>{bitbucket?<BitbucketAuthorizationForm organizationId={organizationId}/>:<p role="status" className="muted">Ask your operator to register and deploy the OpenReview Forge app before connecting.</p>}</div>
   :kind==="origin"?<div className="provider-connect"><p>Install the OpenReview Origin App, approve repository contents, pull requests, reviews, and checks, then choose repositories. Mirrored repositories permit indexing but Origin rejects pull request access and writes.</p>{origin?<><p className="row-start"><a className="button primary" href={"/api/origin/install?organization="+organizationId}>Connect Cursor Origin</a></p><p className="muted">Origin installation requests namespace:user_tokens:write for verified personal author links. This lets the app mint user tokens for active namespace members. OpenReview mints read-only, repository-limited tokens after personal confirmation; native admin consent is required.</p></>:<p role="status" className="muted">Origin setup is required before connecting. Ask your OpenReview administrator to register the app. <a href="https://cursor.com/docs/api/origin" target="_blank" rel="noreferrer">Origin App setup instructions</a></p>}</div>
   :<ProviderForm key={kind} organizationId={organizationId} kind={kind}/>}
  </div>
 </Dialog>;
}
