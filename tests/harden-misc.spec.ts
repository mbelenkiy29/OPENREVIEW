import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import {generateKeyPairSync} from 'node:crypto';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import type {Id} from '../convex/_generated/dataModel';
import {z} from 'zod';
import {Origin} from '../src/origin';
const modules=import.meta.glob('../convex/**/*.ts');
const sessionSecret='harden-session-secret-at-least-32-characters',service='harden-service-secret',head='a'.repeat(40),oldHead='b'.repeat(40);
beforeEach(()=>{process.env.SESSION_SECRET=sessionSecret;process.env.SERVICE_SECRET=service;});
afterEach(()=>vi.restoreAllMocks());

// PR #5 by alice: 300 open findings left on an older review, two on the latest. Reads are capped below 300.
async function busyPr(){
 const t=convexTest({schema,modules,transactionLimits:{documentsRead:200}});
 const userId=await t.mutation(api.users.login,{secret:service,githubId:1,login:'alice',avatar:''});
 const token=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setSubject(userId).setIssuer('openreview').setAudience('openreview').setExpirationTime('1h').sign(new TextEncoder().encode(sessionSecret));
 const organizationId=await t.mutation(api.users.createOrganization,{token,name:'Acme'});
 await t.mutation(api.repositories.connect,{token,secret:service,organizationId,installationId:1,account:'acme',accountId:1,repositories:[{id:1,fullName:'acme/shop',defaultBranch:'main'}]});
 const [repo]=await t.query(api.repositories.list,{token,organizationId});
 const latest=await t.run(async ctx=>{
  await ctx.db.patch(repo._id,{enabled:true});
  await ctx.db.insert('pullRequests',{organizationId,repositoryId:repo._id,number:5,title:'Busy',author:'alice',url:'https://github.com/acme/shop/pull/5',headSha:head,baseSha:'c'.repeat(40),state:'open',updatedAt:1});
  const review=(headSha:string)=>ctx.db.insert('reviews',{organizationId,repositoryId:repo._id,prNumber:5,headSha,status:'completed',mode:'standard',attempts:1,createdAt:1,updatedAt:1});
  const finding=(reviewId:Id<'reviews'>,fingerprint:string,commitSha:string)=>ctx.db.insert('findings',{organizationId,repositoryId:repo._id,reviewId,prNumber:5,author:'alice',title:'Finding '+fingerprint,description:'d'.repeat(20),severity:'high',confidence:.9,category:'correctness',filePath:'src/a.ts',startLine:1,endLine:1,evidence:[{filePath:'src/a.ts',startLine:1,quote:'x'}],impact:'impact',suggestedFix:'fix it',agent:'correctness',symbol:'a',fingerprint,commitSha,status:'open',createdAt:1,updatedAt:1});
  const old=await review(oldHead);
  for(let i=0;i<300;i++)await finding(old,'old'+i,oldHead);
  const latest=await review(head);
  await finding(latest,'new1',head);await finding(latest,'new2',head);
  return latest;
 });
 return {t,token,organizationId,repositoryId:repo._id,latest};
}

test('Fix on a PR with a long finding history reads only the latest review',async()=>{
 const {t,token,latest}=await busyPr();
 const requestId=await t.mutation(api.bridge.createFix,{token,reviewId:latest,agent:'codex'});
 expect((await t.run(ctx=>ctx.db.get(requestId)))!.findingIds).toHaveLength(2);
});

test('pr_status and unresolved count only the latest review on a PR with over 200 old findings',async()=>{
 const {t,token,organizationId,repositoryId,latest}=await busyPr();
 expect(await t.query(api.mcpApi.prStatus,{token,organizationId,repositoryId,prNumber:5})).toMatchObject({review:{reviewId:latest,headSha:head},unresolved:2});
 const mine=await t.query(api.mcpApi.unresolvedForUser,{token,organizationId});
 expect(mine.findings.map(f=>f.title).sort()).toEqual(['Finding new1','Finding new2']);
});

test('a second pairing cannot reuse a code that is already registered',async()=>{
 const t=convexTest(schema,modules),code='0123456789ab';
 await t.mutation(api.bridge.startPair,{secret:service,hash:'1'.repeat(64),code,name:'Real device'});
 await expect(t.mutation(api.bridge.startPair,{secret:service,hash:'2'.repeat(64),code,name:'Copycat'})).rejects.toThrow(/already in use/);
});

test('directory lists every top-level folder even when one folder holds thousands of files',async()=>{
 const t=convexTest({schema,modules,transactionLimits:{documentsRead:200}});
 const repositoryId=await t.run(async ctx=>{
  const organizationId=await ctx.db.insert('organizations',{name:'Mono',createdAt:0});
  const repositoryId=await ctx.db.insert('repositories',{organizationId,fullName:'mono/repo',defaultBranch:'main',enabled:true,indexStatus:'ready',createdAt:0});
  const storageId=await ctx.storage.store(new Blob(['x']));
  const file=(path:string)=>ctx.db.insert('repositoryFiles',{organizationId,repositoryId,path,sha:'s',storageId,language:'ts',updatedAt:0});
  for(let i=0;i<3001;i++)await file('apps/f'+i+'.ts');
  for(const path of ['README.md','apps-old.ts','src/main.ts'])await file(path);
  return repositoryId;
 });
 expect(await t.query(internal.agentTools.directory,{repositoryId,path:''})).toEqual(['README.md','apps-old.ts','apps','src']);
});

test('Origin refuses a response body over 20MB',async()=>{
 const credentials={appId:'app_fixture',installationId:'i_fixture',privateKey:generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}).toString()};
 vi.spyOn(globalThis,'fetch').mockImplementation(async input=>String(input).endsWith('/access_tokens')?Response.json({token:'oit_fixture',expiresAt:new Date(Date.now()+240000).toISOString()}):new Response(JSON.stringify({id:'x'.repeat(20000001)})));
 await expect(new Origin(credentials).request('/repos/acme/shop',z.object({id:z.string()}))).rejects.toThrow(/20MB/);
});
