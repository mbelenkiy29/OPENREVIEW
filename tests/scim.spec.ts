import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import {createHash,randomBytes} from 'node:crypto';
import schema from '../convex/schema';
import {api} from '../convex/_generated/api';
import type {Id} from '../convex/_generated/dataModel';
import {scimJoin} from '../convex/scim';

const modules=import.meta.glob('../convex/**/*.ts');
const secret='scim-session-secret-at-least-32-characters',svc='scim-service',base='https://review.example.com/api/scim/v2';
beforeEach(()=>{vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});vi.setSystemTime(Date.UTC(2026,10,19,12));Object.assign(process.env,{SESSION_SECRET:secret,SERVICE_SECRET:svc,BILLING_ENABLED:'true'});});
afterEach(()=>{vi.useRealTimers();delete process.env.BILLING_ENABLED;});

const make=()=>convexTest(schema,modules);
type T=ReturnType<typeof make>;
async function signIn(t:T,githubId:number,login:string){
 const sid=randomBytes(32).toString('base64url');
 const id=await t.mutation(api.identity.signIn,{secret:svc,provider:'github',providerUserId:String(githubId),login,avatar:'',email:`${login}@acme.com`,emailVerified:true,sessionHash:createHash('sha256').update(sid).digest('hex')}) as Id<'users'>;
 return {id,token:await new SignJWT({sid}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(id).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret))};
}
const contract={id:'c1',mode:'managed' as const,startsAt:Date.UTC(2026,10,1),endsAt:Date.UTC(2027,10,1),committedContributors:25,minimumContributors:25,contributorPriceCents:2200,includedUsagePerContributorUsd:12,overageMultiplier:1.15,netDays:30,graceDays:30,nonBillableAuthors:[]};
// A workspace on a plan: Enterprise (with its contract) or Pro.
async function workspace(t:T,owner:{token:string},name:string,plan:'enterprise'|'pro'){
 const org=await t.mutation(api.users.createOrganization,{token:owner.token,name});
 await t.run(async ctx=>{await ctx.db.patch(org,{planSelectedAt:Date.now()});await ctx.db.insert('billingAccounts',{organizationId:org,status:'active',seats:1,trialEndsAt:0,updatedAt:Date.now(),subscriptionId:`sub_${name}`,plan,...(plan==='enterprise'?{contract}:{})});});
 return org;
}
async function scimToken(t:T,owner:{token:string},org:Id<'organizations'>){const value='scim_'+randomBytes(32).toString('hex'),tokenHash=createHash('sha256').update(value).digest('hex');await t.mutation(api.scim.createToken,{token:owner.token,organizationId:org,tokenHash});return tokenHash;}
const call=(t:T,tokenHash:string,resource:'Users'|'Groups',method:string,extra:{id?:string;body?:unknown;filter?:string}={})=>t.mutation(api.scim.handle,{secret:svc,tokenHash,baseUrl:base,resource,method,...(extra.id?{id:extra.id}:{}),...(extra.filter?{filter:extra.filter}:{}),...(extra.body===undefined?{}:{body:JSON.stringify(extra.body)})}) as Promise<{status:number;body?:any}>; // eslint-disable-line @typescript-eslint/no-explicit-any
const role=(t:T,org:Id<'organizations'>,userId:Id<'users'>)=>t.run(async ctx=>(await ctx.db.query('organizationMembers').withIndex('by_org_user',q=>q.eq('organizationId',org).eq('userId',userId)).unique())?.role??null);

