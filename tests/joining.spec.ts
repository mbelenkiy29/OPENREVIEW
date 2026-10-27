import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import {createHash,randomBytes} from 'node:crypto';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import type {Id} from '../convex/_generated/dataModel';

// "Join a team" requests and the People → Member link (convex/joinRequests.ts, convex/identity.ts).
const modules=import.meta.glob('../convex/**/*.ts');
const secret='joining-session-secret-at-least-32-characters',svc='joining-service';
beforeEach(()=>{Object.assign(process.env,{SESSION_SECRET:secret,SERVICE_SECRET:svc});});
afterEach(()=>{vi.useRealTimers();});
const harness=()=>convexTest(schema,modules);
type T=ReturnType<typeof harness>;
let githubId=1000;
// A new GitHub user, or a new session for an existing one (`id`).
async function user(t:T,login:string,id=String(githubId++)){
 const sid=randomBytes(32).toString('base64url');
 const userId=await t.mutation(api.identity.signIn,{secret:svc,provider:'github',providerUserId:id,login,avatar:'',emailVerified:false,sessionHash:createHash('sha256').update(sid).digest('hex'),userAgent:'Vitest'});
 return {id,userId,token:await new SignJWT({sid}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(userId).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret))};
}
const hash=(raw:string)=>createHash('sha256').update(raw).digest('hex');
const role=(t:T,organizationId:Id<'organizations'>,userId:Id<'users'>)=>t.run(async ctx=>(await ctx.db.query('organizationMembers').withIndex('by_org_user',q=>q.eq('organizationId',organizationId).eq('userId',userId)).unique())?.role);

// A workspace with the App installed on the GitHub org "acme" (installation 7, account 900), which made the team "acme".
async function workspace(t:T){
 const owner=await user(t,'owner');
 const organizationId=await t.mutation(api.users.createOrganization,{token:owner.token,name:'Acme'});
 const teamId=await t.run(async ctx=>{
  await ctx.db.insert('githubInstallations',{organizationId,installationId:7,account:'acme',accountId:900,active:true,createdAt:1});
  return ctx.db.insert('teams',{organizationId,name:'acme',externalKey:JSON.stringify(['github','https://api.github.com','900']),createdAt:1});
 });
 return {owner,organizationId,teamId};
}

test('a GitHub user who can see the installation requests a team; an org or team admin answers it',async()=>{
 const t=harness();
 const {owner,organizationId,teamId}=await workspace(t);
 const alice=await user(t,'alice'),bob=await user(t,'bob'),carol=await user(t,'carol'),dave=await user(t,'dave');
 await t.run(async ctx=>{
  await ctx.db.insert('organizationMembers',{organizationId,userId:bob.userId,role:'member'});
  await ctx.db.insert('organizationMembers',{organizationId,userId:carol.userId,role:'member'});
  await ctx.db.insert('teamMembers',{organizationId,teamId,userId:carol.userId,role:'admin'});
 });
 // Only the web server, which read the installations from GitHub, may ask.
 await expect(t.query(api.joinRequests.joinable,{token:alice.token,secret:'wrong',installationIds:[7]})).rejects.toThrow('Unauthorized service');
 expect(await t.query(api.joinRequests.joinable,{token:alice.token,secret:svc,installationIds:[8]})).toEqual([]);
 expect(await t.query(api.joinRequests.joinable,{token:alice.token,secret:svc,installationIds:[7]})).toEqual([{teamId,team:'acme',organization:'Acme',provider:'github',requested:false}]);
 // Org admins see every team, and team members already have it.
 expect(await t.query(api.joinRequests.joinable,{token:owner.token,secret:svc,installationIds:[7]})).toEqual([]);
 expect(await t.query(api.joinRequests.joinable,{token:carol.token,secret:svc,installationIds:[7]})).toEqual([]);

 await expect(t.mutation(api.joinRequests.request,{token:alice.token,secret:svc,teamId,installationIds:[8]})).rejects.toThrow("can't see");
 await t.mutation(api.joinRequests.request,{token:alice.token,secret:svc,teamId,installationIds:[7]});
 await t.mutation(api.joinRequests.request,{token:alice.token,secret:svc,teamId,installationIds:[7]});
 await t.mutation(api.joinRequests.request,{token:dave.token,secret:svc,teamId,installationIds:[7]});
 expect((await t.query(api.joinRequests.joinable,{token:alice.token,secret:svc,installationIds:[7]}))[0].requested).toBe(true);
 const requests=await t.query(api.joinRequests.pending,{token:owner.token,organizationId});
 expect(requests.map(r=>[r.login,r.team])).toEqual([['alice','acme'],['dave','acme']]);

 // A plain member neither sees nor answers requests; the team's admin does both.
 expect(await t.query(api.joinRequests.pending,{token:bob.token,organizationId})).toEqual([]);
 await expect(t.mutation(api.joinRequests.answer,{token:bob.token,requestId:requests[0]._id,approve:true})).rejects.toThrow('Team admin required');
 expect(await t.query(api.joinRequests.pending,{token:carol.token,organizationId})).toHaveLength(2);
 await t.mutation(api.joinRequests.answer,{token:carol.token,requestId:requests[0]._id,approve:true});
 expect(await role(t,organizationId,alice.userId)).toBe('member');
 expect(await t.run(ctx=>ctx.db.query('teamMembers').withIndex('by_team_user',q=>q.eq('teamId',teamId).eq('userId',alice.userId)).unique())).toMatchObject({role:'member'});
 expect(await t.query(api.joinRequests.joinable,{token:alice.token,secret:svc,installationIds:[7]})).toEqual([]);

 await t.mutation(api.joinRequests.answer,{token:owner.token,requestId:requests[1]._id,approve:false});
 expect(await role(t,organizationId,dave.userId)).toBeNull();
 expect(await t.query(api.joinRequests.pending,{token:owner.token,organizationId})).toEqual([]);
 await expect(t.mutation(api.joinRequests.answer,{token:owner.token,requestId:requests[1]._id,approve:true})).rejects.toThrow('already answered');
});

