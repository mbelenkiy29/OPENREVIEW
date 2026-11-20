import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import {createHash,createHmac,randomBytes} from 'node:crypto';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import type {Id} from '../convex/_generated/dataModel';

const modules=import.meta.glob('../convex/**/*.ts');
const secret='enterprise-session-secret-at-least-32-chars',svc='enterprise-service',operatorId=206921626,whsec='whsec_enterprise_fixture';
const env={SESSION_SECRET:secret,SERVICE_SECRET:svc,OPERATOR_GITHUB_IDS:String(operatorId),BILLING_ENABLED:'true',STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_WEBHOOK_SECRET:whsec,STRIPE_SEAT_PRICE_ID:'price_seat',STRIPE_PRO_PRICE_ID:'price_pro',STRIPE_USAGE_PRICE_ID:'price_usage',STRIPE_ENTERPRISE_PRODUCT_ID:'prod_ent',STRIPE_ENTERPRISE_USAGE_PRICE_ID:'price_entusage',STRIPE_CONTRIBUTOR_METER_ID:'mtr_contributors'};
beforeEach(()=>{vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});vi.setSystemTime(Date.UTC(2026,9,14,12));Object.assign(process.env,env);});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();for(const k of Object.keys(env))if(!['SESSION_SECRET','SERVICE_SECRET'].includes(k))delete process.env[k];});

// A GitHub sign-in with its browser session; `legacy` is a token without one, like those minted for API-key calls.
async function signIn(t:ReturnType<typeof convexTest>,githubId:number,login:string){
 const sid=randomBytes(32).toString('base64url');
 const id=await t.mutation(api.identity.signIn,{secret:svc,provider:'github',providerUserId:String(githubId),login,avatar:'',emailVerified:false,sessionHash:createHash('sha256').update(sid).digest('hex')});
 const jwt=(claims:Record<string,string>)=>new SignJWT(claims).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(id).setIssuedAt().setExpirationTime('800d').sign(new TextEncoder().encode(secret));
 return {id,token:await jwt({sid}),legacy:await jwt({})};
}
async function setup(){
 const t=convexTest(schema,modules);
 const operator=await signIn(t,operatorId,'operator'),alice=await signIn(t,31,'alice');
 const org=await t.mutation(api.users.createOrganization,{token:alice.token,name:'Acme'});
 // Acme is on Pro with a live card subscription.
 await t.run(async ctx=>{await ctx.db.patch(org,{planSelectedAt:Date.now(),plan:'pro'});await ctx.db.insert('billingAccounts',{organizationId:org,status:'active',seats:3,trialEndsAt:0,updatedAt:Date.now(),customerId:'cus_acme',subscriptionId:'sub_pro',subscriptionItemId:'si_pro',plan:'pro',lastEventCreated:Date.UTC(2026,9,14,11)});});
 return {t,operator,alice,org};
}
const terms=(organizationId:Id<'organizations'>)=>({organizationId,mode:'managed' as const,startsAt:Date.UTC(2026,10,1),committedContributors:30,contributorPriceCents:2200,includedUsagePerContributorUsd:12,overageMultiplier:1.15,netDays:30,graceDays:30,nonBillableAuthors:[' release-bot ','release-bot'],notes:'Order form 14'});
const account=(t:Awaited<ReturnType<typeof setup>>['t'],org:Id<'organizations'>)=>t.run(async ctx=>(await ctx.db.query('billingAccounts').withIndex('by_org',q=>q.eq('organizationId',org)).unique())!);
type Call={path:string;body:string;key:string|null};
// Stripe stand-in: records each request and answers with an id; `fail` makes one path answer 400 once.
function fakeStripe(fail?:string){
 const calls:Call[]=[];let failed=false;
 vi.spyOn(globalThis,'fetch').mockImplementation(async(input:string|URL|Request,init?:RequestInit)=>{
  const path=new URL(String(input)).pathname;calls.push({path,body:decodeURIComponent(String(init?.body)),key:new Headers(init?.headers).get('idempotency-key')});
  if(path===fail&&!failed){failed=true;return Response.json({error:{type:'invalid_request_error'}},{status:400});}
  return Response.json({id:path.endsWith('/prices')?`price_${calls.filter(c=>c.path===path).length}`:'sub_sched_1'});
 });
 return calls;
}

