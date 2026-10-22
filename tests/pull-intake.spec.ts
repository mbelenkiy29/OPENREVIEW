import {test,expect,vi,afterEach} from "vitest";
import {convexTest} from "convex-test";
import {SignJWT} from "jose";
import schema from "../convex/schema";
import {api,internal} from "../convex/_generated/api";
import {Github} from "../src/github";
const modules=import.meta.glob("../convex/**/*.ts");
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
async function setup(){
 process.env.SESSION_SECRET="pull-intake-session-secret-long-enough";process.env.SERVICE_SECRET="pull-intake-service";
 const t=convexTest(schema,modules),user=await t.mutation(api.users.login,{secret:process.env.SERVICE_SECRET,githubId:4001,login:"intake",avatar:""});
 const token=await new SignJWT({}).setSubject(user).setProtectedHeader({alg:"HS256"}).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET));
 const organizationId=await t.mutation(api.users.createOrganization,{token,name:"Intake"});
 await t.mutation(api.repositories.connect,{token,secret:process.env.SERVICE_SECRET,organizationId,installationId:9401,account:"intake",accountId:4001,repositories:[{id:9410,fullName:"intake/example",defaultBranch:"main"}]});
 const [repo]=await t.query(api.repositories.list,{token,organizationId});await t.run(ctx=>ctx.db.patch(repo._id,{enabled:true}));
 const observation={repositoryId:repo._id,number:1,title:"Pending manual review",author:"alice",url:"https://github.com/intake/example/pull/1",headSha:"a".repeat(40),baseSha:"b".repeat(40),state:"open",observedAt:200};
 return {t,token,organizationId,repo,observation};
}
test("never-reviewed changes paginate and filter without scheduling a review; stale intake and review cannot replace current metadata",async()=>{
 const s=await setup();
 for(let number=1;number<=31;number++)await s.t.mutation(internal.pulls.observe,{...s.observation,number});
 const first=await s.t.query(api.pulls.browse,{token:s.token,organizationId:s.organizationId,page:1,pageSize:30});
 expect(first.page).toHaveLength(30);expect(first.total).toBe(31);expect(first.page.every(p=>p.latest===null)).toBe(true);
 const second=await s.t.query(api.pulls.browse,{token:s.token,organizationId:s.organizationId,page:2,pageSize:30});expect(second.page).toHaveLength(1);
 await s.t.mutation(internal.pulls.observe,{...s.observation,title:"New revision",headSha:"c".repeat(40),revisionKey:"native-new",observedAt:300});
 await s.t.mutation(internal.pulls.observe,{...s.observation,state:"closed",observedAt:250});
 await s.t.mutation(internal.webhooks.lifecycle,{repositoryId:s.repo._id,prNumber:1,action:"closed",state:"closed",observedAt:250});
 const reviewId=await s.t.run(ctx=>ctx.db.insert("reviews",{organizationId:s.organizationId,repositoryId:s.repo._id,prNumber:1,headSha:s.observation.headSha,status:"ingesting",mode:"standard",attempts:1,createdAt:Date.now(),updatedAt:Date.now()}));
 await s.t.mutation(internal.reviews.recordPr,{reviewId,title:"Old title",author:"alice",url:s.observation.url,headSha:s.observation.headSha,baseSha:s.observation.baseSha,state:"closed",commits:[s.observation.headSha]});
 const filtered=await s.t.query(api.pulls.browse,{token:s.token,organizationId:s.organizationId,search:"New revision",state:"open",author:"alice",page:1,pageSize:30});
 expect(filtered.page).toHaveLength(1);expect(filtered.page[0]).toMatchObject({headSha:"c".repeat(40),state:"open",title:"New revision",revisionKey:"native-new"});
 expect(await s.t.run(ctx=>ctx.db.query("reviews").collect())).toHaveLength(1);
});
test("GitHub automatic-off intake uses native current metadata even for an obsolete close event",async()=>{
 vi.useFakeTimers();const s=await setup();
 await s.t.run(async ctx=>{const settings=await ctx.db.query("repositorySettings").withIndex("by_repo",q=>q.eq("repositoryId",s.repo._id)).unique();await ctx.db.patch(settings!._id,{settings:{...settings!.settings,automatic:false}});});
 const github=new Github("fixture");vi.spyOn(Github,"installation").mockResolvedValue(github);
 const request=vi.spyOn(github,"request").mockResolvedValue({number:1,title:"Reopened manually",html_url:s.observation.url,state:"open",draft:false,user:{login:"alice"},head:{sha:"c".repeat(40),ref:"feature"},base:{sha:s.observation.baseSha,ref:"main"}});
 const deliveryId=await s.t.run(async ctx=>{const payloadStorageId=await ctx.storage.store(new Blob([JSON.stringify({action:"closed",installation:{id:9401},repository:{id:9410},pull_request:{number:1,draft:false,state:"closed",head:{sha:s.observation.headSha,ref:"feature"},base:{ref:"main"}}})]));return ctx.db.insert("webhookDeliveries",{deliveryId:"intake-stale-close",event:"pull_request",payloadStorageId,status:"queued",attempts:0,createdAt:Date.now(),updatedAt:Date.now()});});
 await s.t.action(internal.webhookJobs.process,{deliveryId});
 expect(await s.t.query(internal.webhooks.data,{deliveryId})).toMatchObject({status:"completed"});
 const rows=await s.t.query(api.pulls.browse,{token:s.token,organizationId:s.organizationId,page:1,pageSize:30});
 expect(rows.page[0]).toMatchObject({title:"Reopened manually",state:"open",headSha:"c".repeat(40),latest:null});
 expect(request).toHaveBeenCalledTimes(1);expect(await s.t.run(ctx=>ctx.db.query("reviews").collect())).toHaveLength(0);
});

