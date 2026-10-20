import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import {createHash} from 'node:crypto';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import type {Id} from '../convex/_generated/dataModel';
import {proGatesAt,upgradeNote} from '../src/plans';
import {Github} from '../src/github';
import {HttpModel} from '../src/engine/model';
import {encryptCredential} from '../src/credentials';
import type {ModelRequest} from '../src/engine/types';
import type {z} from 'zod';

// Pro gates (src/plans.ts): each is off on Free and Starter, on for Pro, and everything is unlocked with billing off.
const holder=vi.hoisted(()=>({t:undefined as unknown as ReturnType<typeof convexTest>,user:undefined as unknown}));
const secret='pro-gates-session-secret-at-least-32-characters',service='pro-gates-service';
vi.mock('../src/server',()=>({
 backend:()=>{type Call=(ref:unknown,args:unknown)=>Promise<unknown>;const t=holder.t as unknown as {query:Call;mutation:Call;action:Call};return {query:(ref:unknown,args:unknown)=>t.query(ref,args),mutation:(ref:unknown,args:unknown)=>t.mutation(ref,args),action:(ref:unknown,args:unknown)=>t.action(ref,args)};},
 current:async()=>holder.user,
 signSession:(userId:string)=>new SignJWT({}).setProtectedHeader({alg:'HS256'}).setSubject(userId).setIssuer('openreview').setAudience('openreview').setExpirationTime('1h').sign(new TextEncoder().encode('pro-gates-session-secret-at-least-32-characters')),
}));
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>undefined})}));
import {apiIdentity,ApiAuthError} from '../src/api-auth';
import {GET as listRepositories} from '../app/api/repositories/route';
import {GET as workspaceRoute} from '../app/api/workspace/route';
import {GET as p4Status,POST as p4Upload} from '../app/api/p4/index/route';
import {GET as analyticsRoute} from '../app/api/analytics/route';

const modules=import.meta.glob('../convex/**/*.ts');
const day=86400000;
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.UTC(2026,9,20,12));process.env.SESSION_SECRET=secret;process.env.SERVICE_SECRET=service;process.env.LLM_API_KEY='fixture';process.env.CREDENTIAL_ENCRYPTION_KEY='pro-gates-encryption-key-at-least-32-characters';});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();delete process.env.BILLING_ENABLED;});

async function setup(){
 const t=convexTest(schema,modules);holder.t=t;
 const id=await t.mutation(api.users.login,{secret:service,githubId:71,login:'alice',avatar:''});
 const token=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(id).setExpirationTime('1h').sign(new TextEncoder().encode(secret));
 const org=await t.mutation(api.users.createOrganization,{token,name:'Acme'});
 await t.mutation(api.repositories.connect,{token,secret:service,organizationId:org,installationId:71,account:'acme',accountId:1,repositories:[{id:7101,fullName:'acme/shop',defaultBranch:'main'}]});
 const repo=(await t.query(api.repositories.list,{token,organizationId:org}))[0];
 await t.run(ctx=>ctx.db.patch(repo._id,{enabled:true}));
 // Billing on with no subscription is Free; pro() adds a Pro subscription.
 const billing=(on:boolean)=>{if(on)process.env.BILLING_ENABLED='true';else delete process.env.BILLING_ENABLED;};
 const pro=(status='active')=>t.run(ctx=>ctx.db.insert('billingAccounts',{organizationId:org,customerId:'cus_1',subscriptionId:'sub_1',plan:'pro',status,seats:1,trialEndsAt:Date.now(),updatedAt:Date.now()}));
 holder.user={token,organizations:[{_id:org}]};
 return {t,id,token,org,repo,billing,pro};
}
const saml={protocol:'saml' as const,name:'Okta',active:true,jitRole:'member' as const,samlEntryPoint:'https://idp.acme.com/sso',samlIdpCert:'-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtest\n-----END PUBLIC KEY-----'};

test('billing.locked lists the Pro features a plan lacks, and none with billing off',async()=>{
 const {t,token,org,billing,pro}=await setup();
 expect(await t.query(api.billing.locked,{token,organizationId:org})).toEqual([]);
 billing(true);
 expect(await t.query(api.billing.locked,{token,organizationId:org})).toEqual(['review.deep','review.reproTests','fix.pullRequests','context.requirements','memory.conventions','api.access','analytics.history','auth.sso','audit.log']);
 await pro();
 expect(await t.query(api.billing.locked,{token,organizationId:org})).toEqual([]);
});

