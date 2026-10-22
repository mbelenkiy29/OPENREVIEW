import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import {indexWriteAllowed} from "./indexAuthority";
import {maxWebhookAttempts} from "./webhooks";
// Expired model answers are up to 200 KB each, so they are deleted in their own small batches: a big
// backlog never pushes the recovery sweep past a transaction's read limit.
export const sweepCache = internalMutation({
  args: {},
  handler: async (ctx) => {
    const expired = await ctx.db.query("modelCache").withIndex("by_expiry", (q) => q.lt("expiresAt", Date.now())).take(25);
    for (const cached of expired) await ctx.db.delete(cached._id);
    if (expired.length === 25) await ctx.scheduler.runAfter(0, internal.recovery.sweepCache, {});
  },
});
// Each heavy part runs in its own transaction, so one part's backlog (big index jobs, big reviews) can never push
// the others past a transaction's read limit and stop all recovery.
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const part of [internal.recovery.sweepCache, internal.recovery.sweepIndexJobs, internal.recovery.sweepReviews]) await ctx.scheduler.runAfter(0, part, {});
    const stale = Date.now() - 15 * 60000;
    // Native conversation recovery runs in its own transaction so a large P4 backlog never stalls every tenant's sweep.
    await ctx.scheduler.runAfter(0, internal.p4Conversations.recover, {});
    for (const knowledgeStatus of ["queued", "generating"]) for (const repo of await ctx.db.query("repositories").withIndex("by_knowledge_status", (q) => q.eq("knowledgeStatus", knowledgeStatus)).take(100))
      if (
        repo.indexStatus === "ready" &&
        (repo.knowledgeUpdatedAt ?? 0) < stale
      ) {
        if ((repo.knowledgeAttempt ?? 1) >= 3)
          await ctx.db.patch(repo._id, {
            knowledgeStatus: "failed",
            knowledgeError: "Knowledge recovery exhausted",
          });
        else
          await ctx.scheduler.runAfter(0, internal.knowledgeJobs.generate, {
            repositoryId: repo._id,
            paths: repo.knowledgePaths ?? [],
            attempt: (repo.knowledgeAttempt ?? 1) + 1,
          });
      }
    for (const conversation of await ctx.db
      .query("conversations")
      .withIndex("by_status", (q) => q.eq("status", "answering"))
      .take(100)) {
      if(conversation.nativeP4)continue;
      if ((conversation.updatedAt ?? conversation.createdAt) >= stale) continue;
      if ((conversation.attempts ?? 1) >= 3) {
        await ctx.db.patch(conversation._id, {
          status: "failed",
          error: "Reply recovery exhausted",
          updatedAt: Date.now(),
        });
        continue;
      }
      await ctx.scheduler.runAfter(0, internal.conversationJobs.reply, {
        repositoryId: conversation.repositoryId,
        prNumber: conversation.prNumber,
        commentId: conversation.githubCommentId,
        author: conversation.author,
        question: conversation.question,
        inline: conversation.inline ?? false,
        parentCommentId: conversation.parentCommentId,
      });
    }
    // A delivery whose action died is picked up again: stuck "processing", or "queued" and never started.
    for (const status of ["processing", "queued"]) for (const delivery of await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_status", (q) => q.eq("status", status))
      .take(100))
      if (delivery.updatedAt >= stale) continue;
      // An old event replayed later can undo newer state, so only deliveries from the last 6 hours restart; older
      // ones are closed as failed, which also keeps them from filling this 100-row window.
      else if (delivery.createdAt < Date.now() - 6 * 3600000) await ctx.db.patch(delivery._id, { status: "failed", error: "Too old to replay", updatedAt: Date.now() });
      else if (delivery.attempts < maxWebhookAttempts) await ctx.scheduler.runAfter(0, internal.webhookJobs.process, { deliveryId: delivery._id });
      else await ctx.db.patch(delivery._id, { status: "failed", error: "Webhook recovery attempts exhausted", updatedAt: Date.now() });
    // Non-GitHub provider events get the same recovery: their action can die before marking the event too.
    for (const status of ["processing", "queued"]) for (const event of await ctx.db
      .query("providerEvents")
      .withIndex("by_status", (q) => q.eq("status", status))
      .take(100))
      if ((event.updatedAt ?? event.createdAt) >= stale) continue;
      else if (event.createdAt < Date.now() - 6 * 3600000) await ctx.db.patch(event._id, { status: "failed", error: "Too old to replay", updatedAt: Date.now() });
      else if (event.attempts < maxWebhookAttempts) await ctx.scheduler.runAfter(0, internal.providerJobs.event, { id: event._id });
      else await ctx.db.patch(event._id, { status: "failed", error: "Provider event recovery attempts exhausted", updatedAt: Date.now() });
  },
});
export const sweepIndexJobs = internalMutation({
  args: {},
  handler: async (ctx) => {
    const stale = Date.now() - 15 * 60000;
    for (const job of await ctx.db
      .query("indexJobs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .take(100)) {
      const repo=await ctx.db.get(job.repositoryId);
      if(!await indexWriteAllowed(ctx,repo,job)){await ctx.db.patch(job._id,{status:"cancelled",error:"Indexing authorization was revoked",updatedAt:Date.now()});if(repo&&["queued","indexing"].includes(repo.indexStatus))await ctx.db.patch(repo._id,{indexStatus:"cancelled",error:"Indexing authorization was revoked"});continue;}
      if (job.updatedAt >= stale) continue;
      if (job.attempts >= 3) {
        await ctx.db.patch(job._id, {
          status: "failed",
          error: "Index recovery attempts exhausted",
          updatedAt: Date.now(),
        });
        await ctx.db.patch(job.repositoryId, {
          indexStatus: "failed",
          error: "Index recovery attempts exhausted",
        });
        continue;
      }
      await ctx.db.patch(job._id, {
        attempts: job.attempts + 1,
        updatedAt: Date.now(),
      });
      if (job.manifestStorageId)
        await ctx.scheduler.runAfter(0, internal.jobs.indexBatch, {
          jobId: job._id,
        });
      else {
        await ctx.db.patch(job._id, { status: "failed" });
        await ctx.scheduler.runAfter(0, internal.jobs.index, {
          repositoryId: job.repositoryId,
        });
      }
    }
  },
});
export const sweepReviews = internalMutation({
  args: {},
  handler: async (ctx) => {
    const stale = Date.now() - 15 * 60000;
    for (const stage of [
      "queued",
      "waiting_agent",
      "ingesting",
      "retrieving_context",
      "reviewing",
      "verifying",
      "summarizing",
      "publishing",
    ]) {
      for (const review of await ctx.db
        .query("reviews")
        .withIndex("by_status", (q) => q.eq("status", stage))
        .take(100))
        if (review.updatedAt < stale) {
          if((review.nativeP4?.lease?.expiresAt??0)>Date.now())continue;
          if(review.retryScheduledId){
            const retry=await ctx.db.system.get(review.retryScheduledId);
            if(retry&&["pending","inProgress"].includes(retry.state.kind))continue;
          }
          if (review.attempts >= 3)
            await ctx.db.patch(review._id, {
              status: "failed",
              error: "Review recovery attempts exhausted",
              updatedAt: Date.now(),
              finishedAt: Date.now(),
              retryScheduledId: undefined,
              retryAt: undefined,
            });
          else {
            await ctx.db.patch(review._id, {
              status: "queued",
              // A run stuck in "queued" died before ingesting (which counts attempts itself), so count it here.
              ...(stage === "queued" ? { attempts: review.attempts + 1 } : {}),
              updatedAt: Date.now(),
              finishedAt: undefined,
              retryScheduledId: undefined,
              retryAt: undefined,
            });
            await ctx.scheduler.runAfter(0, internal.jobs.review, {
              reviewId: review._id,
            });
          }
        }
    }
  },
});