test("merged lifecycle cancels active reviews, preserves completed evidence and rejects older open observations",async()=>{
 const s=await setup();await s.t.mutation(internal.pulls.observe,s.observation);
 const ids=await s.t.run(async ctx=>{
  const common={organizationId:s.organizationId,repositoryId:s.repo._id,prNumber:1,headSha:s.observation.headSha,mode:"standard",attempts:1,createdAt:Date.now(),updatedAt:Date.now()};
  return {active:await ctx.db.insert("reviews",{...common,status:"reviewing"}),completed:await ctx.db.insert("reviews",{...common,status:"completed"})};
 });
 await s.t.mutation(internal.webhooks.lifecycle,{repositoryId:s.repo._id,prNumber:1,action:"closed",state:"merged",observedAt:300});
 await s.t.mutation(internal.pulls.observe,{...s.observation,title:"Delayed open event",observedAt:250});
 await s.t.mutation(internal.webhooks.lifecycle,{repositoryId:s.repo._id,prNumber:1,action:"closed",state:"closed",observedAt:250});
 expect(await s.t.run(ctx=>ctx.db.query("pullRequests").first())).toMatchObject({state:"merged",nativeObservedAt:300,title:s.observation.title});
 expect(await s.t.run(ctx=>ctx.db.get(ids.active))).toMatchObject({status:"cancelled"});
 expect(await s.t.run(ctx=>ctx.db.get(ids.completed))).toMatchObject({status:"completed"});
});