test('auth.sso: a new SSO connection needs Pro, and one from before the Pro gates keeps working and stays editable',async()=>{
 const {t,token,org,billing,pro}=await setup();
 billing(true);
 await expect(t.mutation(api.sso.saveConnection,{token,organizationId:org,...saml})).rejects.toThrow(upgradeNote['auth.sso']);
 // Configured before the gates shipped (proGatesAt): still editable and still used for sign-in on Free.
 expect(Date.now()).toBeLessThan(proGatesAt);
 billing(false);
 await t.mutation(api.sso.saveConnection,{token,organizationId:org,...saml});
 billing(true);
 await t.mutation(api.sso.saveConnection,{token,organizationId:org,...saml,name:'Okta EU'});
 expect((await t.query(api.sso.settings,{token,organizationId:org})).connection).toMatchObject({name:'Okta EU',active:true});
 const connection=(await t.query(api.sso.settings,{token,organizationId:org})).connection!;
 expect(await t.query(api.sso.forLogin,{secret:service,connectionId:connection._id})).toMatchObject({id:connection._id,protocol:'saml'});
 // A second workspace on Pro can set one up.
 const fresh=await t.mutation(api.users.createOrganization,{token,name:'Beta'});
 await expect(t.mutation(api.sso.saveConnection,{token,organizationId:fresh,...saml})).rejects.toThrow(/Pro plan/);
 await pro();
 await t.run(async ctx=>{const a=(await ctx.db.query('billingAccounts').collect())[0];await ctx.db.patch(a._id,{organizationId:fresh});});
 await t.mutation(api.sso.saveConnection,{token,organizationId:fresh,...saml});
});

test('auth.sso: after a Pro trial lapses, sign-in keeps working and an admin can only turn SSO off or stop requiring it',async()=>{
 vi.setSystemTime(proGatesAt+30*day);
 const {t,token,org,billing,pro}=await setup();
 billing(true);
 await pro('trialing');
 await t.mutation(api.sso.saveConnection,{token,organizationId:org,...saml});
 const domainId=await t.mutation(api.sso.addDomain,{token,organizationId:org,domain:'acme.com'});
 await t.run(ctx=>ctx.db.patch(domainId,{verifiedAt:Date.now()}));
 await t.mutation(api.sso.setEnforcement,{token,organizationId:org,enforce:true});
 // The trial ends without a card: the workspace is on Free.
 await t.run(async ctx=>{const a=(await ctx.db.query('billingAccounts').collect())[0];await ctx.db.patch(a._id,{status:'canceled'});});
 const connection=(await t.query(api.sso.settings,{token,organizationId:org})).connection!;
 expect(await t.query(api.sso.forLogin,{secret:service,connectionId:connection._id})).toMatchObject({id:connection._id});
 await expect(t.mutation(api.sso.saveConnection,{token,organizationId:org,...saml,name:'Renamed'})).rejects.toThrow(upgradeNote['auth.sso']);
 await expect(t.mutation(api.sso.addDomain,{token,organizationId:org,domain:'acme.io'})).rejects.toThrow(/Pro plan/);
 await t.mutation(api.sso.setEnforcement,{token,organizationId:org,enforce:false});
 await expect(t.mutation(api.sso.setEnforcement,{token,organizationId:org,enforce:true})).rejects.toThrow(/Pro plan/);
 await t.mutation(api.sso.saveConnection,{token,organizationId:org,...saml,active:false});
 expect((await t.query(api.sso.settings,{token,organizationId:org})).connection).toMatchObject({active:false,enforce:false});
 await expect(t.mutation(api.sso.saveConnection,{token,organizationId:org,...saml})).rejects.toThrow(/Pro plan/);
});

test('audit.log: the audit log is Pro, while events are still recorded',async()=>{
 const {t,token,org,billing,pro}=await setup();
 billing(true);
 await t.mutation(api.analytics.setMinutesPerFinding,{token,organizationId:org,minutes:20});
 await expect(t.query(api.scopes.activityPage,{token,organizationId:org})).rejects.toThrow(upgradeNote['audit.log']);
 await expect(t.query(api.scopes.activity,{token,organizationId:org})).rejects.toThrow(/Pro plan/);
 await pro();
 expect((await t.query(api.scopes.activityPage,{token,organizationId:org})).page.map(e=>e.action)).toContain('analytics.minutes_per_finding_changed');
});

