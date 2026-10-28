import { choosePlanMessage, hasEntitlement, planMissing } from "./billing";
import {upgradeNote} from "../src/plans";
import {query,mutation,internalMutation} from "./_generated/server";
import {internal} from "./_generated/api";
import {v} from "convex/values";
import {authorize,visibleRepositories,audit} from "./auth";
import {indexingAccess,enableIndexing} from "./repositories";
import {connectionDigest} from "./indexAuthority";
import type {QueryCtx,MutationCtx} from "./_generated/server";
import type {Doc,Id} from "./_generated/dataModel";
import {repositoryIdentity} from "./repositoryIdentity";
import {settingsValidator} from "./schema";
import {assertValidSettings} from "./scopes";
import {deploymentDefaults,newWorkspaceDefaults,scopeDefaults} from "../src/review-settings";
import {isConfigureStep,isWizardStep,nextStep,stepKeys} from "../src/onboarding-steps";
import {billingConfig} from "../src/billing";
import type {Infer} from "convex/values";

async function setupAccess(ctx:QueryCtx|MutationCtx,repo:Doc<"repositories">){
 const connection=repo.connectionId?await ctx.db.get(repo.connectionId):null;
 if(connection?.kind!=="perforce")return {nativeIndex:false,setupError:await indexingAccess(ctx,repo)};
 return {nativeIndex:true,setupError:connection.organizationId!==repo.organizationId||!connection.active||connection.suspended?"Provider access is disconnected or suspended":!repo.externalId?"Native project identity is unavailable":null};
}
// Setup can finish once a selected repository is indexing (enabled) or uses native Perforce indexing: the rule
// the wizard's step guards apply (indexingStarted in app/dashboard/onboarding/setup.ts).
async function setupReady(ctx:QueryCtx,organization:Doc<"organizations">){
 const repos=await ctx.db.query("repositories").withIndex("by_org",q=>q.eq("organizationId",organization._id)).collect();
 const selected=organization.onboardingRepositoryIds?repos.filter(r=>organization.onboardingRepositoryIds!.includes(r._id)):repos.filter(r=>r.enabled);
 for(const r of selected)if(r.enabled||(r.connectionId&&(await ctx.db.get(r.connectionId))?.kind==="perforce"))return true;
 return false;
}

