import {afterEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import {encryptCredential} from '../src/credentials';
const modules=import.meta.glob('../convex/**/*.ts');
const id=(n:number)=>`${String(n).repeat(8)}-1111-4111-8111-${'1'.repeat(12)}`,url=(n:number)=>`https://www.notion.so/acme/Spec-${id(n).replace(/-/g,'')}`;
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

// Linear + Notion connected to one repo; `notionText` sizes each page body.
async function setup(notionText:(page:string)=>string=()=>'Totals stay in integer cents.'){
 Object.assign(process.env,{SERVICE_SECRET:'gate-service',CREDENTIAL_ENCRYPTION_KEY:'gate-encryption-secret-at-least-32-characters'});
 const t=convexTest(schema,modules),alice=await t.mutation(api.users.login,{secret:'gate-service',githubId:91,login:'alice',avatar:''});
 const repositoryId=await t.run(async ctx=>{
  const organizationId=await ctx.db.insert('organizations',{name:'Acme',createdAt:Date.now()});await ctx.db.insert('organizationMembers',{organizationId,userId:alice,role:'member'});
  const repo=await ctx.db.insert('repositories',{organizationId,fullName:'acme/shop',defaultBranch:'main',enabled:true,indexStatus:'ready',createdAt:Date.now()}),expiresAt=Date.now()+3600000;
  for(const kind of ['linear','notion'] as const)await ctx.db.insert('integrationConnections',{organizationId,kind,externalId:'native-org',name:kind,credentials:encryptCredential(JSON.stringify({accessToken:'fixture-access-token',refreshToken:'fixture-refresh-token',expiresAt}),organizationId+':'+kind),expiresAt,active:true,generation:1,teamIds:kind==='linear'?['team']:[],projectIds:[],repositoryIds:[repo],createdAt:Date.now()});
  return repo;
 });
 const calls:string[]=[];
 vi.stubGlobal('fetch',async(input:string|URL,init?:RequestInit)=>{
  const u=new URL(String(input));calls.push(u.hostname+u.pathname);
  if(u.hostname==='api.linear.app'){const full=JSON.parse(String(init?.body)).query.includes('description');return Response.json({data:{organization:{id:'native-org'},issue:{id:'i1',identifier:'PAY-1',team:{id:'team'},project:null,...(full?{title:'Pay',description:'Refunds are idempotent.',updatedAt:'2026-10-03T00:00:00.000Z',url:'https://linear.app/acme/issue/PAY-1/pay'}:{})}}});}
  const page=/^\/v1\/(?:pages|blocks)\/([^/]+)/.exec(u.pathname)?.[1]??'';
  if(u.pathname.startsWith('/v1/pages/'))return Response.json({object:'page',id:page,url:url(Number(page[0])),last_edited_time:'2026-10-02T09:00:00.000Z',properties:{Name:{type:'title',title:[{plain_text:'Spec'}]}}});
  if(u.pathname.endsWith('/children'))return Response.json({results:[{id:'b',type:'paragraph',paragraph:{rich_text:[{plain_text:notionText(page)}]}}],has_more:false,next_cursor:null});
  throw new Error('Unexpected request '+u.href);
 });
 return {t,repositoryId,calls};
}

test('requirements are fetched only for a PR author who is a linked workspace member with repository access',async()=>{
 const {t,repositoryId,calls}=await setup(),references=`PAY-1 ${url(2)}`;
 for(const author of [{},{actor:'mallory',authorExternalId:'666'},{actor:'alice',authorExternalId:'92'},{actor:'alice'}]){
  const denied=await t.action(internal.integrationJobs.requirements,{repositoryId,references,...author});
  expect(denied).toEqual({files:[],scopes:[],coverage:['Linked tickets and documents were not fetched: the PR author is not a linked workspace member with access to this repository.']});
 }
 expect(calls).toEqual([]);
 const allowed=await t.action(internal.integrationJobs.requirements,{repositoryId,references,actor:'alice',authorExternalId:'91'});
 expect(allowed.files.map(f=>f.path.split('/')[1])).toEqual(['linear','notion']);
 expect(calls.some(c=>c.startsWith('api.linear.app'))&&calls.some(c=>c.startsWith('api.notion.com'))).toBe(true);
});

test('once the requirements byte budget is full no further pages are fetched',async()=>{
 const {t,repositoryId,calls}=await setup(()=>'a'.repeat(60000));
 const result=await t.action(internal.integrationJobs.requirements,{repositoryId,references:[2,3,4].map(url).join(' '),actor:'alice',authorExternalId:'91'});
 expect(result.files.map(f=>f.path.split('/').at(-1))).toEqual([id(2)+'.md']);
 expect(result.coverage).toContain('Notion requirements context exceeded the 100KB limit.');
 expect(calls.filter(c=>c.includes(id(4)))).toEqual([]);
});
