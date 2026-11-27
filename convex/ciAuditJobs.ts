"use node";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { Github } from "../src/github";
import { auditActions } from "../src/ci-audit";
import { redact } from "../src/redact";

// Runs one CI audit (convex/ciAudits.ts) with the repository's GitHub App installation token. Read-only:
// Actions runs, jobs and workflow files. Up to 600 runs get their jobs read; the rest are estimated.
export const run = internalAction({
  args: { auditId: v.id("ciAudits") },
  handler: async (ctx, a) => {
    const job = await ctx.runQuery(internal.ciAudits.job, { auditId: a.auditId });
    if (!job || job.audit.status !== "queued") return;
    await ctx.runMutation(internal.ciAudits.progress, { auditId: a.auditId, status: "running" });
    try {
      if (!job.repo.installationId || job.repo.connectionId) throw new Error("CI audits need a repository connected through the GitHub App");
      const github = await Github.installation(job.repo.installationId);
      if (!github.canReadActions) throw new Error("The GitHub App needs the Actions: Read permission on this installation. An admin of the GitHub account can accept it in the installation's settings on GitHub.");
      const history = await github.actionsHistory(job.repo.fullName, { days: 30, maxWait: 0, deadline: Date.now() + 8 * 60000 });
      await ctx.runMutation(internal.ciAudits.progress, { auditId: a.auditId, status: "done", report: JSON.stringify(auditActions(history)) });
    } catch (error) {
      await ctx.runMutation(internal.ciAudits.progress, { auditId: a.auditId, status: "failed", error: redact(error instanceof Error ? error.message : String(error)) });
    }
  },
});
