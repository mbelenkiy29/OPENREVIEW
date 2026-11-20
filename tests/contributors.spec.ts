import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import type {Id} from '../convex/_generated/dataModel';
import {scheduleSeatSync} from '../convex/billing';
import {ownKeyOnlyReason} from '../src/billing';

const modules=import.meta.glob('../convex/**/*.ts');
const secret='contributors-session-secret-at-least-32-chars';
const env={SESSION_SECRET:secret,SERVICE_SECRET:'contributors-service',BILLING_ENABLED:'true',STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_SEAT_PRICE_ID:'price_seat',STRIPE_PRO_PRICE_ID:'price_pro'};
beforeEach(()=>{vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});vi.setSystemTime(Date.UTC(2026,9,14,12));Object.assign(process.env,env);});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();for(const k of Object.keys(env))if(!['SESSION_SECRET','SERVICE_SECRET'].includes(k))delete process.env[k];});

type T=Awaited<ReturnType<typeof setup>>['t'];
async function setup(){
 const t=convexTest(schema,modules);
 const id=await t.mutation(api.users.login,{secret:'contributors-service',githubId:41,login:'alice',avatar:''}) as Id<'users'>;
 const token=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(id).setExpirationTime('120d').sign(new TextEncoder().encode(secret));
 const org=await t.mutation(api.users.createOrganization,{token,name:'Acme'});
 await t.mutation(api.repositories.connect,{token,secret:'contributors-service',organizationId:org,installationId:41,account:'acme',accountId:1,repositories:[{id:4101,fullName:'acme/shop',defaultBranch:'main'}]});
 const [repo]=await t.query(api.repositories.list,{token,organizationId:org});
 return {t,token,alice:id,org,repo:repo._id as Id<'repositories'>};
}
let pr=0;
// A running review by `author` that then finishes (completed unless `error`).
async function review(t:T,org:Id<'organizations'>,repo:Id<'repositories'>,author:string|undefined,error?:string){
 const now=Date.now(),reviewId=await t.run(ctx=>ctx.db.insert('reviews',{organizationId:org,repositoryId:repo,prNumber:++pr,headSha:String(pr).padStart(40,'a'),status:'running',mode:'standard',attempts:0,createdAt:now,updatedAt:now,...(author?{author}:{})}));
 await t.mutation(internal.reviews.finished,{reviewId,...(error?{error}:{})});
 return reviewId;
}
const rows=(t:T,org:Id<'organizations'>,period:string)=>t.run(async ctx=>(await ctx.db.query('activeContributors').withIndex('by_org_period_key',q=>q.eq('organizationId',org).eq('period',period)).collect()).map(r=>({key:r.key,login:r.login,bot:r.bot})).sort((a,b)=>a.key.localeCompare(b.key)));
const contract=(mode:'managed'|'ownKey',committed:number)=>({id:'c1',mode,startsAt:Date.UTC(2026,8,1),endsAt:Date.UTC(2027,8,1),committedContributors:committed,minimumContributors:committed,contributorPriceCents:2200,includedUsagePerContributorUsd:0.01,overageMultiplier:1.15,netDays:30,graceDays:30,nonBillableAuthors:['release-bot']});
const enterprise=(t:T,org:Id<'organizations'>,mode:'managed'|'ownKey',committed:number)=>t.run(async ctx=>{
 const account={status:'active',seats:1,trialEndsAt:0,updatedAt:Date.now(),subscriptionId:'sub_e',subscriptionItemId:'si_e',customerId:'cus_e',plan:'enterprise',contract:contract(mode,committed)};
 const existing=await ctx.db.query('billingAccounts').withIndex('by_org',q=>q.eq('organizationId',org)).unique();
 // Signing the contract is what selects the plan (E2.2 will do this when it creates the contract).
 await ctx.db.patch(org,{planSelectedAt:Date.now()});
 if(existing)await ctx.db.patch(existing._id,account);else await ctx.db.insert('billingAccounts',{organizationId:org,...account});
});

test('each author of a completed review is one ledger row a month; bots are listed but not counted',async()=>{
 const {t,alice,org,repo}=await setup();
 await enterprise(t,org,'managed',2);
 await review(t,org,repo,'Bob');await review(t,org,repo,'bob');
 await review(t,org,repo,'carol','model failed');
 await review(t,org,repo,undefined);
 await review(t,org,repo,'dependabot[bot]');await review(t,org,repo,'Release-Bot');
 // alice signed in with GitHub, so her pull requests are keyed by her OpenReview user.
 await review(t,org,repo,'alice');
 expect(await rows(t,org,'2026-10')).toEqual([{key:'github:github:bob',login:'Bob',bot:false},{key:'github:github:dependabot[bot]',login:'dependabot[bot]',bot:true},{key:'github:github:release-bot',login:'Release-Bot',bot:true},{key:`user:${alice}`,login:'alice',bot:false}]);
 // A review finished in the last second of the month lands in that month.
 vi.setSystemTime(Date.UTC(2026,9,31,23,59,59));
 await review(t,org,repo,'dave');
 vi.setSystemTime(Date.UTC(2026,10,1,0,0,1));
 await review(t,org,repo,'erin');
 expect((await rows(t,org,'2026-10')).map(r=>r.login)).toContain('dave');
 expect(await rows(t,org,'2026-11')).toEqual([{key:'github:github:erin',login:'erin',bot:false}]);
 // The backfill rebuilds the month to the same rows.
 const incremental=await rows(t,org,'2026-10');
 await t.run(async ctx=>{for(const r of await ctx.db.query('activeContributors').collect())if(r.login==='Bob')await ctx.db.delete(r._id);});
 await t.mutation(internal.contributors.backfill,{organizationId:org,period:'2026-10'});
 expect(await rows(t,org,'2026-10')).toEqual(incremental);
 expect(await rows(t,org,'2026-11')).toHaveLength(1);
 await expect(t.mutation(internal.contributors.backfill,{organizationId:org,period:'2026-13'})).rejects.toThrow(/YYYY-MM/);
});