test('a member link joins as Member until an admin resets or disables it',async()=>{
 const t=harness();
 const {owner,organizationId}=await workspace(t);
 const bob=await user(t,'bob'),erin=await user(t,'erin'),frank=await user(t,'frank');
 await t.run(ctx=>ctx.db.insert('organizationMembers',{organizationId,userId:bob.userId,role:'member'}));
 await expect(t.mutation(api.identity.setMemberLink,{token:bob.token,organizationId,tokenHash:hash('nope')})).rejects.toThrow('Forbidden');
 expect(await t.query(api.identity.memberLink,{token:owner.token,organizationId})).toBeNull();

 await t.mutation(api.identity.setMemberLink,{token:owner.token,organizationId,tokenHash:hash('first')});
 expect(await t.query(api.identity.memberLink,{token:owner.token,organizationId})).toMatchObject({createdAt:expect.any(Number)});
 expect(await t.query(api.identity.invitationPreview,{tokenHash:hash('first')})).toMatchObject({workspace:'Acme',role:'member'});
 expect(await t.mutation(api.identity.acceptEmailInvitation,{token:erin.token,tokenHash:hash('first')})).toBe(organizationId);
 expect(await role(t,organizationId,erin.userId)).toBe('member');

 // Reset: the old link stops working at once, the new one works for anyone.
 await t.mutation(api.identity.setMemberLink,{token:owner.token,organizationId,tokenHash:hash('second')});
 expect(await t.query(api.identity.invitationPreview,{tokenHash:hash('first')})).toBeNull();
 await expect(t.mutation(api.identity.acceptEmailInvitation,{token:frank.token,tokenHash:hash('first')})).rejects.toThrow('invalid or expired');
 expect(await t.query(api.identity.invitationPreview,{tokenHash:hash('second')})).toMatchObject({workspace:'Acme',role:'member'});

 await t.mutation(api.identity.setMemberLink,{token:owner.token,organizationId});
 expect(await t.query(api.identity.memberLink,{token:owner.token,organizationId})).toBeNull();
 expect(await t.query(api.identity.invitationPreview,{tokenHash:hash('second')})).toBeNull();
 expect(await role(t,organizationId,frank.userId)).toBeNull();
});

