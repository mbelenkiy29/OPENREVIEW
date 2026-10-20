import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import type {Id} from '../convex/_generated/dataModel';
const modules=import.meta.glob('../convex/**/*.ts');
const secret='analytics-session-secret-at-least-32-characters',day=86400000,d1=Date.UTC(2026,9,10,9),d2=Date.UTC(2026,9,11,15);
beforeEach(()=>{vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});vi.setSystemTime(Date.UTC(2026,9,14,12));Object.assign(process.env,{SESSION_SECRET:secret,SERVICE_SECRET:'analytics-service'});});
afterEach(()=>{vi.useRealTimers();});

async function setup(){
 const t=convexTest(schema,modules);
 const login=async(githubId:number,name:string)=>{const id=await t.mutation(api.users.login,{secret:'analytics-service',githubId,login:name,avatar:''});return {id:id as Id<'users'>,token:await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(id).setExpirationTime('30d').sign(new TextEncoder().encode(secret))};};
 const admin=await login(41,'admin'),member=await login(42,'member');
 const org=await t.mutation(api.users.createOrganization,{token:admin.token,name:'Acme'});
 await t.mutation(api.repositories.connect,{token:admin.token,secret:'analytics-service',organizationId:org,installationId:41,account:'acme',accountId:1,repositories:[{id:4101,fullName:'acme/web',defaultBranch:'main'},{id:4102,fullName:'acme/secret',defaultBranch:'main'}]});
 const repos=await t.query(api.repositories.list,{token:admin.token,organizationId:org});
 const [web,hidden]=['acme/web','acme/secret'].map(n=>repos.find(r=>r.fullName===n)!);
 const ids=await t.run(async ctx=>{
  await ctx.db.insert('organizationMembers',{organizationId:org,userId:member.id,role:'member'});
  await ctx.db.patch(hidden._id,{teamId:await ctx.db.insert('teams',{organizationId:org,name:'Secret',createdAt:0})});
  const review=(repositoryId:Id<'repositories'>,at:number,author:string,status='completed')=>ctx.db.insert('reviews',{organizationId:org,repositoryId,prNumber:1,headSha:'a'.repeat(40),status,mode:'standard',attempts:1,author,createdAt:at,updatedAt:at});
  const r1=await review(web._id,d1,'ana'),r2=await review(web._id,d2,'bo'),r3=await review(hidden._id,d1,'ana'),r4=await review(web._id,d1,'ana','failed');
  const finding=(reviewId:Id<'reviews'>,repositoryId:Id<'repositories'>,at:number,author:string,severity:string,status:string,lastFeedback?:string)=>ctx.db.insert('findings',{organizationId:org,repositoryId,reviewId,prNumber:1,title:'t',description:'d',severity,confidence:0.9,category:'correctness',filePath:'a.ts',startLine:1,endLine:1,commitSha:'a'.repeat(40),evidence:[],impact:'i',suggestedFix:'f',symbol:'s',fingerprint:'fp'+Math.random(),agent:'correctness',status,author,...(lastFeedback?{lastFeedback}:{}),createdAt:at,updatedAt:at});
  const open=await finding(r1,web._id,d1,'ana','high','open','useful');
  await finding(r1,web._id,d1,'ana','low','resolved');await finding(r2,web._id,d2,'bo','critical','resolved','not_useful');await finding(r3,hidden._id,d1,'ana','high','open');
  void r4;
  return {open};
 });
 return {t,admin,member,org,web,hidden,...ids};
}
const roll=async(t:Awaited<ReturnType<typeof setup>>['t'],org:Id<'organizations'>)=>{for(const d of ['2026-10-10','2026-10-11'])await t.mutation(internal.analyticsRollup.rollupDay,{organizationId:org,day:d});};
const period={since:Date.UTC(2026,9,10),until:Date.UTC(2026,9,12)-1};