test('api.access: creating keys needs Pro; existing keys answer 402 and are kept',async()=>{
 const {t,id,token,org,billing,pro}=await setup();
 const raw='or_existing_key_123';
 await t.run(ctx=>ctx.db.insert('apiKeys',{organizationId:org,userId:id,hash:createHash('sha256').update(raw).digest('hex'),name:'CI',prefix:raw.slice(0,11),createdAt:0,revoked:false,scopes:['admin']}));
 const request=()=>new Request('http://localhost/api/repositories',{headers:{authorization:'Bearer '+raw}});
 expect((await listRepositories(request())).status).toBe(200);
 billing(true);
 await expect(t.mutation(api.apiKeys.create,{token,organizationId:org,name:'New',hash:'a'.repeat(64),prefix:'or_new'})).rejects.toThrow(upgradeNote['api.access']);
 const refused=await listRepositories(request());
 expect(refused.status).toBe(402);
 expect(await refused.json()).toEqual({error:upgradeNote['api.access']});
 await expect(apiIdentity(request(),'read')).rejects.toSatisfy((e:unknown)=>e instanceof ApiAuthError&&e.status===402);
 expect(await t.run(ctx=>ctx.db.query('apiKeys').collect())).toHaveLength(1);
 await pro();
 expect((await listRepositories(request())).status).toBe(200);
 await t.mutation(api.apiKeys.create,{token,organizationId:org,name:'New',hash:'a'.repeat(64),prefix:'or_new'});
});

test('analytics.history: periods starting more than 30 days back need Pro',async()=>{
 const {t,token,org,billing,pro}=await setup();
 const recent={token,organizationId:org,since:Date.UTC(2026,8,20),until:Date.now()},older={...recent,since:Date.UTC(2026,8,19)};
 billing(true);
 // The default view (this month, or the last 30 days) stays open.
 expect((await t.query(api.analytics.report,recent)).totalReviews).toBe(0);
 expect((await t.query(api.analytics.trends,{...recent,since:Date.UTC(2026,9,1)})).totals.reviews).toBe(0);
 await expect(t.query(api.analytics.report,older)).rejects.toThrow(upgradeNote['analytics.history']);
 await expect(t.query(api.analytics.trends,older)).rejects.toThrow(/Pro plan/);
 await pro();
 expect((await t.query(api.analytics.trends,{...older,since:older.since-200*day})).totals.reviews).toBe(0);
 billing(false);
 expect((await t.query(api.analytics.report,older)).totalReviews).toBe(0);
});

test('memory.conventions: learning is skipped without Pro, without moving the cursor; approved conventions stay',async()=>{
 const {t,org,repo,billing}=await setup();
 await t.run(async ctx=>{await ctx.db.patch(repo._id,{conventionsCursor:7});await ctx.db.insert('learnedRules',{organizationId:org,repositoryId:repo._id,text:'Prefer early returns',category:'style',status:'approved',frequency:3,evidence:[],createdAt:0,updatedAt:0});});
 billing(true);
 // No provider or model is reached: ingest only marks the repository synced so the sweep moves on.
 expect(await t.action(internal.conventionJobs.ingest,{repositoryId:repo._id})).toEqual({added:0,merged:0,rejected:0});
 const after=await t.run(ctx=>ctx.db.get(repo._id));
 expect(after).toMatchObject({conventionsCursor:7,conventionsSyncedAt:Date.now()});
 expect(await t.run(ctx=>ctx.db.query('learnedRules').collect())).toMatchObject([{status:'approved',text:'Prefer early returns'}]);
});

