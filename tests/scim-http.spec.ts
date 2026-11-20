import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import {createHash,randomBytes} from 'node:crypto';
import schema from '../convex/schema';
import {api} from '../convex/_generated/api';
import type {Id} from '../convex/_generated/dataModel';
import {upgradeNote} from '../src/plans';

// SCIM HTTP routes (app/api/scim/v2) hash the bearer token and hand the request to convex/scim.ts.
const holder=vi.hoisted(()=>({t:undefined as unknown,mutations:0}));
vi.mock('../src/server',()=>({
 backend:()=>{
  type Call=(ref:unknown,args:unknown)=>Promise<unknown>;
  const t=holder.t as {query:Call;mutation:Call};
  return {query:(r:unknown,a:unknown)=>t.query(r,a),mutation:(r:unknown,a:unknown)=>{holder.mutations++;return t.mutation(r,a);}};
 },
}));
import {GET as listUsers,POST as createUser} from '../app/api/scim/v2/Users/route';
import {GET as getUser,PUT as putUser,PATCH as patchUser,DELETE as deleteUser} from '../app/api/scim/v2/Users/[id]/route';
import {GET as listGroups,POST as createGroup} from '../app/api/scim/v2/Groups/route';
import {GET as getGroup,PUT as putGroup,PATCH as patchGroup,DELETE as deleteGroup} from '../app/api/scim/v2/Groups/[id]/route';

const modules=import.meta.glob('../convex/**/*.ts');
const secret='scim-http-session-secret-at-least-32-chars',svc='scim-http-service',base='https://review.example.com/api/scim/v2';
beforeEach(()=>{
 holder.mutations=0;
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});
 vi.setSystemTime(Date.UTC(2026,10,19,12));
 Object.assign(process.env,{SESSION_SECRET:secret,SERVICE_SECRET:svc,APP_URL:'https://review.example.com',BILLING_ENABLED:'true'});
});
afterEach(()=>{vi.useRealTimers();delete process.env.BILLING_ENABLED;delete process.env.APP_URL;});

