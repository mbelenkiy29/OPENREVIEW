// Product milestones for analytics: sign-up, workspace created, first repository connected and
// first completed review. The browser sends them to PostHog with the time each happened, and only
// after the visitor accepts analytics cookies; it then marks them reported so each goes out once.
// Workspace milestones go to the workspace's owners only, so each is sent once per workspace, and
// internal or test accounts (convex/conversions.ts isInternal) get none, so they never count as ad
// conversions. The authoritative server-side record is convex/conversions.ts.
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { authenticated } from "./auth";
import { internalAccount } from "./conversions";

export type Milestone = { key: string; event: string; at: number; workspaceId?: string };
const key = /^(signed_up|(workspace_created|repository_connected|first_review_completed):[a-z0-9]{1,64})$/;

/** Milestones of the signed-in user, and of the given workspace when they own it, not yet reported. */
export const pending = query({ args: { token: v.string(), organizationId: v.optional(v.id("organizations")) }, handler: async (ctx, a): Promise<Milestone[]> => {
  const user = await authenticated(ctx, a.token), reported = new Set(user.analyticsMilestones ?? []);
  if (await internalAccount(ctx, user)) return [];
  const found: Milestone[] = [{ key: "signed_up", event: "signed_up", at: user.createdAt }];
  const organizationId = a.organizationId;
  const member = organizationId && await ctx.db.query("organizationMembers").withIndex("by_org_user", (q) => q.eq("organizationId", organizationId).eq("userId", user._id)).unique();
  const org = member && member.role === "owner" ? await ctx.db.get(member.organizationId) : null;
  if (org) {
    const workspaceId = org._id as string;
    found.push({ key: `workspace_created:${workspaceId}`, event: "workspace_created", at: org.onboarding?.startedAt ?? org.createdAt, workspaceId });
    const enabled = (await ctx.db.query("repositories").withIndex("by_org", (q) => q.eq("organizationId", org._id)).take(500)).filter((r) => r.enabled);
    if (enabled.length) found.push({ key: `repository_connected:${workspaceId}`, event: "repository_connected", at: Math.min(...enabled.map((r) => r._creationTime)), workspaceId });
    // The workspace's oldest completed review, looking at its first 200 reviews at most.
    const first = (await ctx.db.query("reviews").withIndex("by_org_time", (q) => q.eq("organizationId", org._id)).order("asc").take(200)).find((r) => r.status === "completed")?.createdAt;
    if (first !== undefined) found.push({ key: `first_review_completed:${workspaceId}`, event: "first_review_completed", at: first, workspaceId });
  }
  return found.filter((m) => !reported.has(m.key));
} });

/** Records milestones the browser sent, so they are not sent again. Unknown keys are ignored. */
export const markReported = mutation({ args: { token: v.string(), keys: v.array(v.string()) }, handler: async (ctx, a) => {
  const user = await authenticated(ctx, a.token);
  const keys = a.keys.filter((k) => key.test(k)).slice(0, 20);
  if (!keys.length) return;
  const all = [...new Set([...(user.analyticsMilestones ?? []), ...keys])].slice(-200);
  await ctx.db.patch(user._id, { analyticsMilestones: all });
} });