test('only an operator in a browser session creates a contract, and bad terms or a deployment that is not set up save nothing',async()=>{
 const {t,operator,alice,org}=await setup(),calls=fakeStripe();
 for(const token of [alice.token,operator.legacy])await expect(t.action(api.enterpriseJobs.createContract,{token,...terms(org)})).rejects.toThrow(/Forbidden/);
 await expect(t.action(api.enterpriseJobs.createContract,{token:operator.token,...terms(org),committedContributors:24})).rejects.toThrow(/at least 25/);
 await expect(t.action(api.enterpriseJobs.createContract,{token:operator.token,...terms(org),startsAt:Date.UTC(2026,10,2)})).rejects.toThrow(/first of a month/);
 delete process.env.STRIPE_CONTRIBUTOR_METER_ID;
 await expect(t.action(api.enterpriseJobs.createContract,{token:operator.token,...terms(org)})).rejects.toThrow(/STRIPE_CONTRIBUTOR_METER_ID/);
 expect(calls).toEqual([]);
 expect((await account(t,org)).contract).toBeUndefined();
 expect(await t.run(ctx=>ctx.db.query('operatorAudit').collect())).toEqual([]);
});

test('creating a contract makes two prices and a one-year invoiced schedule, and a retry reuses its idempotency keys',async()=>{
 const {t,operator,org}=await setup(),calls=fakeStripe('/v1/subscription_schedules');
 // Stripe refuses the schedule once: the draft and both prices exist, nothing is marked created.
 await expect(t.action(api.enterpriseJobs.createContract,{token:operator.token,...terms(org)})).rejects.toThrow();
 const draft=(await account(t,org)).contract!;
 expect(draft).toMatchObject({mode:'managed',committedContributors:30,minimumContributors:25,endsAt:Date.UTC(2027,10,1),nonBillableAuthors:['release-bot']});
 expect(draft.stripe).toBeUndefined();
 expect(await t.action(api.enterpriseJobs.createContract,{token:operator.token,...terms(org)})).toBe('created');
 const keys=(path:string)=>calls.filter(c=>c.path===path).map(c=>c.key);
 expect(keys('/v1/prices')).toEqual([`contract:${draft.id}:commit`,`contract:${draft.id}:trueup`,`contract:${draft.id}:commit`,`contract:${draft.id}:trueup`]);
 expect(keys('/v1/subscription_schedules')).toEqual([`contract:${draft.id}:schedule`,`contract:${draft.id}:schedule`]);
 expect(calls.filter(c=>c.path==='/v1/customers')).toEqual([]);
 const [commit,trueUp]=calls.filter(c=>c.path==='/v1/prices').map(c=>c.body),schedule=calls.filter(c=>c.path==='/v1/subscription_schedules').at(-1)!.body;
 for(const part of ['product=prod_ent','currency=usd','unit_amount=26400','recurring[interval]=year',`metadata[contractId]=${draft.id}`])expect(commit).toContain(part);
 for(const part of ['unit_amount=2200','recurring[interval]=month','recurring[usage_type]=metered','recurring[meter]=mtr_contributors'])expect(trueUp).toContain(part);
 for(const part of ['customer=cus_acme',`start_date=${Date.UTC(2026,10,1)/1000}`,'end_behavior=cancel','billing_mode[type]=flexible','phases[0][items][0][quantity]=30','phases[0][items][2][price]=price_entusage','phases[0][duration][interval]=year','phases[0][duration][interval_count]=1','phases[0][collection_method]=send_invoice','phases[0][invoice_settings][days_until_due]=30',`phases[0][metadata][organizationId]=${org}`,`phases[0][metadata][contractId]=${draft.id}`])expect(schedule).toContain(part);
 const saved=await account(t,org);
 expect(saved.contract).toMatchObject({id:draft.id,stripe:{productId:'prod_ent',usagePriceId:'price_entusage',scheduleId:'sub_sched_1'}});
 // The workspace stays on Pro until Stripe's webhook says the contract's subscription exists.
 expect(saved.plan).toBe('pro');
 expect((await t.run(ctx=>ctx.db.query('operatorAudit').collect())).map(e=>e.action)).toEqual(['enterprise.contract_draft','enterprise.contract_draft','enterprise.contract_created']);
 expect((await t.run(ctx=>ctx.db.query('auditEvents').collect())).filter(e=>e.action==='billing.contract_created').map(e=>e.target)).toEqual([draft.id]);
 // Acme was on Pro: that subscription ends when the contract starts, with no proration, and the move is audited.
 expect(calls.at(-1)).toEqual({path:'/v1/subscriptions/sub_pro',body:`cancel_at=${Date.UTC(2026,10,1)/1000}&proration_behavior=none`,key:`contract:${draft.id}:cancelpro`});
 expect((await t.run(ctx=>ctx.db.query('auditEvents').collect())).filter(e=>e.action==='billing.migrated_from_pro').map(e=>e.target)).toEqual(['sub_pro']);
 // While the contract is in force the form only takes its renewal, which starts the day the term ends.
 await expect(t.action(api.enterpriseJobs.createContract,{token:operator.token,...terms(org)})).rejects.toThrow(/until 2027-11-01; a renewal starts that day/);
 // Own key carries no overage item, and changed terms get a new contract id.
 const other=await t.mutation(api.users.createOrganization,{token:operator.token,name:'Other'});
 expect(await t.action(api.enterpriseJobs.createContract,{token:operator.token,...terms(other),mode:'ownKey'})).toBe('created');
 expect(calls.at(-1)!.path).toBe('/v1/subscription_schedules');
 expect(calls.at(-1)!.body).not.toContain('phases[0][items][2]');
 expect(calls.some(c=>c.path==='/v1/customers')).toBe(true);
});

