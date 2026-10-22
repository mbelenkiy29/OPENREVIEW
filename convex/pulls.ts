import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {authenticated} from "./auth";
import {contextReadable} from "./repositoryContext";
import {p4BaselineMetadata} from "./p4Index";
import {authorizeRepository,audit} from "./auth";
import { repositoryAccess, visibleRepositories } from "./auth";
type PullDoc=Doc<"pullRequests">;
// Adds the latest readable review and whether the viewer can request one, per row.
async function enrich(ctx:QueryCtx,viewerId:Id<"users">,rows:PullDoc[]){
 const readiness=new Map<string,Promise<{allowed:boolean;baseRevision?:string}>>();
 async function canReview(repositoryId:Id<"repositories">,baseRevision:string){
  if(!readiness.has(repositoryId))readiness.set(repositoryId,(async()=>{try{
   await repositoryAccess(ctx,viewerId,repositoryId,true);const repo=await ctx.db.get(repositoryId),connection=repo?.connectionId?await ctx.db.get(repo.connectionId):null;
   if(connection?.kind==='perforce'){const baseline=await p4BaselineMetadata(ctx,{repositoryId,requestedBy:viewerId});return {allowed:true,baseRevision:baseline.job.sha};}
   return {allowed:Boolean(repo?.enabled&&(!connection||connection.active&&!connection.suspended))};
  }catch{return {allowed:false};}})());const ready=await readiness.get(repositoryId)!;return ready.allowed&&(ready.baseRevision===undefined||ready.baseRevision===baseRevision);
 }
 return Promise.all(rows.map(async pr=>{const latest=await ctx.db.query("reviews").withIndex("by_pr",q=>q.eq("repositoryId",pr.repositoryId).eq("prNumber",pr.number)).order("desc").first();const canRequest=pr.state==='open'&&!pr.headSha.startsWith('p4-status:')&&await canReview(pr.repositoryId,pr.baseSha);return {...pr,canRequest,latest:latest&&await contextReadable(ctx,viewerId,latest)?latest:null};}));
}
const running=new Set(["queued","ingesting","indexing","reviewing","verifying","summarizing","publishing"]);
// Dashboard list: filters apply before paging, so pages are full and the total is exact.
// shortcut: reads at most the newest 1,000 matching changes (500 with review filters); add a counter table or the aggregate component when workspaces outgrow that.
export const browse=query({args:{token:v.string(),organizationId:v.id("organizations"),teamId:v.optional(v.id("teams")),repositoryId:v.optional(v.id("repositories")),author:v.optional(v.string()),state:v.optional(v.string()),search:v.optional(v.string()),status:v.optional(v.string()),impact:v.optional(v.string()),reviewer:v.optional(v.string()),scoreMin:v.optional(v.number()),scoreMax:v.optional(v.number()),page:v.number(),pageSize:v.number()},handler:async(ctx,a)=>{
 const viewer=await authenticated(ctx,a.token);
 const repos=await visibleRepositories(ctx,a.token,a.organizationId,a.teamId),allowed=new Set(repos.map(r=>r._id).filter(id=>!a.repositoryId||id===a.repositoryId));
 if(a.repositoryId&&!allowed.size)throw new Error("Repository not accessible in selected scope");
 if(!Number.isSafeInteger(a.page)||a.page<1||!Number.isSafeInteger(a.pageSize)||a.pageSize<1||a.pageSize>100)throw new Error("Invalid page");
 const reviewFilters=Boolean(a.status||a.impact||a.scoreMin!==undefined||a.scoreMax!==undefined),limit=reviewFilters?500:1000;
 const empty={page:[],total:0,capped:false};
 if(!allowed.size)return empty;
 // The state is read through an index, never filtered while scanning: a filter scan reads every merged
 // change to find a few open ones. "Closed" means every change that is no longer open (Greptile's Closed
 // list), so it reads closed and merged and merges the two lists newest first.
 const read=(state?:string)=>a.search?ctx.db.query("pullRequests").withSearchIndex("by_title",q=>{const s=q.search("title",a.search!).eq("organizationId",a.organizationId);return state?s.eq("state",state):s;}):a.repositoryId?(state?ctx.db.query("pullRequests").withIndex("by_repo_state",q=>q.eq("repositoryId",a.repositoryId!).eq("state",state)):ctx.db.query("pullRequests").withIndex("by_repo_number",q=>q.eq("repositoryId",a.repositoryId!))).order("desc"):(state?ctx.db.query("pullRequests").withIndex("by_org_state",q=>q.eq("organizationId",a.organizationId).eq("state",state)):ctx.db.query("pullRequests").withIndex("by_org",q=>q.eq("organizationId",a.organizationId))).order("desc");
 const lists=await Promise.all((a.state==="closed"?["closed","merged"]:[a.state]).map(state=>read(state).take(limit+1)));
 const scanned=lists.length===1?lists[0]:lists.flat().sort((x,y)=>a.search?0:a.repositoryId?y.number-x.number:y._creationTime-x._creationTime).slice(0,limit+1);
 const author=a.author?.toLowerCase(),reviewer=a.reviewer?.toLowerCase();
 const rows=scanned.filter(pr=>allowed.has(pr.repositoryId)&&(!author||pr.author.toLowerCase()===author)&&(!reviewer||Boolean(pr.requestedReviewers?.some(r=>r.toLowerCase()===reviewer))));
 let matched:PullDoc[]|Awaited<ReturnType<typeof enrich>>=rows.slice(0,limit);
 if(reviewFilters)matched=(await enrich(ctx,viewer._id,rows.slice(0,limit))).filter(pr=>{
  const r=pr.latest&&pr.latest.headSha===pr.headSha?pr.latest:null,score=r?.reviewScore?.value;
  if(a.status&&(a.status==="unreviewed"?r!==null:a.status==="running"?!r||!running.has(r.status):r?.status!==a.status))return false;
  if(a.impact&&r?.approvalAssessment?.risk!==a.impact)return false;
  if(a.scoreMin!==undefined&&(score===undefined||score<a.scoreMin))return false;
  return a.scoreMax===undefined||score!==undefined&&score<=a.scoreMax;
 });
 const page=matched.slice((a.page-1)*a.pageSize,a.page*a.pageSize);
 return {page:reviewFilters?page as Awaited<ReturnType<typeof enrich>>:await enrich(ctx,viewer._id,page as PullDoc[]),total:matched.length,capped:rows.length>limit};
}});

