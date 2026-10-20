import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import {HttpModel} from '../src/engine/model';
import {reviewChange} from '../src/engine/review';
import type {Id} from '../convex/_generated/dataModel';
import type {ReviewInput} from '../src/engine/types';

// Route handlers run for real against convex-test; the review engine itself is stubbed.
const holder=vi.hoisted(()=>({t:undefined as unknown as ReturnType<typeof convexTest>}));
const secret='integration-session-secret-at-least-32-characters';
vi.mock('../src/server',()=>({
 backend:()=>{type Call=(ref:unknown,args:unknown)=>Promise<unknown>;const t=holder.t as unknown as {query:Call;mutation:Call;action:Call};return {query:(ref:unknown,args:unknown)=>t.query(ref,args),mutation:(ref:unknown,args:unknown)=>t.mutation(ref,args),action:(ref:unknown,args:unknown)=>t.action(ref,args)};},
 signSession:(userId:string)=>new SignJWT({}).setProtectedHeader({alg:'HS256'}).setSubject(userId).setIssuer('openreview').setAudience('openreview').setExpirationTime('1h').sign(new TextEncoder().encode('integration-session-secret-at-least-32-characters')),
}));
vi.mock('../src/engine/review',async(original)=>({...await original<typeof import('../src/engine/review')>(),reviewChange:vi.fn()}));
import {POST as startRoute} from '../app/api/reviews/local/route';
import {GET as progressRoute} from '../app/api/reviews/local/[id]/route';

const modules=import.meta.glob('../convex/**/*.ts');
beforeEach(()=>{vi.useFakeTimers();process.env.SESSION_SECRET=secret;process.env.SERVICE_SECRET='integration-service-secret';process.env.LLM_API_KEY='fixture';delete process.env.EMBEDDING_MODEL;delete process.env.BILLING_ENABLED;});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();delete process.env.BILLING_ENABLED;});