function signed(event:Record<string,unknown>){const body=JSON.stringify(event),ts=Math.floor(Date.now()/1000);return {body,headers:{'content-type':'application/json','stripe-signature':`t=${ts},v1=${createHmac('sha256',whsec).update(`${ts}.${body}`).digest('hex')}`}};}
const deliver=async(t:Awaited<ReturnType<typeof setup>>['t'],event:Record<string,unknown>)=>{const {body,headers}=signed(event);expect((await t.fetch('/stripe/webhook',{method:'POST',headers,body})).status).toBe(200);return t.run(async ctx=>(await ctx.db.query('stripeEvents').withIndex('by_event',q=>q.eq('eventId',String(event.id))).unique())!.outcome);};
const item=(id:string,price:string,usage:'licensed'|'metered',product:string,quantity?:number)=>({id,...(quantity===undefined?{}:{quantity}),price:{id:price,product,recurring:{usage_type:usage}}});
const sub=(evt:string,type:string,created:number,id:string,items:unknown[],metadata:Record<string,string>={},status='active')=>({id:evt,type,created,data:{object:{id,customer:'cus_acme',status,metadata,items:{data:items}}}});

test('the contract subscription replaces the live Pro one; other subscriptions, late Pro events and old events change nothing',async()=>{
 const {t,operator,org}=await setup();fakeStripe();
 await t.action(api.enterpriseJobs.createContract,{token:operator.token,...terms(org)});
 const contractId=(await account(t,org)).contract!.id,at=Math.floor(Date.UTC(2026,10,1)/1000);
 const threeItems=[item('si_over','price_2','metered','prod_ent'),item('si_commit','price_1','licensed','prod_ent',30),item('si_usage','price_entusage','metered','prod_usage')];
 // A second subscription that is not this contract's is still refused.
 expect(await deliver(t,sub('evt_foreign','customer.subscription.created',at,'sub_x',[item('si_x','price_pro','licensed','prod_pro',9)],{organizationId:org,contractId:'someone-elses'}))).toBe('other subscription');
 // The contract's first event is older than the Pro subscription's last one and still applies.
 await t.run(async ctx=>{const a=await ctx.db.query('billingAccounts').first();await ctx.db.patch(a!._id,{lastEventCreated:(at+60)*1000});});
 expect(await deliver(t,sub('evt_ent','customer.subscription.created',at,'sub_ent',threeItems,{organizationId:org,contractId}))).toBe('active');
 expect(await account(t,org)).toMatchObject({plan:'enterprise',status:'active',seats:30,subscriptionId:'sub_ent',subscriptionItemId:'si_commit'});
 expect((await t.run(ctx=>ctx.db.get(org)))?.plan).toBe('enterprise');
 expect(await t.query(internal.billing.entitlement,{organizationId:org,key:'auth.sso'})).toBe(true);
 // Pro ending in the same second is the replaced subscription, not a cancellation of the workspace.
 expect(await deliver(t,sub('evt_pro_gone','customer.subscription.deleted',at,'sub_pro',[item('si_pro','price_pro','licensed','prod_pro',3)],{organizationId:org},'canceled'))).toBe('replaced subscription');
 expect(await deliver(t,sub('evt_ent_old','customer.subscription.updated',at-10,'sub_ent',[item('si_commit','price_pro','licensed','prod_pro',1)],{organizationId:org,contractId}))).toBe('stale');
 expect(await account(t,org)).toMatchObject({plan:'enterprise',status:'active',seats:30,subscriptionId:'sub_ent'});
});