test('with billing disabled no contributor rows are written',async()=>{
 const {t,org,repo}=await setup();
 delete process.env.BILLING_ENABLED;
 await review(t,org,repo,'bob');
 await t.mutation(internal.contributors.backfill,{organizationId:org,period:'2026-10'});
 expect(await t.run(ctx=>ctx.db.query('activeContributors').collect())).toEqual([]);
});

test('an Enterprise contract sets the included usage, never syncs seats, and refuses Checkout and plan changes',async()=>{
 const {t,token,org,repo}=await setup();
 await enterprise(t,org,'managed',2);
 expect(await t.query(api.billing.status,{token,organizationId:org})).toMatchObject({plan:'enterprise',planName:'Enterprise',limit:20_000,allowed:true});
 for(const author of ['bob','carol','dave'])await review(t,org,repo,author);
 // Three active contributors pass the commitment of two. Admins see the price and who counted; members only the counts.
 const admin=await t.query(api.billing.status,{token,organizationId:org});
 expect(admin).toMatchObject({plan:'enterprise',limit:30_000,enterprise:{mode:'managed',committed:2,active:3,priceCents:2200,renewed:false}});
 expect(admin.enabled&&admin.enterprise?.contributors?.map(c=>[c.login,c.billed])).toEqual([['bob',true],['carol',true],['dave',true]]);
 const memberId=await t.mutation(api.users.login,{secret:'contributors-service',githubId:42,login:'mia',avatar:''}) as Id<'users'>;
 await t.run(ctx=>ctx.db.insert('organizationMembers',{organizationId:org,userId:memberId,role:'member'}));
 const memberToken=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(memberId).setExpirationTime('120d').sign(new TextEncoder().encode(secret));
 expect(await t.query(api.billing.status,{token:memberToken,organizationId:org})).toMatchObject({enterprise:{active:3,committed:2,priceCents:null,contributors:null}});
 expect(await t.query(internal.billing.entitlement,{organizationId:org,key:'auth.sso'})).toBe(true);
 await t.run(ctx=>scheduleSeatSync(ctx,org));
 expect((await t.run(ctx=>ctx.db.system.query('_scheduled_functions').collect())).filter(j=>j.name.includes('syncSeats'))).toEqual([]);
 expect(await t.query(internal.billing.seatSyncTarget,{organizationId:org})).toBeNull();
 await expect(t.action(api.billingJobs.checkout,{token,organizationId:org})).rejects.toThrow(/account manager/);
 await expect(t.action(api.billingJobs.changePlan,{token,organizationId:org,plan:'pro'})).rejects.toThrow(/account manager/);
 // Own key: nothing is metered, so a call on the operator's model is refused.
 await enterprise(t,org,'ownKey',2);
 await expect(t.mutation(internal.inferenceBudget.reserve,{provider:'openai',model:'gpt-4.1',baseUrl:'https://api.openai.com/v1',inputTokenCeiling:1000,outputTokenCeiling:1000,organizationId:org})).rejects.toThrow(ownKeyOnlyReason);
 expect(await t.query(api.billing.status,{token,organizationId:org})).toMatchObject({plan:'enterprise',limit:0,allowed:true});
});

test('the closed month is reported once per contract: contributors above the commitment, on their own meter',async()=>{
 const {t,token,org,repo}=await setup();
 const other=await t.mutation(api.users.createOrganization,{token,name:'Seats'});
 await t.run(ctx=>ctx.db.insert('billingAccounts',{organizationId:other,status:'active',seats:1,trialEndsAt:0,updatedAt:Date.now(),subscriptionId:'sub_s',customerId:'cus_s',plan:'pro'}));
 await enterprise(t,org,'managed',2);
 for(const author of ['bob','carol','dave','erin','dependabot[bot]'])await review(t,org,repo,author);
 vi.setSystemTime(Date.UTC(2026,10,1,0,10));
 expect(await t.mutation(internal.billing.queueContributorReports,{})).toBe(1);
 expect(await t.mutation(internal.billing.queueContributorReports,{})).toBe(0);
 const events=await t.run(ctx=>ctx.db.query('billingMeterEvents').collect());
 expect(events.map(e=>[e.organizationId,e.kind,e.period,e.quantity,e.status])).toEqual([[org,'contributors','2026-10',2,'pending']]);
 const bodies:{body:string;key:string|null}[]=[];vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{bodies.push({body:decodeURIComponent(String(init?.body)),key:new Headers(init?.headers).get('idempotency-key')});return Response.json({});});
 expect(await t.action(internal.billingJobs.reportUsage,{id:events[0]._id})).toBe('reported');
 const identifier=`contributors:${org}:2026-10`;
 expect(bodies).toHaveLength(1);
 expect(bodies[0].key).toBe(`meter:${identifier}`);
 for(const part of ['event_name=openreview_contributors_over',`identifier=${identifier}`,`timestamp=${Date.UTC(2026,10,1)/1000-1}`,'payload[stripe_customer_id]=cus_e','payload[value]=2'])expect(bodies[0].body).toContain(part);
 // A contract that had not started in the closed month is not reported.
 vi.setSystemTime(Date.UTC(2026,8,1,0,10));
 expect(await t.mutation(internal.billing.queueContributorReports,{})).toBe(0);
});
