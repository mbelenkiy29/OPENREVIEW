import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import {createHmac} from 'node:crypto';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import type {Id} from '../convex/_generated/dataModel';
import {STALE_RESERVATION_MS} from '../convex/inferenceBudget';
const modules=import.meta.glob('../convex/**/*.ts');
const secret='billing-session-secret-at-least-32-characters',whsec='whsec_billing_fixture';
const env={SESSION_SECRET:secret,SERVICE_SECRET:'billing-service',BILLING_ENABLED:'true',BILLING_TRIAL_USAGE_USD:'0.02',BILLING_USAGE_PER_SEAT_USD:'0.01',BILLING_GRACE_DAYS:'7',STRIPE_WEBHOOK_SECRET:whsec,STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_SEAT_PRICE_ID:'price_seat',APP_URL:'https://review.example.com'};
beforeEach(()=>{vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});vi.setSystemTime(Date.UTC(2026,9,14,12));Object.assign(process.env,env);});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();for(const k of [...Object.keys(env),'BILLING_TRIAL_DAYS'])if(!['SESSION_SECRET','SERVICE_SECRET'].includes(k))delete process.env[k];});

async function setup(){
 const t=convexTest(schema,modules);
 const login=async(githubId:number,name:string)=>{const id=await t.mutation(api.users.login,{secret:'billing-service',githubId,login:name,avatar:''});return {id:id as Id<'users'>,token:await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(id).setExpirationTime('120d').sign(new TextEncoder().encode(secret))};};
 const alice=await login(31,'alice'),bob=await login(32,'bob'),vera=await login(33,'vera');
 const org=await t.mutation(api.users.createOrganization,{token:alice.token,name:'Acme'});
 // Most tests cover workspaces from before plans were required (trial without a card); see the
 // required-plan test for new workspaces.
 await t.run(ctx=>ctx.db.patch(org,{planRequired:undefined}));
 await t.mutation(api.repositories.connect,{token:alice.token,secret:'billing-service',organizationId:org,installationId:31,account:'acme',accountId:1,repositories:[{id:3101,fullName:'acme/shop',defaultBranch:'main'}]});
 const [repo]=await t.query(api.repositories.list,{token:alice.token,organizationId:org});
 const members=await t.run(async ctx=>{await ctx.db.patch(repo._id,{enabled:true});return {bob:await ctx.db.insert('organizationMembers',{organizationId:org,userId:bob.id,role:'member'}),vera:await ctx.db.insert('organizationMembers',{organizationId:org,userId:vera.id,role:'viewer'})};});
 return {t,alice,bob,vera,org,repo,members};
}
// One model call: gpt-4.1 at $2/$8 per million reserves $0.01 for 1000 + 1000 tokens and settles what was used.
const quote={provider:'openai',model:'gpt-4.1',baseUrl:'https://api.openai.com/v1',inputTokenCeiling:1000,outputTokenCeiling:1000};
const reserve=(t:Awaited<ReturnType<typeof setup>>['t'],organizationId:Id<'organizations'>)=>t.mutation(internal.inferenceBudget.reserve,{...quote,organizationId});
async function spend(t:Awaited<ReturnType<typeof setup>>['t'],organizationId:Id<'organizations'>,tokens=1000){const id=await reserve(t,organizationId);if(!id)throw Error('No reservation');await t.mutation(internal.inferenceBudget.settle,{id,inputTokens:tokens,outputTokens:tokens});}
const enqueue=(t:Awaited<ReturnType<typeof setup>>['t'],repositoryId:Id<'repositories'>,pr:number)=>t.mutation(internal.reviews.enqueue,{repositoryId,prNumber:pr,headSha:String(pr).padStart(40,'a'),trigger:'automatic'});
const reviewOf=(t:Awaited<ReturnType<typeof setup>>['t'],id:Id<'reviews'>|null)=>t.run(ctx=>ctx.db.get(id!));
function signed(event:Record<string,unknown>,key=whsec){const body=JSON.stringify(event),ts=Math.floor(Date.now()/1000);return {body,headers:{'content-type':'application/json','stripe-signature':`t=${ts},v1=${createHmac('sha256',key).update(`${ts}.${body}`).digest('hex')}`}};}
const deliver=(t:Awaited<ReturnType<typeof setup>>['t'],event:Record<string,unknown>,key?:string)=>{const {body,headers}=signed(event,key);return t.fetch('/stripe/webhook',{method:'POST',headers,body});};
const subscription=(id:string,type:string,status:string,quantity:number,created:number,org?:string)=>({id,type,created,data:{object:{id:'sub_1',customer:'cus_1',status,metadata:org?{organizationId:org}:{},items:{data:[{id:'si_1',quantity,current_period_end:created+30*86400}]}}}});