test('a Starter subscription that also carries the extra-usage item still records its seat item',async()=>{
 const {t,org}=await setup();
 await t.run(async ctx=>{const a=await ctx.db.query('billingAccounts').first();await ctx.db.patch(a!._id,{subscriptionId:undefined,subscriptionItemId:undefined,status:'trial',plan:undefined,lastEventCreated:undefined});});
 const at=Math.floor(Date.now()/1000);
 expect(await deliver(t,sub('evt_starter','customer.subscription.created',at,'sub_s',[item('si_usage','price_usage','metered','prod_usage'),item('si_seat','price_seat','licensed','prod_starter',4)],{organizationId:org}))).toBe('active');
 expect(await account(t,org)).toMatchObject({plan:'starter',seats:4,subscriptionItemId:'si_seat',subscriptionId:'sub_s'});
});

test('Pro ending a moment before the contract starts never leaves the workspace without a plan',async()=>{
 const {t,operator,org}=await setup();fakeStripe();
 await t.action(api.enterpriseJobs.createContract,{token:operator.token,...terms(org)});
 const contractId=(await account(t,org)).contract!.id,at=Math.floor(Date.UTC(2026,10,1)/1000);
 vi.setSystemTime(Date.UTC(2026,10,1,0,0,5));
 expect(await deliver(t,sub('evt_pro_gone','customer.subscription.deleted',at,'sub_pro',[item('si_pro','price_pro','licensed','prod_pro',3)],{organizationId:org},'canceled'))).toBe('contract takeover');
 expect(await t.query(internal.billing.entitlement,{organizationId:org,key:'auth.sso'})).toBe(true);
 // Sessions end long before a term does, so each later step signs in again.
 const later=await signIn(t,31,'alice');
 expect(await t.query(api.billing.status,{token:later.token,organizationId:org})).toMatchObject({plan:'enterprise',allowed:true});
 expect(await deliver(t,sub('evt_ent','customer.subscription.created',at,'sub_ent',[item('si_commit','price_1','licensed','prod_ent',30)],{organizationId:org,contractId}))).toBe('active');
 expect(await account(t,org)).toMatchObject({plan:'enterprise',status:'active',subscriptionId:'sub_ent',seats:30});
 // A Pro subscription cancelled long before the contract starts is an ordinary cancellation.
 const early=await t.mutation(api.users.createOrganization,{token:later.token,name:'Early'});
 await t.run(ctx=>ctx.db.insert('billingAccounts',{organizationId:early,status:'active',seats:1,trialEndsAt:0,updatedAt:Date.now(),customerId:'cus_early',subscriptionId:'sub_early',plan:'pro'}));
 await t.action(api.enterpriseJobs.createContract,{token:(await signIn(t,operatorId,'operator')).token,...terms(early),startsAt:Date.UTC(2027,1,1)});
 const gone={...sub('evt_early','customer.subscription.deleted',at+60,'sub_early',[],{},'canceled')};(gone.data.object as {customer:string}).customer='cus_early';
 expect(await deliver(t,gone)).toBe('canceled');
});