async function setup(){
 const t=convexTest(schema,modules);holder.t=t;
 const login=async(githubId:number,name:string)=>{const id=await t.mutation(api.users.login,{secret:'integration-service-secret',githubId,login:name,avatar:''});return {id,token:await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(id).setExpirationTime('1h').sign(new TextEncoder().encode(secret))};};
 const alice=await login(61,'alice'),bob=await login(63,'bob'),mallory=await login(62,'mallory');
 const org=await t.mutation(api.users.createOrganization,{token:alice.token,name:'Acme'});
 const rival=await t.mutation(api.users.createOrganization,{token:mallory.token,name:'Rival'});
 await t.mutation(api.repositories.connect,{token:alice.token,secret:'integration-service-secret',organizationId:org,installationId:61,account:'acme',accountId:1,repositories:[{id:6101,fullName:'acme/shop',defaultBranch:'main'},{id:6102,fullName:'acme/new',defaultBranch:'main'}]});
 await t.mutation(api.repositories.connect,{token:mallory.token,secret:'integration-service-secret',organizationId:rival,installationId:62,account:'rival',accountId:2,repositories:[{id:6201,fullName:'rival/app',defaultBranch:'main'}]});
 const repos=[...await t.query(api.repositories.list,{token:alice.token,organizationId:org}),...await t.query(api.repositories.list,{token:mallory.token,organizationId:rival})];
 const [shop,fresh,rivalRepo]=['acme/shop','acme/new','rival/app'].map(n=>repos.find(r=>r.fullName===n)!);
 const keys=await t.run(async ctx=>{
  await ctx.db.insert('organizationMembers',{organizationId:org,userId:bob.id as Id<'users'>,role:'member'});
  for(const r of [shop,rivalRepo]){
   await ctx.db.patch(r._id,{enabled:true,indexStatus:'ready',indexedSha:'d'.repeat(40)});
   const content='export function total(cents: number, qty: number) {\n  return cents * qty;\n}\n';
   await ctx.db.insert('repositoryFiles',{organizationId:r.organizationId,repositoryId:r._id,path:'src/cart.ts',sha:'blob',storageId:await ctx.storage.store(new Blob([content])),language:'typescript',updatedAt:0});
   await ctx.db.insert('codeChunks',{organizationId:r.organizationId,repositoryId:r._id,filePath:'src/cart.ts',startLine:1,content});
  }
  await ctx.db.patch(fresh._id,{enabled:false});
  const key=async(raw:string,organizationId:Id<'organizations'>,userId:string,scopes:string[])=>{await ctx.db.insert('apiKeys',{organizationId,userId:userId as Id<'users'>,hash:createHash('sha256').update(raw).digest('hex'),name:raw,prefix:raw.slice(0,11),createdAt:0,revoked:false,scopes});return raw;};
  return {read:await key('or_read_key',org,alice.id,['read']),write:await key('or_write_key',org,alice.id,['write']),bob:await key('or_bob_key_x',org,bob.id,['write']),rival:await key('or_rival_key',rival,mallory.id,['admin'])};
 });
 return {t,org,shop,fresh,rivalRepo,keys};
}
const request=(path:string,key?:string,body?:unknown)=>new Request('http://localhost'+path,{method:body===undefined?'GET':'POST',headers:{...(key?{authorization:'Bearer '+key}:{}),'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
const params=(id:string)=>({params:Promise.resolve({id})});
const json=async(r:Response)=>[r.status,await r.json()] as const;
const diff='diff --git a/src/pay.ts b/src/pay.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/pay.ts\n@@ -0,0 +1,2 @@\n+import { total } from "./cart";\n+export const pay = (cents: number) => total(cents, 2);\n';
const upload=(repositoryId:string,extra:object={})=>({repositoryId,baseSha:'a'.repeat(40),headSha:'b'.repeat(40),title:'Add pay',diff,files:[{path:'src/pay.ts',sha:'c'.repeat(40),content:'import { total } from "./cart";\nexport const pay = (cents: number) => total(cents, 2);\n'}],...extra});
const uploads=(t:ReturnType<typeof convexTest>)=>t.run(async ctx=>(await ctx.db.system.query('_storage').collect()).length);

test('a write-scoped key starts a review; read keys, missing keys and bad payloads are refused',async()=>{
 const {t,shop,keys}=await setup();
 expect((await startRoute(request('/api/reviews/local',undefined,upload(shop._id)))).status).toBe(401);
 expect(await json(await startRoute(request('/api/reviews/local',keys.read,upload(shop._id))))).toEqual([403,{error:'This API key does not have the write scope'}]);
 const [bad,body]=await json(await startRoute(request('/api/reviews/local',keys.write,upload(shop._id,{baseSha:'main'}))));
 expect([bad,body.issues[0].path]).toEqual([400,'baseSha']);
 expect((await json(await startRoute(request('/api/reviews/local',keys.write,upload(shop._id,{diff:'x'.repeat(1_000_001)})))))[1].issues[0].path).toBe('diff');
 const before=await uploads(t);
 const [status,started]=await json(await startRoute(request('/api/reviews/local',keys.write,upload(shop._id))));
 expect([status,started.status]).toEqual([202,'queued']);
 expect(await uploads(t)).toBe(before+1);
 const jobs=await t.run(ctx=>ctx.db.system.query('_scheduled_functions').collect());
 expect(jobs.filter(j=>(j.args[0] as {id?:string}).id===started.reviewId).map(j=>j.name).sort()).toEqual(['cliReviewJobs:run','cliReviews:expire','cliReviews:remove']);
});

test('a workspace starts at most 20 reviews a minute; the 21st is refused without keeping the upload',async()=>{
 const {t,shop,keys}=await setup();
 for(let i=0;i<20;i++) expect((await startRoute(request('/api/reviews/local',keys.write,upload(shop._id)))).status).toBe(202);
 const before=await uploads(t);
 expect(await json(await startRoute(request('/api/reviews/local',keys.write,upload(shop._id))))).toEqual([429,{error:'Rate limit exceeded; retry after a minute'}]);
 expect(await uploads(t)).toBe(before);
 expect(await t.run(ctx=>ctx.db.query('cliReviews').collect())).toHaveLength(20);
});

test('repositories outside the workspace, disabled or unindexed ones, and an exhausted plan are refused without keeping the upload',async()=>{
 const {t,org,shop,fresh,rivalRepo,keys}=await setup();
 const before=await uploads(t);
 expect((await startRoute(request('/api/reviews/local',keys.write,upload(rivalRepo._id)))).status).toBe(404);
 expect((await startRoute(request('/api/reviews/local',keys.rival,upload(shop._id)))).status).toBe(404);
 expect(await json(await startRoute(request('/api/reviews/local',keys.write,upload(fresh._id))))).toEqual([409,{error:'acme/new is not enabled in OpenReview. Enable it under Repositories, or review with --local.'}]);
 await t.run(ctx=>ctx.db.patch(fresh._id,{enabled:true}));
 expect((await json(await startRoute(request('/api/reviews/local',keys.write,upload(fresh._id)))))[0]).toBe(409);
 process.env.BILLING_ENABLED='true';
 await t.run(ctx=>ctx.db.patch(org,{planRequired:true}));
 const [status,body]=await json(await startRoute(request('/api/reviews/local',keys.write,upload(shop._id))));
 expect(status).toBe(402);
 expect(body.error).toMatch(/^Billing: /);
 expect(await uploads(t)).toBe(before);
 expect(await t.run(ctx=>ctx.db.query('cliReviews').collect())).toEqual([]);
});

test('the job reviews the upload with index context, records cli-review usage, deletes the upload, and only the requester reads the result',async()=>{
 const {t,shop,keys}=await setup();
 let input:ReviewInput|undefined;
 vi.spyOn(HttpModel.prototype,'generate').mockResolvedValue({value:{ok:true},usage:{task:'review',provider:'openai',model:'gpt-4.1',inputTokens:120,outputTokens:30,latencyMs:7,estimatedCost:0.02,cached:false}});
 vi.mocked(reviewChange).mockImplementation(async(reviewInput,model,stage)=>{
  input=reviewInput;
  await stage!('reviewing');
  await model.generate({task:'review'} as never,z.object({ok:z.boolean()}));
  return {summary:'One issue.',findings:[{filePath:'src/pay.ts',startLine:2,endLine:2,severity:'medium',category:'logic',title:'Quantity is hard-coded',description:'Always charges two.',evidence:[],suggestedFix:'Pass the quantity.',confidence:0.9,fingerprint:'f1',agent:'logic',commitSha:'b'.repeat(40)}],diagrams:[]} as never;
 });
 const before=await uploads(t);
 const [,started]=await json(await startRoute(request('/api/reviews/local',keys.write,upload(shop._id,{mode:'deep',security:true,instructions:'Focus on the retry logic.'}))));
 expect(await json(await progressRoute(request('/api/reviews/local/'+started.reviewId,keys.read),params(started.reviewId)))).toEqual([200,{id:started.reviewId,status:'queued',stage:null,error:null,result:null}]);
 await t.action(internal.cliReviewJobs.run,{id:started.reviewId});
 expect(input?.files.map(f=>f.path)).toContain('src/pay.ts');
 expect(input?.files.find(f=>f.path==='src/pay.ts')?.content).toContain('total(cents, 2)');
 expect(input?.settings?.categories).toEqual(['security']);
 expect(input?.mode).toBe('deep');
 expect(input?.settings?.instructions).toContain('Focus on the retry logic.');
 expect(input?.diff.map(f=>f.path)).toEqual(['src/pay.ts']);
 const [status,body]=await json(await progressRoute(request('/api/reviews/local/'+started.reviewId,keys.read),params(started.reviewId)));
 expect(status).toBe(200);
 expect(body).toMatchObject({status:'completed',error:null,result:{summary:'One issue.',findings:[{filePath:'src/pay.ts',title:'Quantity is hard-coded'}]}});
 expect(await uploads(t)).toBe(before);
 const usage=await t.run(ctx=>ctx.db.query('usageEvents').collect());
 expect(usage.map(u=>[u.kind,u.repositoryId,u.inputTokens,u.estimatedCost])).toEqual([['cli-review',shop._id,120,0.02]]);
 // Another member of the same workspace and other workspaces cannot read it.
 expect((await progressRoute(request('/api/reviews/local/'+started.reviewId,keys.bob),params(started.reviewId))).status).toBe(404);
 expect((await progressRoute(request('/api/reviews/local/'+started.reviewId,keys.rival),params(started.reviewId))).status).toBe(404);
 expect((await progressRoute(request('/api/reviews/local/nope',keys.read),params('nope'))).status).toBe(404);
 // A day later the row is gone.
 await t.mutation(internal.cliReviews.remove,{id:started.reviewId});
 expect((await progressRoute(request('/api/reviews/local/'+started.reviewId,keys.read),params(started.reviewId))).status).toBe(404);
});

test('a failing engine and a review that never finishes end as failed and drop the upload',async()=>{
 const {t,shop,keys}=await setup();
 vi.mocked(reviewChange).mockRejectedValue(new Error('Model unavailable for sk-proj-abcdefghijklmnopqrstuvwxyz123456'));
 const before=await uploads(t);
 const [,failed]=await json(await startRoute(request('/api/reviews/local',keys.write,upload(shop._id))));
 await t.action(internal.cliReviewJobs.run,{id:failed.reviewId});
 const [,body]=await json(await progressRoute(request('/api/reviews/local/'+failed.reviewId,keys.read),params(failed.reviewId)));
 expect(body.status).toBe('failed');
 expect(body.error).toContain('Model unavailable');
 expect(body.error).not.toContain('abcdefghijklmnopqrstuvwxyz');
 const [,stuck]=await json(await startRoute(request('/api/reviews/local',keys.write,upload(shop._id))));
 await t.mutation(internal.cliReviews.expire,{id:stuck.reviewId});
 expect((await json(await progressRoute(request('/api/reviews/local/'+stuck.reviewId,keys.read),params(stuck.reviewId))))[1]).toMatchObject({status:'failed',error:'The review did not finish in time. Run it again.'});
 // A late finish does not overwrite the expiry.
 await t.mutation(internal.cliReviews.finish,{id:stuck.reviewId,result:'{}'});
 expect((await json(await progressRoute(request('/api/reviews/local/'+stuck.reviewId,keys.read),params(stuck.reviewId))))[1].status).toBe('failed');
 expect(await uploads(t)).toBe(before);
});
