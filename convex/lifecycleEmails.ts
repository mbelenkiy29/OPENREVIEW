import { internalAction, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { emailConfigured, sendEmail } from "../src/email";
import { verifiedEmail } from "./referralLedger";

// One-time emails: a thank-you on sign-up, then a workspace's first repository, first review and
// subscription (workspace emails go to its owners at the time). Only verified addresses get them, so
// GitHub-only users (no email scope) get none. Each kind is recorded on the user or workspace in the
// transaction that schedules the send, so it never goes out twice; a failed send is not retried.
const appOrigin = () => new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
const emails = {
  welcome: (url: string) => ({ subject: "Thanks for signing up for OpenReview", text: `Thanks for signing up for OpenReview.\n\nConnect a repository and OpenReview reviews its next pull request:\n${url}\n\nReply to this email if you have questions.` }),
  repository_connected: (url: string) => ({ subject: "Your first repository is connected", text: `Your first repository is connected to OpenReview. Its next pull request gets an automatic review.\n\nManage repositories: ${url}` }),
  first_review_completed: (url: string) => ({ subject: "Your first OpenReview review is done", text: `OpenReview finished its first review in your workspace. The findings are on the pull request and in your dashboard:\n${url}` }),
  subscribed: (url: string) => ({ subject: "Thanks for subscribing to OpenReview", text: `Thanks for subscribing to OpenReview. Your workspace's plan is active.\n\nBilling and usage: ${url}/settings/billing` }),
};
type Kind = keyof typeof emails;
const kind = v.union(...(Object.keys(emails) as Kind[]).map((k) => v.literal(k)));

export async function lifecycleEmail(ctx: MutationCtx, k: Kind, to: { userId: Id<"users"> } | { organizationId: Id<"organizations"> }) {
  let userIds: Id<"users">[];
  if ("userId" in to) {
    const user = await ctx.db.get(to.userId);
    if (!user || user.lifecycleEmails?.includes(k)) return;
    await ctx.db.patch(user._id, { lifecycleEmails: [...(user.lifecycleEmails ?? []), k] });
    userIds = [user._id];
  } else {
    // Only workspaces created with the list get these: older ones' history (reviews, repositories) can be
    // purged by retention, so "first" can't be told from what remains.
    const org = await ctx.db.get(to.organizationId);
    if (!org?.lifecycleEmails || org.lifecycleEmails.includes(k)) return;
    await ctx.db.patch(org._id, { lifecycleEmails: [...(org.lifecycleEmails ?? []), k] });
    userIds = (await ctx.db.query("organizationMembers").withIndex("by_org", (q) => q.eq("organizationId", org._id)).collect()).filter((m) => m.role === "owner").map((m) => m.userId);
  }
  // Milestones are recorded even with email off, so turning it on later never sends a stale "first".
  if (!emailConfigured()) return;
  for (const userId of userIds) {
    const address = await verifiedEmail(ctx, userId);
    if (address) await ctx.scheduler.runAfter(0, internal.lifecycleEmails.send, { to: address, kind: k });
  }
}
export const send = internalAction({ args: { to: v.string(), kind }, handler: async (_ctx, a) => { await sendEmail({ to: a.to, ...emails[a.kind](`${appOrigin()}/dashboard`) }); } });
