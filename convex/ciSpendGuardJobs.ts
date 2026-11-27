"use node";
import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
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
  handler: async (ctx): Promise<number> => {
    if (!ciCostEnabled()) return 0;
    const guards: Id<"ciSpendGuards">[] = await ctx.runQuery(internal.ciSpendGuards.all, {});
    for (const [i, guardId] of guards.entries()) await ctx.scheduler.runAfter(i * 20000, internal.ciSpendGuardJobs.check, { guardId });
    return guards.length;
  },
});

const appOrigin = () => { try { return process.env.APP_URL ? new URL(process.env.APP_URL).origin : undefined; } catch { return undefined; } };
// One check stays well inside Convex's ten-minute action limit: repositories share this budget, and those
// not reached are reported as not checked today rather than losing the whole check.
const checkBudgetMs = 7 * 60000, repositoryMs = 60000;

const sendValidator = v.object({ key: v.string(), channel: v.union(v.literal("email"), v.literal("slack")), to: v.string(), subject: v.string(), text: v.string() });
type Send = { key: string; channel: "email" | "slack"; to: string; subject: string; text: string };

// Sends each message once (deliver claims its key); failed ones are retried with the same keys, at most three times.
async function sendAll(ctx: ActionCtx, organizationId: Id<"organizations">, slackInstallationId: Id<"slackInstallations"> | undefined, sends: Send[], attempt: number) {
  const outcome: Record<string, string> = {};
  const slack = slackInstallationId && sends.some((s) => s.channel === "slack") ? await slackClient(ctx, slackInstallationId) : null;
  for (const s of sends) {
    outcome[s.key] = s.channel === "email"
      ? await deliver(ctx, organizationId, s.key, "email", () => sendEmail({ to: s.to, subject: s.subject, text: s.text }))
      : slack ? await deliver(ctx, organizationId, s.key, "slack", () => slack.postMessage({ channel: s.to, text: `*${escapeSlack(s.subject)}*\n${escapeSlack(s.text)}` })) : "skipped";
  }
  const failed = sends.filter((s) => outcome[s.key] === "failed");
  if (failed.length && attempt < 3) await ctx.scheduler.runAfter(600000 * attempt, internal.ciSpendGuardJobs.redeliver, { organizationId, ...(slackInstallationId ? { slackInstallationId } : {}), sends: failed, attempt: attempt + 1 });
  return outcome;
}

export const redeliver = internalAction({
  args: { organizationId: v.id("organizations"), slackInstallationId: v.optional(v.id("slackInstallations")), sends: v.array(sendValidator), attempt: v.number() },
  handler: async (ctx, a): Promise<Record<string, string>> => {
    if (!ciCostEnabled()) return {};
    return sendAll(ctx, a.organizationId, a.slackInstallationId, a.sends, a.attempt);
  },
});

export const check = internalAction({
  args: { guardId: v.id("ciSpendGuards"), now: v.optional(v.number()) },
  handler: async (ctx, a): Promise<Record<string, string>> => {
    // The flag is checked again here: checks queued by a sweep can run long after it.
    if (!ciCostEnabled()) return {};
    const c = await ctx.runQuery(internal.ciSpendGuards.checkContext, { guardId: a.guardId });
    if (!c) return {};
    const now = a.now ?? Date.now(), { period } = monthToDate(now), monthStart = Date.parse(`${period}-01T00:00:00Z`);
    const started = Date.now(), notes: string[] = [];
    const spend: (RepositorySpend & { repositoryId: Id<"repositories"> })[] = [];
    for (const r of c.repositories) {
      const left = checkBudgetMs - (Date.now() - started);
      if (left < 5000) { spend.push({ repositoryId: r.repositoryId, repository: r.fullName, cost: 0, minutes: 0, error: "not checked today (time limit)" }); continue; }
      try {
        const github = await Github.installation(r.installationId);
        if (!github.canReadActions) throw new Error("the GitHub App needs Actions: Read");
        const history = await github.actionsHistory(r.fullName, { since: monthStart, now, maxJobRuns: 200, maxWait: 0, deadline: Date.now() + Math.min(repositoryMs, left) });
        const auditResult = auditActions(history, { now });
        // A history cut short (rate limit or time) is a lower bound for the month, and says so.
        const partial = Boolean(history.truncated?.length) || Date.parse(history.from) > monthStart + 3600000;
        if (partial) notes.push(`${r.fullName}: only part of the month could be read, so its spend is at least the amount shown.`);
        spend.push({ repositoryId: r.repositoryId, repository: r.fullName, cost: auditResult.cost.total, minutes: auditResult.minutes.total, audit: auditResult, partial });
      } catch (error) {
        spend.push({ repositoryId: r.repositoryId, repository: r.fullName, cost: 0, minutes: 0, error: redact(error instanceof Error ? error.message : String(error)).slice(0, 200) });
      }
    }
    if (c.skippedRepositories > 0) notes.push(`${c.skippedRepositories} more repositories were not checked; the guard checks at most ${c.repositories.length} a day, repositories with critical workflows first.`);
    const problems = criticalProblems(c.critical, spend, now);
    const step = c.guard.monthlyBudget ? budgetStep(spend.reduce((n, s) => n + s.cost, 0), c.guard.monthlyBudget) : undefined;
    const origin = appOrigin();
    const messages = guardMessages({ workspace: c.workspace, period, budget: c.guard.monthlyBudget, spend, problems, step, notes, url: origin && `${origin}/dashboard/organization/ci` });
    await ctx.runMutation(internal.ciSpendGuards.recordCheck, {
      guardId: a.guardId, at: now, period, total: Math.round(messages.total * 100) / 100, problems, notes,
      repositories: spend.map((s) => ({ repositoryId: s.repositoryId, fullName: s.repository, cost: Math.round(s.cost * 100) / 100, minutes: Math.round(s.minutes), ...(s.error ? { error: s.error } : {}), ...(s.partial ? { partial: true } : {}) })),
    });

    // Each message is keyed so it goes out once: a budget step once a month, the others once a day.
    const today = new Date(now).toISOString().slice(0, 10), org = c.guard.organizationId;
    const messagesToSend: { key: string; message: { subject: string; text: string } }[] = [
      ...(messages.budget && step ? [{ key: `ci.budget.${step}:${org}:${period}`, message: messages.budget }] : []),
      ...(messages.critical ? [{ key: `ci.critical:${org}:${today}`, message: messages.critical }] : []),
      ...(c.guard.dailySummary ? [{ key: `ci.daily:${org}:${today}`, message: messages.daily }] : []),
    ];
    const sends: Send[] = messagesToSend.flatMap(({ key, message }) => [
      ...c.recipients.map((r): Send => ({ key: `${key}:email:${r.userId}`, channel: "email", to: r.email, ...message })),
      ...(c.slack ? [{ key: `${key}:slack:${c.slack.channelId}`, channel: "slack" as const, to: c.slack.channelId, ...message }] : []),
    ]);
    return sendAll(ctx, org, c.slack?.installationId, sends, 1);
  },
});