test("initial enabled setup imports two pages durably without reviews, rejects replayed cursor and preserves a newer webhook",async()=>{
 vi.useFakeTimers();const s=await setup();
 const scm=new Github("fixture"),page=vi.spyOn(scm,"openChanges").mockImplementation(async(_repo,cursor)=>({numbers:cursor===null?Array.from({length:30},(_,i)=>i+1):[31],next:cursor===null?"2":null}));
 vi.spyOn(Github,"installation").mockResolvedValue(scm);
 const metadata=vi.spyOn(scm,"changeMetadata").mockImplementation(async(_repo,number)=>({number,title:"Existing PR "+number,html_url:s.observation.url,state:"open",draft:false,user:{login:"alice"},head:{sha:s.observation.headSha,ref:"feature"},base:{sha:s.observation.baseSha,ref:"main"}}));
 await s.t.mutation(api.repositories.configure,{token:s.token,repositoryId:s.repo._id,enabled:true});
 const [job]=await s.t.run(ctx=>ctx.db.query("pullCatalogJobs").collect());expect(job.status).toBe("queued");expect(await s.t.mutation(api.pullCatalogs.sync,{token:s.token,repositoryId:s.repo._id})).toBe(job._id);
 await s.t.action(internal.pullCatalogJobs.step,{id:job._id});
 expect(await s.t.run(ctx=>ctx.db.get(job._id))).toMatchObject({status:"queued",cursor:"2",processed:30,pages:1});
 await s.t.mutation(internal.pulls.observe,{...s.observation,number:31,title:"New webhook",headSha:"c".repeat(40),observedAt:Date.now()+1000});
 await s.t.action(internal.pullCatalogJobs.step,{id:job._id});expect(await s.t.run(ctx=>ctx.db.get(job._id))).toMatchObject({status:"completed",processed:31,pages:2});
 await s.t.action(internal.pullCatalogJobs.step,{id:job._id});expect(page).toHaveBeenCalledTimes(2);expect(metadata).toHaveBeenCalledTimes(31);
 const records=await s.t.run(ctx=>ctx.db.query("pullRequests").collect());expect(records).toHaveLength(31);expect(records.find(r=>r.number===31)).toMatchObject({title:"New webhook",headSha:"c".repeat(40)});expect(await s.t.run(ctx=>ctx.db.query("reviews").collect())).toHaveLength(0);
 const next=await s.t.mutation(api.pullCatalogs.sync,{token:s.token,repositoryId:s.repo._id}),leaseId="repeated";await s.t.mutation(internal.pullCatalogs.claim,{id:next,leaseId});
 await s.t.mutation(internal.pullCatalogs.finishPage,{id:next,leaseId,rows:[{...s.observation,observedAt:Date.now()}],next:"same"});await s.t.mutation(internal.pullCatalogs.claim,{id:next,leaseId:"next"});
 await expect(s.t.mutation(internal.pullCatalogs.finishPage,{id:next,leaseId:"next",rows:[s.observation],next:"same"})).rejects.toThrow("repeated");
});
test("catalog failures retry the page atomically, revoked access cancels import, and viewers cannot synchronize",async()=>{
 vi.useFakeTimers();const s=await setup(),scm=new Github("fixture");vi.spyOn(Github,"installation").mockResolvedValue(scm);vi.spyOn(scm,"openChanges").mockResolvedValue({numbers:[1],next:null});
 const metadata=vi.spyOn(scm,"changeMetadata").mockRejectedValueOnce(Error("Native transient failure")).mockResolvedValue({number:1,title:"Existing PR",html_url:s.observation.url,state:"open",draft:false,user:{login:"alice"},head:{sha:s.observation.headSha,ref:"feature"},base:{sha:s.observation.baseSha,ref:"main"}});
 const id=await s.t.mutation(api.pullCatalogs.sync,{token:s.token,repositoryId:s.repo._id});await s.t.action(internal.pullCatalogJobs.step,{id});expect(await s.t.run(ctx=>ctx.db.get(id))).toMatchObject({status:"queued",attempts:1,pages:0,processed:0,error:"Native transient failure"});expect(await s.t.run(ctx=>ctx.db.query("pullRequests").collect())).toHaveLength(0);
 await s.t.action(internal.pullCatalogJobs.step,{id});expect(await s.t.run(ctx=>ctx.db.get(id))).toMatchObject({status:"completed",processed:1});
 const revoked=await s.t.mutation(api.pullCatalogs.sync,{token:s.token,repositoryId:s.repo._id});metadata.mockImplementation(async()=>{await s.t.run(ctx=>ctx.db.patch(s.repo._id,{enabled:false}));return {number:1,title:"Must not save",html_url:s.observation.url,state:"closed",draft:false,user:{login:"alice"},head:{sha:"d".repeat(40),ref:"feature"},base:{sha:s.observation.baseSha,ref:"main"}};});
 await s.t.action(internal.pullCatalogJobs.step,{id:revoked});await s.t.action(internal.pullCatalogJobs.step,{id:revoked});expect(await s.t.run(ctx=>ctx.db.get(revoked))).toMatchObject({status:"cancelled"});expect((await s.t.run(ctx=>ctx.db.query("pullRequests").first()))?.title).toBe("Existing PR");
 await s.t.run(async ctx=>{const member=await ctx.db.query("organizationMembers").withIndex("by_org",q=>q.eq("organizationId",s.organizationId)).first();await ctx.db.patch(member!._id,{role:"viewer"});});
 await expect(s.t.mutation(api.pullCatalogs.sync,{token:s.token,repositoryId:s.repo._id})).rejects.toThrow("Forbidden");
 const other=await s.t.mutation(api.users.createOrganization,{token:s.token,name:"Other catalog"});await expect(s.t.query(api.pullCatalogs.list,{token:s.token,organizationId:other,repositoryId:s.repo._id})).rejects.toThrow("accessible");
});

