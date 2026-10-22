import {test,expect,vi} from 'vitest';
import {convexTest} from 'convex-test';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
const modules=import.meta.glob('../convex/**/*.ts');
// Above the 32,000 documents-scanned-per-transaction ceiling that the old whole-repository
// `.collect()` in repositories.data would hit on every review and index batch.
const FILES=33_000;
async function setup(){
 const t=convexTest(schema,modules);
 const state=await t.run(async ctx=>{
  const organizationId=await ctx.db.insert('organizations',{name:'Monorepo',createdAt:Date.now()});
  const repositoryId=await ctx.db.insert('repositories',{organizationId,fullName:'fixture/monorepo',defaultBranch:'main',enabled:true,indexStatus:'indexing',createdAt:Date.now()});
  const storageId=await ctx.storage.store(new Blob(['export const value = 1;']));
  // Removal deletes each file's blob, so the swept files get their own.
  for(let i=0;i<FILES;i++)await ctx.db.insert('repositoryFiles',{organizationId,repositoryId,path:`pkg${String(i%50).padStart(2,'0')}/src/file${i}.ts`,sha:'s'+i,storageId:i<2?await ctx.storage.store(new Blob(['own'])):storageId,language:'ts',updatedAt:0});
  const jobId=await ctx.db.insert('indexJobs',{organizationId,repositoryId,sha:'b'.repeat(40),status:'running',total:FILES,processed:0,changed:0,attempts:1,createdAt:Date.now(),updatedAt:Date.now()});
  return {organizationId,repositoryId,jobId};
 });
 return {t,...state};
}
test('a repository above the old read ceiling is served by bounded, need-based reads',async()=>{
 const {t,repositoryId,jobId}=await setup();
 const data=await t.query(internal.repositories.data,{repositoryId});
 expect(data.repo._id).toBe(repositoryId);
 expect('files' in data).toBe(false);
 // Full inventory only through ≤1000-row pages.
 const seen=new Set<string>();let cursor:string|null=null,pages=0;
 for(;;){
  const page:{files:{path:string}[];cursor:string;done:boolean}=await t.query(internal.repositories.filePage,{repositoryId,cursor,numItems:5000});
  expect(page.files.length).toBeLessThanOrEqual(1000);
  for(const f of page.files)seen.add(f.path);
  pages++;if(page.done)break;cursor=page.cursor;
 }
 expect(seen.size).toBe(FILES);expect(pages).toBeGreaterThanOrEqual(33);
 // A review or index batch looks up exactly the paths it needs.
 const wanted=['pkg07/src/file7.ts','pkg49/src/file32999.ts','missing.ts'];
 expect((await t.query(internal.repositories.filesByPath,{repositoryId,paths:wanted})).map(f=>f.path).sort()).toEqual(wanted.slice(0,2).sort());
 await expect(t.query(internal.repositories.filesByPath,{repositoryId,paths:Array.from({length:201},(_,i)=>'p'+i)})).rejects.toThrow('exceeds 200');
 const under=await t.query(internal.repositories.filesUnder,{repositoryId,directories:['pkg03/src'],paths:[],limit:30});
 expect(under).toHaveLength(30);expect(under.every(f=>f.path.startsWith('pkg03/src/'))).toBe(true);
 // Completion no longer reads or receives the whole inventory: stale files are swept in small batches.
 await expect(t.mutation(internal.repositories.removeIndexedFiles,{repositoryId,jobId,paths:Array.from({length:26},(_,i)=>'x'+i)})).rejects.toThrow('exceeds 25');
 expect(await t.mutation(internal.repositories.removeIndexedFiles,{repositoryId,jobId,paths:['pkg00/src/file0.ts','pkg01/src/file1.ts']})).toBe(true);
 expect(await t.mutation(internal.repositories.finishIndex,{repositoryId,jobId,sha:'b'.repeat(40),processed:FILES-2,knowledgePaths:['pkg00/src/file0.ts','pkg02/src/file2.ts','never-indexed.ts'],removedPaths:['pkg00/src/file0.ts']})).toBe(true);
 const repo=await t.run(ctx=>ctx.db.get(repositoryId));
 expect(repo).toMatchObject({indexStatus:'ready',indexedSha:'b'.repeat(40),knowledgePaths:['pkg00/src/file0.ts','pkg02/src/file2.ts']});
 expect(await t.run(ctx=>ctx.db.get(jobId))).toMatchObject({status:'completed',processed:FILES-2});
 expect((await t.query(internal.repositories.filesByPath,{repositoryId,paths:['pkg00/src/file0.ts','pkg01/src/file1.ts']}))).toHaveLength(0);
},120_000);