test('context.requirements: the review stage is skipped with a coverage note, and connecting needs Pro',async()=>{
 const {t,token,org,repo,billing}=await setup();
 await t.run(ctx=>ctx.db.insert('integrationConnections',{organizationId:org,kind:'linear',externalId:'lin',name:'Linear',credentials:'x',expiresAt:Date.now()+day,active:true,generation:1,teamIds:['team'],projectIds:[],repositoryIds:[repo._id],createdAt:Date.now()}));
 const requirements=()=>t.action(internal.integrationJobs.requirements,{repositoryId:repo._id,references:'ENG-1',actor:'stranger'});
 billing(true);
 expect(await requirements()).toEqual({files:[],scopes:[],coverage:[upgradeNote['context.requirements']]});
 await expect(t.mutation(internal.integrations.save,{token,organizationId:org,kind:'notion',externalId:'n',name:'Notion',credentials:'x',expiresAt:Date.now()+day})).rejects.toThrow(upgradeNote['context.requirements']);
 // Reconnecting an existing connection (e.g. Notion after its token broke) works on any plan.
 await t.run(ctx=>ctx.db.insert('integrationConnections',{organizationId:org,kind:'notion',externalId:'old',name:'Notion',credentials:'x',expiresAt:Date.now(),active:false,generation:1,teamIds:[],projectIds:[],repositoryIds:[],createdAt:Date.now()}));
 await t.mutation(internal.integrations.save,{token,organizationId:org,kind:'notion',externalId:'old',name:'Notion',credentials:'y',expiresAt:Date.now()+day});
 // Billing off: the stage runs (here it stops at the unverified author, before any network call).
 billing(false);
 expect((await requirements()).coverage[0]).toMatch(/^Linked tickets and documents were not fetched: /);
});

test('Perforce works on every plan: a Perforce key made on Free passes the real p4 routes and the key check, and nothing else',async()=>{
 const {t,token,org,repo,billing}=await setup();
 billing(true);
 const raw='or_perforce_key_123456';
 await t.mutation(api.apiKeys.create,{token,organizationId:org,name:'P4 watcher',hash:createHash('sha256').update(raw).digest('hex'),prefix:raw.slice(0,11),scopes:['read'],perforce:true});
 expect((await t.query(api.apiKeys.list,{token,organizationId:org}))[0]).toMatchObject({perforce:true,scopes:['admin']});
 const call=(path:string,init:RequestInit={})=>new Request('http://localhost'+path,{...init,headers:{authorization:'Bearer '+raw,'content-type':'application/json'}});
 // Authenticated and authorized: these fail on the repository (not a Perforce one), never on the plan.
 const status=await p4Status(call('/api/p4/index?repositoryId='+repo._id));
 expect([status.status,await status.json()]).toEqual([403,{error:'P4 indexing status unavailable; check current administrator access and connection'}]);
 const upload=await p4Upload(call('/api/p4/index',{method:'POST',body:JSON.stringify({repositoryId:repo._id,instance:'https://p4.example',inventory:{}})}));
 expect(upload.status).toBe(400);
 expect((await upload.json()).error).toMatch(/^P4 indexing request rejected/);
 // `openreview login --api-key` checks the key here.
 expect((await workspaceRoute(call('/api/workspace'))).status).toBe(200);
 const other=await listRepositories(call('/api/repositories'));
 expect([other.status,await other.json()]).toEqual([402,{error:upgradeNote['api.access']}]);
 // On Pro it still passes only Perforce routes.
 await t.run(ctx=>ctx.db.insert('billingAccounts',{organizationId:org,subscriptionId:'sub_1',plan:'pro',status:'active',seats:1,trialEndsAt:Date.now(),updatedAt:Date.now()}));
 expect((await listRepositories(call('/api/repositories'))).status).toBe(403);
 await expect(apiIdentity(call('/api/p4/index'),'admin',{plan:false})).resolves.toMatchObject({organizationId:org});
});

test('analytics.history: the CSV export answers 402 with the upgrade note',async()=>{
 const {billing,pro}=await setup();
 billing(true);
 const csv=(since:string)=>analyticsRoute(new Request(`http://localhost/api/analytics?since=${since}&until=2026-10-20`));
 const locked=await csv('2026-09-01');
 expect([locked.status,await locked.text()]).toEqual([402,upgradeNote['analytics.history']]);
 expect((await csv('2026-10-01')).status).toBe(200);
 await pro();
 expect((await csv('2026-09-01')).status).toBe(200);
});

