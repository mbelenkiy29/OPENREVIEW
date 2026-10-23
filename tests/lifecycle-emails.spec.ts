import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import {createHash,randomBytes} from 'node:crypto';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
const modules=import.meta.glob('../convex/**/*.ts');
const secret='lifecycle-session-secret-at-least-32-characters',svc='lifecycle-service';
beforeEach(()=>{vi.useFakeTimers();Object.assign(process.env,{SESSION_SECRET:secret,SERVICE_SECRET:svc,APP_URL:'https://review.example.com',RESEND_API_KEY:'re_fixture',EMAIL_FROM:'OpenReview <noreply@example.com>'});});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();delete process.env.RESEND_API_KEY;delete process.env.EMAIL_FROM;});

type T=ReturnType<typeof convexTest>;
async function signIn(t:T,profile:{provider:'github'|'google';providerUserId:string;login:string;email?:string;emailVerified:boolean}){
 const sid=randomBytes(32).toString('base64url');
 const userId=await t.mutation(api.identity.signIn,{secret:svc,avatar:'',...profile,sessionHash:createHash('sha256').update(sid).digest('hex')});
 return {userId,token:await new SignJWT({sid}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(userId).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret))};
}
const queued=(t:T)=>t.run(async ctx=>(await ctx.db.system.query('_scheduled_functions').collect()).filter(f=>f.name.startsWith('lifecycleEmails')).map(f=>f.args[0] as {to:string;kind:string}));

test('sign-up sends one thank-you to a verified address and none to GitHub-only users',async()=>{
 const t=convexTest(schema,modules);
 const mails:{to:string;subject:string}[]=[];
 vi.spyOn(globalThis,'fetch').mockImplementation(async(_u:string|URL|Request,init?:RequestInit)=>{const b=JSON.parse(String(init?.body));mails.push({to:b.to[0],subject:b.subject});return Response.json({id:'m'+mails.length});});
 const google={provider:'google' as const,providerUserId:'g1',login:'ann',email:'ann@example.com',emailVerified:true};
 await signIn(t,google);
 await signIn(t,google);
 await signIn(t,{provider:'github',providerUserId:'7',login:'octo',emailVerified:false});
 await t.finishAllScheduledFunctions(vi.runAllTimers);
 expect(mails).toEqual([{to:'ann@example.com',subject:'Thanks for signing up for OpenReview'}]);
});

test('the first completed review in a workspace emails its owner once; later reviews do not',async()=>{
 const t=convexTest(schema,modules);
 const owner=await signIn(t,{provider:'google',providerUserId:'g2',login:'olga',email:'olga@example.com',emailVerified:true});
 const org=await t.mutation(api.users.createOrganization,{token:owner.token,name:'Acme'});
 const [first,second]=await t.run(async ctx=>{
  const repositoryId=await ctx.db.insert('repositories',{organizationId:org,githubId:1,fullName:'acme/shop',defaultBranch:'main',enabled:true,indexStatus:'ready',createdAt:0});
  return Promise.all([1,2].map(n=>ctx.db.insert('reviews',{organizationId:org,repositoryId,prNumber:n,headSha:'f'.repeat(40),status:'running',mode:'standard',attempts:1,createdAt:n,updatedAt:n})));
 });
 await t.mutation(internal.reviews.finished,{reviewId:first});
 await t.mutation(internal.reviews.finished,{reviewId:second});
 expect(await queued(t)).toEqual([{to:'olga@example.com',kind:'welcome'},{to:'olga@example.com',kind:'first_review_completed'}]);
 expect((await t.run(ctx=>ctx.db.get(owner.userId)))?.lifecycleEmails).toEqual(['welcome']);
 expect((await t.run(ctx=>ctx.db.get(org)))?.lifecycleEmails).toEqual(['first_review_completed']);
});

test('workspaces created before these emails existed get none, even with their history purged',async()=>{
 const t=convexTest(schema,modules);
 const owner=await signIn(t,{provider:'google',providerUserId:'g3',login:'pia',email:'pia@example.com',emailVerified:true});
 const org=await t.mutation(api.users.createOrganization,{token:owner.token,name:'Acme'});
 const review=await t.run(async ctx=>{
  await ctx.db.patch(org,{lifecycleEmails:undefined});
  const repositoryId=await ctx.db.insert('repositories',{organizationId:org,githubId:1,fullName:'acme/shop',defaultBranch:'main',enabled:true,indexStatus:'ready',createdAt:0});
  return ctx.db.insert('reviews',{organizationId:org,repositoryId,prNumber:1,headSha:'f'.repeat(40),status:'running',mode:'standard',attempts:1,createdAt:1,updatedAt:1});
 });
 await t.mutation(internal.reviews.finished,{reviewId:review});
 expect(await queued(t)).toEqual([{to:'pia@example.com',kind:'welcome'}]);
});

test('a milestone reached while email is off is recorded, so turning email on later sends no stale first',async()=>{
 const t=convexTest(schema,modules);
 const owner=await signIn(t,{provider:'google',providerUserId:'g4',login:'quinn',email:'quinn@example.com',emailVerified:true});
 const org=await t.mutation(api.users.createOrganization,{token:owner.token,name:'Acme'});
 const [first,second]=await t.run(async ctx=>{
  const repositoryId=await ctx.db.insert('repositories',{organizationId:org,githubId:1,fullName:'acme/shop',defaultBranch:'main',enabled:true,indexStatus:'ready',createdAt:0});
  return Promise.all([1,2].map(n=>ctx.db.insert('reviews',{organizationId:org,repositoryId,prNumber:n,headSha:'f'.repeat(40),status:'running',mode:'standard',attempts:1,createdAt:n,updatedAt:n})));
 });
 delete process.env.RESEND_API_KEY;
 await t.mutation(internal.reviews.finished,{reviewId:first});
 process.env.RESEND_API_KEY='re_fixture';
 await t.mutation(internal.reviews.finished,{reviewId:second});
 expect(await queued(t)).toEqual([{to:'quinn@example.com',kind:'welcome'}]);
 expect((await t.run(ctx=>ctx.db.get(org)))?.lifecycleEmails).toEqual(['first_review_completed']);
});