test('the recovery sweep finds stuck knowledge past the first 1,000 repositories and clears expired cache in small batches',async()=>{
 vi.useFakeTimers();
 const t=convexTest(schema,modules);
 const stuck=await t.run(async ctx=>{
  const organizationId=await ctx.db.insert('organizations',{name:'Hosted',createdAt:Date.now()});
  for(let i=0;i<1000;i++)await ctx.db.insert('repositories',{organizationId,fullName:`fixture/r${i}`,defaultBranch:'main',enabled:true,indexStatus:'ready',createdAt:Date.now()});
  for(let i=0;i<60;i++)await ctx.db.insert('modelCache',{organizationId,key:`k${i}`,result:'x',expiresAt:Date.now()-1});
  return ctx.db.insert('repositories',{organizationId,fullName:'fixture/stuck',defaultBranch:'main',enabled:true,indexStatus:'ready',knowledgeStatus:'queued',knowledgeUpdatedAt:Date.now()-20*60000,createdAt:Date.now()});
 });
 await t.mutation(internal.recovery.sweep,{});
 const scheduled=await t.run(ctx=>ctx.db.system.query('_scheduled_functions').collect());
 expect(scheduled.some(s=>s.name.includes('knowledgeJobs')&&(s.args[0] as {repositoryId:string}).repositoryId===stuck)).toBe(true);
 expect(scheduled.some(s=>s.name.includes('sweepCache'))).toBe(true);
 await t.mutation(internal.recovery.sweepCache,{});
 expect((await t.run(ctx=>ctx.db.query('modelCache').collect())).length).toBe(35);
 expect((await t.run(ctx=>ctx.db.system.query('_scheduled_functions').collect())).filter(s=>s.name.includes('sweepCache')).length).toBe(2);
 vi.useRealTimers();
});

test('a burst of more than 20 webhook reviews in a minute is deferred, not dropped; a manual request still gets the limit error',async()=>{
 vi.useFakeTimers();vi.setSystemTime(Date.UTC(2026,9,14,12,0,10));
 const t=convexTest(schema,modules);
 const repositoryId=await t.run(async ctx=>ctx.db.insert('repositories',{organizationId:await ctx.db.insert('organizations',{name:'Busy',createdAt:Date.now()}),fullName:'fixture/busy',defaultBranch:'main',enabled:true,indexStatus:'ready',createdAt:Date.now()}));
 const enqueue=(pr:number,trigger:'automatic'|'manual')=>t.mutation(internal.reviews.enqueue,{repositoryId,prNumber:pr,headSha:String(pr).padStart(40,'a'),trigger});
 for(let pr=1;pr<=20;pr++)await enqueue(pr,'automatic');
 const deferred=await enqueue(21,'automatic');
 expect((await t.run(ctx=>ctx.db.get(deferred!)))?.status).toBe('queued');
 const job=(await t.run(ctx=>ctx.db.system.query('_scheduled_functions').collect())).find(s=>(s.args[0] as {reviewId?:string}).reviewId===deferred);
 expect(job!.scheduledTime).toBe(Date.UTC(2026,9,14,12,1,0)+2000);
 await expect(enqueue(22,'manual')).rejects.toThrow('Rate limit');
 vi.useRealTimers();
});

test('a provider event finds its repository through the connection index, not by reading every repository',async()=>{
 const t=convexTest(schema,modules);
 const {connectionId,target}=await t.run(async ctx=>{
  const organizationId=await ctx.db.insert('organizations',{name:'GitLab shop',createdAt:Date.now()});
  const connectionId=await ctx.db.insert('providerConnections',{organizationId,kind:'gitlab',instance:'https://gitlab.example',name:'GitLab',credentials:'x',webhookSecret:'',active:true,createdAt:Date.now()});
  const other=await ctx.db.insert('providerConnections',{organizationId,kind:'gitlab',instance:'https://gitlab.other',name:'Other',credentials:'x',webhookSecret:'',active:true,createdAt:Date.now()});
  for(let i=0;i<300;i++)await ctx.db.insert('repositories',{organizationId,connectionId,externalId:String(i),fullName:`group/r${i}`,defaultBranch:'main',enabled:true,indexStatus:'ready',createdAt:Date.now()});
  await ctx.db.insert('repositories',{organizationId,connectionId:other,externalId:'42',fullName:'other/r42',defaultBranch:'main',enabled:true,indexStatus:'ready',createdAt:Date.now()});
  return {connectionId,target:(await ctx.db.query('repositories').withIndex('by_connection',q=>q.eq('connectionId',connectionId).eq('externalId','42')).first())!._id};
 });
 expect((await t.query(internal.providerConnections.repository,{connectionId,externalId:'42'}))?._id).toBe(target);
 expect(await t.query(internal.providerConnections.repository,{connectionId,externalId:'missing'})).toBeNull();
 await t.run(ctx=>ctx.db.patch(connectionId,{active:false}));
 expect(await t.query(internal.providerConnections.repository,{connectionId,externalId:'42'})).toBeNull();
});

