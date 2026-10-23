"use node";
import { action, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { provider } from "./scm";
import { Github } from "../src/github";

// Live provider reads for the dashboard's pull request page (GitHub and GitHub Enterprise), never stored.
type Checks = Awaited<ReturnType<Github["checks"]>>;
type Discussion = Awaited<ReturnType<Github["discussion"]>>;
async function github(ctx: ActionCtx, token: string, pullRequestId: Id<"pullRequests">): Promise<{ scm: Github; repo: Doc<"repositories">; pr: Doc<"pullRequests"> } | null> {
  const { repo, pr }: { repo: Doc<"repositories">; pr: Doc<"pullRequests"> } = await ctx.runQuery(internal.pulls.readTarget, { token, pullRequestId });
  const scm = await provider(ctx, repo);
  return scm instanceof Github ? { scm, repo, pr } : null;
}
export const checks = action({ args: { token: v.string(), pullRequestId: v.id("pullRequests") }, handler: async (ctx, a): Promise<Checks | null> => {
  const target = await github(ctx, a.token, a.pullRequestId);
  return target && /^[a-f0-9]{40}$/.test(target.pr.headSha) ? target.scm.checks(target.repo.fullName, target.pr.headSha) : null;
} });
export const discussion = action({ args: { token: v.string(), pullRequestId: v.id("pullRequests") }, handler: async (ctx, a): Promise<Discussion | null> => {
  const target = await github(ctx, a.token, a.pullRequestId);
  return target ? target.scm.discussion(target.repo.fullName, target.pr.number) : null;
} });