test('a GitLab group connected to a workspace is a team its members can ask to join, on the same GitLab instance only',async()=>{
 const t=harness();
 const {owner,organizationId}=await workspace(t);
 const teamId=await t.run(ctx=>ctx.db.insert('teams',{organizationId,name:'acme/platform',externalKey:JSON.stringify(['gitlab','https://gitlab.com','77']),createdAt:1}));
 const gina=await user(t,'gina');
 const gitlab={instance:'https://gitlab.com',groupIds:['77']};
 expect(await t.query(api.joinRequests.joinable,{token:gina.token,secret:svc,installationIds:[],gitlab})).toEqual([{teamId,team:'acme/platform',organization:'Acme',provider:'gitlab',requested:false}]);
 expect(await t.query(api.joinRequests.joinable,{token:gina.token,secret:svc,installationIds:[],gitlab:{...gitlab,instance:'https://gitlab.example.com'}})).toEqual([]);
 await expect(t.mutation(api.joinRequests.request,{token:gina.token,secret:svc,teamId,installationIds:[]})).rejects.toThrow("can't see");
 await t.mutation(api.joinRequests.request,{token:gina.token,secret:svc,teamId,installationIds:[],gitlab});
 const [request]=await t.query(api.joinRequests.pending,{token:owner.token,organizationId});
 await t.mutation(api.joinRequests.answer,{token:owner.token,requestId:request._id,approve:true});
 expect(await role(t,organizationId,gina.userId)).toBe('member');
 expect(await t.query(api.joinRequests.joinable,{token:gina.token,secret:svc,installationIds:[],gitlab})).toEqual([]);
});

test('a join request is emailed to owners, admins and the team\'s admins with a verified notification email, not to members',async()=>{
 const t=harness();
 const {owner,organizationId,teamId}=await workspace(t);
 const alice=await user(t,'alice'),bob=await user(t,'bob'),carol=await user(t,'carol'),dan=await user(t,'dan');
 await t.run(async ctx=>{
  for(const [u,r] of [[bob,'member'],[carol,'member'],[dan,'admin']] as const)await ctx.db.insert('organizationMembers',{organizationId,userId:u.userId,role:r});
  await ctx.db.insert('teamMembers',{organizationId,teamId,userId:carol.userId,role:'admin'});
  // Dan is an admin without a verified address, so he gets no email.
  for(const [u,email,verified] of [[owner,'owner@acme.dev',true],[bob,'bob@acme.dev',true],[carol,'carol@acme.dev',true],[dan,'dan@acme.dev',false]] as const)
   await ctx.db.insert('notificationPreferences',{organizationId,userId:u.userId,email,...(verified?{emailVerifiedAt:1}:{}),reviewCompleted:'off',highSeverity:'off',updatedAt:1});
 });
 await t.mutation(api.joinRequests.request,{token:alice.token,secret:svc,teamId,installationIds:[7]});
 const [request]=await t.query(api.joinRequests.pending,{token:owner.token,organizationId});
 const target=await t.query(internal.notifications.joinRequestTargets,{requestId:request._id});
 expect(target).toMatchObject({organizationId,workspace:'Acme',team:'acme',login:'alice'});
 expect(target!.recipients.map(r=>r.email).sort()).toEqual(['carol@acme.dev','owner@acme.dev']);
});

test('a member link stops working after 30 days',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.UTC(2026,9,27));
 const t=harness();
 let {owner,organizationId}=await workspace(t);
 await t.mutation(api.identity.setMemberLink,{token:owner.token,organizationId,tokenHash:hash('soon-stale')});
 expect(await t.query(api.identity.invitationPreview,{tokenHash:hash('soon-stale')})).toMatchObject({role:'member',expiresAt:Date.UTC(2026,10,26)});
 vi.setSystemTime(Date.UTC(2026,10,26,0,0,1));
 owner=await user(t,'owner',owner.id);
 const erin=await user(t,'erin');
 expect(await t.query(api.identity.memberLink,{token:owner.token,organizationId})).toBeNull();
 expect(await t.query(api.identity.invitationPreview,{tokenHash:hash('soon-stale')})).toBeNull();
 await expect(t.mutation(api.identity.acceptEmailInvitation,{token:erin.token,tokenHash:hash('soon-stale')})).rejects.toThrow('invalid or expired');
});
