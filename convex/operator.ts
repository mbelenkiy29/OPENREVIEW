import { action, internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { authenticatedSession } from "./auth";
import { billingConfig, billingDecision, periodKey, seatCount } from "../src/billing";

// Operators (super admins) of this deployment: OPERATOR_GITHUB_IDS on Convex, comma-separated numeric GitHub
// user ids (a login can be renamed and then reused). Only this setting grants it, never a client flag or a stored field.
export const operatorGithubIds = (env: Record<string, string | undefined> = process.env) => (env.OPERATOR_GITHUB_IDS ?? "").split(",").map((s) => s.trim()).filter((s) => /^\d{1,20}$/.test(s));
// The users those accounts sign in as: the GitHub account that created the user, or one a verified sign-in linked.
async function operatorUsers(ctx: QueryCtx): Promise<Id<"users">[]> {
  const found = await Promise.all(operatorGithubIds().flatMap((id) => [
    ctx.db.query("users").withIndex("by_github", (q) => q.eq("githubId", Number(id))).first().then((u) => u?._id),
    ctx.db.query("identities").withIndex("by_provider_user", (q) => q.eq("provider", "github").eq("providerUserId", id)).first().then((i) => i?.userId),
  ]));
  return found.filter((id): id is Id<"users"> => id !== undefined);
}
export const isOperator = async (ctx: QueryCtx, userId: Id<"users">) => (await operatorUsers(ctx)).includes(userId);
/** A workspace an operator owns; billing treats it as self-hosted (configFor in convex/billing.ts). */
export async function operatorOwned(ctx: QueryCtx, organizationId: Id<"organizations">) {
  for (const userId of await operatorUsers(ctx)) {
    const member = await ctx.db.query("organizationMembers").withIndex("by_org_user", (q) => q.eq("organizationId", organizationId).eq("userId", userId)).unique();
    if (member?.role === "owner") return true;
  }
  return false;
}
// Every operator function starts here. It needs a browser session, so a token the server mints for an API key never passes.
export async function requireOperator(ctx: QueryCtx, token: string) {
  const { user, session } = await authenticatedSession(ctx, token);
  if (!session || !await isOperator(ctx, user._id)) throw new Error("Forbidden");
  return user;
}

export const recordAccess = internalMutation({ args: { token: v.string(), action: v.string() }, handler: async (ctx, a) => {
  const user = await requireOperator(ctx, a.token);
  await ctx.db.insert("operatorAudit", { userId: user._id, action: a.action, createdAt: Date.now() });
} });
export const report = internalQuery({ args: { token: v.string() }, handler: async (ctx, a) => {
  await requireOperator(ctx, a.token);
  return operatorReport(ctx);
} });
// The operator page (app/dashboard/(portal)/operator): records the visit, then reads. Both steps check the caller.
export const overview = action({ args: { token: v.string() }, handler: async (ctx, a): Promise<OperatorReport> => {
  await ctx.runMutation(internal.operator.recordAccess, { token: a.token, action: "operator.overview" });
  return ctx.runQuery(internal.operator.report, { token: a.token });
} });

export type OperatorReport = Awaited<ReturnType<typeof operatorReport>>;
const funnelSteps = ["signup_verified", "first_repository_connected", "first_review_completed", "checkout_started", "subscribed", "first_paid", "upgrade_requested"] as const;
// Metadata and counts across every workspace: names, plans, seats, spend and activity times. Never code, review or
// finding text, chat, emails or user agents. The newest 500 workspaces and users, and 30 days of model calls.
async function operatorReport(ctx: QueryCtx) {
  const now = Date.now(), config = billingConfig(), period = periodKey(now), today = new Date(now);
  const since = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 29), cap = 500, usageCap = 10_000, feedSize = 50;
  const [organizations, users, usage, budget, operators] = await Promise.all([
    ctx.db.query("organizations").order("desc").take(cap),
    ctx.db.query("users").order("desc").take(cap),
    ctx.db.query("usageEvents").withIndex("by_creation_time", (q) => q.gte("_creationTime", since)).order("desc").take(usageCap),
    ctx.db.query("inferenceBudgets").unique(),
    operatorUsers(ctx).then((ids) => new Set<string>(ids)),
  ]);
  const days = Array.from({ length: 30 }, (_, i) => new Date(since + i * 86_400_000).toISOString().slice(0, 10));
  const spent = new Map<string, number>();
  for (const u of usage) spent.set(u.organizationId, (spent.get(u.organizationId) ?? 0) + u.estimatedCost);

  const workspaces = await Promise.all(organizations.map(async (o) => {
    const [members, account, month, last] = await Promise.all([
      ctx.db.query("organizationMembers").withIndex("by_org", (q) => q.eq("organizationId", o._id)).take(1000),
      ctx.db.query("billingAccounts").withIndex("by_org", (q) => q.eq("organizationId", o._id)).unique(),
      ctx.db.query("billingUsage").withIndex("by_org_period", (q) => q.eq("organizationId", o._id).eq("period", period)).unique(),
      ctx.db.query("usageEvents").withIndex("by_org_time", (q) => q.eq("organizationId", o._id)).order("desc").first(),
    ]);
    const exempt = config.enabled && members.some((m) => m.role === "owner" && operators.has(m.userId));
    // shortcut: leaves out the one-Free-workspace-per-owner rule, so an owner's second Free workspace shows the Free allowance; check its Billing page.
    const decision = config.enabled && !exempt ? billingDecision(account ?? { status: "trial", seats: 0, trialEndsAt: 0 }, month?.usedMicros ?? 0, now, config) : null;
    return {
      id: o._id, name: o.name, createdAt: o.createdAt, exempt, plan: decision?.plan ?? null, status: account?.subscriptionId ? account.status : null,
      choosingPlan: config.enabled && !exempt && Boolean(o.planRequired && !o.planSelectedAt), seats: seatCount(members), members: members.length,
      billedSeats: account?.subscriptionId ? account.seats : null, spend: spent.get(o._id) ?? 0, usedMicros: month?.usedMicros ?? 0, limitMicros: decision?.limit ?? null,
      reviews: month?.reviews ?? 0, blocked: month?.blocked ?? 0, fixes: month?.fixes ?? 0, lastActivity: last?.createdAt ?? null,
    };
  }));
  workspaces.sort((x, y) => y.spend - x.spend || y.createdAt - x.createdAt);

  const people = await Promise.all(users.map(async (u) => {
    const [identities, memberships] = await Promise.all([
      ctx.db.query("identities").withIndex("by_user", (q) => q.eq("userId", u._id)).take(20),
      ctx.db.query("organizationMembers").withIndex("by_user", (q) => q.eq("userId", u._id)).take(100),
    ]);
    return { id: u._id, login: u.login, createdAt: u.createdAt, operator: operators.has(u._id), providers: [...new Set(identities.map((i) => i.provider))], lastSignIn: identities.length ? Math.max(...identities.map((i) => i.lastLoginAt)) : null, workspaces: memberships.length, owned: memberships.filter((m) => m.role === "owner").length };
  }));

  // Spend and model calls per day: the three workspaces that spent most, then everyone else.
  const top = workspaces.filter((w) => w.spend > 0).slice(0, 3), series = [...top.map((w) => w.name), "Other"];
  const chart = { spend: series.map(() => days.map(() => 0)), calls: series.map(() => days.map(() => 0)) };
  for (const u of usage) {
    const d = days.indexOf(new Date(u.createdAt).toISOString().slice(0, 10)), s = top.findIndex((w) => w.id === u.organizationId);
    if (d < 0) continue;
    chart.spend[s < 0 ? series.length - 1 : s][d] += u.estimatedCost;
    chart.calls[s < 0 ? series.length - 1 : s][d]++;
  }

  // Recent activity: sign-ins, reviews, agent fixes and plan changes, newest first.
  const logins = new Map<string, string>(users.map((u) => [u._id, u.login])), names = new Map<string, string>(organizations.map((o) => [o._id, o.name]));
  const login = async (id?: Id<"users">) => id ? logins.get(id) ?? (await ctx.db.get(id))?.login ?? null : null;
  const workspace = async (id?: Id<"organizations">) => id ? names.get(id) ?? (await ctx.db.get(id))?.name ?? null : null;
  const [sessions, reviews, fixes, audits, access] = await Promise.all([
    ctx.db.query("sessions").order("desc").take(feedSize),
    ctx.db.query("reviews").order("desc").take(feedSize),
    ctx.db.query("fixRequests").order("desc").take(feedSize),
    ctx.db.query("auditEvents").order("desc").take(300),
    ctx.db.query("operatorAudit").order("desc").take(20),
  ]);
  const planLabels: Record<string, string> = { "billing.plan_selected": "Chose plan", "billing.plan_changed": "Plan changed to", "billing.plan_change_requested": "Asked to change plan to" };
  const fixLabels: Record<string, string> = { hosted: "Agent fix", cloud: "Cloud agent handoff" };
  const activity = (await Promise.all([
    // A session started by linking another provider is not a new sign-in.
    ...sessions.filter((s) => !s.signedInAt).map(async (s) => ({ at: s.createdAt, kind: "sign-in", label: `Signed in with ${s.provider}`, user: await login(s.userId), workspace: null })),
    ...reviews.map(async (r) => ({ at: r._creationTime, kind: "review", label: r.status === "failed" && r.error?.startsWith("Billing:") ? "Review blocked by billing" : `Review ${r.status}`, user: null, workspace: await workspace(r.organizationId) })),
    ...fixes.map(async (f) => ({ at: f.createdAt, kind: "fix", label: `${fixLabels[f.kind ?? ""] ?? "Local agent fix"} ${f.status}`, user: await login(f.userId), workspace: await workspace(f.organizationId) })),
    ...audits.filter((e) => planLabels[e.action]).map(async (e) => ({ at: e.createdAt, kind: "plan", label: `${planLabels[e.action]} ${e.target}`, user: await login(e.userId), workspace: await workspace(e.organizationId) })),
  ])).sort((x, y) => y.at - x.at).slice(0, feedSize);

  const total = (key: "spend" | "reviews" | "blocked" | "fixes") => workspaces.reduce((n, w) => n + w[key], 0);
  // Funnel steps and paywall hits from conversionEvents (convex/conversions.ts), each counted once per workspace or user.
  const [steps, paywalls] = await Promise.all([
    Promise.all(funnelSteps.map(async (name) => ({ name, count: (await ctx.db.query("conversionEvents").withIndex("by_name_at", (q) => q.eq("name", name).gte("at", since)).take(5000)).length }))),
    ctx.db.query("conversionEvents").withIndex("by_name_at", (q) => q.eq("name", "paywall").gte("at", since)).take(5000),
  ]);
  const wanted = Object.entries(paywalls.reduce<Record<string, number>>((n, e) => ({ ...n, [e.method ?? "unknown"]: (n[e.method ?? "unknown"] ?? 0) + 1 }), {})).map(([feature, count]) => ({ feature, count })).sort((x, y) => y.count - x.count);
  return {
    billing: config.enabled, days, series, chart, workspaces, users: people, activity, funnel: { steps, wanted },
    access: await Promise.all(access.map(async (e) => ({ id: e._id, at: e.createdAt, action: e.action, user: await login(e.userId) }))),
    capped: { workspaces: organizations.length === cap, users: users.length === cap, usage: usage.length === usageCap },
    totals: { users: users.length, workspaces: workspaces.length, operators: operators.size, spend: total("spend"), reviews: total("reviews"), blocked: total("blocked"), fixes: total("fixes"), plans: Object.fromEntries(["free", "starter", "pro"].map((p) => [p, workspaces.filter((w) => w.plan === p).length])) },
    budget: budget ? { limitMicros: budget.limitMicros, usedMicros: budget.committedMicros + budget.reservedMicros } : null,
  };
}
