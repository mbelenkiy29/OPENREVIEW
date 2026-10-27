"use node";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { provider } from "./scm";
import { Github } from "../src/github";
import { openFix, prepareFix } from "./fixPreparation";

// Autofix: the same validated, single-range fix pull request as "Open a fix PR", opened for the pull
// request's author once its review completes (convex/autofix.ts picks the findings).
export const run = internalAction({
  args: { reviewId: v.id("reviews") },
  handler: async (ctx, a): Promise<string[]> => {
    const target = await ctx.runQuery(internal.autofix.targets, a);
    if (!target?.findings.length) return [];
    const { repo, prNumber, findings } = target;
    const github = await provider(ctx, repo);
    if (!(github instanceof Github) || !github.openFixPullRequest || github.permissions?.contents !== "write") return [];
    const pr = await github.pullRequest(repo.fullName, prNumber);
    if (pr.head.sha !== target.headSha) return [];
    const tree = new Map((await github.tree(repo.fullName, pr.head.sha)).map((f) => [f.path, f]));
    const opened: string[] = [];
    for (const finding of findings) {
      const prepared = await prepareFix(ctx, { github, repo, pr, tree, target: finding });
      let result: { url?: string; note?: string };
      try {
        const fix = await openFix({ github, repo, pr, target: finding, prepared, author: pr.user.login, prNumber, requestedIn: "Autofix", automatic: true });
        result = fix.pullRequest ? { url: fix.pullRequest.url } : { note: fix.note ?? prepared.problem };
      } catch (error) {
        // The author lost write access, or GitHub refused the branch: skip this finding, keep the others.
        result = { note: error instanceof Error ? error.message : "Fix pull request failed" };
      }
      await ctx.runMutation(internal.autofix.record, { findingId: finding._id, ...result });
      if (result.url) opened.push(result.url);
    }
    return opened;
  },
});
