import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import type {Id} from '../convex/_generated/dataModel';
import * as stripeClient from '../src/billing';

const modules=import.meta.glob('../convex/**/*.ts');
const secret='billing-off-session-secret-at-least-32-chars',svc='billing-off-service';
const stripeEnv={STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_SEAT_PRICE_ID:'price_seat',STRIPE_PRO_PRICE_ID:'price_pro',STRIPE_WEBHOOK_SECRET:'whsec_fixture',APP_URL:'https://review.example.com'};
beforeEach(()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});
 vi.setSystemTime(Date.UTC(2026,9,14,12));
 Object.assign(process.env,{SESSION_SECRET:secret,SERVICE_SECRET:svc,...stripeEnv});
 delete process.env.BILLING_ENABLED;
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();for(const k of [...Object.keys(stripeEnv),'BILLING_ENABLED'])delete process.env[k];});

function watchStripe(){
 const stripeUrls:string[]=[];
 vi.spyOn(globalThis,'fetch').mockImplementation(async(input:string|URL|Request)=>{
  const url=String(input);
  if(/stripe\.com/i.test(url))stripeUrls.push(url);
  return Response.json({});
 });
 const stripe=vi.spyOn(stripeClient,'stripe');
 const stripeGet=vi.spyOn(stripeClient,'stripeGet');
 const stripeV2=vi.spyOn(stripeClient,'stripeV2');
 return {
  stripeUrls,
  assertNone:()=>{
   expect(stripe).not.toHaveBeenCalled();
   expect(stripeGet).not.toHaveBeenCalled();
   expect(stripeV2).not.toHaveBeenCalled();
   expect(stripeUrls).toEqual([]);
  },
 };
}

test('with BILLING_ENABLED unset the free and self-host paths never call Stripe',async()=>{
 const watched=watchStripe();
 const t=convexTest(schema,modules);
 const id=await t.mutation(api.users.login,{secret:svc,githubId:51,login:'alice',avatar:''}) as Id<'users'>;
 const token=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(id).setExpirationTime('120d').sign(new TextEncoder().encode(secret));
 // Onboarding / plan: a new workspace does not become a Stripe customer, and setup does not visit the plan step.
 const org=await t.mutation(api.users.createOrganization,{token,name:'Acme'});
 await t.finishAllScheduledFunctions(vi.runAllTimers);
 expect(await t.action(internal.billingJobs.createCustomer,{organizationId:org})).toBe('skipped');
 expect(await t.mutation(internal.billing.backfillCustomers,{})).toEqual({dryRun:true,workspaces:0});
 expect((await t.run(ctx=>ctx.db.get(org)))?.planRequired).toBeUndefined();
 expect(await t.mutation(api.onboarding.advance,{token,organizationId:org,step:'team'})).toBe('done');
 expect(await t.query(api.onboarding.status,{token,organizationId:org})).toMatchObject({admin:true});
 // Billing page data.
 expect(await t.query(api.billing.status,{token,organizationId:org})).toEqual({enabled:false});
 expect(await t.query(api.billing.locked,{token,organizationId:org})).toEqual([]);
 // Webhook-independent review flow: enqueue and complete a review without Stripe.
 await t.mutation(api.repositories.connect,{token,secret:svc,organizationId:org,installationId:51,account:'acme',accountId:1,repositories:[{id:5101,fullName:'acme/shop',defaultBranch:'main'}]});
 const [repo]=await t.query(api.repositories.list,{token,organizationId:org});
 await t.run(ctx=>ctx.db.patch(repo._id,{enabled:true}));
 const reviewId=await t.mutation(internal.reviews.enqueue,{repositoryId:repo._id,prNumber:1,headSha:'a'.repeat(40),trigger:'automatic'});
 expect(reviewId).toBeTruthy();
 const queued=reviewId!;
 expect((await t.run(ctx=>ctx.db.get(queued)))?.status).toBe('queued');
 await t.run(async ctx=>{await ctx.db.patch(queued,{status:'running',author:'bob'});});
 await t.mutation(internal.reviews.finished,{reviewId:queued});
 expect(await t.run(ctx=>ctx.db.query('activeContributors').collect())).toEqual([]);
 expect(await t.run(ctx=>ctx.db.query('billingAccounts').collect())).toEqual([]);
 expect(await t.run(ctx=>ctx.db.query('billingMeterEvents').collect())).toEqual([]);
 // Enterprise contributor reporting: leftover contract rows still do not enqueue a Stripe meter event.
 await t.run(async ctx=>{
  await ctx.db.insert('billingAccounts',{organizationId:org,status:'active',seats:25,trialEndsAt:0,updatedAt:Date.now(),subscriptionId:'sub_e',customerId:'cus_e',plan:'enterprise',contract:{id:'c1',mode:'managed',startsAt:Date.UTC(2026,8,1),endsAt:Date.UTC(2027,8,1),committedContributors:25,minimumContributors:25,contributorPriceCents:2200,includedUsagePerContributorUsd:12,overageMultiplier:1.15,netDays:30,graceDays:30,nonBillableAuthors:[]}});
  await ctx.db.insert('activeContributors',{organizationId:org,period:'2026-10',key:'github:github:bob',login:'bob',provider:'github',firstReviewId:queued,firstAt:Date.now(),bot:false});
 });
 vi.setSystemTime(Date.UTC(2026,10,1,0,10));
 expect(await t.mutation(internal.billing.queueContributorReports,{})).toBe(0);
 await t.finishAllScheduledFunctions(vi.runAllTimers);
 expect(await t.run(ctx=>ctx.db.query('billingMeterEvents').collect())).toEqual([]);
 expect((await t.fetch('/stripe/webhook',{method:'POST',body:'{}'})).status).toBe(404);
 watched.assertNone();
});

test('with BILLING_ENABLED=false the same paths still never call Stripe',async()=>{
 process.env.BILLING_ENABLED='false';
 const watched=watchStripe();
 const t=convexTest(schema,modules);
 const id=await t.mutation(api.users.login,{secret:svc,githubId:52,login:'bob',avatar:''}) as Id<'users'>;
 const token=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(id).setExpirationTime('120d').sign(new TextEncoder().encode(secret));
 const org=await t.mutation(api.users.createOrganization,{token,name:'Selfhost'});
 await t.finishAllScheduledFunctions(vi.runAllTimers);
 expect(await t.query(api.billing.status,{token,organizationId:org})).toEqual({enabled:false});
 expect(await t.mutation(internal.billing.queueContributorReports,{})).toBe(0);
 watched.assertNone();
});