test('a SCIM token works only for its own Enterprise workspace, and requests are rate limited',async()=>{
 const t=make(),alice=await signIn(t,1,'alice'),zed=await signIn(t,2,'zed');
 const acme=await workspace(t,alice,'Acme','enterprise'),other=await workspace(t,zed,'Other','enterprise'),pro=await workspace(t,zed,'Pro','pro');
 await expect(scimToken(t,zed,pro)).rejects.toThrow(/Enterprise plan/);
 await expect(scimToken(t,zed,acme)).rejects.toThrow();
 const a=await scimToken(t,alice,acme),b=await scimToken(t,zed,other);
 expect((await call(t,'0'.repeat(64),'Users','GET')).status).toBe(401);
 await expect(t.mutation(api.scim.handle,{secret:'wrong',tokenHash:a,baseUrl:base,resource:'Users',method:'GET'})).rejects.toThrow(/Unauthorized/);
 const made=await call(t,a,'Users','POST',{body:{userName:'bob@acme.com'}});
 expect(made.status).toBe(201);
 // The other workspace's token neither lists nor reads, changes or deletes it.
 expect((await call(t,b,'Users','GET')).body.totalResults).toBe(0);
 for(const method of ['GET','PATCH','PUT','DELETE'])expect((await call(t,b,'Users',method,{id:made.body.id,body:{}})).status).toBe(404);
 expect((await call(t,a,'Users','GET',{filter:'userName eq "BOB@acme.com"'})).body).toMatchObject({totalResults:1,Resources:[{id:made.body.id,userName:'bob@acme.com',active:true,meta:{location:`${base}/Users/${made.body.id}`}}]});
 expect((await call(t,a,'Users','GET',{filter:'userName sw "bob"'})).status).toBe(400);
 // A workspace that leaves Enterprise is refused, but its admin can still revoke the token.
 await t.run(async ctx=>{const acc=(await ctx.db.query('billingAccounts').withIndex('by_org',q=>q.eq('organizationId',other)).unique())!;await ctx.db.patch(acc._id,{plan:'pro',contract:undefined});});
 expect((await call(t,b,'Users','GET')).status).toBe(403);
 const settings=await t.query(api.scim.settings,{token:zed.token,organizationId:other});
 await t.mutation(api.scim.revokeToken,{token:zed.token,tokenId:settings.tokens[0]._id});
 expect((await call(t,b,'Users','GET')).status).toBe(401);
 // Past 600 requests in a minute the request is refused.
 await t.run(async ctx=>{const row=(await ctx.db.query('rateLimits').withIndex('by_key',q=>q.eq('key',`scim:${acme}`)).unique())!;await ctx.db.patch(row._id,{count:600});});
 await expect(call(t,a,'Users','GET')).rejects.toThrow(/Rate limit exceeded/);
});

test('provisioning adds members, deactivating removes them and ends their sessions, and people without an account join at first SSO sign-in',async()=>{
 const t=make(),alice=await signIn(t,1,'alice'),bob=await signIn(t,2,'bob');
 const acme=await workspace(t,alice,'Acme','enterprise'),tok=await scimToken(t,alice,acme);
 const made=await call(t,tok,'Users','POST',{body:{schemas:['urn:ietf:params:scim:schemas:core:2.0:User'],userName:'Bob@acme.com',name:{givenName:'Bob',familyName:'B'},title:'ignored','urn:ietf:params:scim:schemas:extension:enterprise:2.0:User':{department:'x'}}});
 expect(made).toMatchObject({status:201,body:{userName:'bob@acme.com',displayName:'Bob B',active:true}});
 expect(await role(t,acme,bob.id)).toBe('member');
 expect((await call(t,tok,'Users','POST',{body:{userName:'bob@acme.com'}})).status).toBe(409);
 expect((await call(t,tok,'Users','POST',{body:{userName:'bob'}})).status).toBe(400);
 expect(await t.query(api.users.me,{token:bob.token})).toBeTruthy();
 // Entra-style deactivation.
 expect((await call(t,tok,'Users','PATCH',{id:made.body.id,body:{Operations:[{op:'Replace',path:'active',value:'False'}]}})).body.active).toBe(false);
 expect(await role(t,acme,bob.id)).toBeNull();
 await expect(t.query(api.users.me,{token:bob.token})).rejects.toThrow();
 expect((await t.run(ctx=>ctx.db.query('auditEvents').collect())).map(e=>e.action)).toEqual(expect.arrayContaining(['scim.token_created','scim.member_added','scim.member_removed']));
 // Reactivating brings the membership back; deleting removes it again.
 await call(t,tok,'Users','PUT',{id:made.body.id,body:{userName:'bob@acme.com',active:true}});
 expect(await role(t,acme,bob.id)).toBe('member');
 expect((await call(t,tok,'Users','DELETE',{id:made.body.id})).status).toBe(204);
 expect(await role(t,acme,bob.id)).toBeNull();
 expect((await call(t,tok,'Users','GET',{id:made.body.id})).status).toBe(404);
 // Carol is provisioned before she has an account; she joins when she first signs in with SSO.
 await call(t,tok,'Users','POST',{body:{userName:'carol@acme.com'}});
 const carol=await signIn(t,3,'carol');
 expect(await role(t,acme,carol.id)).toBeNull();
 expect(await t.run(ctx=>scimJoin(ctx,acme,carol.id,'Carol@acme.com'))).toBe(true);
 expect(await role(t,acme,carol.id)).toBe('member');
 const dave=await signIn(t,4,'dave');
 expect(await t.run(ctx=>scimJoin(ctx,acme,dave.id,'dave@acme.com'))).toBe(false);
 // The last owner cannot be deprovisioned.
 const owner=await call(t,tok,'Users','POST',{body:{userName:'alice@acme.com'}});
 expect((await call(t,tok,'Users','PATCH',{id:owner.body.id,body:{Operations:[{op:'replace',value:{active:false}}]}})).status).toBe(409);
 expect(await role(t,acme,alice.id)).toBe('owner');
 expect((await call(t,tok,'Users','GET',{id:owner.body.id})).body.active).toBe(true);
});

