import {beforeEach,expect,test} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import schema from '../convex/schema';
import {api} from '../convex/_generated/api';
import type {Id} from '../convex/_generated/dataModel';
const modules=import.meta.glob('../convex/**/*.ts');
const secret='integration-session-secret-at-least-32-characters',service='integration-service-secret';
beforeEach(()=>{process.env.SESSION_SECRET=secret;process.env.SERVICE_SECRET=service;});

// A workspace whose member sees untagged repos, team "mine" (member) and team "watch" (viewer), but not team "other".
async function setup(documentsRead:number,counts={open:150,mine:150,watch:50,other:150}){
 const t=convexTest({schema,modules,transactionLimits:{documentsRead}});
 const login=async(githubId:number,name:string)=>{const id=await t.mutation(api.users.login,{secret:service,githubId,login:name,avatar:''});return {id,token:await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(id).setExpirationTime('1h').sign(new TextEncoder().encode(secret))};};
 const owner=await login(81,'olga'),member=await login(82,'max');
 const organizationId=await t.mutation(api.users.createOrganization,{token:owner.token,name:'Scale'});
 const seeded=await t.run(async ctx=>{
  const team=async(name:string,role?:'member'|'viewer')=>{const id=await ctx.db.insert('teams',{organizationId,name,createdAt:0});if(role)await ctx.db.insert('teamMembers',{organizationId,teamId:id,userId:member.id,role});return id;};
  const teams={open:undefined,mine:await team('mine','member'),watch:await team('watch','viewer'),other:await team('other')};
  await ctx.db.insert('organizationMembers',{organizationId,userId:member.id,role:'member'});
  const repos:Record<keyof typeof counts,Id<'repositories'>[]>={open:[],mine:[],watch:[],other:[]};
  for(const k of Object.keys(counts) as (keyof typeof counts)[])for(let i=0;i<counts[k];i++)repos[k].push(await ctx.db.insert('repositories',{organizationId,fullName:`scale/${k}-${i}`,defaultBranch:'main',enabled:true,indexStatus:'ready',createdAt:0,...(teams[k]?{teamId:teams[k]}:{})}));
  return {teams,repos};
 });
 return {t,owner:owner.token,member:member.token,organizationId,...seeded};
}
const sorted=(ids:string[])=>[...ids].sort();

test('overview for a member of a workspace with many repositories stays bounded and returns the same repositories',async()=>{
 const {t,member,organizationId,repos}=await setup(1000);
 const overview=await t.query(api.dashboard.overview,{token:member,organizationId});
 expect(sorted(overview.repositories.map(r=>r._id))).toEqual(sorted([...repos.open,...repos.mine,...repos.watch]));
 // Write access as repositoryAccess(write) decides it: a team viewer cannot write that team's repositories.
 expect(sorted(overview.writableRepositoryIds)).toEqual(sorted([...repos.open,...repos.mine]));
 expect(overview.indexJobs).toHaveLength(350);
});

test('overview hides rules scoped to a team the member does not belong to, as rulesPage does',async()=>{
 const {t,member,owner,organizationId,teams}=await setup(1000,{open:1,mine:1,watch:0,other:1});
 const rule={instructions:'Review instructions',category:'correctness',severity:'high',globs:[],enabled:true,createdAt:0};
 await t.run(async ctx=>{for(const [title,teamId] of [['workspace',undefined],['mine',teams.mine],['other',teams.other]] as const)await ctx.db.insert('customRules',{...rule,organizationId,title,...(teamId?{teamId}:{})});});
 expect(sorted((await t.query(api.dashboard.overview,{token:member,organizationId})).rules.map(r=>r.title))).toEqual(['mine','workspace']);
 expect(sorted((await t.query(api.dashboard.overview,{token:owner,organizationId})).rules.map(r=>r.title))).toEqual(['mine','other','workspace']);
});

