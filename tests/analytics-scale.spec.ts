import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import type {Id} from '../convex/_generated/dataModel';
const modules=import.meta.glob('../convex/**/*.ts');
const secret='analytics-scale-secret-at-least-32-characters',now=Date.UTC(2026,9,14,12);
beforeEach(()=>{vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});vi.setSystemTime(now);Object.assign(process.env,{SESSION_SECRET:secret,SERVICE_SECRET:'scale-service'});});
afterEach(()=>{vi.useRealTimers();});

// Convex's real per-function limits: 16,384 documents and 8MB read, 1,000 functions scheduled (enforce a stricter 500).
async function setup(){
 const t=convexTest({schema,modules,transactionLimits:{documentsRead:16384,bytesRead:8*1024*1024,functionsScheduled:500}});
 const id=await t.mutation(api.users.login,{secret:'scale-service',githubId:7,login:'admin',avatar:''});
 const token=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(id).setExpirationTime('1h').sign(new TextEncoder().encode(secret));
 const organizationId=await t.mutation(api.users.createOrganization,{token,name:'Busy'});
 const repositoryId=await t.run(ctx=>ctx.db.insert('repositories',{organizationId,fullName:'busy/app',defaultBranch:'main',enabled:true,indexStatus:'pending',createdAt:1}));
 return {t,token,organizationId,repositoryId};
}

test('report stays under the read limit for a busy period and says the totals are capped',async()=>{
 const {t,token,organizationId,repositoryId}=await setup();
 await t.run(async ctx=>{for(const [n,at] of [[1,now-3000],[2,now-1000]])await ctx.db.insert('reviews',{organizationId,repositoryId,prNumber:n,headSha:'a'.repeat(40),status:'completed',mode:'standard',attempts:1,createdAt:at,updatedAt:at});});
 for(let c=0;c<2;c++)await t.run(async ctx=>{for(let i=0;i<8500;i++)await ctx.db.insert('usageEvents',{organizationId,repositoryId,kind:'review',inputTokens:1,outputTokens:1,estimatedCost:0.01,durationMs:1,createdAt:now-10000+i});});
 const period={token,organizationId,since:now-86400000,until:now};
 const report=await t.query(api.analytics.report,period);
 expect(report.capped).toBe(true);
 expect(report.totalReviews).toBe(2);
 expect(report.recent.map(r=>r.prNumber)).toEqual([2,1]);
 expect(report.tokens).toBe(8000);
 expect((await t.query(api.analytics.report,{...period,until:now-10001})).capped).toBe(false);
});

test('report stays under the 8MB byte limit when reviews and findings carry full text',async()=>{
 const {t,token,organizationId,repositoryId}=await setup();
 const reviewIds=await t.run(async ctx=>{const ids:Id<'reviews'>[]=[];for(let i=0;i<600;i++)ids.push(await ctx.db.insert('reviews',{organizationId,repositoryId,prNumber:i,headSha:'a'.repeat(40),status:'completed',mode:'standard',attempts:1,summary:'s'.repeat(5000),createdAt:now-60000+i,updatedAt:now}));return ids;});
 await t.run(async ctx=>{for(let i=0;i<1000;i++)await ctx.db.insert('findings',{organizationId,repositoryId,reviewId:reviewIds[599-(i%100)],prNumber:1,title:'t',description:'d'.repeat(1500),severity:'high',confidence:0.9,category:'correctness',filePath:'a.ts',startLine:1,endLine:1,commitSha:'a'.repeat(40),evidence:[{filePath:'a.ts',startLine:1,quote:'q'.repeat(500)}],impact:'i'.repeat(300),suggestedFix:'f'.repeat(700),symbol:'s',fingerprint:'fp'+i,agent:'correctness',status:'open',createdAt:now-50000+i,updatedAt:now});});
 await t.run(async ctx=>{for(let i=0;i<8000;i++)await ctx.db.insert('usageEvents',{organizationId,repositoryId,reviewId:reviewIds[599],kind:'review',inputTokens:1,outputTokens:1,estimatedCost:0.01,durationMs:1,createdAt:now-40000+i});});
 const report=await t.query(api.analytics.report,{token,organizationId,since:now-86400000,until:now});
 expect([report.capped,report.totalReviews,report.findings]).toEqual([true,250,700]);
});

test('trends read the newest days first and flag a capped period',async()=>{
 const {t,token,organizationId,repositoryId}=await setup();
 const row=(day:string)=>({organizationId,repositoryId,day,author:'ana',reviews:1,completed:1,findings:0,high:0,addressed:0,useful:0,notUseful:0,updatedAt:now});
 for(let c=0;c<2;c++)await t.run(async ctx=>{for(let i=0;i<8245;i++)await ctx.db.insert('analyticsDaily',row('2026-10-01'));});
 await t.run(async ctx=>{for(let i=0;i<10;i++)await ctx.db.insert('analyticsDaily',row('2026-10-14'));});
 const trends=await t.query(api.analytics.trends,{token,organizationId,since:Date.UTC(2026,9,1),until:now});
 expect(trends.capped).toBe(true);
 expect(trends.days.at(-1)).toMatchObject({day:'2026-10-14',reviews:10});
 expect(trends.totals.reviews).toBe(15000);
});

test('the rollup sweep pages organizations, schedules under the limit, and covers every org-day',async()=>{
 const {t}=await setup();
 const orgs=await t.run(async ctx=>{const ids:Id<'organizations'>[]=[(await ctx.db.query('organizations').first())!._id];for(let i=1;i<29;i++)ids.push(await ctx.db.insert('organizations',{name:'Org '+i,createdAt:0}));return ids;});
 const jobs=()=>t.run(ctx=>ctx.db.system.query('_scheduled_functions').collect());
 const counts=[await t.mutation(internal.analyticsRollup.sweep,{days:35})],done=new Set<string>();
 for(;;){
  const next=(await jobs()).filter(j=>j.name.includes('analyticsRollup:sweep')&&!done.has(j._id));
  if(!next.length)break;
  for(const j of next){done.add(j._id);counts.push(await t.mutation(internal.analyticsRollup.sweep,j.args[0] as never));}
 }
 expect(counts.every(n=>n<=480)).toBe(true);
 expect(counts.length).toBeGreaterThan(1);
 const rollups=(await jobs()).filter(j=>j.name.includes('analyticsRollup:rollupDay')).map(j=>j.args[0] as {organizationId:string;day:string});
 const covered=new Set(rollups.map(r=>`${r.organizationId}|${r.day}`));
 expect(covered.size).toBe(29*35);
 expect(rollups).toHaveLength(29*35);
 expect(new Set(rollups.map(r=>r.organizationId))).toEqual(new Set(orgs));
 expect(new Set(rollups.map(r=>r.day)).has('2026-09-10')).toBe(true);
});
