import {beforeEach,expect,test} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import schema from '../convex/schema';
import {api} from '../convex/_generated/api';
import type {Id} from '../convex/_generated/dataModel';
const modules=import.meta.glob('../convex/**/*.ts');
const secret='integration-session-secret-at-least-32-characters';
beforeEach(()=>{Object.assign(process.env,{SESSION_SECRET:secret,SERVICE_SECRET:'integration-service-secret'});});

test('reviewed marks stop at 2,000 rows per developer and pull request; existing rows still toggle and older-head rows are reused',async()=>{
 const t=convexTest(schema,modules);
 const id=await t.mutation(api.users.login,{secret:'integration-service-secret',githubId:91,login:'alice',avatar:''}) as Id<'users'>;
 const token=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(id).setExpirationTime('1h').sign(new TextEncoder().encode(secret));
 const org=await t.mutation(api.users.createOrganization,{token,name:'Acme'});
 await t.mutation(api.repositories.connect,{token,secret:'integration-service-secret',organizationId:org,installationId:91,account:'acme',accountId:1,repositories:[{id:9101,fullName:'acme/shop',defaultBranch:'main'}]});
 const [repo]=await t.query(api.repositories.list,{token,organizationId:org});
 const review=(headSha:string)=>t.run(ctx=>ctx.db.insert('reviews',{organizationId:org,repositoryId:repo._id,prNumber:1,headSha,status:'completed',mode:'standard',attempts:1,createdAt:0,updatedAt:0}));
 const old=await review('a'.repeat(40)),reviewId=await review('b'.repeat(40));
 await t.run(async ctx=>{for(let i=0;i<2000;i++)await ctx.db.insert('fileReviews',{organizationId:org,userId:id,repositoryId:repo._id,prNumber:1,path:`f${i}.ts`,headSha:'b'.repeat(40),updatedAt:0});});
 const count=()=>t.run(async ctx=>(await ctx.db.query('fileReviews').collect()).length);
 await expect(t.mutation(api.fileReviews.mark,{token,reviewId,path:'new.ts',reviewed:true})).rejects.toThrow('Too many files');
 await t.mutation(api.fileReviews.mark,{token,reviewId,path:'f5.ts',reviewed:true});
 expect(await count()).toBe(2000);
 await t.mutation(api.fileReviews.mark,{token,reviewId,path:'f5.ts',reviewed:false});
 await t.mutation(api.fileReviews.mark,{token,reviewId,path:'new.ts',reviewed:true});
 expect(await count()).toBe(2000);
 // At the cap, a row last marked on an older head is recycled rather than refusing the new path.
 await t.mutation(api.fileReviews.mark,{token,reviewId:old,path:'f6.ts',reviewed:true});
 await t.mutation(api.fileReviews.mark,{token,reviewId,path:'later.ts',reviewed:true});
 expect(await count()).toBe(2000);
 const paths=await t.query(api.fileReviews.list,{token,reviewId});
 expect(paths).toContain('later.ts');
 expect(paths).not.toContain('f6.ts');
});