export const status=query({args:{token:v.string(),organizationId:v.id("organizations")},handler:async(ctx,a)=>{
 const {member}=await authorize(ctx,a.token,a.organizationId),organization=await ctx.db.get(a.organizationId);
 const repositories=await visibleRepositories(ctx,a.token,a.organizationId);
 const selectedIds=organization?.onboardingRepositoryIds??repositories.filter(r=>r.enabled).map(r=>r._id);
 const settings=await ctx.db.query("scopeSettings").withIndex("by_org",q=>q.eq("organizationId",a.organizationId)).collect();
 const rows=await Promise.all(repositories.map(async r=>{
  const access=await setupAccess(ctx,r),job=await ctx.db.query("indexJobs").withIndex("by_repo",q=>q.eq("repositoryId",r._id)).order("desc").first();
  const connectedProvider=r.connectionId?await ctx.db.get(r.connectionId):null;
  const connection=connectedProvider?.organizationId===r.organizationId?connectedProvider:null;
  const provider=await repositoryIdentity(ctx,r);
  const nativeReady=Boolean(connection&&!access.setupError&&r.indexStatus==="ready"&&r.indexedSha&&job?.status==="completed"&&job.organizationId===r.organizationId&&job.sha===r.indexedSha&&job.manifestStorageId&&job.nativeDepot?.connectionId===connection._id&&job.nativeDepot.credentialDigest===await connectionDigest(connection.credentials));
  return {...r,...access,provider,selected:selectedIds.includes(r._id),job,ready:access.nativeIndex?nativeReady:r.enabled&&r.indexStatus==="ready"};
 }));
 const selected=rows.filter(r=>r.selected),configured=settings.some(s=>!s.teamId);
 const installations=await ctx.db.query("githubInstallations").withIndex("by_org",q=>q.eq("organizationId",a.organizationId)).collect();
 const connections=await ctx.db.query("providerConnections").withIndex("by_org",q=>q.eq("organizationId",a.organizationId)).collect();
 const connected=installations.some(c=>c.active)||connections.some(c=>c.active&&!c.suspended);
 // Progress is derived from current authorized state, including connection revocation.
 const unavailableSelection=selectedIds.some(id=>!rows.some(r=>r._id===id));
 const step=!connected?2:unavailableSelection||!selected.length||selected.some(r=>r.setupError)?3:!configured?4:!selected.every(r=>r.ready)?5:6;
 // Bounded code-graph sample for the setup illustration: up to 12 indexed files from each of the
 // first three selected (visible) repositories, plus module references between sampled files.
 const graph:{repository:string;files:string[];edges:[string,string][]}[]=[];
 for(const r of selected.filter(r=>!r.nativeIndex).slice(0,3)){
  const files=(await ctx.db.query("repositoryFiles").withIndex("by_repo",q=>q.eq("repositoryId",r._id)).take(12)).map(f=>f.path),known=new Set(files),edges:[string,string][]=[];
  for(const path of files){const refs=await ctx.db.query("graphModuleReferences").withIndex("by_path",q=>q.eq("repositoryId",r._id).eq("path",path)).first();for(const ref of refs?.references??[])if(known.has(ref.resolvedPath)&&ref.resolvedPath!==path)edges.push([path,ref.resolvedPath]);}
  graph.push({repository:r.fullName,files,edges:edges.slice(0,24)});
 }
 return {repositories:rows,configured,step,unavailableSelection,admin:["owner","admin"].includes(member.role),
  onboarding:organization?.onboarding??null,defaults:scopeDefaults(settings,undefined,deploymentDefaults()),graph,
  connections:{github:installations.filter(i=>i.active).map(i=>({account:i.account})),providers:connections.filter(c=>c.active&&!c.suspended).map(c=>({_id:c._id,kind:c.kind,name:c.name}))}};
}});
export const select=mutation({args:{token:v.string(),organizationId:v.id("organizations"),repositoryIds:v.array(v.id("repositories"))},handler:async(ctx,a)=>{
 const {user}=await authorize(ctx,a.token,a.organizationId,true);
 const repos=await visibleRepositories(ctx,a.token,a.organizationId),ids=[...new Set(a.repositoryIds)];
 if(!ids.length||ids.length!==a.repositoryIds.length)throw new Error("Select at least one repository without duplicates");
 for(const id of ids){const r=repos.find(r=>r._id===id);if(!r)throw new Error("Repository is outside this workspace");const {setupError}=await setupAccess(ctx,r);if(setupError)throw new Error(setupError);}
 await ctx.db.patch(a.organizationId,{onboardingRepositoryIds:ids});await audit(ctx,a.organizationId,user._id,"onboarding.repositories_selected",a.organizationId);
}});
export const start=mutation({args:{token:v.string(),organizationId:v.id("organizations"),pauseReviews:v.optional(v.boolean())},handler:async(ctx,a)=>{
 const {user}=await authorize(ctx,a.token,a.organizationId,true),organization=await ctx.db.get(a.organizationId);
 const settings=await ctx.db.query("scopeSettings").withIndex("by_org",q=>q.eq("organizationId",a.organizationId)).collect();
 if(!settings.some(s=>!s.teamId)){
  if(!a.pauseReviews)throw new Error("Save workspace behavior before indexing");
  // Guided setup indexes while behavior is still being configured: hold automatic reviews until the
  // triggers step (or the end of setup) decides them.
  await ctx.db.insert("scopeSettings",{organizationId:a.organizationId,settings:{...deploymentDefaults(),...newWorkspaceDefaults,automatic:false},overrideKeys:["automatic",...Object.keys(newWorkspaceDefaults)]});
  await ctx.db.patch(a.organizationId,{onboarding:{...(organization?.onboarding??{startedAt:Date.now()}),reviewsPaused:true}});
  await audit(ctx,a.organizationId,user._id,"onboarding.reviews_paused",a.organizationId);
 }
 const repos=await visibleRepositories(ctx,a.token,a.organizationId),ids=organization?.onboardingRepositoryIds??repos.filter(r=>r.enabled).map(r=>r._id);
 if(!ids.length)throw new Error("Select repositories before indexing");
 const enable:Id<"repositories">[]=[];
 for(const id of ids){const r=repos.find(r=>r._id===id);if(!r)throw new Error("Selected repository is unavailable");const access=await setupAccess(ctx,r);if(access.setupError)throw new Error(access.setupError);if(!access.nativeIndex)enable.push(id);}
 if(!enable.length)throw new Error("Use native Perforce indexing setup for the selected repositories");
 await enableRepositories(ctx,a.organizationId,enable);
 await audit(ctx,a.organizationId,user._id,"onboarding.indexing_started",a.organizationId);
}});
// A new repository schedules a catalog and an index job and Convex allows 1,000 scheduled functions per mutation, so enable 100 per transaction and continue with the rest.
async function enableRepositories(ctx:MutationCtx,organizationId:Id<"organizations">,ids:Id<"repositories">[]){
 for(const id of ids.slice(0,100)){const r=await ctx.db.get(id);if(r?.organizationId===organizationId&&!(await setupAccess(ctx,r)).setupError)await enableIndexing(ctx,r);}
 if(ids.length>100)await ctx.scheduler.runAfter(0,internal.onboarding.enableBatch,{organizationId,repositoryIds:ids.slice(100)});
}
export const enableBatch=internalMutation({args:{organizationId:v.id("organizations"),repositoryIds:v.array(v.id("repositories"))},handler:(ctx,a)=>enableRepositories(ctx,a.organizationId,a.repositoryIds)});

