"use node";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { z } from "zod";
import { provider } from "./scm";
import { Github } from "../src/github";
import { openFix, prepareFix } from "./fixPreparation";
import type { Doc } from "./_generated/dataModel";

// The dashboard's "Open a fix PR": checks run in fixPullRequests.authorizeOpen, then the same
// validated suggestion and fix pull request as "@openreview fix this in a new PR".
export const open = action({
  args: { token: v.string(), findingId: v.id("findings") },
  handler: async (ctx, a): Promise<{ url?: string; reused?: boolean; note?: string }> => {
    const auth = await ctx.runMutation(internal.fixPullRequests.authorizeOpen, a);
    const done = async (result: { url?: string; reused?: boolean; note?: string }) => {
      await ctx.runMutation(internal.fixPullRequests.recordResult, { organizationId: auth.organizationId, userId: auth.userId, findingId: a.findingId, opened: Boolean(result.url), detail: result.url ?? result.note ?? "" });
      if (result.url) await ctx.runMutation(internal.issues.recordFixPullRequest, { findingId: a.findingId, url: result.url, automatic: false });
      return result;
    };
    const { repo } = await ctx.runQuery(internal.repositories.data, { repositoryId: auth.repositoryId });
    const finding = (await ctx.runQuery(internal.fixPullRequests.finding, { findingId: a.findingId })) as Doc<"findings"> | null;
    if (!finding) throw new Error("Finding not found");
    const github = await provider(ctx, repo);
    if (!(github instanceof Github) || !github.openFixPullRequest) return done({ note: "Fix pull requests are not available for this provider." });
    if (github.permissions && repo.installationId !== undefined) await ctx.runMutation(internal.fixPullRequests.recordPermissions, { installationId: repo.installationId, permissions: github.permissions });
    if (github.permissions?.contents !== "write") return done({ note: "The GitHub App does not have Contents: Read and write permission. An owner of the GitHub account must grant it (GitHub → Settings → Applications → Installed GitHub Apps → Review request)." });
    // The pull request is opened for the signed-in user's GitHub account, which must still have write access.
    const login = (await github.request(`/user/${auth.githubId}`, z.object({ login: z.string().min(1) }))).login;
    const pr = await github.pullRequest(repo.fullName, finding.prNumber);
    if (pr.head.sha !== finding.commitSha) return done({ note: "The pull request changed after this review; open a fix pull request from the new review." });
    const tree = new Map((await github.tree(repo.fullName, pr.head.sha)).map((f) => [f.path, f]));
    const prepared = await prepareFix(ctx, { github, repo, pr, tree, target: finding });
    if (!prepared.suggestion) return done({ note: `No fix pull request was opened: ${prepared.problem ?? "no validated suggestion is available"}.` });
    try {
      const opened = await openFix({ github, repo, pr, target: finding, prepared, author: login, prNumber: finding.prNumber, requestedIn: "the OpenReview dashboard" });
      return done(opened.pullRequest ? { url: opened.pullRequest.url, reused: opened.pullRequest.reused } : { note: opened.note });
    } catch (error) {
      if (error instanceof Error && /write access revoked/.test(error.message)) return done({ note: `Your GitHub account (@${login}) needs write access to ${repo.fullName} to open a fix pull request.` });
      throw error;
    }
  },
});
