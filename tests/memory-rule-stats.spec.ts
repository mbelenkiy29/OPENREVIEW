import {test,expect} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import schema from '../convex/schema';
import {api} from '../convex/_generated/api';
import type {Id} from '../convex/_generated/dataModel';
const modules=import.meta.glob('../convex/**/*.ts');

test('rule stats count citing findings in visible repositories; search, status and usage stay in the workspace',async()=>{
 process.env.SERVICE_SECRET='stats-service';process.env.SESSION_SECRET='stats-session-secret-at-least-32-characters';
 const t=convexTest(schema,modules);
 const sign=async(githubId:number)=>{const id=await t.mutation(api.users.login,{secret:'stats-service',githubId,login:'u'+githubId,avatar:''});return {id,token:await new SignJWT({}).setSubject(id).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setExpirationTime('1h').sign(new TextEncoder().encode(process.env.SESSION_SECRET))};};
 const admin=await sign(1),outsider=await sign(2);
 const organizationId=await t.mutation(api.users.createOrganization,{token:admin.token,name:'Stats'});
 const otherOrg=await t.mutation(api.users.createOrganization,{token:outsider.token,name:'Other'});
 await t.mutation(api.repositories.connect,{token:admin.token,secret:'stats-service',organizationId,installationId:7,account:'acme',accountId:1,repositories:[{id:1,fullName:'acme/api',defaultBranch:'main'},{id:2,fullName:'acme/web',defaultBranch:'main'}]});
 const repos=Object.fromEntries((await t.query(api.repositories.list,{token:admin.token,organizationId})).map(r=>[r.fullName,r._id])) as Record<string,Id<'repositories'>>;
 const team=await t.mutation(api.scopes.createTeam,{token:admin.token,organizationId,name:'API'});
 await t.mutation(api.scopes.assign,{token:admin.token,repositoryId:repos['acme/api'],teamId:team});
 const rule=(title:string,enabled=true)=>t.mutation(api.dashboard.rules,{token:admin.token,organizationId,title,instructions:title+' instructions.',category:'rules',severity:'medium',globs:[],enabled});
 await rule('Keep cents');await rule('Old logging rule',false);
 const [cents]=(await t.query(api.dashboard.rulesPage,{token:admin.token,organizationId,search:'cents'})).page;
 const now=Date.now(),lastYear=now-400*864e5;
 await t.run(async ctx=>{
  for(const [repo,at,status,lastFeedback] of [['acme/api',now,'resolved','useful'],['acme/api',now-1,'resolved','not_useful'],['acme/api',lastYear,'open',undefined],['acme/web',now-2,'resolved','false_positive']] as const){
   const reviewId=await ctx.db.insert('reviews',{organizationId,repositoryId:repos[repo],prNumber:3,headSha:'a'.repeat(40),status:'completed',mode:'standard',attempts:1,createdAt:at,updatedAt:at});
   await ctx.db.insert('findings',{organizationId,repositoryId:repos[repo],reviewId,prNumber:3,title:'Cited '+at,description:'d',severity:'high',confidence:0.9,category:'rules',filePath:'a.ts',startLine:1,endLine:1,commitSha:'a'.repeat(40),evidence:[],impact:'i',suggestedFix:'f',symbol:'s',fingerprint:'fp'+at,agent:'rules',ruleId:cents._id,status,...(lastFeedback?{lastFeedback}:{}),createdAt:at,updatedAt:at});
  }
 });
 const all=await t.query(api.dashboard.rulesPage,{token:admin.token,organizationId,search:'CENTS'});
 expect(all.page.map(r=>r.title)).toEqual(['Keep cents']);
 expect(all.page[0].stats).toEqual({uses:4,capped:false,addressed:3,usesThisMonth:3,useful:1,notUseful:2});
 // Scoped to the API team, the acme/web finding is not counted.
 expect((await t.query(api.dashboard.rulesPage,{token:admin.token,organizationId,teamId:team,search:'cents'})).page[0].stats).toMatchObject({uses:3,addressed:2,notUseful:1});
 expect((await t.query(api.dashboard.rulesPage,{token:admin.token,organizationId,status:'disabled'})).page.map(r=>r.title)).toEqual(['Old logging rule']);
 const usage=await t.query(api.dashboard.ruleUsage,{token:admin.token,organizationId,ruleId:cents._id});
 expect(usage.map(u=>u.createdAt)).toEqual([now,now-1,now-2,lastYear]);
 expect(await t.query(api.dashboard.ruleUsage,{token:admin.token,organizationId,teamId:team,ruleId:cents._id})).toHaveLength(3);
 await expect(t.query(api.dashboard.ruleUsage,{token:outsider.token,organizationId,ruleId:cents._id})).rejects.toThrow();
 expect(await t.query(api.dashboard.ruleUsage,{token:outsider.token,organizationId:otherOrg,ruleId:cents._id})).toEqual([]);
});