test('turning off a repository reads only its newest index job, however many old ones it has',async()=>{
 const t=convexTest({schema,modules,transactionLimits:{documentsRead:50}});
 const {repositoryId,running}=await t.run(async ctx=>{
  const organizationId=await ctx.db.insert('organizations',{name:'Busy',createdAt:Date.now()});
  const repositoryId=await ctx.db.insert('repositories',{organizationId,fullName:'fixture/busy',defaultBranch:'main',enabled:true,indexStatus:'indexing',createdAt:Date.now()});
  for(let i=0;i<100;i++)await ctx.db.insert('indexJobs',{organizationId,repositoryId,sha:String(i).padStart(40,'0'),status:'completed',total:1,processed:1,changed:1,attempts:1,createdAt:i,updatedAt:i});
  return {repositoryId,running:await ctx.db.insert('indexJobs',{organizationId,repositoryId,sha:'f'.repeat(40),status:'running',total:1,processed:0,changed:0,attempts:1,createdAt:Date.now(),updatedAt:Date.now()})};
 });
 const {disableRepository}=await import('../convex/repositories');
 await t.run(async ctx=>disableRepository(ctx as never,(await ctx.db.get(repositoryId))!));
 expect(await t.run(ctx=>ctx.db.get(running))).toMatchObject({status:'cancelled'});
 expect(await t.run(ctx=>ctx.db.get(repositoryId))).toMatchObject({enabled:false,indexStatus:'cancelled'});
});

test('a failed webhook is retried for about half an hour; recovery restarts stuck or never-started deliveries and gives up after six attempts',async()=>{
 vi.useFakeTimers();vi.setSystemTime(Date.UTC(2026,9,14,12));
 const t=convexTest(schema,modules);
 const insert=(status:string,attempts:number,updatedAt=Date.now())=>t.run(async ctx=>ctx.db.insert('webhookDeliveries',{deliveryId:`d-${status}-${attempts}-${updatedAt}`,event:'pull_request',payloadStorageId:await ctx.storage.store(new Blob(['{}'])),status,attempts,createdAt:updatedAt,updatedAt}));
 const retries=async(id:string)=>(await t.run(ctx=>ctx.db.system.query('_scheduled_functions').collect())).filter(s=>(s.args[0] as {deliveryId?:string}).deliveryId===id).map(s=>Math.round((s.scheduledTime-Date.now())/1000));
 // The third failure used to be the last; now it waits 4.5 minutes and tries again.
 const third=await insert('processing',3);await t.mutation(internal.webhooks.mark,{deliveryId:third,status:'failed',error:'GitHub 502'});
 expect(await retries(third)).toEqual([270]);
 const sixth=await insert('processing',6);await t.mutation(internal.webhooks.mark,{deliveryId:sixth,status:'failed',error:'GitHub 502'});
 expect(await retries(sixth)).toEqual([]);
 const old=Date.now()-20*60000,queued=await insert('queued',0,old),stuck=await insert('processing',2,old),exhausted=await insert('processing',6,old);
 await t.mutation(internal.recovery.sweep,{});
 expect(await retries(queued)).toEqual([0]);expect(await retries(stuck)).toEqual([0]);expect(await retries(exhausted)).toEqual([]);
 expect(await t.run(ctx=>ctx.db.get(exhausted))).toMatchObject({status:'failed',error:'Webhook recovery attempts exhausted'});
 vi.useRealTimers();
});

test('device pairing is rate limited per caller, so one caller cannot block pairing for everyone',async()=>{
 process.env.SERVICE_SECRET='pair-service';
 const t=convexTest(schema,modules);
 const pair=(i:number,client:string)=>t.mutation(api.bridge.startPair,{secret:'pair-service',hash:i.toString(16).padStart(64,'0'),code:'abcdef123456',name:'Laptop',client});
 for(let i=0;i<30;i++)await pair(i,'203.0.113.9');
 await expect(pair(30,'203.0.113.9')).rejects.toThrow('Rate limit');
 expect(await pair(31,'198.51.100.7')).toBeTruthy();
});
