import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import {createHash,randomBytes} from 'node:crypto';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import type {Id} from '../convex/_generated/dataModel';
import {fixAllowance} from '../convex/billing';
import {entitlements} from '../src/plans';
const modules=import.meta.glob('../convex/**/*.ts');
const secret='operator-session-secret-at-least-32-characters',svc='operator-service',operatorId=206921626;
const extra=['OPERATOR_GITHUB_IDS','BILLING_ENABLED','BILLING_FREE_USAGE_USD'];
beforeEach(()=>{vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});vi.setSystemTime(Date.UTC(2026,9,26,12));Object.assign(process.env,{SESSION_SECRET:secret,SERVICE_SECRET:svc,OPERATOR_GITHUB_IDS:` ${operatorId}, not-an-id`});});
afterEach(()=>{vi.useRealTimers();for(const k of extra)delete process.env[k];});

type T=ReturnType<typeof convexTest>;
// A GitHub sign-in with its server-side session, as the OAuth callback makes it; `legacy` is a token without one,
// like those the web server mints for API-key calls.
async function signIn(t:T,githubId:number,login:string){
 const sid=randomBytes(32).toString('base64url');
 const id=await t.mutation(api.identity.signIn,{secret:svc,provider:'github',providerUserId:String(githubId),login,avatar:'',emailVerified:false,sessionHash:createHash('sha256').update(sid).digest('hex')});
 const jwt=(claims:Record<string,string>)=>new SignJWT(claims).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(id).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
 return {id,token:await jwt({sid}),legacy:await jwt({})};
}
// One gpt-4.1 call of 1000 + 1000 tokens: $0.01.
const quote={provider:'openai',model:'gpt-4.1',baseUrl:'https://api.openai.com/v1',inputTokenCeiling:1000,outputTokenCeiling:1000};
const reserve=(t:T,organizationId:Id<'organizations'>)=>t.mutation(internal.inferenceBudget.reserve,{...quote,organizationId});
async function spend(t:T,organizationId:Id<'organizations'>){const id=await reserve(t,organizationId);await t.mutation(internal.inferenceBudget.settle,{id:id!,inputTokens:1000,outputTokens:1000});}

test('only an operator named in OPERATOR_GITHUB_IDS, in a browser session, opens the operator report; each visit is recorded and no content leaves a workspace',async()=>{
 const t=convexTest(schema,modules);
 const operator=await signIn(t,operatorId,'mbelenkiy29'),alice=await signIn(t,31,'alice');
 // Same login, different GitHub account: logins can be renamed and reused, so only the numeric id counts.
 const impostor=await signIn(t,32,'mbelenkiy29');
 const org=await t.mutation(api.users.createOrganization,{token:alice.token,name:'Acme'});
 await t.mutation(api.repositories.connect,{token:alice.token,secret:svc,organizationId:org,installationId:31,account:'acme',accountId:1,repositories:[{id:3101,fullName:'acme/secret-repo',defaultBranch:'main'}]});
 const [repo]=await t.query(api.repositories.list,{token:alice.token,organizationId:org});
 await t.run(ctx=>ctx.db.patch(repo._id,{enabled:true}));
 const review=await t.mutation(internal.reviews.enqueue,{repositoryId:repo._id,prNumber:7,headSha:'a'.repeat(40),trigger:'automatic'});
 await t.run(ctx=>ctx.db.patch(review!,{title:'SECRET title',summary:'SECRET summary'}));

 for(const caller of [alice.token,impostor.token,operator.legacy]){
  await expect(t.action(api.operator.overview,{token:caller})).rejects.toThrow(/Forbidden/);
  await expect(t.query(internal.operator.report,{token:caller})).rejects.toThrow(/Forbidden/);
  await expect(t.mutation(internal.operator.recordAccess,{token:caller,action:'operator.overview'})).rejects.toThrow(/Forbidden/);
 }
 expect((await t.query(api.users.me,{token:alice.token})).operator).toBe(false);
 expect((await t.query(api.users.me,{token:operator.token})).operator).toBe(true);
 // Refused calls leave nothing in the operator log.
 expect(await t.run(ctx=>ctx.db.query('operatorAudit').collect())).toEqual([]);

 const report=await t.action(api.operator.overview,{token:operator.token});
 expect(report.workspaces).toMatchObject([{name:'Acme',seats:1,exempt:false}]);
 expect(report.users.map(u=>[u.login,u.operator])).toEqual([['mbelenkiy29',false],['alice',false],['mbelenkiy29',true]]);
 expect(report.activity.map(e=>e.label)).toEqual(expect.arrayContaining(['Signed in with github','Review queued']));
 expect(report.access).toMatchObject([{action:'operator.overview',user:'mbelenkiy29'}]);
 expect(JSON.stringify(report)).not.toMatch(/SECRET|secret-repo/);
 // Removing the id from the setting takes the access away.
 delete process.env.OPERATOR_GITHUB_IDS;
 await expect(t.action(api.operator.overview,{token:operator.token})).rejects.toThrow(/Forbidden/);
});