test("catalog recovery reaches expired work beyond 1,000 live jobs and does not duplicate pending dispatches",async()=>{
 vi.useFakeTimers();const s=await setup(),now=Date.now();
 const targets=await s.t.run(async ctx=>{
  const common={repositoryId:s.repo._id,organizationId:s.organizationId,authority:"fixture",cursor:null,seenCursors:[],processed:0,pages:0,attempts:0,createdAt:now,updatedAt:now};
  const ids=[];
  for(const status of ["queued","running"]){
   for(let i=0;i<1000;i++)await ctx.db.insert("pullCatalogJobs",{...common,status,lease:{id:"live",expiresAt:now+600000}});
   ids.push(await ctx.db.insert("pullCatalogJobs",{...common,status,lease:{id:"expired",expiresAt:now-1}}));
  }
  return ids;
 });
 for(const status of ["queued","running"] as const){
  let cursor:string|null=null,pages=0;
  for(;;){const page:{isDone:boolean;cursor:string}=await s.t.mutation(internal.pullCatalogs.recoverPage,{status,cursor});pages++;if(page.isDone)break;cursor=page.cursor;}
  expect(pages).toBe(11);
 }
 const before=await s.t.run(ctx=>Promise.all(targets.map(id=>ctx.db.get(id))));
 for(const job of before){expect(job?.status).toBe("queued");expect(job?.lease).toBeUndefined();expect(job?.scheduledId).toBeDefined();}
 await s.t.mutation(internal.pullCatalogs.recover,{});
 // The recovered running job moved into queued after its cursor scan. Walk queued again to exercise overlap.
 let cursor:string|null=null;
 for(;;){const page:{isDone:boolean;cursor:string}=await s.t.mutation(internal.pullCatalogs.recoverPage,{status:"queued",cursor});if(page.isDone)break;cursor=page.cursor;}
 const after=await s.t.run(ctx=>Promise.all(targets.map(id=>ctx.db.get(id))));
 expect(after.map(job=>job?.scheduledId)).toEqual(before.map(job=>job?.scheduledId));
 const late=await s.t.run(ctx=>ctx.db.insert("pullCatalogJobs",{repositoryId:s.repo._id,organizationId:s.organizationId,authority:"fixture",status:"queued",cursor:null,seenCursors:[],processed:0,pages:0,attempts:0,createdAt:now,updatedAt:now}));
 await s.t.mutation(internal.pullCatalogs.recover,{});
 await s.t.finishAllScheduledFunctions(()=>vi.runAllTimersAsync());
 // Scheduled continuations actually drain; authority revalidation cancels these synthetic bindings.
 const drained=await s.t.run(ctx=>Promise.all(targets.map(id=>ctx.db.get(id))));
 expect(drained.every(job=>job?.status==="cancelled")).toBe(true);
 expect(await s.t.run(ctx=>ctx.db.get(late))).toMatchObject({status:"cancelled",error:"Repository connection changed; restart import"});
 expect(await s.t.run(ctx=>ctx.db.query("pullCatalogJobs").withIndex("by_status",q=>q.eq("status","running")).collect())).toHaveLength(1000);
 expect(await s.t.run(ctx=>ctx.db.query("reviews").collect())).toHaveLength(0);
});