test('a mapped group sets roles, leaving it demotes to member, and SCIM never changes an owner',async()=>{
 const t=make(),alice=await signIn(t,1,'alice'),bob=await signIn(t,2,'bob'),carol=await signIn(t,3,'carol');
 const acme=await workspace(t,alice,'Acme','enterprise'),tok=await scimToken(t,alice,acme);
 const ids:Record<string,string>={};
 for(const name of ['alice','bob','carol'])ids[name]=(await call(t,tok,'Users','POST',{body:{userName:`${name}@acme.com`}})).body.id;
 const admins=await call(t,tok,'Groups','POST',{body:{displayName:'Admins',members:[{value:ids.bob,$ref:`${base}/Users/${ids.bob}`},{value:'not-an-id'}]}});
 expect(admins).toMatchObject({status:201,body:{displayName:'Admins',members:[{value:ids.bob}]}});
 expect((await call(t,tok,'Groups','POST',{body:{displayName:'Admins'}})).status).toBe(409);
 const viewers=await call(t,tok,'Groups','POST',{body:{displayName:'Viewers',members:[{value:ids.alice},{value:ids.bob},{value:ids.carol}]}});
 // Unmapped groups change nothing.
 expect([await role(t,acme,bob.id),await role(t,acme,carol.id)]).toEqual(['member','member']);
 const groups=(await t.query(api.scim.settings,{token:alice.token,organizationId:acme})).groups;
 const groupId=(name:string)=>groups.find(g=>g.displayName===name)!._id;
 await t.mutation(api.scim.setGroupRole,{token:alice.token,groupId:groupId('Viewers'),role:'viewer'});
 await t.mutation(api.scim.setGroupRole,{token:alice.token,groupId:groupId('Admins'),role:'admin'});
 // Bob is in both: the role with the most access wins. Alice stays owner.
 expect([await role(t,acme,alice.id),await role(t,acme,bob.id),await role(t,acme,carol.id)]).toEqual(['owner','admin','viewer']);
 await expect(t.mutation(api.scim.setGroupRole,{token:bob.token,groupId:groupId('Viewers'),role:'owner' as never})).rejects.toThrow();
 // A group change updates roles.
 await call(t,tok,'Groups','PATCH',{id:admins.body.id,body:{Operations:[{op:'remove',path:`members[value eq "${ids.bob}"]`},{op:'add',path:'members',value:[{value:ids.carol}]}]}});
 expect([await role(t,acme,bob.id),await role(t,acme,carol.id)]).toEqual(['viewer','admin']);
 await call(t,tok,'Groups','PUT',{id:viewers.body.id,body:{displayName:'Viewers',members:[{value:ids.alice}]}});
 expect(await role(t,acme,bob.id)).toBe('member');
 expect((await call(t,tok,'Groups','DELETE',{id:admins.body.id})).status).toBe(204);
 expect([await role(t,acme,alice.id),await role(t,acme,carol.id)]).toEqual(['owner','member']);
 expect((await call(t,tok,'Groups','GET',{filter:'displayName eq "Viewers"'})).body).toMatchObject({totalResults:1,Resources:[{displayName:'Viewers',members:[{value:ids.alice}]}]});
});