test('the daily rollup feeds trends: series, addressed rate, time saved, repository and author totals',async()=>{
 const {t,admin,org,web,hidden}=await setup();
 await roll(t,org);
 const trends=await t.query(api.analytics.trends,{token:admin.token,organizationId:org,...period});
 expect(trends.days).toEqual([{day:'2026-10-10',reviews:3,findings:3,high:2,addressed:1,useful:1,notUseful:0,commitAddressed:0,ignored:0},{day:'2026-10-11',reviews:1,findings:1,high:1,addressed:1,useful:0,notUseful:1,commitAddressed:0,ignored:0}]);
 expect(trends.totals).toEqual({reviews:4,findings:4,high:3,addressed:2,useful:1,notUseful:1,commitAddressed:0,ignored:0});
 expect(trends.fixRate).toBeNull();
 expect(trends.addressedRate).toBe(0.5);
 expect([trends.minutesPerFinding,trends.hoursSaved]).toEqual([15,0.5]);
 expect(trends.byRepository.map(r=>[r.label,r.findings,r.reviews])).toEqual([['acme/web',3,3],['acme/secret',1,1]]);
 expect(trends.byAuthor.map(r=>[r.label,r.findings])).toEqual([['@ana',3],['@bo',1]]);
 const rows=await t.run(ctx=>ctx.db.query('analyticsDaily').collect());
 expect(rows.find(r=>r.repositoryId===web._id&&r.day==='2026-10-10'&&r.author==='ana')).toMatchObject({reviews:2,completed:1,findings:2,useful:1});
 expect(rows.some(r=>r.repositoryId===hidden._id)).toBe(true);
 // Filters narrow the aggregates.
 expect((await t.query(api.analytics.trends,{token:admin.token,organizationId:org,...period,author:'@bo'})).totals).toEqual({reviews:1,findings:1,high:1,addressed:1,useful:0,notUseful:1,commitAddressed:0,ignored:0});
 expect((await t.query(api.analytics.trends,{token:admin.token,organizationId:org,...period,repositoryId:web._id})).totals.findings).toBe(3);
});

test('rollups are idempotent, pick up later fixes, and never count repositories the viewer cannot see',async()=>{
 const {t,admin,member,org,open}=await setup();
 await roll(t,org);await roll(t,org);
 expect((await t.query(api.analytics.trends,{token:admin.token,organizationId:org,...period})).totals.findings).toBe(4);
 await t.run(ctx=>ctx.db.patch(open,{status:'resolved'}));
 expect((await t.query(api.analytics.trends,{token:admin.token,organizationId:org,...period})).totals.addressed).toBe(2);
 await roll(t,org);
 expect((await t.query(api.analytics.trends,{token:admin.token,organizationId:org,...period})).totals.addressed).toBe(3);
 const visible=await t.query(api.analytics.trends,{token:member.token,organizationId:org,...period});
 expect(visible.totals).toEqual({reviews:3,findings:3,high:2,addressed:3,useful:1,notUseful:1,commitAddressed:0,ignored:0});
 expect(visible.byRepository.map(r=>r.label)).toEqual(['acme/web']);
 // The sweep schedules one rollup per organization-day.
 expect(await t.mutation(internal.analyticsRollup.sweep,{days:2})).toBe(2);
 expect((await t.run(ctx=>ctx.db.system.query('_scheduled_functions').collect())).filter(j=>j.name.includes('analyticsRollup:rollupDay')).map(j=>(j.args[0] as {day:string}).day)).toEqual(['2026-10-14','2026-10-13']);
});

test('the daily 35-day sweep pages through workspaces, staying under 1,000 scheduled functions per transaction',async()=>{
 const t=convexTest({schema,modules,transactionLimits:true});
 await t.run(async ctx=>{for(let i=0;i<30;i++)await ctx.db.insert('organizations',{name:'Org'+i,createdAt:0});});
 await t.mutation(internal.analyticsRollup.sweep,{days:35});
 await t.finishAllScheduledFunctions(vi.runAllTimers);
 const rollups=(await t.run(ctx=>ctx.db.system.query('_scheduled_functions').collect())).filter(j=>j.name.includes('analyticsRollup:rollupDay'));
 expect([rollups.length,new Set(rollups.map(j=>(j.args[0] as {organizationId:string}).organizationId)).size,rollups.every(j=>j.state.kind==='success')]).toEqual([30*35,30,true]);
});

test('the minutes-per-finding estimate is admin-only, validated and audited',async()=>{
 const {t,admin,member,org}=await setup();
 await roll(t,org);
 await expect(t.mutation(api.analytics.setMinutesPerFinding,{token:member.token,organizationId:org,minutes:30})).rejects.toThrow(/Forbidden/);
 await expect(t.mutation(api.analytics.setMinutesPerFinding,{token:admin.token,organizationId:org,minutes:0})).rejects.toThrow(/1 to 480/);
 await t.mutation(api.analytics.setMinutesPerFinding,{token:admin.token,organizationId:org,minutes:45});
 expect((await t.query(api.analytics.trends,{token:admin.token,organizationId:org,...period})).hoursSaved).toBe(1.5);
 expect((await t.run(ctx=>ctx.db.query('auditEvents').collect())).some(e=>e.action==='analytics.minutes_per_finding_changed'&&e.target==='45')).toBe(true);
 await expect(t.query(api.analytics.trends,{token:admin.token,organizationId:org,since:0,until:400*day})).rejects.toThrow(/at most one year/);
});