export const observationFields={
 repositoryId:v.id("repositories"),number:v.number(),title:v.string(),author:v.string(),url:v.string(),
 headSha:v.string(),baseSha:v.string(),state:v.string(),revisionKey:v.optional(v.string()),observedAt:v.number(),
 isDraft:v.optional(v.boolean()),additions:v.optional(v.number()),deletions:v.optional(v.number()),changedFiles:v.optional(v.number()),requestedReviewers:v.optional(v.array(v.string())),
};
export type PullObservation={repositoryId:Id<"repositories">;number:number;title:string;author:string;url:string;headSha:string;baseSha:string;state:string;revisionKey?:string;observedAt:number;isDraft?:boolean;additions?:number;deletions?:number;changedFiles?:number;requestedReviewers?:string[]};
// Called only after authenticated provider reads, independently of review policy.
export async function observePull(ctx:MutationCtx,a:PullObservation,options?:{nativePollingAuthorized:boolean}){
 const repo=await ctx.db.get(a.repositoryId);
 // Native P4 uses a separately authorized poll rather than the Git repository enable flag.
 if(!repo||!repo.enabled&&!options?.nativePollingAuthorized)return null;
 if(!Number.isSafeInteger(a.number)||a.number<1||!Number.isFinite(a.observedAt))throw new Error("Invalid change observation");
 const old=await ctx.db.query("pullRequests").withIndex("by_repo_number",q=>q.eq("repositoryId",repo._id).eq("number",a.number)).unique();
 if(old?.nativeObservedAt!==undefined&&old.nativeObservedAt>=a.observedAt)return old._id;
 const {observedAt,...metadata}=a;
 const data={...metadata,organizationId:repo.organizationId,nativeObservedAt:observedAt,updatedAt:Date.now()};
 if(old){await ctx.db.patch(old._id,data);return old._id;}
 return ctx.db.insert("pullRequests",data);
}
export const observe=internalMutation({args:observationFields,handler:observePull});

