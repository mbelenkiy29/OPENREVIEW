"use node";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { z } from "zod";
import { provider } from "./scm";
import { Github } from "../src/github";
import { budgetModel } from "./budgetModel";
import { reviewToolbox } from "./agentToolbox";
import { publishable } from "./fixPreparation";
import { runFixAgent } from "../src/engine/fix-agent";
import { findingSchema, type ModelProvider } from "../src/engine/types";
import { fixPrompt } from "../src/fix-prompt";
import { fixBranchName } from "../src/fix-command";
import { redact } from "../src/redact";
import type { Doc } from "./_generated/dataModel";

// OpenReview's fix agent for one finding, scheduled by fixPullRequests.start (dashboard) or startFromComment
// ("@openreview fix this in a new PR"). It edits the code at the reviewed head and opens a pull request from a
// new openreview/fix-* branch into the pull request's branch; that branch itself is never written.
export const run = internalAction({
  args: {
    findingId: v.id("findings"),
    // Dashboard runs: the fixRequests row the Fix page polls, and the requester's linked GitHub account.
    requestId: v.optional(v.id("fixRequests")), userId: v.optional(v.id("users")), githubId: v.optional(v.number()),
    // Comment runs: the comment author and the thread to answer.
    author: v.optional(v.string()), replyTo: v.optional(v.object({ prNumber: v.number(), commentId: v.optional(v.union(v.number(), v.string())) })),
  },
  handler: async (ctx, a) => {
    const finding = (await ctx.runQuery(internal.fixPullRequests.finding, { findingId: a.findingId })) as Doc<"findings"> | null;
    if (!finding) throw new Error("Finding not found");
    const { repo } = await ctx.runQuery(internal.repositories.data, { repositoryId: finding.repositoryId });
    let github: Github | undefined, usedModel = false;
    const done = async (result: { url?: string; reused?: boolean; note?: string }) => {
      if (!usedModel) await ctx.runMutation(internal.fixPullRequests.release, { organizationId: repo.organizationId });
      if (a.requestId) await ctx.runMutation(internal.fixPullRequests.progress, result.url ? { requestId: a.requestId, status: "opened", pullRequestUrl: result.url } : { requestId: a.requestId, status: "failed", error: result.note ?? "The fix did not finish" });
      await ctx.runMutation(internal.fixPullRequests.recordResult, { organizationId: repo.organizationId, userId: a.userId, findingId: a.findingId, opened: Boolean(result.url), detail: result.url ?? result.note ?? "" });
      if (a.replyTo && github) {
        const body = result.url ? `${result.reused ? "A fix pull request already exists" : "Opened a fix pull request"} for **${finding.title.replace(/[\r\n]+/g, " ").slice(0, 200)}**: ${result.url}. It targets this pull request's branch; nothing was pushed to this branch. No tests were run by OpenReview, so review it before merging.` : (result.note ?? "The fix did not finish.");
        await github.reply(repo.fullName, a.replyTo.prNumber, body, a.replyTo.commentId, `fix-pull-request:${a.findingId}:${a.replyTo.commentId ?? "pr"}`);
      }
    };
    const attempt = async (): Promise<{ url?: string; reused?: boolean; note?: string }> => {
      const scm = await provider(ctx, repo);
      if (!(scm instanceof Github) || !scm.openFixPullRequest) return { note: "Fix pull requests are not available for this provider." };
      github = scm;
      if (github.permissions && repo.installationId !== undefined) await ctx.runMutation(internal.fixPullRequests.recordPermissions, { installationId: repo.installationId, permissions: github.permissions });
      if (github.permissions?.contents !== "write") return { note: "The GitHub App does not have Contents: Read and write permission. An owner of the GitHub account must grant it (GitHub → Settings → Applications → Installed GitHub Apps → Review request)." };
      // The pull request is opened for the requester's GitHub account, which must still have write access.
      const login = a.author ?? (a.githubId ? (await github.request(`/user/${a.githubId}`, z.object({ login: z.string().min(1) }))).login : undefined);
      if (!login || !github.canReply || !await github.canReply(repo.fullName, login)) return { note: `${login ? `Your GitHub account (@${login})` : "Your GitHub account"} needs write access to ${repo.fullName} to open a fix pull request.` };
      const pr = await github.pullRequest(repo.fullName, finding.prNumber);
      if (pr.head.sha !== finding.commitSha) return { note: "The pull request changed after this review; ask for a fix from the new review." };
      if (a.requestId) await ctx.runMutation(internal.fixPullRequests.progress, { requestId: a.requestId, status: "running" });
      const tree = new Map((await github.tree(repo.fullName, pr.head.sha)).map((f) => [f.path, f]));
      const tools = reviewToolbox(ctx, repo, pr.head.sha, tree, (repository, path, sha) => github!.blob(repository, path, sha), []);
      const opening = fixPrompt(repo.fullName, `PR #${finding.prNumber}`, [{ ...findingSchema.parse(finding), fingerprint: finding.fingerprint, agent: finding.agent, commitSha: finding.commitSha }]);
      const base = await budgetModel(ctx, repo.organizationId);
      // The agent fix stays spent once a model turn has run; earlier failures give it back (done).
      const model: ModelProvider = { generate: (request, schema) => base.generate(request, schema), runTools: async (request) => { const turn = await base.runTools!(request); usedModel = true; return turn; } };
      const fix = await runFixAgent({ model, tools, opening });
      const spent = fix.usage.reduce((sum, u) => ({ inputTokens: sum.inputTokens + u.inputTokens, outputTokens: sum.outputTokens + u.outputTokens, estimatedCost: sum.estimatedCost + u.estimatedCost, durationMs: sum.durationMs + u.latencyMs }), { inputTokens: 0, outputTokens: 0, estimatedCost: 0, durationMs: 0 });
      await ctx.runMutation(internal.usage.record, { repositoryId: repo._id, kind: "fix", ...spent });
      const summary = publishable(fix.summary);
      if (!fix.finished) return { note: `OpenReview's fix agent stopped early (${fix.stopReason}), so no fix pull request was opened.` };
      if (!fix.edits.length) return { note: `OpenReview's fix agent made no changes${summary ? `: ${summary}` : "."}` };
      const title = finding.title.replace(/[\r\n]+/g, " ");
      const opened = await github.openFixPullRequest(repo.fullName, finding.prNumber, {
        branch: fixBranchName(finding.prNumber, finding.fingerprint), expectedHead: pr.head.sha,
        files: fix.edits.map((e) => ({ ...e, mode: tree.get(e.path)?.mode ?? "100644" })),
        title: ("OpenReview fix: " + title).slice(0, 120),
        body: `Requested by @${login} for the finding in \`${finding.filePath}:${finding.startLine}\`. OpenReview's fix agent changed:\n\n${fix.edits.map((e) => `- \`${e.path}\``).join("\n")}\n\n${summary ?? ""}\n\nThis pull request targets the branch of #${finding.prNumber}. No tests were run by OpenReview; review the change before merging.`.replace(/\n{3,}/g, "\n\n"),
        message: ("Fix: " + title).slice(0, 200),
      });
      return "skipped" in opened ? { note: `No fix pull request was opened: ${opened.skipped}.` } : { url: opened.url, reused: opened.reused };
    };
    await done(await attempt().catch((error) => ({ note: "The fix failed: " + redact(error instanceof Error ? error.message.replace(/^Billing: /, "") : "unknown error").slice(0, 300) })));
  },
});