test('renewal: reminders go out once at 60 and 30 days, a renewal takes over when the term ends, and the last month is reported before it does',async()=>{
 const {t,operator,org}=await setup(),calls=fakeStripe();
 await t.action(api.enterpriseJobs.createContract,{token:operator.token,...terms(org)});
 const first=(await account(t,org)).contract!.id,start=Math.floor(Date.UTC(2026,10,1)/1000),end=Date.UTC(2027,10,1);
 await deliver(t,sub('evt_ent','customer.subscription.created',start,'sub_ent',[item('si_commit','price_1','licensed','prod_ent',30)],{organizationId:org,contractId:first}));
 expect(await t.mutation(internal.enterprise.remindRenewals,{})).toBe(0);
 vi.setSystemTime(end-57*86400000);
 expect(await t.mutation(internal.enterprise.remindRenewals,{})).toBe(1);
 expect(await t.mutation(internal.enterprise.remindRenewals,{})).toBe(0);
 vi.setSystemTime(end-29*86400000);
 expect(await t.mutation(internal.enterprise.remindRenewals,{})).toBe(1);
 expect(await t.mutation(internal.enterprise.remindRenewals,{})).toBe(0);
 expect((await account(t,org)).contract!.remindersSent).toEqual([60,30]);
 // The renewal must start the day the term ends; it waits beside the contract in force.
 const token=(await signIn(t,operatorId,'operator')).token;
 await expect(t.action(api.enterpriseJobs.createContract,{token,...terms(org),startsAt:Date.UTC(2027,11,1)})).rejects.toThrow(/a renewal starts that day/);
 expect(await t.action(api.enterpriseJobs.createContract,{token,...terms(org),startsAt:end,committedContributors:40})).toBe('created');
 const renewed=await account(t,org);
 expect(renewed.contract).toMatchObject({id:first,committedContributors:30});
 expect(renewed.nextContract).toMatchObject({committedContributors:40,startsAt:end,endsAt:Date.UTC(2028,10,1),stripe:{scheduleId:'sub_sched_1'}});
 // A renewal cancels nothing: the old schedule ends the old subscription.
 expect(calls.filter(c=>c.path.startsWith('/v1/subscriptions/'))).toHaveLength(1);
 await expect(t.action(api.enterpriseJobs.createContract,{token,...terms(org),startsAt:end,committedContributors:50})).rejects.toThrow(/already has a renewal/);
 // The term's last month is reported at 23:30 on its last day, not after the subscription is gone.
 vi.setSystemTime(end-86400000);
 expect(await t.mutation(internal.billing.queueContributorReports,{final:true})).toBe(0);
 vi.setSystemTime(end-30*60000);
 expect(await t.mutation(internal.billing.queueContributorReports,{final:true})).toBe(1);
 expect((await t.run(ctx=>ctx.db.query('billingMeterEvents').collect())).map(e=>[e.kind,e.period,e.quantity])).toEqual([['contributors','2027-10',0]]);
 vi.setSystemTime(end+10*60000);
 expect(await t.mutation(internal.billing.queueContributorReports,{})).toBe(0);
 // The old subscription ends first; the renewal takes over, then its own subscription arrives.
 expect(await deliver(t,sub('evt_old_gone','customer.subscription.deleted',end/1000,'sub_ent',[],{organizationId:org,contractId:first},'canceled'))).toBe('contract takeover');
 expect(await account(t,org)).toMatchObject({plan:'enterprise',status:'active',seats:40,contract:{id:renewed.nextContract!.id}});
 expect((await account(t,org)).nextContract).toBeUndefined();
 expect(await deliver(t,sub('evt_new','customer.subscription.created',end/1000,'sub_ent2',[item('si_c2','price_3','licensed','prod_ent',40)],{organizationId:org,contractId:renewed.nextContract!.id}))).toBe('active');
 expect(await account(t,org)).toMatchObject({plan:'enterprise',subscriptionId:'sub_ent2',seats:40});
});