test('catalog Git requests reject stale native revisions, coalesce duplicate clicks and preserve legacy re-review',async()=>{
 vi.useFakeTimers();const s=await setup();await s.t.mutation(internal.pulls.observe,s.observation);
 const scm=new Github('fixture');vi.spyOn(Github,'installation').mockResolvedValue(scm);
 let nativeHead='c'.repeat(40);const native=vi.spyOn(scm,'pullRequest').mockImplementation(async()=>({state:'open',head:{sha:nativeHead}} as Awaited<ReturnType<Github['pullRequest']>>));
 const request={token:s.token,repositoryId:s.repo._id,prNumber:1,expectedRevision:s.observation.headSha,expectedBaseRevision:s.observation.baseSha};
 await expect(s.t.action(api.pullReviewJobs.request,{...request,expectedRevision:'obsolete'})).rejects.toThrow('Revision changed');expect(native).not.toHaveBeenCalled();
 await expect(s.t.action(api.pullReviewJobs.request,request)).rejects.toThrow('Revision changed');expect(await s.t.run(ctx=>ctx.db.query('reviews').collect())).toHaveLength(0);
 nativeHead=s.observation.headSha;const id=await s.t.action(api.pullReviewJobs.request,request);expect(id).not.toBeNull();expect(await s.t.action(api.pullReviewJobs.request,request)).toBe(id);expect(await s.t.run(ctx=>ctx.db.query('reviews').collect())).toHaveLength(1);
 nativeHead='c'.repeat(40);const next=await s.t.action(api.providerJobs.rereview,{token:s.token,repositoryId:s.repo._id,prNumber:1});expect(next).not.toBe(id);expect(await s.t.run(ctx=>ctx.db.get(next!))).toMatchObject({status:'queued',headSha:nativeHead});
 expect(await s.t.run(ctx=>ctx.db.query('modelCalls').collect())).toHaveLength(0);
 await s.t.mutation(api.reviews.cancel,{token:s.token,reviewId:next!});await s.t.finishAllScheduledFunctions(vi.runAllTimers);
});
test("browse filters before paging, counts the total and filters on the current review",async()=>{
 const s=await setup();
 for(let number=1;number<=25;number++)await s.t.mutation(internal.pulls.observe,{...s.observation,number,author:number%2?"alice":"Bob",state:number<=20?"open":"merged",observedAt:200+number});
 const args={token:s.token,organizationId:s.organizationId,pageSize:10};
 const first=await s.t.query(api.pulls.browse,{...args,page:1,state:"open"});
 expect(first.total).toBe(20);expect(first.page).toHaveLength(10);expect(first.capped).toBe(false);
 expect((await s.t.query(api.pulls.browse,{...args,page:2,state:"open"})).page).toHaveLength(10);
 // Author matches case-insensitively and short pages never happen.
 const bob=await s.t.query(api.pulls.browse,{...args,page:1,author:"bob"});expect(bob.total).toBe(12);expect(bob.page).toHaveLength(10);
 const now=Date.now(),review=(number:number,value:number,risk:"low"|"high")=>s.t.run(ctx=>ctx.db.insert("reviews",{organizationId:s.organizationId,repositoryId:s.repo._id,prNumber:number,headSha:s.observation.headSha,status:"completed",mode:"standard",attempts:1,reviewScore:{value,reason:"r"},approvalAssessment:{risk,confidence:.9,reason:"r"},createdAt:now,updatedAt:now}));
 await review(1,5,"low");await review(2,2,"high");await review(3,4,"high");
 expect((await s.t.query(api.pulls.browse,{...args,page:1,scoreMin:4})).page.map(p=>p.number).sort()).toEqual([1,3]);
 expect((await s.t.query(api.pulls.browse,{...args,page:1,impact:"high",scoreMax:3})).page.map(p=>p.number)).toEqual([2]);
 expect((await s.t.query(api.pulls.browse,{...args,page:1,status:"unreviewed",state:"open"})).total).toBe(17);
 expect((await s.t.query(api.pulls.browse,{...args,page:1,state:"closed"})).total).toBe(5);
 await expect(s.t.query(api.pulls.browse,{...args,page:0})).rejects.toThrow("Invalid page");
});
test("GitHub size, draft and requested reviewers are kept on the pull request row",async()=>{
 const s=await setup();
 const {changeMetadataSchema,pullObservation}=await import("../src/change-metadata");
 const pr=changeMetadataSchema.parse({number:7,title:"Sized",html_url:s.observation.url,state:"open",draft:true,user:{login:"alice"},head:{sha:"c".repeat(40),ref:"feature"},base:{sha:"b".repeat(40),ref:"main"},additions:120,deletions:4,changed_files:3,requested_reviewers:[{login:"bob"}],mergeable:true});
 await s.t.mutation(internal.pulls.observe,pullObservation(s.repo._id,pr,500));
 const [row]=(await s.t.query(api.pulls.browse,{token:s.token,organizationId:s.organizationId,page:1,pageSize:10})).page;
 expect(row).toMatchObject({number:7,isDraft:true,additions:120,deletions:4,changedFiles:3,requestedReviewers:["bob"]});
 expect((await s.t.query(api.pulls.browse,{token:s.token,organizationId:s.organizationId,page:1,pageSize:10,reviewer:"BOB"})).page.map(p=>p.number)).toEqual([7]);
 // Providers without these fields (or Gitea's nulls) still parse.
 expect(pullObservation(s.repo._id,changeMetadataSchema.parse({...pr,additions:null,requested_reviewers:null}),1)).toMatchObject({additions:undefined,requestedReviewers:undefined});
});
test("dashboard actions need write access on a GitHub.com repository and report the linked GitHub accounts",async()=>{
 const s=await setup();
 const pullRequestId=await s.t.mutation(internal.pulls.observe,s.observation);
 const target=await s.t.query(api.pulls.actionTarget,{token:s.token,pullRequestId:pullRequestId!});
 expect(target).toMatchObject({fullName:"intake/example",number:1,headSha:"a".repeat(40)});expect(target.githubIds).toContain(4001);
 await s.t.mutation(api.pulls.recordAction,{token:s.token,pullRequestId:pullRequestId!,action:"merge"});
 expect((await s.t.run(ctx=>ctx.db.query("auditEvents").collect())).some(e=>e.action==="pull.merge")).toBe(true);
 // Another workspace's user cannot act on it.
 const other=await s.t.mutation(api.users.login,{secret:process.env.SERVICE_SECRET!,githubId:4002,login:"outsider",avatar:""});
 const otherToken=await new SignJWT({}).setSubject(other).setProtectedHeader({alg:"HS256"}).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET));
 await expect(s.t.query(api.pulls.actionTarget,{token:otherToken,pullRequestId:pullRequestId!})).rejects.toThrow();
 // Repositories behind other provider connections keep their own UI for these actions.
 const connectionId=await s.t.run(ctx=>ctx.db.insert("providerConnections",{organizationId:s.organizationId,kind:"gitlab",instance:"https://gitlab.example",name:"GitLab",credentials:"x",webhookSecret:"x",active:true,createdAt:1}));
 await s.t.run(ctx=>ctx.db.patch(s.repo._id,{connectionId}));
 await expect(s.t.query(api.pulls.actionTarget,{token:s.token,pullRequestId:pullRequestId!})).rejects.toThrow("GitHub.com");
});
test("Reviewed marks are per developer and stop counting once the head moves",async()=>{
 const s=await setup(),now=Date.now();
 const reviewId=await s.t.run(ctx=>ctx.db.insert("reviews",{organizationId:s.organizationId,repositoryId:s.repo._id,prNumber:1,headSha:"a".repeat(40),status:"completed",mode:"standard",attempts:1,createdAt:now,updatedAt:now}));
 await s.t.mutation(api.fileReviews.mark,{token:s.token,reviewId,path:"src/a.ts",reviewed:true});
 await s.t.mutation(api.fileReviews.mark,{token:s.token,reviewId,path:"src/b.ts",reviewed:true});
 await s.t.mutation(api.fileReviews.mark,{token:s.token,reviewId,path:"src/b.ts",reviewed:false});
 expect(await s.t.query(api.fileReviews.list,{token:s.token,reviewId})).toEqual(["src/a.ts"]);
 const next=await s.t.run(ctx=>ctx.db.insert("reviews",{organizationId:s.organizationId,repositoryId:s.repo._id,prNumber:1,headSha:"c".repeat(40),status:"completed",mode:"standard",attempts:1,createdAt:now,updatedAt:now}));
 expect(await s.t.query(api.fileReviews.list,{token:s.token,reviewId:next})).toEqual([]);
 await expect(s.t.mutation(api.fileReviews.mark,{token:s.token,reviewId,path:"",reviewed:true})).rejects.toThrow("Invalid path");
});

