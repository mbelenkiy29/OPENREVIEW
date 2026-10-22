import {test,expect} from 'vitest';
import {convexTest} from 'convex-test';
import schema from '../convex/schema';
import {internal} from '../convex/_generated/api';
import type {Id} from '../convex/_generated/dataModel';
import type {ActionCtx} from '../convex/_generated/server';
import {reviewAgentHooks} from '../convex/agentToolbox';
import {maxAgentResumes,type AgentState} from '../src/engine/agent';
const modules=import.meta.glob('../convex/**/*.ts');

test('a review whose saved agent state cannot be loaded is failed after maxAgentResumes suspensions instead of restarting forever',async()=>{
 const t=convexTest(schema,modules);
 const head='h'.repeat(40);
 const reviewId=await t.run(async ctx=>{
  const organizationId=await ctx.db.insert('organizations',{name:'o',createdAt:Date.now()});
  const repositoryId=await ctx.db.insert('repositories',{organizationId,fullName:'o/app',defaultBranch:'main',enabled:true,indexStatus:'ready',createdAt:Date.now()} as never);
  return ctx.db.insert('reviews',{organizationId,repositoryId,prNumber:1,headSha:head,status:'reviewing',mode:'deep',attempts:1,createdAt:Date.now(),updatedAt:Date.now()} as never) as Promise<Id<'reviews'>>;
 });
 // Only the parts of an action context the hooks use.
 const ctx={runQuery:t.query,storage:{get:async(id:Id<'_storage'>)=>{const text=await t.run(async c=>(await c.storage.get(id))?.text()??null);return text===null?null:new Blob([text]);}}} as unknown as ActionCtx;
 const hooks=reviewAgentHooks(ctx,reviewId,Date.now());
 // Stands in for a state over the 8MB load limit: present, but never loadable.
 const broken=async()=>{const storageId=await t.run(c=>c.storage.store(new Blob(['{"version":1}'])));expect(await t.mutation(internal.reviews.saveAgentState,{reviewId,storageId,headSha:head})).toBe(true);};
 for(let step=1;step<=maxAgentResumes;step++){
  expect(await hooks.load!()).toBeNull();
  await broken();
  expect(await t.mutation(internal.reviews.suspendAgent,{reviewId})).toBe(true);
  expect(await t.mutation(internal.reviews.stage,{reviewId,status:'ingesting'})).toBe(true);
  await t.run(c=>c.db.patch(reviewId,{status:'reviewing'}));
 }
 expect(await t.run(c=>c.db.get(reviewId))).toMatchObject({agentResumes:maxAgentResumes,attempts:1});
 // The next step fails with a clear error instead of starting a fresh budget, and suspending again is refused.
 await expect(hooks.load!()).rejects.toThrow(/could not be restored after 6 resumes/);
 expect(await t.mutation(internal.reviews.suspendAgent,{reviewId})).toBe(false);
 // A loadable state carries the row's count, so the engine's own resume limit stops it gracefully.
 const valid:AgentState={version:1,headSha:head,messages:[],reported:[],sources:[],toolCalls:0,tokens:0,elapsedMs:0,turns:0,resumes:0,done:false};
 const storageId=await t.run(c=>c.storage.store(new Blob([JSON.stringify(valid)])));
 await t.mutation(internal.reviews.saveAgentState,{reviewId,storageId,headSha:head});
 expect((await hooks.load!())?.resumes).toBe(maxAgentResumes);
});
