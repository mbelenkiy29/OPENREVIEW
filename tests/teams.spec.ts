import {beforeEach,expect,test} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import {createHash,randomBytes} from 'node:crypto';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import type {Id} from '../convex/_generated/dataModel';
import {defaults} from '../src/review-settings';

// Teams as on Greptile: invites from a team's People page join that team, team admins manage their team, and a
// team's Code Review Settings can Sync from parent (convex/scopes.ts, convex/users.ts, convex/identity.ts).
const modules=import.meta.glob('../convex/**/*.ts');
const secret='teams-session-secret-at-least-32-characters-long',svc='teams-service';
beforeEach(()=>{Object.assign(process.env,{SESSION_SECRET:secret,SERVICE_SECRET:svc});});
const harness=()=>convexTest(schema,modules);
type T=ReturnType<typeof harness>;
let githubId=5000;
async function user(t:T,login:string){
 const sid=randomBytes(32).toString('base64url');
 const userId=await t.mutation(api.identity.signIn,{secret:svc,provider:'github',providerUserId:String(githubId++),login,avatar:'',emailVerified:false,sessionHash:createHash('sha256').update(sid).digest('hex'),userAgent:'Vitest'});
 return {userId,token:await new SignJWT({sid}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(userId).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret))};
}
const roles=(t:T,organizationId:Id<'organizations'>,teamId:Id<'teams'>,userId:Id<'users'>)=>t.run(async ctx=>[
 (await ctx.db.query('organizationMembers').withIndex('by_org_user',q=>q.eq('organizationId',organizationId).eq('userId',userId)).unique())?.role,
 (await ctx.db.query('teamMembers').withIndex('by_team_user',q=>q.eq('teamId',teamId).eq('userId',userId)).unique())?.role??null]);
async function workspace(t:T){
 const owner=await user(t,'owner');
 const organizationId=await t.mutation(api.users.createOrganization,{token:owner.token,name:'Acme'});
 const teamId=await t.run(ctx=>ctx.db.insert('teams',{organizationId,name:'acme-web',createdAt:1}));
 return {owner,organizationId,teamId};
}

test('an invitation from a team joins that team with the invited role, and the organization as a Member or Viewer',async()=>{
 const t=harness();
 const {owner,organizationId,teamId}=await workspace(t);
 const other=await t.mutation(api.users.createOrganization,{token:owner.token,name:'Elsewhere'});
 const elsewhere=await t.run(ctx=>ctx.db.insert('teams',{organizationId:other,name:'theirs',createdAt:1}));
 await expect(t.mutation(api.users.invite,{token:owner.token,organizationId,githubLogin:'tia',role:'member',teamId:elsewhere})).rejects.toThrow('Team not accessible');

 const invitationId=await t.mutation(api.users.invite,{token:owner.token,organizationId,githubLogin:'tia',role:'admin',teamId});
 const tia=await user(t,'tia');
 expect(await t.mutation(api.users.acceptInvitation,{token:tia.token,invitationId})).toBe(organizationId);
 // A team admin, not a workspace admin.
 expect(await roles(t,organizationId,teamId,tia.userId)).toEqual(['member','admin']);

 await t.mutation(internal.identity.createEmailInvitation,{token:owner.token,organizationId,email:'vic@acme.dev',role:'viewer',teamId,tokenHash:createHash('sha256').update('vic-link').digest('hex')});
 const vic=await user(t,'vic');
 await t.mutation(api.identity.acceptEmailInvitation,{token:vic.token,tokenHash:createHash('sha256').update('vic-link').digest('hex')});
 expect(await roles(t,organizationId,teamId,vic.userId)).toEqual(['viewer','viewer']);
});

test('a team admin manages their own team; a plain member cannot',async()=>{
 const t=harness();
 const {organizationId,teamId}=await workspace(t);
 const lead=await user(t,'lead'),dev=await user(t,'dev'),new_=await user(t,'newcomer');
 await t.run(async ctx=>{
  for(const u of [lead,dev,new_])await ctx.db.insert('organizationMembers',{organizationId,userId:u.userId,role:'member'});
  await ctx.db.insert('teamMembers',{organizationId,teamId,userId:lead.userId,role:'admin'});
 });
 await expect(t.mutation(api.scopes.member,{token:dev.token,teamId,userId:new_.userId,role:'member',remove:false})).rejects.toThrow('Team admin required');
 await t.mutation(api.scopes.member,{token:lead.token,teamId,userId:new_.userId,role:'member',remove:false});
 await t.mutation(api.scopes.member,{token:lead.token,teamId,userId:new_.userId,role:'viewer',remove:false});
 expect(await roles(t,organizationId,teamId,new_.userId)).toEqual(['member','viewer']);
 await t.mutation(api.scopes.member,{token:lead.token,teamId,userId:new_.userId,role:'viewer',remove:true});
 expect((await roles(t,organizationId,teamId,new_.userId))[1]).toBeNull();
 // Owner-only org settings stay out of a team admin's reach.
 await expect(t.mutation(api.scopes.syncTeam,{token:lead.token,teamId})).rejects.toThrow('Forbidden');
});

test('Sync from parent drops a team\'s overrides so it follows the workspace again',async()=>{
 const t=harness();
 const {owner,organizationId,teamId}=await workspace(t);
 const scopeId=await t.run(ctx=>ctx.db.insert('scopeSettings',{organizationId,teamId,settings:defaults as never,overrideKeys:['automatic','maxComments']}));
 await t.mutation(api.scopes.syncTeam,{token:owner.token,teamId});
 expect((await t.run(ctx=>ctx.db.get(scopeId)))?.overrideKeys).toEqual([]);
});