test("the Open tab reads open changes through the state index, not by scanning merged ones; Closed lists closed and merged newest first",async()=>{
 // convex-test does not count rows a .filter() drops, so this checks the results; the indexes are in convex/schema.ts.
 const s=await setup();
 const base={organizationId:s.organizationId,repositoryId:s.repo._id,title:"Change",author:"alice",url:s.observation.url,headSha:s.observation.headSha,baseSha:s.observation.baseSha,updatedAt:1};
 await s.t.run(async ctx=>{
  await ctx.db.insert("pullRequests",{...base,number:1,state:"open"});
  await ctx.db.insert("pullRequests",{...base,number:2,state:"closed"});
  for(let number=3;number<4003;number++)await ctx.db.insert("pullRequests",{...base,number,state:"merged"});
  await ctx.db.insert("pullRequests",{...base,number:4003,state:"open"});
 });
 const args={token:s.token,organizationId:s.organizationId,pageSize:10,page:1};
 const open=await s.t.query(api.pulls.browse,{...args,state:"open"});
 expect(open.page.map(p=>p.number)).toEqual([4003,1]);expect(open.total).toBe(2);
 const closed=await s.t.query(api.pulls.browse,{...args,state:"closed"});
 expect(closed.capped).toBe(true);expect(closed.page.map(p=>p.number)).toEqual([4002,4001,4000,3999,3998,3997,3996,3995,3994,3993]);
 expect((await s.t.query(api.pulls.browse,{...args,repositoryId:s.repo._id,state:"open"})).page.map(p=>p.number)).toEqual([4003,1]);
});
