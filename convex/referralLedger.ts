import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { normalizeReferralCode, referralConfig } from "../src/referrals";

// Referral helpers shared by sign-in, workspace creation and the referral functions (no endpoints).
export async function codeOwner(ctx: QueryCtx, code: unknown) {
  const normalized = normalizeReferralCode(code);
  return normalized ? ctx.db.query("referralCodes").withIndex("by_code", (q) => q.eq("code", normalized)).first() : null;
}
// Attributes a user created by this sign-in to the code's owner. Never throws: a bad code or a
// referral bug must not break sign-in.
export async function recordReferralSignup(ctx: MutationCtx, userId: Id<"users">, code: string | undefined) {
  if (!code || !referralConfig().enabled) return;
  try {
    const owner = await codeOwner(ctx, code);
    if (!owner || owner.userId === userId || await ctx.db.query("referrals").withIndex("by_referred_user", (q) => q.eq("referredUserId", userId)).first()) return;
    // shortcut: automatic fraud matching (card/email/domain) would hold the referral here; operators void abuse with referralOps:voidReferral.
    const now = Date.now();
    await ctx.db.insert("referrals", { referrerId: owner.userId, referredUserId: userId, source: "link", status: "signed_up", attributedAt: now, updatedAt: now });
  } catch (error) { console.error(JSON.stringify({ event: "referral.signup_failed", error: error instanceof Error ? error.message.slice(0, 200) : "unknown" })); }
}
export const referralOfWorkspace = (ctx: QueryCtx, organizationId: Id<"organizations">) => ctx.db.query("referrals").withIndex("by_referred_org", (q) => q.eq("referredOrganizationId", organizationId)).first();
// The referred person's first workspace carries the referral; one referral per workspace.
export async function bindReferralOnWorkspace(ctx: MutationCtx, userId: Id<"users">, organizationId: Id<"organizations">) {
  if (!referralConfig().enabled) return;
  const referral = await ctx.db.query("referrals").withIndex("by_referred_user", (q) => q.eq("referredUserId", userId)).first();
  if (referral?.status !== "signed_up" || await referralOfWorkspace(ctx, organizationId)) return;
  await ctx.db.patch(referral._id, { referredOrganizationId: organizationId, status: "pending", boundAt: Date.now(), updatedAt: Date.now() });
}

export const isMember = async (ctx: QueryCtx, organizationId: Id<"organizations">, userId: Id<"users">) => Boolean(await ctx.db.query("organizationMembers").withIndex("by_org_user", (q) => q.eq("organizationId", organizationId).eq("userId", userId)).unique());
/** A current member, or someone who was one and has since left (self-referral check). Any audit row
 *  of theirs counts: creating a workspace writes none, but its creator can only leave after promoting another owner. */
export async function everMember(ctx: QueryCtx, organizationId: Id<"organizations">, userId: Id<"users">) {
  return await isMember(ctx, organizationId, userId) || Boolean(await ctx.db.query("auditEvents").withIndex("by_org_user", (q) => q.eq("organizationId", organizationId).eq("userId", userId)).first());
}
/** The address to email a user at: the latest provider-verified identity, else a verified notification address. */
export async function verifiedEmail(ctx: QueryCtx, userId: Id<"users">): Promise<string | null> {
  const identity = (await ctx.db.query("identities").withIndex("by_user", (q) => q.eq("userId", userId)).take(20)).filter((i) => i.emailVerified && i.email).sort((a, b) => b.lastLoginAt - a.lastLoginAt)[0];
  if (identity?.email) return identity.email;
  return (await ctx.db.query("notificationPreferences").withIndex("by_user_org", (q) => q.eq("userId", userId)).take(100)).filter((p) => p.email && p.emailVerifiedAt).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.email ?? null;
}
/** A login safe to show to someone else: GitHub usernames only. Email and Google logins are an
 *  email address's local part, so they are never shown (null). */
export async function publicLogin(ctx: QueryCtx, userId: Id<"users">) {
  const user = await ctx.db.get(userId);
  return user?.githubId !== undefined ? user.login : null;
}