test('trial usage is enforced on every model call and at enqueue; blocked reviews are recorded with the billing reason and counted',async()=>{
 process.env.BILLING_TRIAL_DAYS='60';
 const {t,alice,vera,org,repo}=await setup();
 const first=await enqueue(t,repo._id,1);
 expect((await reviewOf(t,first))?.status).toBe('queued');
 // The trial includes $0.02 a month: one call fits, two concurrent ones cannot both reserve, and the
 // refusal comes before anything is sent.
 await spend(t,org);
 const racing=await Promise.allSettled([reserve(t,org),reserve(t,org)]);
 expect(racing.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(String((racing.find(r=>r.status==='rejected') as PromiseRejectedResult).reason)).toMatch(/trial's included usage is used up/);
 const held=(racing.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<Id<'inferenceReservations'>|null>).value!;
 expect(await t.query(api.billing.status,{token:alice.token,organizationId:org})).toMatchObject({used:10000,reserved:10000,allowed:false});
 await t.mutation(internal.inferenceBudget.settle,{id:held,inputTokens:1000,outputTokens:1000});
 const blocked=await enqueue(t,repo._id,2);
 expect(await reviewOf(t,blocked)).toMatchObject({status:'failed',error:"Billing: The trial's included usage is used up. Subscribe in Settings → Billing to keep reviewing."});
 // Re-requesting an existing queued head does not count again.
 expect(await enqueue(t,repo._id,1)).toBe(first);
 const status=await t.query(api.billing.status,{token:alice.token,organizationId:org});
 expect(status).toMatchObject({enabled:true,plan:'trial',allowed:false,used:20000,reserved:0,limit:20000,reviews:1,blocked:1,activeSeats:2,referral:null,resetsAt:Date.UTC(2026,10,1)});
 // The referral program is off by default (REFERRALS_ENABLED unset); a viewer never sees it either.
 expect((await t.query(api.billing.status,{token:vera.token,organizationId:org})).referral).toBeNull();
 // A new month resets the counter; an expired trial blocks regardless.
 vi.setSystemTime(Date.UTC(2026,10,1,0,0,1));
 expect((await reviewOf(t,await enqueue(t,repo._id,4)))?.status).toBe('queued');
 vi.setSystemTime(Date.UTC(2026,11,14));
 expect((await reviewOf(t,await enqueue(t,repo._id,5)))?.error).toMatch(/free trial has ended/);
});

test('the trial starts with the first review, so workspaces created before billing get the full trial',async()=>{
 const {t,alice,org,repo}=await setup();
 // A month after the workspace was created, nothing has been billed yet: the trial has not started.
 vi.setSystemTime(Date.UTC(2026,10,14,12));
 const before=await t.query(api.billing.status,{token:alice.token,organizationId:org});
 expect(before).toMatchObject({plan:'trial',allowed:true,trialStarted:false,trialDays:14,trialEndsAt:Date.now()+14*86400000});
 expect((await reviewOf(t,await enqueue(t,repo._id,1)))?.status).toBe('queued');
 const started=await t.query(api.billing.status,{token:alice.token,organizationId:org});
 expect(started).toMatchObject({trialStarted:true,trialEndsAt:Date.UTC(2026,10,28,12),reviews:1});
 vi.setSystemTime(Date.UTC(2026,10,28,12));
 expect((await reviewOf(t,await enqueue(t,repo._id,2)))?.error).toMatch(/free trial has ended/);
});

test('switching Stripe modes drops test customers and subscriptions but keeps the trial',async()=>{
 const {t,alice,org,repo}=await setup();
 const created=Math.floor(Date.now()/1000);
 await deliver(t,{id:'evt_link',type:'checkout.session.completed',created,data:{object:{mode:'subscription',client_reference_id:org,customer:'cus_test',subscription:'sub_1'}}});
 await deliver(t,{...subscription('evt_trial','customer.subscription.created','trialing',2,created+1,org),data:{object:{id:'sub_1',customer:'cus_test',status:'trialing',metadata:{organizationId:org},items:{data:[{id:'si_1',quantity:2,current_period_end:created+14*86400}]}}}});
 const before=(await t.run(ctx=>ctx.db.query('billingAccounts').collect()))[0];
 expect(before).toMatchObject({customerId:'cus_test',subscriptionId:'sub_1',status:'trialing'});
 await expect(t.mutation(internal.billing.forgetStripeLinks,{confirm:'nope' as 'switch-stripe-mode'})).rejects.toThrow();
 expect(await t.mutation(internal.billing.forgetStripeLinks,{confirm:'switch-stripe-mode'})).toBe(1);
 const after=(await t.run(ctx=>ctx.db.query('billingAccounts').collect()))[0];
 expect(after).toMatchObject({status:'trial',seats:2,trialEndsAt:before.trialEndsAt});
 for(const key of ['customerId','subscriptionId','subscriptionItemId','currentPeriodEnd','lastEventCreated'] as const)expect(after[key]).toBeUndefined();
 expect(await t.query(api.billing.status,{token:alice.token,organizationId:org})).toMatchObject({plan:'trial',allowed:true,hasCustomer:false,trialStarted:true});
 // A live Checkout now creates a new customer instead of reusing the test one.
 vi.spyOn(globalThis,'fetch').mockImplementation(async(input:string|URL|Request)=>String(input).endsWith('/v1/customers')?Response.json({id:'cus_live'}):Response.json({id:'cs_1',url:'https://checkout.stripe.com/c/pay/cs_1'}));
 await t.action(api.billingJobs.checkout,{token:alice.token,organizationId:org});
 expect((await t.run(ctx=>ctx.db.query('billingAccounts').collect()))[0].customerId).toBe('cus_live');
 expect((await reviewOf(t,await enqueue(t,repo._id,1)))?.status).toBe('queued');
});

test('without BILLING_ENABLED nothing is enforced and the webhook endpoint does not exist',async()=>{
 delete process.env.BILLING_ENABLED;
 const {t,alice,org,repo}=await setup();
 for(let pr=1;pr<=4;pr++)expect((await reviewOf(t,await enqueue(t,repo._id,pr)))?.status).toBe('queued');
 expect(await t.query(api.billing.status,{token:alice.token,organizationId:org})).toEqual({enabled:false});
 expect((await deliver(t,subscription('evt_off','customer.subscription.updated','active',1,1))).status).toBe(404);
 expect(await t.run(ctx=>ctx.db.query('billingAccounts').collect())).toEqual([]);
});

test('signed Stripe webhooks link the workspace, apply once, and ignore replays and out-of-order events',async()=>{
 const {t,alice,org,repo}=await setup();
 const created=Math.floor(Date.now()/1000);
 const bad=signed({id:'evt_x',type:'invoice.paid',created,data:{object:{customer:'cus_1'}}});
 expect((await t.fetch('/stripe/webhook',{method:'POST',headers:bad.headers,body:bad.body+' '})).status).toBe(401);
 expect((await deliver(t,{id:'evt_x',type:'invoice.paid',created,data:{object:{customer:'cus_1'}}},'whsec_wrong')).status).toBe(401);
 const checkout={id:'evt_checkout',type:'checkout.session.completed',created,data:{object:{mode:'subscription',client_reference_id:org,customer:'cus_1',subscription:'sub_1'}}};
 expect((await deliver(t,checkout)).status).toBe(200);
 expect((await deliver(t,checkout)).status).toBe(200);
 const outcomes=async()=>(await t.run(ctx=>ctx.db.query('stripeEvents').collect())).map(e=>[e.eventId,e.outcome]);
 expect(await outcomes()).toEqual([['evt_checkout','linked']]);
 await deliver(t,subscription('evt_sub_new','customer.subscription.updated','active',3,created+20,org));
 await deliver(t,subscription('evt_sub_old','customer.subscription.created','incomplete',1,created+10,org));
 await deliver(t,subscription('evt_sub_new','customer.subscription.updated','active',3,created+20,org));
 expect(await outcomes()).toEqual([['evt_checkout','linked'],['evt_sub_new','active'],['evt_sub_old','stale']]);
 expect(await t.run(ctx=>ctx.db.query('billingAccounts').collect())).toEqual([expect.objectContaining({organizationId:org,customerId:'cus_1',subscriptionId:'sub_1',subscriptionItemId:'si_1',status:'active',seats:3})]);
 // Starter plan: 3 seats × $0.01 of included usage a month.
 for(let pr=1;pr<=3;pr++){expect((await reviewOf(t,await enqueue(t,repo._id,pr)))?.status).toBe('queued');await spend(t,org);}
 expect((await reviewOf(t,await enqueue(t,repo._id,4)))?.error).toMatch(/used its included usage for this month\. Usage resets on November 1/);
 expect(await t.query(api.billing.status,{token:alice.token,organizationId:org})).toMatchObject({plan:'starter',limit:30000,used:30000,reviews:3});
 // A subscription for another workspace cannot hijack this customer.
 await deliver(t,subscription('evt_spoof','customer.subscription.updated','active',99,created+30,'k57abc0000000000000000organizations'));
 expect((await t.run(ctx=>ctx.db.query('billingAccounts').collect()))[0].seats).toBe(3);
 // Payment failure (Stripe marks the subscription past due): reviews continue through the grace period, then pause; payment restores them.
 vi.setSystemTime(Date.UTC(2026,10,2));
 const failedAt=Math.floor(Date.now()/1000);
 await deliver(t,subscription('evt_past_due','customer.subscription.updated','past_due',3,failedAt,org));
 expect((await t.query(api.billing.status,{token:alice.token,organizationId:org})).status).toBe('past_due');
 vi.setSystemTime(Date.UTC(2026,10,8));
 expect((await reviewOf(t,await enqueue(t,repo._id,8)))?.status).toBe('queued');
 vi.setSystemTime(Date.UTC(2026,10,9,1));
 expect((await reviewOf(t,await enqueue(t,repo._id,9)))?.error).toMatch(/past due and the grace period has ended/);
 await deliver(t,subscription('evt_recovered','customer.subscription.updated','active',3,Math.floor(Date.now()/1000),org));
 expect((await reviewOf(t,await enqueue(t,repo._id,10)))?.status).toBe('queued');
 // Invoice events never set the status, so a late or redelivered payment failure cannot block the paid workspace.
 // Current API versions put the invoice's subscription under parent.subscription_details.
 const lateFailure=(id:string)=>({id,type:'invoice.payment_failed',created:failedAt,data:{object:{customer:'cus_1',parent:{subscription_details:{subscription:'sub_1'}}}}});
 await deliver(t,{id:'evt_paid',type:'invoice.paid',created:Math.floor(Date.now()/1000),data:{object:{customer:'cus_1',subscription:'sub_1'}}});
 await deliver(t,lateFailure('evt_failed_late'));
 expect((await t.query(api.billing.status,{token:alice.token,organizationId:org})).status).toBe('active');
 expect((await reviewOf(t,await enqueue(t,repo._id,11)))?.status).toBe('queued');
 // Cancellation falls back to the (expired) trial; a late payment failure does not revive it as past due.
 await deliver(t,subscription('evt_cancel','customer.subscription.deleted','canceled',3,Math.floor(Date.now()/1000),org));
 await deliver(t,lateFailure('evt_failed_after_cancel'));
 expect((await t.query(api.billing.status,{token:alice.token,organizationId:org})).status).toBe('canceled');
 expect((await reviewOf(t,await enqueue(t,repo._id,12)))?.error).toMatch(/free trial has ended/);
});

test('seats follow membership: viewers are free and changes resync the subscription quantity',async()=>{
 const {t,alice,bob,org,members}=await setup();
 const calls:{url:string;body:string;key:string|null}[]=[];
 vi.spyOn(globalThis,'fetch').mockImplementation(async(input:string|URL|Request,init?:RequestInit)=>{const url=String(input);calls.push({url,body:String(init?.body),key:new Headers(init?.headers).get('idempotency-key')});
  if(url.endsWith('/v1/customers'))return Response.json({id:'cus_1'});
  if(url.endsWith('/v1/checkout/sessions'))return Response.json({id:'cs_1',url:'https://checkout.stripe.com/c/pay/cs_1'});
  if(url.endsWith('/v1/billing_portal/sessions'))return Response.json({url:'https://billing.stripe.com/p/session_1'});
  if(url.includes('/v1/subscriptions/'))return Response.json({id:'sub_1'});
  return new Response('unexpected',{status:500});});
 await expect(t.action(api.billingJobs.checkout,{token:bob.token,organizationId:org})).rejects.toThrow(/Forbidden/);
 expect(await t.action(api.billingJobs.checkout,{token:alice.token,organizationId:org})).toBe('https://checkout.stripe.com/c/pay/cs_1');
 const session=new URLSearchParams(calls[1].body);
 // The untouched 14-day trial carries into the subscription, so the card is not charged until it ends.
 expect(Object.fromEntries(session)).toMatchObject({mode:'subscription',customer:'cus_1',client_reference_id:org,integration_identifier:expect.stringMatching(/^openreview-starter-seats-[a-z]{8}$/),allow_promotion_codes:'true','line_items[0][price]':'price_seat','line_items[0][quantity]':'2','subscription_data[metadata][organizationId]':org,'subscription_data[trial_end]':String(Math.floor((Date.now()+14*86400000)/1000)),success_url:'https://review.example.com/dashboard/settings/billing?checkout=success',cancel_url:'https://review.example.com/dashboard/settings/billing?checkout=cancelled'});
 expect(session.has('payment_method_types')).toBe(false);
 expect(session.get('payment_method_collection')).toBe('always');
 // With the referral program off (the default) the request has exactly these fields: no discounts, no referral metadata.
 expect([...session.keys()]).toEqual(['mode','customer','client_reference_id','payment_method_collection','integration_identifier','allow_promotion_codes','line_items[0][price]','line_items[0][quantity]','subscription_data[metadata][organizationId]','subscription_data[trial_end]','success_url','cancel_url']);
 // From guided setup, Checkout returns to the plan step.
 await t.action(api.billingJobs.checkout,{token:alice.token,organizationId:org,returnTo:'onboarding'});
 expect(Object.fromEntries(new URLSearchParams(calls.at(-1)!.body))).toMatchObject({success_url:'https://review.example.com/dashboard/onboarding/plan?checkout=success',cancel_url:'https://review.example.com/dashboard/onboarding/plan?checkout=cancelled'});
 expect(calls[0].key).toBe(`customer:${org}`);
 expect(await t.action(api.billingJobs.portal,{token:alice.token,organizationId:org})).toBe('https://billing.stripe.com/p/session_1');
 await deliver(t,subscription('evt_sub','customer.subscription.created','active',2,Math.floor(Date.now()/1000),org));
 // Promoting the viewer adds a billed seat; the sync job updates Stripe once.
 await t.mutation(api.team.update,{token:alice.token,memberId:members.vera,role:'member',remove:false});
 const jobs=(await t.run(ctx=>ctx.db.system.query('_scheduled_functions').collect())).filter(j=>j.name.includes('billingJobs:syncSeats'));
 expect(jobs).toHaveLength(1);
 expect(await t.action(internal.billingJobs.syncSeats,{organizationId:org})).toBe('updated');
 const update=calls.at(-1)!;
 expect(update.url).toBe('https://api.stripe.com/v1/subscriptions/sub_1');
 expect(Object.fromEntries(new URLSearchParams(update.body))).toEqual({'items[0][id]':'si_1','items[0][quantity]':'3',proration_behavior:'create_prorations'});
 // No idempotency key: within Stripe's 24h key window a later 2→3 change (after 3→2) would otherwise replay this one.
 expect(update.key).toBeNull();
 expect((await t.query(api.billing.status,{token:alice.token,organizationId:org})).activeSeats).toBe(3);
 await expect(t.action(api.billingJobs.checkout,{token:alice.token,organizationId:org})).rejects.toThrow(/already has a subscription/);
 // Live keys are refused unless explicitly allowed.
 process.env.STRIPE_SECRET_KEY='sk_live_x';
 await expect(t.action(api.billingJobs.portal,{token:alice.token,organizationId:org})).rejects.toThrow(/test-mode key/);
});

test('a new workspace must choose a plan: nothing indexes, reviews or finishes setup until Stripe confirms the trial',async()=>{
 const {t,alice,repo}=await setup();
 const fresh=await t.mutation(api.users.createOrganization,{token:alice.token,name:'New customer'});
 expect((await t.run(ctx=>ctx.db.get(fresh)))?.planRequired).toBe(true);
 expect(await t.query(api.billing.status,{token:alice.token,organizationId:fresh})).toMatchObject({planRequired:true,planSelected:false,planMissing:true});
 await t.mutation(api.repositories.connect,{token:alice.token,secret:'billing-service',organizationId:fresh,installationId:77,account:'newco',accountId:7,repositories:[{id:7701,fullName:'newco/app',defaultBranch:'main'}]});
 const newRepo=(await t.run(ctx=>ctx.db.query('repositories').withIndex('by_github',q=>q.eq('githubId',7701)).unique()))!;
 await expect(t.mutation(api.repositories.configure,{token:alice.token,repositoryId:newRepo._id,enabled:true})).rejects.toThrow(/Choose a plan/);
 await expect(t.mutation(api.onboarding.advance,{token:alice.token,organizationId:fresh,step:'plan'})).rejects.toThrow(/Choose a plan/);
 await expect(t.mutation(api.onboarding.complete,{token:alice.token,organizationId:fresh,skipped:true})).rejects.toThrow(/Choose a plan/);
 await t.run(ctx=>ctx.db.patch(newRepo._id,{enabled:true}));
 const blocked=await reviewOf(t,await enqueue(t,newRepo._id,1));
 expect([blocked?.status,blocked?.error]).toEqual(['failed',expect.stringMatching(/^Billing: Choose a plan/)]);
 // An abandoned or failed Checkout is not a choice.
 const created=Math.floor(Date.now()/1000);
 await t.mutation(internal.billing.linkCustomer,{organizationId:fresh,customerId:'cus_new'});
 await deliver(t,{id:'evt_incomplete',type:'customer.subscription.created',created,data:{object:{id:'sub_new',customer:'cus_new',status:'incomplete',metadata:{organizationId:fresh},items:{data:[{id:'si_new',quantity:1,current_period_end:created+14*86400}]}}}});
 expect((await t.run(ctx=>ctx.db.get(fresh)))?.planSelectedAt).toBeUndefined();
 // Stripe confirms the trial subscription (card collected): the choice is recorded once and everything opens up.
 await deliver(t,{id:'evt_new_checkout',type:'checkout.session.completed',created:created+1,data:{object:{mode:'subscription',client_reference_id:fresh,customer:'cus_new',subscription:'sub_new'}}});
 const chosen=(await t.run(ctx=>ctx.db.get(fresh)))!;
 expect([chosen.plan,typeof chosen.planSelectedAt]).toEqual(['starter','number']);
 expect((await t.run(ctx=>ctx.db.query('auditEvents').collect())).filter(e=>e.action==='billing.plan_selected').map(e=>e.organizationId)).toEqual([fresh]);
 expect(await t.query(api.billing.status,{token:alice.token,organizationId:fresh})).toMatchObject({planSelected:true,planMissing:false});
 await t.mutation(api.repositories.configure,{token:alice.token,repositoryId:newRepo._id,enabled:true});
 expect(await t.mutation(api.onboarding.advance,{token:alice.token,organizationId:fresh,step:'plan'})).toBe('connect');
 // Workspaces from before plans were required are untouched.
 expect(await t.query(api.billing.status,{token:alice.token,organizationId:repo.organizationId})).toMatchObject({planRequired:false,planMissing:false});
});

test('extra usage runs past the included amount up to the admin cap and is metered to Stripe once',async()=>{
 const {t,alice,bob,org}=await setup();
 await t.run(ctx=>ctx.db.insert('billingAccounts',{organizationId:org,customerId:'cus_1',subscriptionId:'sub_1',status:'active',seats:1,trialEndsAt:Date.now(),updatedAt:Date.now()}));
 // 1 seat includes $0.01: a half-size call leaves $0.005, and the next full call does not fit without extra usage.
 await spend(t,org,500);
 await expect(reserve(t,org)).rejects.toThrow(/turn on extra usage in Settings → Billing/);
 await expect(t.mutation(api.billing.setSpendingCap,{token:bob.token,organizationId:org,capUsd:1})).rejects.toThrow();
 await expect(t.mutation(api.billing.setSpendingCap,{token:alice.token,organizationId:org,capUsd:-1})).rejects.toThrow(/between/);
 await t.mutation(api.billing.setSpendingCap,{token:alice.token,organizationId:org,capUsd:0.01});
 // Only the part past the included usage is extra: $0.005 of this $0.01 call.
 await spend(t,org);
 await expect(reserve(t,org)).rejects.toThrow(/extra usage cap of \$0\.01 this month/);
 const [event]=await t.run(ctx=>ctx.db.query('billingMeterEvents').collect());
 expect(event).toMatchObject({organizationId:org,period:'2026-10',micros:5000,status:'pending'});
 expect(await t.query(api.billing.status,{token:alice.token,organizationId:org})).toMatchObject({used:15000,limit:10000,overage:5000,capUsd:0.01});
 expect(await t.run(ctx=>ctx.db.query('auditEvents').filter(q=>q.eq(q.field('action'),'billing.spending_cap')).collect())).toHaveLength(1);
 const bodies:string[]=[];vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{bodies.push(String(init?.body));return Response.json({});});
 expect(await t.action(internal.billingJobs.reportUsage,{id:event._id})).toBe('reported');
 expect(await t.action(internal.billingJobs.reportUsage,{id:event._id})).toBe('done');
 expect(bodies).toHaveLength(1);
 expect(bodies[0]).toContain(`identifier=${event._id}`);expect(bodies[0]).toContain('payload%5Bvalue%5D=5000');expect(bodies[0]).toContain('payload%5Bstripe_customer_id%5D=cus_1');
 // A new month starts from zero.
 vi.setSystemTime(Date.UTC(2026,10,1,0,0,1));
 expect(await reserve(t,org)).toBeTruthy();
});

test('workspaces pick models from the operator price list',async()=>{
 const {t,alice,bob,org,repo}=await setup();
 process.env.LLM_PROVIDER='openrouter';process.env.INFERENCE_PRICES=JSON.stringify({'openrouter:openai/gpt-4.1':{input:2,output:8},'openrouter:anthropic/claude-sonnet-5-5':{input:3,output:15},'openai:gpt-4.1':{input:2,output:8}});
 try{
  expect((await t.query(api.scopes.list,{token:alice.token,organizationId:org})).models.map(m=>m.model)).toEqual(['openai/gpt-4.1','anthropic/claude-sonnet-5-5']);
  const current=await t.query(api.settings.repository,{token:alice.token,repositoryId:repo._id});
  expect(current.models).toHaveLength(2);
  await expect(t.mutation(api.scopes.save,{token:alice.token,organizationId:org,settings:{...current.settings,model:'meta/unpriced'},overrideKeys:['model']})).rejects.toThrow(/model from this deployment's list/);
  await expect(t.mutation(api.repositories.configure,{token:alice.token,repositoryId:repo._id,enabled:true,settings:{...current.settings,aiAuthoredModel:'meta/unpriced'}})).rejects.toThrow(/model from this deployment's list/);
  expect(await t.query(internal.scopes.workspaceModel,{organizationId:org})).toBeNull();
  await t.mutation(api.scopes.save,{token:alice.token,organizationId:org,settings:{...current.settings,model:'anthropic/claude-sonnet-5-5'},overrideKeys:['model']});
  expect(await t.query(internal.scopes.workspaceModel,{organizationId:org})).toBe('anthropic/claude-sonnet-5-5');
  // Settings → AI Model: admins pick or reset; members only see it; other scope overrides are kept.
  await expect(t.mutation(api.scopes.setWorkspaceModel,{token:bob.token,organizationId:org,model:'openai/gpt-4.1'})).rejects.toThrow();
  await expect(t.mutation(api.scopes.setWorkspaceModel,{token:alice.token,organizationId:org,model:'meta/unpriced'})).rejects.toThrow(/model from this deployment's list/);
  await t.mutation(api.scopes.setWorkspaceModel,{token:alice.token,organizationId:org,model:'openai/gpt-4.1'});
  expect(await t.query(api.scopes.modelChoice,{token:bob.token,organizationId:org})).toMatchObject({model:'openai/gpt-4.1',ownKey:false,models:[{model:'openai/gpt-4.1'},{model:'anthropic/claude-sonnet-5-5'}]});
  await t.mutation(api.scopes.setWorkspaceModel,{token:alice.token,organizationId:org,model:''});
  expect(await t.query(internal.scopes.workspaceModel,{organizationId:org})).toBeNull();
 }finally{delete process.env.LLM_PROVIDER;delete process.env.INFERENCE_PRICES;}
});

test('a workspace without saved scope settings gets one holding only the model override',async()=>{
 const {t,alice,org}=await setup();
 await t.run(async ctx=>{for(const s of await ctx.db.query('scopeSettings').collect())await ctx.db.delete(s._id);});
 await t.mutation(api.scopes.setWorkspaceModel,{token:alice.token,organizationId:org,model:'gpt-4.1-mini'});
 expect(await t.run(ctx=>ctx.db.query('scopeSettings').collect())).toEqual([expect.objectContaining({organizationId:org,overrideKeys:['model'],settings:expect.objectContaining({model:'gpt-4.1-mini'})})]);
});

test('a workspace reservation that is never settled stops counting after expiry and is not billed',async()=>{
 const {t,alice,org}=await setup();
 // The trial's $0.02 holds two calls in flight; neither reports usage.
 const old=await reserve(t,org),fresh=await reserve(t,org);
 await expect(reserve(t,org)).rejects.toThrow(/included usage is used up/);
 await t.run(ctx=>ctx.db.patch(old!,{createdAt:Date.now()-STALE_RESERVATION_MS-1}));
 await t.mutation(internal.inferenceBudget.expireStale,{});
 expect(await t.query(api.billing.status,{token:alice.token,organizationId:org})).toMatchObject({used:0,reserved:10000,allowed:true});
 expect(await t.run(async ctx=>(await ctx.db.get(fresh!))!.status)).toBe('reserved');
 expect(await reserve(t,org)).toBeTruthy();
});
