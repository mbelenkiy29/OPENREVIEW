import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import type {Id} from '../convex/_generated/dataModel';
import {Github} from '../src/github';
import {HttpModel} from '../src/engine/model';
import type {ModelRequest} from '../src/engine/types';
import type {z} from 'zod';

// Reviews that settings rule out (drafts, size limits) end as "skipped", like Greptile's SKIPPED, not "cancelled".
const modules=import.meta.glob('../convex/**/*.ts');
const secret='review-skipped-session-secret-at-least-32-chars',service='review-skipped-service';
beforeEach(()=>{process.env.SESSION_SECRET=secret;process.env.SERVICE_SECRET=service;process.env.LLM_API_KEY='fixture';});
afterEach(()=>{vi.restoreAllMocks();});

async function setup(){
 const t=convexTest(schema,modules);
 const id=await t.mutation(api.users.login,{secret:service,githubId:72,login:'alice',avatar:''});
 const token=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(id).setExpirationTime('1h').sign(new TextEncoder().encode(secret));
 const org=await t.mutation(api.users.createOrganization,{token,name:'Acme'});
 await t.mutation(api.repositories.connect,{token,secret:service,organizationId:org,installationId:72,account:'acme',accountId:1,repositories:[{id:7201,fullName:'acme/shop',defaultBranch:'main'}]});
 const repo=(await t.query(api.repositories.list,{token,organizationId:org}))[0];
 await t.run(ctx=>ctx.db.patch(repo._id,{enabled:true,indexStatus:'ready',indexedSha:'a'.repeat(40)}));
 const scm=new Github('fixture');vi.spyOn(Github,'installation').mockResolvedValue(scm);
 vi.spyOn(scm,'tree').mockResolvedValue([]);
 const publish=vi.spyOn(scm,'publish').mockResolvedValue({id:5,reused:false,comments:[]});
 const generate=vi.spyOn(HttpModel.prototype,'generate').mockImplementation(async function<T>(request:ModelRequest,validator:z.ZodType<T>){
  const value=request.task.startsWith('review:')?{findings:[]}:request.task==='diagram'?{diagram:null}:{summary:'Totals now divide by 100.',reviewScore:{value:4,reason:'No verified findings.'}};
  return {value:validator.parse(value),usage:{task:request.task,provider:'fixture',model:'fixture',inputTokens:1,outputTokens:1,latencyMs:0,estimatedCost:0,cached:false}};
 });
 const head='1'.repeat(40);
 const pull=(draft:boolean)=>vi.spyOn(scm,'pullRequest').mockResolvedValue({number:1,title:'Totals',body:'',draft,state:'open',html_url:'https://github.com/acme/shop/pull/1',user:{login:'bob'},head:{sha:head,ref:'feature'},base:{sha:'a'.repeat(40),ref:'main'},diff:[{path:'src/total.ts',status:'modified',patch:'@@ -1 +1 @@\n-export const total = (c: number) => c;\n+export const total = (c: number) => c / 100;'},{path:'src/tax.ts',status:'modified',patch:'@@ -1 +1 @@\n-export const tax = 0;\n+export const tax = 1;'}],comments:[],reviews:[],commits:[],checks:[]} as never);
 const run=async()=>{const reviewId=(await t.mutation(internal.reviews.enqueue,{repositoryId:repo._id,prNumber:1,headSha:head}))!;await t.action(internal.jobs.review,{reviewId});return reviewId;};
 const state=(reviewId:Id<'reviews'>)=>t.run(async ctx=>({review:(await ctx.db.get(reviewId))!,runs:await ctx.db.query('reviewRuns').withIndex('by_review',q=>q.eq('reviewId',reviewId)).collect()}));
 return {t,repo,publish,generate,pull,run,state};
}

test('a draft is skipped without model calls, and reviewed once it is marked ready',async()=>{
 const {publish,generate,pull,run,state}=await setup();
 pull(true);
 const skipped=await run();
 const first=await state(skipped);
 expect(first.review.status).toBe('skipped');
 expect(first.review.finishedAt).toBeDefined();
 expect(first.runs.at(-1)).toMatchObject({stage:'skipped',detail:expect.stringMatching(/^Skipped: draft reviews are off/)});
 expect(generate).not.toHaveBeenCalled();
 expect(publish).not.toHaveBeenCalled();
 // ready_for_review keeps the same head: a skipped review must not block the new one.
 pull(false);
 const reviewed=await run();
 expect(reviewed).not.toBe(skipped);
 expect((await state(reviewed)).review.status).toBe('completed');
 expect((await state(skipped)).review.status).toBe('skipped');
});

test('a pull request over the size limit is skipped',async()=>{
 const {t,repo,publish,pull,run,state}=await setup();
 await t.run(async ctx=>{const row=(await ctx.db.query('repositorySettings').withIndex('by_repo',q=>q.eq('repositoryId',repo._id)).unique())!;await ctx.db.patch(row._id,{inherit:false,settings:{...row.settings,maxFiles:1}});});
 pull(false);
 const {review,runs}=await state(await run());
 expect(review.status).toBe('skipped');
 expect(runs.at(-1)?.detail).toMatch(/^Skipped: 2 changed files exceed the configured limit of 1/);
 expect(publish).not.toHaveBeenCalled();
});