export const requestContext=internalQuery({args:{token:v.string(),repositoryId:v.id('repositories'),prNumber:v.number(),expectedRevision:v.string(),expectedBaseRevision:v.string()},handler:async(ctx,a)=>{
 const {repo,user}=await authorizeRepository(ctx,a.token,a.repositoryId,true);
 if(!Number.isSafeInteger(a.prNumber)||a.prNumber<1)throw new Error('Invalid change number');
 const pr=await ctx.db.query('pullRequests').withIndex('by_repo_number',q=>q.eq('repositoryId',repo._id).eq('number',a.prNumber)).unique();
 if(!pr||pr.state!=='open')throw new Error('Open change unavailable');
 if(pr.headSha!==a.expectedRevision||pr.baseSha!==a.expectedBaseRevision)throw new Error('Revision changed; refresh the pull request list');
 const connection=repo.connectionId?await ctx.db.get(repo.connectionId):null;
 if(connection?.kind==='perforce'){
  const baseline=await p4BaselineMetadata(ctx,{repositoryId:repo._id,requestedBy:user._id});
  if(!pr.headSha.startsWith('p4:')||baseline.job.sha!==pr.baseSha)throw new Error('Pinned shelf or submitted baseline unavailable; sync native polling and refresh the list');
  return {nativeP4:true,organizationId:repo.organizationId,revisionKey:pr.revisionKey};
 }
 if(!repo.enabled||connection&&(!connection.active||connection.suspended))throw new Error('Repository review access is disabled');
 return {nativeP4:false,organizationId:repo.organizationId,revisionKey:pr.revisionKey};
}});
// One pull request by id or by repository and number, with its latest readable review and review count.
export const get=query({args:{token:v.string(),pullRequestId:v.optional(v.id("pullRequests")),repositoryId:v.optional(v.id("repositories")),number:v.optional(v.number())},handler:async(ctx,a)=>{
 const viewer=await authenticated(ctx,a.token);
 const pr=a.pullRequestId?await ctx.db.get(a.pullRequestId):a.repositoryId&&a.number!==undefined?await ctx.db.query("pullRequests").withIndex("by_repo_number",q=>q.eq("repositoryId",a.repositoryId!).eq("number",a.number!)).unique():null;
 if(!pr)return null;
 await authorizeRepository(ctx,a.token,pr.repositoryId);
 const [row]=await enrich(ctx,viewer._id,[pr]);
 const reviewCount=(await ctx.db.query("reviews").withIndex("by_pr",q=>q.eq("repositoryId",pr.repositoryId).eq("prNumber",pr.number)).take(100)).length;
 return {...row,reviewCount};
}});
// What the dashboard needs to act on a pull request as the signed-in developer: write access in
// OpenReview, a github.com repository, and the GitHub accounts linked to this user.
export const actionTarget=query({args:{token:v.string(),pullRequestId:v.id("pullRequests")},handler:async(ctx,a)=>{
 const pr=await ctx.db.get(a.pullRequestId);if(!pr)throw new Error("Pull request not found");
 const {repo,user}=await authorizeRepository(ctx,a.token,pr.repositoryId,true);
 const connection=repo.connectionId?await ctx.db.get(repo.connectionId):null;
 if(connection||!repo.installationId)throw new Error("Dashboard actions are available for GitHub.com repositories");
 const identities=await ctx.db.query("identities").withIndex("by_user",q=>q.eq("userId",user._id)).collect();
 const githubIds=[...new Set([...identities.filter(i=>i.provider==="github").map(i=>Number(i.providerUserId)),...(user.githubId&&user.githubId>0?[user.githubId]:[])])];
 return {fullName:repo.fullName,number:pr.number,headSha:pr.headSha,state:pr.state,githubIds};
}});
export const recordAction=mutation({args:{token:v.string(),pullRequestId:v.id("pullRequests"),action:v.string()},handler:async(ctx,a)=>{
 const pr=await ctx.db.get(a.pullRequestId);if(!pr)throw new Error("Pull request not found");
 const {user}=await authorizeRepository(ctx,a.token,pr.repositoryId,true);
 await audit(ctx,pr.organizationId,user._id,"pull."+a.action.replace(/[^a-z_]/g,"").slice(0,30),pr._id);
}});
// Read access to one pull request and its repository, for provider reads (checks, discussion).
export const readTarget=internalQuery({args:{token:v.string(),pullRequestId:v.id("pullRequests")},handler:async(ctx,a)=>{
 const pr=await ctx.db.get(a.pullRequestId);if(!pr)throw new Error("Pull request not found");
 const {repo}=await authorizeRepository(ctx,a.token,pr.repositoryId);
 return {repo,pr};
}});