const make=()=>{const t=convexTest(schema,modules);holder.t=t;return t;};
type T=ReturnType<typeof make>;
async function signIn(t:T,githubId:number,login:string){
 const sid=randomBytes(32).toString('base64url');
 const id=await t.mutation(api.identity.signIn,{secret:svc,provider:'github',providerUserId:String(githubId),login,avatar:'',email:`${login}@acme.com`,emailVerified:true,sessionHash:createHash('sha256').update(sid).digest('hex')}) as Id<'users'>;
 return {id,token:await new SignJWT({sid}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(id).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret))};
}
const contract={id:'c1',mode:'managed' as const,startsAt:Date.UTC(2026,10,1),endsAt:Date.UTC(2027,10,1),committedContributors:25,minimumContributors:25,contributorPriceCents:2200,includedUsagePerContributorUsd:12,overageMultiplier:1.15,netDays:30,graceDays:30,nonBillableAuthors:[]};
async function workspace(t:T,owner:{token:string},name:string,plan:'enterprise'|'pro'){
 const org=await t.mutation(api.users.createOrganization,{token:owner.token,name});
 await t.run(async ctx=>{await ctx.db.patch(org,{planSelectedAt:Date.now()});await ctx.db.insert('billingAccounts',{organizationId:org,status:'active',seats:1,trialEndsAt:0,updatedAt:Date.now(),subscriptionId:`sub_${name}`,plan,...(plan==='enterprise'?{contract}:{})});});
 return org;
}
async function scimToken(t:T,owner:{token:string},org:Id<'organizations'>){
 const value='scim_'+randomBytes(32).toString('hex');
 await t.mutation(api.scim.createToken,{token:owner.token,organizationId:org,tokenHash:createHash('sha256').update(value).digest('hex')});
 return value;
}
function req(method:string,path:string,auth?:string,body?:unknown){
 const headers=new Headers();
 if(auth!==undefined)headers.set('authorization',auth);
 if(body!==undefined)headers.set('content-type','application/scim+json');
 return new Request(`${base}${path}`,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
}
const params=(id:string)=>({params:Promise.resolve({id})});
async function send(method:string,path:string,auth?:string,body?:unknown){
 const request=req(method,path,auth,body),[kind,id]=path.slice(1).split('/');
 const response=kind==='Users'
  ? id?await ({GET:getUser,PUT:putUser,PATCH:patchUser,DELETE:deleteUser}[method] as typeof getUser)(request,params(id)):await ({GET:listUsers,POST:createUser}[method] as typeof listUsers)(request)
  : id?await ({GET:getGroup,PUT:putGroup,PATCH:patchGroup,DELETE:deleteGroup}[method] as typeof getGroup)(request,params(id)):await ({GET:listGroups,POST:createGroup}[method] as typeof listGroups)(request);
 return {status:response.status,type:response.headers.get('content-type'),body:response.status===204?undefined:await response.json()};
}
const bearer=(value:string)=>`Bearer ${value}`;
const role=(t:T,org:Id<'organizations'>,userId:Id<'users'>)=>t.run(async ctx=>(await ctx.db.query('organizationMembers').withIndex('by_org_user',q=>q.eq('organizationId',org).eq('userId',userId)).unique())?.role??null);

test('SCIM HTTP rejects a missing, malformed, wrong or revoked bearer token with 401 and never talks to Convex for a missing or malformed header',async()=>{
 const t=make(),alice=await signIn(t,1,'alice');
 const acme=await workspace(t,alice,'Acme','enterprise'),value=await scimToken(t,alice,acme);
 holder.mutations=0;
 for(const auth of [undefined,'','Basic abc','Bearer','Bearer shorttoken','Token '+value,'Bearer '+value+' extra']){
  const got=await send('GET','/Users',auth);
  expect(got.status).toBe(401);
  expect(got.type).toBe('application/scim+json');
  expect(got.body).toMatchObject({schemas:['urn:ietf:params:scim:api:messages:2.0:Error'],status:'401'});
 }
 expect(holder.mutations).toBe(0);
 const wrong=await send('GET','/Users',bearer('scim_'+'ab'.repeat(32)));
 expect(wrong).toMatchObject({status:401,body:{detail:'Invalid SCIM token'}});
 expect(holder.mutations).toBe(1);
 const settings=await t.query(api.scim.settings,{token:alice.token,organizationId:acme});
 await t.mutation(api.scim.revokeToken,{token:alice.token,tokenId:settings.tokens[0]._id});
 holder.mutations=0;
 expect((await send('GET','/Users',bearer(value))).status).toBe(401);
 expect(holder.mutations).toBe(1);
});

test("workspace A's SCIM token cannot read, create, update or delete workspace B's users or groups",async()=>{
 const t=make(),alice=await signIn(t,1,'alice'),zed=await signIn(t,2,'zed');
 const acme=await workspace(t,alice,'Acme','enterprise'),other=await workspace(t,zed,'Other','enterprise');
 const a=await scimToken(t,alice,acme),b=await scimToken(t,zed,other);
 const made=await send('POST','/Users',bearer(a),{userName:'bob@acme.com'});
 expect(made.status).toBe(201);
 const listed=await send('GET','/Users',bearer(b));
 expect(listed).toMatchObject({status:200,body:{totalResults:0,Resources:[]}});
 for(const method of ['GET','PATCH','PUT','DELETE'])expect((await send(method,`/Users/${made.body.id}`,bearer(b),method==='GET'||method==='DELETE'?undefined:{})).status).toBe(404);
 const group=await send('POST','/Groups',bearer(a),{displayName:'Admins',members:[{value:made.body.id}]});
 expect(group.status).toBe(201);
 expect((await send('GET','/Groups',bearer(b))).body.totalResults).toBe(0);
 for(const method of ['GET','PATCH','PUT','DELETE'])expect((await send(method,`/Groups/${group.body.id}`,bearer(b),method==='GET'||method==='DELETE'?undefined:{})).status).toBe(404);
 expect((await send('POST','/Users',bearer(b),{userName:'bob@acme.com'})).status).toBe(201);
 expect((await send('GET','/Users',bearer(a))).body.totalResults).toBe(1);
});

test('SCIM HTTP never deprovisions the last owner or changes an owner role, and is refused off Enterprise',async()=>{
 const t=make(),alice=await signIn(t,1,'alice'),bob=await signIn(t,2,'bob'),zed=await signIn(t,3,'zed');
 const acme=await workspace(t,alice,'Acme','enterprise'),pro=await workspace(t,zed,'Pro','pro');
 const tok=await scimToken(t,alice,acme);
 const owner=await send('POST','/Users',bearer(tok),{userName:'alice@acme.com'});
 expect((await send('PATCH',`/Users/${owner.body.id}`,bearer(tok),{Operations:[{op:'replace',value:{active:false}}]})).status).toBe(409);
 expect(await role(t,acme,alice.id)).toBe('owner');
 expect((await send('GET',`/Users/${owner.body.id}`,bearer(tok))).body.active).toBe(true);
 const member=await send('POST','/Users',bearer(tok),{userName:'bob@acme.com'});
 expect(await role(t,acme,bob.id)).toBe('member');
 const admins=await send('POST','/Groups',bearer(tok),{displayName:'Admins',members:[{value:owner.body.id},{value:member.body.id}]});
 const groups=(await t.query(api.scim.settings,{token:alice.token,organizationId:acme})).groups;
 await t.mutation(api.scim.setGroupRole,{token:alice.token,groupId:groups.find(g=>g.displayName==='Admins')!._id,role:'admin'});
 expect([await role(t,acme,alice.id),await role(t,acme,bob.id)]).toEqual(['owner','admin']);
 await send('PUT',`/Groups/${admins.body.id}`,bearer(tok),{displayName:'Admins',members:[]});
 expect([await role(t,acme,alice.id),await role(t,acme,bob.id)]).toEqual(['owner','member']);
 await expect(scimToken(t,zed,pro)).rejects.toThrow(/Enterprise plan/);
 const planted='scim_'+randomBytes(32).toString('hex');
 await t.run(ctx=>ctx.db.insert('scimTokens',{organizationId:pro,tokenHash:createHash('sha256').update(planted).digest('hex'),createdBy:zed.id,createdAt:Date.now()}));
 const refused=await send('GET','/Users',bearer(planted));
 expect(refused.status).toBe(403);
 expect(refused.body.detail).toBe(upgradeNote['auth.scim']);
 await expect(t.query(api.scopes.activityExport,{token:zed.token,organizationId:pro,from:Date.UTC(2026,10,1),to:Date.UTC(2026,11,1)})).rejects.toThrow(/Enterprise plan/);
 await expect(t.query(api.scopes.activityExport,{token:alice.token,organizationId:acme,from:Date.UTC(2026,10,1),to:Date.UTC(2026,11,1)})).resolves.toMatchObject({isDone:true});
});