test('Pro still learns conventions and fetches linked requirements',async()=>{
 const {t,org,repo,billing,pro}=await setup();
 billing(true);
 await pro();
 const scm=new Github('fixture');vi.spyOn(Github,'installation').mockResolvedValue(scm);
 vi.spyOn(scm,'mergedReviewComments').mockResolvedValue({cursor:9,comments:[1,2,3].map(n=>({body:'List endpoints need a pagination limit of 100 items, like the others.',path:'src/list.ts',author:'reviewer'+n,url:`https://github.com/acme/shop/pull/${n}#r${n}`,prNumber:n}))});
 vi.spyOn(HttpModel.prototype,'generate').mockImplementation(async function<T>(request:ModelRequest,validator:z.ZodType<T>){return {value:validator.parse({conventions:[{text:'Flag list endpoints that are missing a pagination limit.',category:'performance',evidence:[0,1]}]}),usage:{task:request.task,provider:'fixture',model:'fixture',inputTokens:10,outputTokens:5,latencyMs:1,estimatedCost:0.001,cached:false}};});
 expect((await t.action(internal.conventionJobs.ingest,{repositoryId:repo._id})).added).toBe(1);
 expect((await t.run(ctx=>ctx.db.get(repo._id)))?.conventionsCursor).toBe(9);
 const expiry=Date.now()+3600000;
 await t.run(ctx=>ctx.db.insert('integrationConnections',{organizationId:org,kind:'linear',externalId:'native-org',name:'Linear',credentials:encryptCredential(JSON.stringify({accessToken:'fixture-access-token',refreshToken:'fixture-refresh-token',expiresAt:expiry}),org+':linear'),expiresAt:expiry,active:true,generation:1,teamIds:['native-team'],projectIds:[],repositoryIds:[repo._id],createdAt:Date.now()}));
 vi.stubGlobal('fetch',async(input:string|URL,init?:RequestInit)=>{
  if(new URL(String(input)).hostname!=='api.linear.app')throw new Error('Unexpected request');
  const full=JSON.parse(String(init?.body)).query.includes('description');
  return Response.json({data:{organization:{id:'native-org'},issue:{id:'native-issue',identifier:'PAY-1',team:{id:'native-team'},project:null,...(full?{title:'Linear requirement',description:'Cap list endpoints.',updatedAt:'2026-10-03T00:00:00.000Z',url:'https://linear.app/fixture/issue/PAY-1/requirement'}:{})}}});
 });
 const result=await t.action(internal.integrationJobs.requirements,{repositoryId:repo._id,references:'PAY-1',actor:'alice',authorExternalId:'71'});
 expect(result.files.map(f=>f.path)).toEqual([expect.stringContaining('/linear/')]);
 expect(result.coverage).not.toContain(upgradeNote['context.requirements']);
});

test('a Starter subscription from before Pro (legacy) keeps its API keys and requirements context',async()=>{
 const {t,id,org,repo,billing}=await setup();
 const raw='or_legacy_ci_key_123';
 await t.run(async ctx=>{
  await ctx.db.insert('apiKeys',{organizationId:org,userId:id,hash:createHash('sha256').update(raw).digest('hex'),name:'CI',prefix:raw.slice(0,11),createdAt:0,revoked:false,scopes:['read']});
  await ctx.db.insert('billingAccounts',{organizationId:org,customerId:'cus_1',subscriptionId:'sub_1',status:'active',seats:1,trialEndsAt:Date.now(),updatedAt:Date.now()});
  await ctx.db.insert('integrationConnections',{organizationId:org,kind:'linear',externalId:'lin',name:'Linear',credentials:'x',expiresAt:Date.now()+day,active:true,generation:1,teamIds:['team'],projectIds:[],repositoryIds:[repo._id],createdAt:Date.now()});
 });
 billing(true);
 const request=()=>new Request('http://localhost/api/repositories',{headers:{authorization:'Bearer '+raw}});
 const requirements=()=>t.action(internal.integrationJobs.requirements,{repositoryId:repo._id,references:'ENG-1',actor:'stranger'});
 // Starter without the migration: gated like any Starter workspace.
 expect((await listRepositories(request())).status).toBe(402);
 expect((await requirements()).coverage).toEqual([upgradeNote['context.requirements']]);
 expect(await t.mutation(internal.billing.grandfatherSubscriptions,{confirm:'grandfather-pre-plan-subscriptions'})).toBe(1);
 expect((await listRepositories(request())).status).toBe(200);
 expect((await requirements()).coverage).not.toContain(upgradeNote['context.requirements']);
 expect(await t.query(internal.billing.entitlement,{organizationId:org,key:'api.access'})).toBe(true);
});
