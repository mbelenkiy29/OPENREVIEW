import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import {createHash,randomBytes} from 'node:crypto';
import schema from '../convex/schema';
import {api} from '../convex/_generated/api';
const modules=import.meta.glob('../convex/**/*.ts');
const secret='invite-gap-session-secret-at-least-32-characters',svc='invite-gap-service';
beforeEach(()=>{vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});vi.setSystemTime(Date.UTC(2026,9,14,12));Object.assign(process.env,{SESSION_SECRET:secret,SERVICE_SECRET:svc,APP_URL:'https://review.example.com',RESEND_API_KEY:'re_fixture',EMAIL_FROM:'OpenReview <noreply@example.com>'});});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();delete process.env.RESEND_API_KEY;delete process.env.EMAIL_FROM;});
type T=ReturnType<typeof convexTest>;
const jwt=(userId:string,sid:string)=>new SignJWT({sid}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(userId).setIssuedAt().setExpirationTime('7d').sign(new TextEncoder().encode(secret));
async function signIn(t:T,p:{provider:'github'|'google';providerUserId:string;login:string;email?:string;emailVerified:boolean}){const sid=randomBytes(32).toString('base64url');const userId=await t.mutation(api.identity.signIn,{secret:svc,avatar:'',...p,sessionHash:createHash('sha256').update(sid).digest('hex')});return {userId,token:await jwt(userId,sid)};}
function mailbox(){const mails:{to:string;text:string}[]=[];vi.spyOn(globalThis,'fetch').mockImplementation(async(_u,init?:RequestInit)=>{const b=JSON.parse(String(init?.body));mails.push({to:b.to[0],text:b.text});return Response.json({id:'m'+mails.length});});return mails;}
const hashOf=(text:string)=>createHash('sha256').update(/\/invite\?token=([A-Za-z0-9_-]+)/.exec(text)![1]).digest('hex');
const roles=async(t:T,token:string)=>(await t.query(api.users.me,{token})).organizations.map(o=>o.role);

// Email invitations end to end, plus reissuing one and how the inviter is named.
test('a new user opens the invite email, signs up, accepts and joins with the invited role: invite email, preview, accept, member with the invited role',async()=>{
 const t=convexTest(schema,modules),mails=mailbox();
 const owner=await signIn(t,{provider:'github',providerUserId:'1',login:'owner',emailVerified:false});
 const org=await t.mutation(api.users.createOrganization,{token:owner.token,name:'Acme'});
 expect(await t.action(api.identityJobs.inviteByEmail,{token:owner.token,organizationId:org,email:'dana@example.com',role:'admin'})).toBe('sent');
 expect(mails[0].text).toContain('https://review.example.com/invite?token=');
 const dana=await signIn(t,{provider:'google',providerUserId:'g-dana',login:'dana',email:'dana@example.com',emailVerified:true});
 expect(await t.mutation(api.identity.acceptEmailInvitation,{token:dana.token,tokenHash:hashOf(mails[0].text)})).toBe(org);
 expect(await roles(t,dana.token)).toEqual(['admin']);
});

test('reissuing an invitation to the same address replaces the earlier link, so a wrong higher role stops working',async()=>{
 const t=convexTest(schema,modules),mails=mailbox();
 const owner=await signIn(t,{provider:'github',providerUserId:'1',login:'owner',emailVerified:false});
 const org=await t.mutation(api.users.createOrganization,{token:owner.token,name:'Acme'}),other=await t.mutation(api.users.createOrganization,{token:owner.token,name:'Other'});
 await t.action(api.identityJobs.inviteByEmail,{token:owner.token,organizationId:org,email:'dana@example.com',role:'admin'});
 await t.action(api.identityJobs.inviteByEmail,{token:owner.token,organizationId:other,email:'dana@example.com',role:'member'});
 await t.action(api.identityJobs.inviteByEmail,{token:owner.token,organizationId:org,email:'Dana@Example.com',role:'viewer'});
 expect((await t.query(api.identity.emailInvitations,{token:owner.token,organizationId:org})).map(i=>i.role)).toEqual(['viewer']);
 expect(await t.query(api.identity.invitationPreview,{tokenHash:hashOf(mails[0].text)})).toBeNull();
 const dana=await signIn(t,{provider:'github',providerUserId:'2',login:'dana',emailVerified:false});
 await expect(t.mutation(api.identity.acceptEmailInvitation,{token:dana.token,tokenHash:hashOf(mails[0].text)})).rejects.toThrow(/invalid or expired/);
 // Another workspace's invitation to the same address is untouched.
 expect(await t.mutation(api.identity.acceptEmailInvitation,{token:dana.token,tokenHash:hashOf(mails[1].text)})).toBe(other);
 expect(await t.mutation(api.identity.acceptEmailInvitation,{token:dana.token,tokenHash:hashOf(mails[2].text)})).toBe(org);
 expect((await t.query(api.users.me,{token:dana.token})).organizations.map(o=>[o.name,o.role])).toEqual([['Other','member'],['Acme','viewer']]);
});

test('reissuing finds the earlier link however many other invitations the workspace sent since',async()=>{
 const t=convexTest(schema,modules),mails=mailbox();
 const owner=await signIn(t,{provider:'github',providerUserId:'1',login:'owner',emailVerified:false});
 const org=await t.mutation(api.users.createOrganization,{token:owner.token,name:'Acme'});
 await t.action(api.identityJobs.inviteByEmail,{token:owner.token,organizationId:org,email:'dana@example.com',role:'admin'});
 await t.run(async ctx=>{for(let i=0;i<150;i++)await ctx.db.insert('emailInvitations',{organizationId:org,email:`p${i}@example.com`,role:'member',tokenHash:createHash('sha256').update(`filler${i}`).digest('hex'),invitedBy:owner.userId,expiresAt:Date.now()+86400000,createdAt:Date.now()});});
 await t.action(api.identityJobs.inviteByEmail,{token:owner.token,organizationId:org,email:'dana@example.com',role:'viewer'});
 expect(await t.query(api.identity.invitationPreview,{tokenHash:hashOf(mails[0].text)})).toBeNull();
});

test('the invite email names a GitHub inviter by username and never shows an email login',async()=>{
 const t=convexTest(schema,modules),mails=mailbox();
 const gh=await signIn(t,{provider:'github',providerUserId:'1',login:'octo',emailVerified:false});
 const jane=await signIn(t,{provider:'google',providerUserId:'g-o',login:'jane.private',email:'jane.private@example.com',emailVerified:true});
 for (const [who,name] of [[gh,'GH'],[jane,'Jane']] as const) await t.action(api.identityJobs.inviteByEmail,{token:who.token,organizationId:await t.mutation(api.users.createOrganization,{token:who.token,name}),email:'dana@example.com',role:'member'});
 expect(mails[0].text).toMatch(/^@octo invited you to join GH/);
 expect(mails[1].text).toMatch(/^A teammate invited you to join Jane/);
 expect(mails[1].text).not.toContain('jane.private');
});

test('the link itself is the credential: whoever opens it and signs in joins, whatever address they use',async()=>{
 const t=convexTest(schema,modules),mails=mailbox();
 const owner=await signIn(t,{provider:'github',providerUserId:'1',login:'owner',emailVerified:false});
 const org=await t.mutation(api.users.createOrganization,{token:owner.token,name:'Acme'});
 await t.action(api.identityJobs.inviteByEmail,{token:owner.token,organizationId:org,email:'dana@example.com',role:'member'});
 const eve=await signIn(t,{provider:'google',providerUserId:'g-eve',login:'eve',email:'eve@other.com',emailVerified:true});
 expect(await t.mutation(api.identity.acceptEmailInvitation,{token:eve.token,tokenHash:hashOf(mails[0].text)})).toBe(org);
});