test('findings.list reads one repository through its own index and caps rows read for workspace-wide pages',async()=>{
 const {t,member,organizationId,repos}=await setup(1200,{open:1,mine:0,watch:0,other:1});
 const [visible,hidden]=[repos.open[0],repos.other[0]];
 await t.run(async ctx=>{
  const finding=async(repositoryId:Id<'repositories'>,i:number)=>{const reviewId=await ctx.db.insert('reviews',{organizationId,repositoryId,prNumber:1,headSha:'a'.repeat(40),status:'completed',mode:'standard',attempts:1,createdAt:i,updatedAt:i});await ctx.db.insert('findings',{organizationId,repositoryId,reviewId,prNumber:1,title:'t'+i,description:'d',severity:'high',confidence:0.9,category:'correctness',filePath:'a.ts',startLine:1,endLine:1,commitSha:'a'.repeat(40),evidence:[],impact:'i',suggestedFix:'f',symbol:'s',fingerprint:'fp'+i,agent:'correctness',status:'open',createdAt:i,updatedAt:i});};
  await finding(visible,0);
  // Newer findings in a repository the member cannot see sit in front of it in the workspace index.
  const reviewId=await ctx.db.insert('reviews',{organizationId,repositoryId:hidden,prNumber:2,headSha:'b'.repeat(40),status:'completed',mode:'standard',attempts:1,createdAt:1,updatedAt:1});
  for(let i=1;i<=1500;i++)await ctx.db.insert('findings',{organizationId,repositoryId:hidden,reviewId,prNumber:2,title:'h'+i,description:'d',severity:'low',confidence:0.9,category:'correctness',filePath:'a.ts',startLine:1,endLine:1,commitSha:'b'.repeat(40),evidence:[],impact:'i',suggestedFix:'f',symbol:'s',fingerprint:'h'+i,agent:'correctness',status:'open',createdAt:i,updatedAt:i});
 });
 expect((await t.query(api.findings.list,{token:member,organizationId,repositoryId:visible})).page.map(f=>f.title)).toEqual(['t0']);
 // Workspace-wide, a page stops at the row cap instead of failing; the next page continues.
 const first=await t.query(api.findings.list,{token:member,organizationId});
 expect(first.page).toEqual([]);expect(first.isDone).toBe(false);
 const second=await t.query(api.findings.list,{token:member,organizationId,cursor:first.continueCursor});
 expect(second.page.map(f=>f.title)).toEqual(['t0']);
});

test('settings.preferences reads a bounded slice of a heavily discussed finding\'s feedback',async()=>{
 const {t,member,organizationId,repos}=await setup(1000,{open:1,mine:0,watch:0,other:0});
 const repositoryId=repos.open[0];
 await t.run(async ctx=>{
  const reviewId=await ctx.db.insert('reviews',{organizationId,repositoryId,prNumber:1,headSha:'a'.repeat(40),status:'completed',mode:'standard',attempts:1,createdAt:0,updatedAt:0});
  const findingId=await ctx.db.insert('findings',{organizationId,repositoryId,reviewId,prNumber:1,title:'Preserve cents',description:'d',severity:'high',confidence:0.9,category:'data',filePath:'a.ts',startLine:1,endLine:1,commitSha:'a'.repeat(40),evidence:[],impact:'i',suggestedFix:'f',symbol:'s',fingerprint:'fp',agent:'data',status:'open',createdAt:0,updatedAt:0});
  for(let i=0;i<1500;i++)await ctx.db.insert('findingFeedback',{organizationId,findingId,value:'useful',comment:'',githubLogin:'dev'+i,createdAt:i});
  await ctx.db.insert('learnedPreferences',{organizationId,repositoryId,findingId,instruction:'Preserve units',category:'data',source:'manual',enabled:true,createdAt:1});
 });
 const [row]=await t.query(api.settings.preferences,{token:member,organizationId});
 expect(row.finding?.title).toBe('Preserve cents');
 expect(row.feedback).toHaveLength(20);expect(row.feedback[0].author).toBe('dev1499');
});

test('memory.rules reads one bounded workspace query instead of 500 rules per visible repository',async()=>{
 const {t,member,organizationId,repos}=await setup(2500,{open:10,mine:0,watch:0,other:0});
 await t.run(async ctx=>{for(const repositoryId of repos.open)for(let i=0;i<300;i++)await ctx.db.insert('learnedRules',{organizationId,repositoryId,text:'Convention '+i,category:'style',status:'approved',frequency:1,evidence:[],createdAt:i,updatedAt:i});});
 const rules=await t.query(api.memory.rules,{token:member,organizationId});
 expect(rules).toHaveLength(300);
 expect(rules[0].updatedAt).toBe(299);
});
