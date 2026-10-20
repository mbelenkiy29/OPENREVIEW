import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import {createHash} from 'node:crypto';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import type {Id} from '../convex/_generated/dataModel';
import {upgradeNote} from '../src/plans';

// Pro gates (src/plans.ts): each is off on Free and Starter, on for Pro, and everything is unlocked with billing off.
const holder=vi.hoisted(()=>({t:undefined as unknown as ReturnType<typeof convexTest>}));
const secret='pro-gates-session-secret-at-least-32-characters',service='pro-gates-service';
vi.mock('../src/server',()=>({
 backend:()=>{type Call=(ref:unknown,args:unknown)=>Promise<unknown>;const t=holder.t as unknown as {query:Call;mutation:Call;action:Call};return {query:(ref:unknown,args:unknown)=>t.query(ref,args),mutation:(ref:unknown,args:unknown)=>t.mutation(ref,args),action:(ref:unknown,args:unknown)=>t.action(ref,args)};},
 signSession:(userId:string)=>new SignJWT({}).setProtectedHeader({alg:'HS256'}).setSubject(userId).setIssuer('openreview').setAudience('openreview').setExpirationTime('1h').sign(new TextEncoder().encode('pro-gates-session-secret-at-least-32-characters')),
}));
import {apiIdentity,ApiAuthError} from '../src/api-auth';
import {GET as listRepositories} from '../app/api/repositories/route';

const modules=import.meta.glob('../convex/**/*.ts');
const day=86400000;
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.UTC(2026,9,20,12));process.env.SESSION_SECRET=secret;process.env.SERVICE_SECRET=service;});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();delete process.env.BILLING_ENABLED;});

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
 const pro=()=>t.run(ctx=>ctx.db.insert('billingAccounts',{organizationId:org,customerId:'cus_1',subscriptionId:'sub_1',plan:'pro',status:'active',seats:1,trialEndsAt:Date.now(),updatedAt:Date.now()}));
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

test('auth.sso: a new SSO connection needs Pro, and one configured before keeps working and stays editable',async()=>{
 const {t,token,org,billing,pro}=await setup();
 billing(true);
 await expect(t.mutation(api.sso.saveConnection,{token,organizationId:org,...saml})).rejects.toThrow(upgradeNote['auth.sso']);
 // Configured while billing was off (or on Pro): still saved and still used for sign-in on Free.
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

test('audit.log: the audit log is Pro, while events are still recorded',async()=>{
 const {t,token,org,billing,pro}=await setup();
 billing(true);
 await t.mutation(api.analytics.setMinutesPerFinding,{token,organizationId:org,minutes:20});
 await expect(t.query(api.scopes.activityPage,{token,organizationId:org})).rejects.toThrow(upgradeNote['audit.log']);
 await expect(t.query(api.scopes.activity,{token,organizationId:org})).rejects.toThrow(/Pro plan/);
 await pro();
 expect((await t.query(api.scopes.activityPage,{token,organizationId:org})).page.map(e=>e.action)).toContain('analytics.minutes_per_finding_changed');
});

test('api.access: creating keys needs Pro; existing keys answer 402 and are kept; Perforce keeps its key',async()=>{
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
 // The Perforce watcher and trigger are a code provider, not the public API.
 expect((await apiIdentity(request(),'admin',{plan:false})).organizationId).toBe(org);
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
 // Billing off: the stage runs (here it stops at the unverified author, before any network call).
 billing(false);
 expect((await requirements()).coverage[0]).toMatch(/^Linked tickets and documents were not fetched: /);
});