test('a contract that ends without a renewal leaves the workspace as a cancelled Pro subscription does; the form shows contributor history to operators only',async()=>{
 const {t,operator,alice,org}=await setup();fakeStripe();
 await expect(t.action(api.enterpriseJobs.contributorHistory,{token:alice.token,organizationId:org})).rejects.toThrow(/Forbidden/);
 expect(await t.action(api.enterpriseJobs.contributorHistory,{token:operator.token,organizationId:org})).toEqual({plan:'pro',seats:3,months:[{period:'2026-08',contributors:0},{period:'2026-09',contributors:0},{period:'2026-10',contributors:0}]});
 await t.action(api.enterpriseJobs.createContract,{token:operator.token,...terms(org)});
 const contractId=(await account(t,org)).contract!.id,start=Math.floor(Date.UTC(2026,10,1)/1000),end=Date.UTC(2027,10,1);
 await deliver(t,sub('evt_ent','customer.subscription.created',start,'sub_ent',[item('si_commit','price_1','licensed','prod_ent',30)],{organizationId:org,contractId}));
 vi.setSystemTime(end+1000);
 expect(await deliver(t,sub('evt_end','customer.subscription.deleted',end/1000,'sub_ent',[],{organizationId:org,contractId},'canceled'))).toBe('canceled');
 expect(await account(t,org)).toMatchObject({status:'canceled'});
 expect(await t.query(internal.billing.entitlement,{organizationId:org,key:'auth.sso'})).toBe(false);
 expect((await t.query(api.billing.status,{token:(await signIn(t,31,'alice')).token,organizationId:org})).plan).toBe('free');
});