// Guided setup: each configuration step writes only its own workspace defaults.
export const saveDefaults=mutation({args:{token:v.string(),organizationId:v.id("organizations"),step:v.string(),settings:settingsValidator},handler:async(ctx,a)=>{
 const {user}=await authorize(ctx,a.token,a.organizationId,true);
 if(!isConfigureStep(a.step))throw new Error("Unknown setup step");
 const allowed=stepKeys[a.step],rows=await ctx.db.query("scopeSettings").withIndex("by_org",q=>q.eq("organizationId",a.organizationId)).collect(),row=rows.find(s=>!s.teamId);
 const changes=Object.fromEntries(allowed.map(key=>[key,(a.settings as Record<string,unknown>)[key]]).filter(([,value])=>value!==undefined));
 // The tools step offers Pro options disabled on lower plans; refuse them here too.
 if(changes.fixPullRequests===true&&!await hasEntitlement(ctx,a.organizationId,"fix.pullRequests"))throw new Error(upgradeNote["fix.pullRequests"]);
 if(changes.mode==="deep"&&!await hasEntitlement(ctx,a.organizationId,"review.deep"))throw new Error("Deep reviews are on the Pro plan; a workspace admin can upgrade in Organization Settings → Billing & Usage.");
 const merged={...(row?.settings??{...deploymentDefaults(),...newWorkspaceDefaults}),...changes} as Infer<typeof settingsValidator>,overrideKeys=[...new Set([...(row?.overrideKeys??Object.keys(newWorkspaceDefaults)),...allowed])];
 assertValidSettings(merged,overrideKeys);
 if(row)await ctx.db.patch(row._id,{settings:merged,overrideKeys});else await ctx.db.insert("scopeSettings",{organizationId:a.organizationId,settings:merged,overrideKeys});
 const organization=await ctx.db.get(a.organizationId);
 await ctx.db.patch(a.organizationId,{onboarding:{...(organization?.onboarding??{startedAt:Date.now()}),step:a.step,...(a.step==="triggers"?{reviewsPaused:false}:{})}});
 await audit(ctx,a.organizationId,user._id,"settings.updated",a.organizationId);
 await audit(ctx,a.organizationId,user._id,"onboarding.step_completed",a.step);
}});
export const advance=mutation({args:{token:v.string(),organizationId:v.id("organizations"),step:v.string()},handler:async(ctx,a)=>{
 const {user}=await authorize(ctx,a.token,a.organizationId,true);
 if(!isWizardStep(a.step)||isConfigureStep(a.step)||a.step==="done")throw new Error("Unknown setup step");
 if(await planMissing(ctx,a.organizationId))throw new Error(choosePlanMessage);
 const organization=await ctx.db.get(a.organizationId);
 await ctx.db.patch(a.organizationId,{onboarding:{...(organization?.onboarding??{startedAt:Date.now()}),step:a.step}});
 await audit(ctx,a.organizationId,user._id,"onboarding.step_completed",a.step);
 // The step to show next; the plan step only exists where this deployment bills workspaces.
 return nextStep(a.step,billingConfig().enabled)??"done";
}});
// Setup is only ever finished from its last step; there is no skipping it, so an unfinished workspace keeps its
// setup prompt (the dashboard banner and the landing redirect) until then.
export const complete=mutation({args:{token:v.string(),organizationId:v.id("organizations")},handler:async(ctx,a)=>{
 const {user}=await authorize(ctx,a.token,a.organizationId,true),organization=await ctx.db.get(a.organizationId);
 if(await planMissing(ctx,a.organizationId))throw new Error(choosePlanMessage);
 if(!organization||!await setupReady(ctx,organization))throw new Error("Select a repository and start indexing before finishing setup");
 const onboarding=organization.onboarding??{startedAt:Date.now()};
 if(onboarding.reviewsPaused){
  // Finished without saving the triggers step (the last step opens once indexing starts): release the hold so
  // automatic reviews follow the defaults.
  const row=(await ctx.db.query("scopeSettings").withIndex("by_org",q=>q.eq("organizationId",a.organizationId)).collect()).find(s=>!s.teamId);
  if(row)await ctx.db.patch(row._id,{settings:{...row.settings,automatic:true},overrideKeys:row.overrideKeys.filter(k=>k!=="automatic")});
  await audit(ctx,a.organizationId,user._id,"onboarding.reviews_resumed",a.organizationId);
 }
 await ctx.db.patch(a.organizationId,{onboarding:{...onboarding,step:"done",reviewsPaused:false,completedAt:Date.now(),completedBy:user._id,skipped:false}});
 await audit(ctx,a.organizationId,user._id,"onboarding.completed",a.organizationId);
}});
// Workspaces that left setup with the old Exit setup before any repository was indexing count as unfinished
// again, so they are prompted until they finish; those already reviewing stay done. Run once per deployment:
// `npx convex run onboarding:reopenSkippedSetups '{"confirm":"reopen-skipped-setups"}' --prod`.
export const reopenSkippedSetups=internalMutation({args:{confirm:v.literal("reopen-skipped-setups")},handler:async(ctx):Promise<number>=>{
 let reopened=0;
 for(const organization of await ctx.db.query("organizations").collect()){
  const onboarding=organization.onboarding;
  if(!onboarding?.skipped||!onboarding.completedAt||await setupReady(ctx,organization))continue;
  await ctx.db.patch(organization._id,{onboarding:{startedAt:onboarding.startedAt,reviewsPaused:false,skipped:false}});
  reopened++;
 }
 return reopened;
}});