test('a workspace an operator owns has unlimited usage, fixes and features, still capped by the inference budget; other workspaces keep their limits',async()=>{
 Object.assign(process.env,{BILLING_ENABLED:'true',BILLING_FREE_USAGE_USD:'0.02'});
 const t=convexTest(schema,modules);
 const operator=await signIn(t,operatorId,'mbelenkiy29'),alice=await signIn(t,31,'alice');
 const mine=await t.mutation(api.users.createOrganization,{token:operator.token,name:'Mine'});
 // An operator's workspaces never choose a plan.
 const second=await t.mutation(api.users.createOrganization,{token:operator.token,name:'Mine too'});
 const theirs=await t.mutation(api.users.createOrganization,{token:alice.token,name:'Theirs'});
 // A new workspace that is not the operator's has no Free plan; this one started on Free before that.
 await t.run(ctx=>ctx.db.patch(theirs,{planSelectedAt:Date.now(),plan:'free'}));
 await t.mutation(api.users.createOrganization,{token:alice.token,name:'Unpaid'});
 // The operator as an admin, not an owner, does not exempt a workspace.
 await t.run(ctx=>ctx.db.insert('organizationMembers',{organizationId:theirs,userId:operator.id,role:'admin'}));

 for(let i=0;i<4;i++)await spend(t,mine);
 await spend(t,theirs);await spend(t,theirs);
 await expect(reserve(t,theirs)).rejects.toThrow(/Free plan's \$0\.02 of usage for this month/);
 // Usage is still counted, nothing is reported to Stripe, and no usage alert goes out.
 const usage=await t.run(async ctx=>({rows:await ctx.db.query('billingUsage').collect(),meter:await ctx.db.query('billingMeterEvents').collect()}));
 expect(usage.rows.find(r=>r.organizationId===mine)).toMatchObject({usedMicros:40000,reservedMicros:0});
 expect(usage.rows.find(r=>r.organizationId===mine)?.alertsSent).toBeUndefined();
 expect(usage.meter).toEqual([]);

 expect(await t.query(api.billing.status,{token:operator.token,organizationId:mine})).toEqual({enabled:false,exempt:true});
 expect(await t.query(api.billing.status,{token:operator.token,organizationId:theirs})).toMatchObject({enabled:true,plan:'free',allowed:false});
 expect(await t.query(api.billing.locked,{token:operator.token,organizationId:mine})).toEqual([]);
 expect(await t.query(api.billing.locked,{token:alice.token,organizationId:theirs})).toEqual([...entitlements]);
 // Free has no agent fixes and the operator's workspace has no monthly limit; its runs are still counted.
 for(let i=0;i<3;i++)expect(await t.run(ctx=>fixAllowance(ctx,mine))).toEqual({allowed:true});
 expect(await t.run(ctx=>fixAllowance(ctx,theirs))).toMatchObject({allowed:false});
 expect((await t.run(ctx=>ctx.db.query('billingUsage').collect())).find(r=>r.organizationId===mine)?.fixes).toBe(3);

 const report=await t.action(api.operator.overview,{token:operator.token});
 expect(Object.fromEntries(report.workspaces.map(w=>[w.name,w.exempt]))).toEqual({'Mine':true,'Mine too':true,'Theirs':false,'Unpaid':false});
 // The report shows each workspace's own allowance: Free for one that keeps it, none for a new unpaid one.
 expect(Object.fromEntries(report.workspaces.map(w=>[w.name,w.limitMicros]))).toEqual({'Mine':null,'Mine too':null,'Theirs':20000,'Unpaid':0});

 // The deployment-wide inference budget stays the ceiling: room for one more $0.01 call, not two.
 await t.mutation(internal.inferenceBudget.initialize,{limitMicros:15000,baselineMicros:0,source:'operator test'});
 await spend(t,mine);
 await expect(reserve(t,mine)).rejects.toThrow(/Inference budget exhausted/);

 // A workspace still without a plan is not sent to the plan step when an operator owns it.
 await t.run(async ctx=>{await ctx.db.patch(second,{planSelectedAt:undefined});await ctx.db.patch(theirs,{planSelectedAt:undefined});});
 expect(Object.fromEntries((await t.query(api.users.me,{token:operator.token})).organizations.map(o=>[o.name,o.planMissing]))).toEqual({'Mine':false,'Mine too':false,'Theirs':true});

 // Self-hosted (billing off) is unchanged: no plan, no quota, and nothing marks the workspace.
 delete process.env.BILLING_ENABLED;
 expect(await t.query(api.billing.status,{token:operator.token,organizationId:mine})).toEqual({enabled:false});
});