test('contract terms: support tier is shown, retention settings stay inside the contract bounds, audit events are pruned and exported only on Enterprise',async()=>{
 const {t,operator,alice,org}=await setup();fakeStripe();
 // On Pro: default bounds, no export.
 await t.mutation(api.dataControls.saveSettings,{token:alice.token,organizationId:org,dataSharing:'private',reviewRetentionDays:null,transcriptRetentionDays:7});
 const range={from:Date.UTC(2026,9,1),to:Date.UTC(2026,11,1)};
 await expect(t.query(api.scopes.activityExport,{token:alice.token,organizationId:org,...range})).rejects.toThrow(/Enterprise plan/);
 await t.action(api.enterpriseJobs.createContract,{token:operator.token,...terms(org),supportTier:' Priority ',retention:{minDays:30,maxDays:365,auditDays:10}});
 await expect(t.action(api.enterpriseJobs.createContract,{token:operator.token,...terms(alice.id as never),retention:{minDays:400,maxDays:365}})).rejects.toThrow();
 const contractId=(await account(t,org)).contract!.id,start=Math.floor(Date.UTC(2026,10,1)/1000);
 // Until the contract is in force its terms change nothing.
 expect((await t.query(api.dataControls.settings,{token:alice.token,organizationId:org})).retentionBounds).toEqual({min:7,max:3650,unlimited:true});
 await deliver(t,sub('evt_ent','customer.subscription.created',start,'sub_ent',[item('si_commit','price_1','licensed','prod_ent',30)],{organizationId:org,contractId}));
 const status=await t.query(api.billing.status,{token:alice.token,organizationId:org});
 expect(status.enabled&&status.enterprise).toMatchObject({supportTier:'Priority'});
 expect((await t.query(api.dataControls.settings,{token:alice.token,organizationId:org})).retentionBounds).toEqual({min:30,max:365,unlimited:false});
 for(const bad of [{reviewRetentionDays:null,transcriptRetentionDays:60},{reviewRetentionDays:29,transcriptRetentionDays:60},{reviewRetentionDays:60,transcriptRetentionDays:366}])await expect(t.mutation(api.dataControls.saveSettings,{token:alice.token,organizationId:org,dataSharing:'private',...bad})).rejects.toThrow(/between 30 and 365 days under this workspace's contract/);
 await t.mutation(api.dataControls.saveSettings,{token:alice.token,organizationId:org,dataSharing:'private',reviewRetentionDays:30,transcriptRetentionDays:365});
 // Export: only this workspace's rows, only inside the range, admins only.
 const other=await t.mutation(api.users.createOrganization,{token:alice.token,name:'Other'});
 await t.run(async ctx=>{await ctx.db.insert('auditEvents',{organizationId:other,action:'other.secret',target:'x',createdAt:Date.now()});});
 const exported=await t.query(api.scopes.activityExport,{token:alice.token,organizationId:org,...range});
 expect(exported.isDone).toBe(true);
 expect(exported.page.map(e=>e.action)).toEqual(expect.arrayContaining(['billing.contract_created','workspace.data_settings']));
 expect(exported.page.map(e=>e.action)).not.toContain('other.secret');
 expect((await t.query(api.scopes.activityExport,{token:alice.token,organizationId:org,from:Date.UTC(2025,0,1),to:Date.UTC(2025,1,1)})).page).toEqual([]);
 const mia=await signIn(t,77,'mia');
 await t.run(ctx=>ctx.db.insert('organizationMembers',{organizationId:org,userId:mia.id as Id<'users'>,role:'member'}));
 await expect(t.query(api.scopes.activityExport,{token:mia.token,organizationId:org,...range})).rejects.toThrow();
 // The contract keeps audit events for 10 days: the sweep removes older ones and leaves the other workspace alone.
 const before=(await t.run(ctx=>ctx.db.query('auditEvents').collect())).filter(e=>e.organizationId===org).length;
 expect(before).toBeGreaterThan(0);
 vi.setSystemTime(Date.now()+11*86400000);
 await t.mutation(internal.dataControls.retention,{organizationId:org});
 const after=await t.run(ctx=>ctx.db.query('auditEvents').collect());
 expect(after.filter(e=>e.organizationId===org)).toEqual([]);
 expect(after.filter(e=>e.organizationId===other)).toHaveLength(1);
});

test('one contract across two workspaces: a person counts once, usage is one pool, and leaving the group returns the workspace to its own plan',async()=>{
 const {t,operator,alice,org}=await setup();fakeStripe();
 const second=await t.mutation(api.users.createOrganization,{token:alice.token,name:'Acme Labs'});
 // Only a workspace with a contract in Stripe can take others, and only operators decide.
 await expect(t.mutation(api.enterprise.setContractGroup,{token:operator.token,organizationId:second,billedOrganizationId:org})).rejects.toThrow(/holds a contract/);
 await t.action(api.enterpriseJobs.createContract,{token:operator.token,...terms(org),committedContributors:25,includedUsagePerContributorUsd:0.001});
 const contractId=(await account(t,org)).contract!.id,start=Math.floor(Date.UTC(2026,10,1)/1000);
 await deliver(t,sub('evt_ent','customer.subscription.created',start,'sub_ent',[item('si_commit','price_1','licensed','prod_ent',25)],{organizationId:org,contractId}));
 await expect(t.mutation(api.enterprise.setContractGroup,{token:alice.token,organizationId:second,billedOrganizationId:org})).rejects.toThrow(/Forbidden/);
 await expect(t.mutation(api.enterprise.setContractGroup,{token:operator.token,organizationId:org,billedOrganizationId:org})).rejects.toThrow(/holds a contract/);
 expect(await t.query(internal.billing.entitlement,{organizationId:second,key:'auth.sso'})).toBe(false);
 await t.mutation(api.enterprise.setContractGroup,{token:operator.token,organizationId:second,billedOrganizationId:org});
 expect(await t.query(internal.billing.entitlement,{organizationId:second,key:'audit.export'})).toBe(true);
 // bob wrote pull requests in both workspaces, carol in one, dave in the other: three people.
 const period='2026-10',row=(organizationId:Id<'organizations'>,login:string,firstAt:number)=>({organizationId,period,key:`github:github:${login}`,login,provider:'github',firstReviewId:reviewId,firstAt,bot:false});
 await t.mutation(api.repositories.connect,{token:alice.token,secret:svc,organizationId:org,installationId:31,account:'acme',accountId:1,repositories:[{id:3101,fullName:'acme/shop',defaultBranch:'main'}]});
 const [repo]=await t.query(api.repositories.list,{token:alice.token,organizationId:org});
 const reviewId=await t.run(ctx=>ctx.db.insert('reviews',{organizationId:org,repositoryId:repo._id,prNumber:1,headSha:'a'.repeat(40),status:'completed',mode:'standard',attempts:0,createdAt:Date.now(),updatedAt:Date.now()}));
 await t.run(async ctx=>{for(const r of [row(org,'bob',2),row(org,'carol',3),row(second,'bob',1),row(second,'dave',4)])await ctx.db.insert('activeContributors',r);});
 const [first,other]=await Promise.all([org,second].map(id=>t.query(api.billing.status,{token:alice.token,organizationId:id})));
 for(const s of [first,other])expect(s).toMatchObject({plan:'enterprise',limit:25_000,enterprise:{active:3,committed:25,workspaces:2}});
 expect(first.enabled&&first.enterprise?.billedHere).toBe(true);
 expect(other.enabled&&other.enterprise?.billedHere).toBe(false);
 expect(other.enabled&&other.enterprise?.contributors?.map(c=>c.login).sort()).toEqual(['bob','carol','dave']);
 // Usage in either workspace draws on the one pool ($0.025): two $0.01 calls fit, the third is refused in both.
 const quote={provider:'openai',model:'gpt-4.1',baseUrl:'https://api.openai.com/v1',inputTokenCeiling:1000,outputTokenCeiling:1000};
 for(const id of [org,second]){const reservation=await t.mutation(internal.inferenceBudget.reserve,{...quote,organizationId:id});await t.mutation(internal.inferenceBudget.settle,{id:reservation!,inputTokens:1000,outputTokens:1000});}
 expect((await t.query(api.billing.status,{token:alice.token,organizationId:second}))).toMatchObject({used:20_000,allowed:true});
 for(const id of [org,second])await expect(t.mutation(internal.inferenceBudget.reserve,{...quote,organizationId:id})).rejects.toThrow(/included usage/);
 // Taken out of the group, the second workspace is on its own plan again (it has none).
 await t.mutation(api.enterprise.setContractGroup,{token:operator.token,organizationId:second,billedOrganizationId:null});
 expect(await t.query(internal.billing.entitlement,{organizationId:second,key:'auth.sso'})).toBe(false);
 expect(await t.query(api.billing.status,{token:alice.token,organizationId:second})).toMatchObject({plan:'free',enterprise:null});
 expect(await t.query(api.billing.status,{token:alice.token,organizationId:org})).toMatchObject({used:10_000,enterprise:{active:2,workspaces:1}});
});
