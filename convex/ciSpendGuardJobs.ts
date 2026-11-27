"use node";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { Github } from "../src/github";
import { auditActions } from "../src/ci-audit";
import { ciCostEnabled } from "../src/ci-audit-github";
import { budgetStep, criticalProblems, guardMessages, monthToDate, type RepositorySpend } from "../src/ci-spend-guard";
import { sendEmail } from "../src/email";
import { escapeSlack } from "../src/slack";
import { redact } from "../src/redact";
import { deliver, slackClient } from "./notificationJobs";

// The daily spend-guard check (convex/crons.ts). Each workspace with a guard gets its own action, spaced
// out, so one slow GitHub account does not hold up the rest. Read-only on GitHub.
export const sweep = internalAction({
  args: {},
  handler: async (ctx) => {
    if (!ciCostEnabled()) return 0;
    const guards = await ctx.runQuery(internal.ciSpendGuards.all, {});
    for (const [i, guardId] of guards.entries()) await ctx.scheduler.runAfter(i * 20000, internal.ciSpendGuardJobs.check, { guardId });
    return guards.length;
  },
});

const appOrigin = () => { try { return process.env.APP_URL ? new URL(process.env.APP_URL).origin : undefined; } catch { return undefined; } };

export const check = internalAction({
  args: { guardId: v.id("ciSpendGuards"), now: v.optional(v.number()) },
  handler: async (ctx, a): Promise<Record<string, string>> => {
    const c = await ctx.runQuery(internal.ciSpendGuards.checkContext, { guardId: a.guardId });
    if (!c) return {};
    const now = a.now ?? Date.now(), { period } = monthToDate(now), monthStart = Date.parse(`${period}-01T00:00:00Z`);
    const spend: (RepositorySpend & { repositoryId: typeof c.repositories[number]["repositoryId"] })[] = [];
    for (const r of c.repositories) {
      try {
        const github = await Github.installation(r.installationId);
        if (!github.canReadActions) throw new Error("the GitHub App needs Actions: Read");
        const auditResult = auditActions(await github.actionsHistory(r.fullName, { since: monthStart, now, maxJobRuns: 200, maxWait: 0, deadline: Date.now() + 60000 }), { now });
        spend.push({ repositoryId: r.repositoryId, repository: r.fullName, cost: auditResult.cost.total, minutes: auditResult.minutes.total, audit: auditResult });
      } catch (error) {
        spend.push({ repositoryId: r.repositoryId, repository: r.fullName, cost: 0, minutes: 0, error: redact(error instanceof Error ? error.message : String(error)).slice(0, 200) });
      }
    }
    const problems = criticalProblems(c.critical, spend, now);
    const step = c.guard.monthlyBudget ? budgetStep(spend.reduce((n, s) => n + s.cost, 0), c.guard.monthlyBudget) : undefined;
    const origin = appOrigin();
    const messages = guardMessages({ workspace: c.workspace, period, budget: c.guard.monthlyBudget, spend, problems, step, url: origin && `${origin}/dashboard/organization/ci` });
    await ctx.runMutation(internal.ciSpendGuards.recordCheck, {
      guardId: a.guardId, at: now, period, total: Math.round(messages.total * 100) / 100, problems,
      repositories: spend.map((s) => ({ repositoryId: s.repositoryId, fullName: s.repository, cost: Math.round(s.cost * 100) / 100, minutes: Math.round(s.minutes), ...(s.error ? { error: s.error } : {}) })),
    });

    // Each message is keyed so it goes out once: a budget step once a month, the others once a day.
    const today = new Date(now).toISOString().slice(0, 10), org = c.guard.organizationId;
    const sends: { key: string; message: { subject: string; text: string } }[] = [
      ...(messages.budget && step ? [{ key: `ci.budget.${step}:${org}:${period}`, message: messages.budget }] : []),
      ...(messages.critical ? [{ key: `ci.critical:${org}:${today}`, message: messages.critical }] : []),
      ...(c.guard.dailySummary ? [{ key: `ci.daily:${org}:${today}`, message: messages.daily }] : []),
    ];
    const outcome: Record<string, string> = {};
    const slack = c.slack && sends.length ? await slackClient(ctx, c.slack.installationId) : null;
    for (const { key, message } of sends) {
      for (const r of c.recipients) outcome[`${key}:email:${r.userId}`] = await deliver(ctx, org, `${key}:email:${r.userId}`, "email", () => sendEmail({ to: r.email, subject: message.subject, text: message.text }));
      if (slack && c.slack) outcome[`${key}:slack:${c.slack.channelId}`] = await deliver(ctx, org, `${key}:slack:${c.slack.channelId}`, "slack", () => slack.postMessage({ channel: c.slack!.channelId, text: `*${escapeSlack(message.subject)}*\n${escapeSlack(message.text)}` }));
    }
    return outcome;
  },
});
