import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

// Issue lifecycle rules, shared by reviews.save, finding feedback, pull request lifecycle and data
// retention. An issue groups a repository's findings with the same fingerprint across pull requests;
// latestFindingId is its most recent occurrence.
export const issueStatuses = ["open", "in_progress", "resolved", "wont_fix", "false_positive"] as const;
export const activeIssue = (status: string) => status === "open" || status === "in_progress";

export async function issueEvent(ctx: MutationCtx, issue: Pick<Doc<"issues">, "_id" | "organizationId">, kind: string, detail: string, actorId?: Id<"users">) {
  await ctx.db.insert("issueEvents", { organizationId: issue.organizationId, issueId: issue._id, kind, detail: detail.slice(0, 5000), ...(actorId ? { actorId } : {}), createdAt: Date.now() });
}

/** Links a stored finding to its issue, creating the issue on first sight. A resolved issue reopens
 *  when the problem is reported again; won't-fix and false-positive decisions stand. */
export async function trackFinding(ctx: MutationCtx, finding: Doc<"findings">, newToPullRequest: boolean, at = Date.now()) {
  const existing = finding.issueId ? await ctx.db.get(finding.issueId)
    : await ctx.db.query("issues").withIndex("by_repo_fingerprint", (q) => q.eq("repositoryId", finding.repositoryId).eq("fingerprint", finding.fingerprint)).unique();
  const facts = { title: finding.title, severity: finding.severity, category: finding.category, latestFindingId: finding._id, lastSeenAt: at, updatedAt: at };
  if (!existing) {
    const number = (await ctx.db.get(finding.organizationId))?.nextIssueNumber ?? 1;
    await ctx.db.patch(finding.organizationId, { nextIssueNumber: number + 1 });
    const issueId = await ctx.db.insert("issues", { organizationId: finding.organizationId, repositoryId: finding.repositoryId, number, fingerprint: finding.fingerprint, status: "open", firstSeenAt: at, ...facts });
    await ctx.db.patch(finding._id, { issueId });
    await issueEvent(ctx, { _id: issueId, organizationId: finding.organizationId }, "created", `Found in PR #${finding.prNumber}`);
    return;
  }
  if (!finding.issueId) await ctx.db.patch(finding._id, { issueId: existing._id });
  const reopen = existing.status === "resolved";
  await ctx.db.patch(existing._id, { ...facts, ...(reopen ? { status: "open" } : {}) });
  if (reopen) await issueEvent(ctx, existing, "reopened", `Reported again in PR #${finding.prNumber}`);
  else if (newToPullRequest) await issueEvent(ctx, existing, "seen", `Also found in PR #${finding.prNumber}`);
}

/** A later commit fixed the issue's latest occurrence. */
export async function findingResolved(ctx: MutationCtx, finding: Doc<"findings">, headSha: string) {
  const issue = finding.issueId ? await ctx.db.get(finding.issueId) : null;
  if (!issue || issue.latestFindingId !== finding._id || !activeIssue(issue.status)) return;
  await ctx.db.patch(issue._id, { status: "resolved", updatedAt: Date.now() });
  await issueEvent(ctx, issue, "resolved_by_commit", `Fixed in PR #${finding.prNumber} at ${headSha.slice(0, 8)}`);
}

/** Feedback changed a finding's status (dashboard, provider reactions, API, MCP). The issue follows
 *  once no other occurrence is still open; feedback that reopens a finding reopens the issue. */
export async function syncIssueStatus(ctx: MutationCtx, finding: Doc<"findings">, status: string, actorId?: Id<"users">) {
  const issue = finding.issueId ? await ctx.db.get(finding.issueId) : null;
  if (!issue || issue.status === status) return;
  if (status === "open") {
    if (activeIssue(issue.status)) return;
    await ctx.db.patch(issue._id, { status: "open", updatedAt: Date.now() });
    return issueEvent(ctx, issue, "reopened", `Reopened by feedback on PR #${finding.prNumber}`, actorId);
  }
  const occurrences = await ctx.db.query("findings").withIndex("by_issue", (q) => q.eq("issueId", issue._id)).take(200);
  if (occurrences.some((f) => f._id !== finding._id && f.status === "open")) return;
  await ctx.db.patch(issue._id, { status, updatedAt: Date.now() });
  await issueEvent(ctx, issue, "status", `Marked ${status.replaceAll("_", " ")} from PR #${finding.prNumber}`, actorId);
}

/** A closed pull request resolves the open issues it was the latest occurrence of; a merged one keeps
 *  them open and marks them merged, since the problem is now in the target branch. */
export async function pullRequestClosed(ctx: MutationCtx, repositoryId: Id<"repositories">, prNumber: number, merged: boolean) {
  for (const finding of await ctx.db.query("findings").withIndex("by_pr", (q) => q.eq("repositoryId", repositoryId).eq("prNumber", prNumber)).take(500)) {
    const issue = finding.issueId ? await ctx.db.get(finding.issueId) : null;
    if (!issue || issue.latestFindingId !== finding._id || !activeIssue(issue.status)) continue;
    if (merged) {
      if (issue.mergedAt) continue;
      await ctx.db.patch(issue._id, { mergedAt: Date.now(), updatedAt: Date.now() });
      await issueEvent(ctx, issue, "pr_merged", `PR #${prNumber} merged while this issue was open`);
    } else {
      await ctx.db.patch(issue._id, { status: "resolved", updatedAt: Date.now() });
      await issueEvent(ctx, issue, "pr_closed", `PR #${prNumber} closed without merging`);
    }
  }
}

/** A fix pull request was opened for an occurrence, from the dashboard or by Autofix. */
export async function fixPullRequestOpened(ctx: MutationCtx, finding: Doc<"findings"> | null, url: string, automatic: boolean) {
  const issue = finding?.issueId ? await ctx.db.get(finding.issueId) : null;
  if (!issue || issue.fixPullRequestUrl === url) return;
  await ctx.db.patch(issue._id, { fixPullRequestUrl: url, updatedAt: Date.now() });
  await issueEvent(ctx, issue, "fix_pr", `${automatic ? "Autofix opened" : "Opened"} a fix pull request: ${url}`);
}

/** Retention removed a finding: an issue left without occurrences goes too, with its events. */
export async function findingRemoved(ctx: MutationCtx, finding: Doc<"findings">) {
  const issue = finding.issueId ? await ctx.db.get(finding.issueId) : null;
  if (!issue) return;
  const remaining = (await ctx.db.query("findings").withIndex("by_issue", (q) => q.eq("issueId", issue._id)).take(200)).filter((f) => f._id !== finding._id);
  if (remaining.length) {
    if (issue.latestFindingId === finding._id) await ctx.db.patch(issue._id, { latestFindingId: remaining.reduce((a, b) => (b._creationTime > a._creationTime ? b : a))._id });
    return;
  }
  for (const e of await ctx.db.query("issueEvents").withIndex("by_issue", (q) => q.eq("issueId", issue._id)).take(1000)) await ctx.db.delete(e._id);
  await ctx.db.delete(issue._id);
}