test('report adds Greptile-style breakdowns: severity per day, contributors, merge time and most upvoted comments',async()=>{
 const {t,admin,member,org,web,hidden,open}=await setup();
 await t.run(async ctx=>{
  const pr=(repositoryId:Id<'repositories'>,number:number,author:string,openedAt:number|undefined,mergedAt:number)=>ctx.db.insert('pullRequests',{organizationId:org,repositoryId,number,title:'PR',author,url:'u',headSha:'a'.repeat(40),baseSha:'b'.repeat(40),state:'merged',updatedAt:mergedAt,...(openedAt===undefined?{}:{openedAt}),mergedAt});
  await pr(web._id,10,'ana',d1-2*3600000,d1);await pr(web._id,11,'bo',d2-4*3600000,d2);await pr(hidden._id,12,'ana',d1-10*3600000,d1);
  await pr(web._id,13,'ana',undefined,d1); // merged before openedAt was recorded: excluded
  await pr(web._id,14,'ana',d1-3600000,Date.UTC(2026,8,1)); // merged outside the period
  const react=(user:string,reaction:string,findingId?:Id<'findings'>)=>ctx.db.insert('commentReactions',{organizationId:org,repositoryId:web._id,prNumber:1,provider:'github',commentId:'c'+user,user,reaction,createdAt:d1,...(findingId?{findingId}:{})});
  await react('x','+1',open);await react('y','+1',open);await react('z','-1',open);
 });
 const r=await t.query(api.analytics.report,{token:admin.token,organizationId:org,...period});
 expect(r.daily.map(d=>[d.date,d.critical,d.high,d.medium,d.low])).toEqual([['2026-10-10',0,2,0,1],['2026-10-11',1,0,0,0]]);
 expect(r.bugRepositories).toBe(2);
 expect(r.contributors).toEqual([{author:'ana',prs:2,repositories:['acme/web','acme/secret']},{author:'bo',prs:1,repositories:['acme/web']}]);
 expect(r.mergeTime).toMatchObject({count:3,meanMs:16/3*3600000,medianMs:4*3600000});
 expect(r.mergeTime.byRepository.map(x=>[x.repository,x.meanMs/3600000,x.count])).toEqual([['acme/secret',10,1],['acme/web',3,2]]);
 expect(r.mergeTime.daily.map(x=>[x.date,x.meanMs/3600000])).toEqual([['2026-10-10',6],['2026-10-11',4]]);
 expect(r.topComments).toEqual([expect.objectContaining({findingId:open,upvotes:2,repository:'acme/web'})]);
 // Filters and visibility: a member outside the Secret team never sees its merge times.
 expect((await t.query(api.analytics.report,{token:admin.token,organizationId:org,...period,author:'bo'})).mergeTime).toMatchObject({count:1,meanMs:4*3600000,medianMs:4*3600000});
 expect((await t.query(api.analytics.report,{token:member.token,organizationId:org,...period})).mergeTime.count).toBe(2);
});

test('pull requests record when OpenReview first saw them and when the merge webhook arrived',async()=>{
 const {t,web}=await setup();
 await t.run(ctx=>ctx.db.patch(web._id,{enabled:true}));
 const observe=(observedAt:number)=>t.mutation(internal.pulls.observe,{repositoryId:web._id,number:7,title:'Seven',author:'ana',url:'u',headSha:'c'.repeat(40),baseSha:'b'.repeat(40),state:'open',observedAt});
 await observe(d1);await observe(d2);
 const merge=(observedAt:number)=>t.mutation(internal.webhooks.lifecycle,{repositoryId:web._id,action:'closed',prNumber:7,state:'closed',merged:true,observedAt});
 await merge(d2+3600000);await merge(d2+7200000);
 const pr=await t.run(ctx=>ctx.db.query('pullRequests').withIndex('by_repo_number',q=>q.eq('repositoryId',web._id).eq('number',7)).unique());
 expect([pr?.openedAt,pr?.mergedAt]).toEqual([d1,d2+3600000]);
});
