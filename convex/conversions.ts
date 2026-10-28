import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { entitlements } from "../src/plans";

// Funnel milestones, recorded server-side in the transaction that reaches them, once each: the key is
// looked up before the insert and mutations are serializable, so retries and racing requests leave one
// row. Ad pixels never read this table; they fire from convex/analyticsMilestones.ts after consent.
//   signup_verified:<userId>        an account created by a completed sign-in (identity.ts resolveIdentity:
//                                   a used magic link, a verified OAuth callback or SSO assertion)
//   github_app_installed:<org>      the workspace's first GitHub App installation (repositories.ts connect)
//   first_repository_connected:<org>, first_review_completed:<org>, subscribed:<org>
//                                   from lifecycleEmails.ts, which records each once per workspace
//                                   (subscribed is a card added at Checkout, trials included)
//   checkout_started:<org>:<plan>   Stripe Checkout opened (billingJobs.checkout); without a later subscribed it was abandoned
//   first_paid:<org>                the first invoice.paid with money in it (billing.applyStripeEvent)
//   paywall:<feature>:<org>         something wanted a feature the plan lacks: a deep review or agentic engine capped,
//                                   repro tests or linked tickets skipped, a fix PR asked for on Free (method = feature)
//   upgrade_requested:<org>         a member asked the admins to upgrade (notifications.requestUpgrade)
export type Conversion = "signup_verified" | "github_app_installed" | "first_repository_connected" | "first_review_completed" | "subscribed" | "checkout_started" | "first_paid" | "paywall" | "upgrade_requested";
export async function recordConversion(ctx: MutationCtx, name: Conversion, subject: string, fields: { userId?: Id<"users">; organizationId?: Id<"organizations">; method?: string } = {}) {
  const key = `${name}:${subject}`;
  if (await ctx.db.query("conversionEvents").withIndex("by_key", (q) => q.eq("key", key)).first()) return false;
  await ctx.db.insert("conversionEvents", { name, key, ...fields, at: Date.now() });
  return true;
}
// For actions: Checkout opened, or a review that skipped a feature the plan lacks.
export const record = internalMutation({ args: { name: v.union(v.literal("checkout_started"), v.literal("paywall")), organizationId: v.id("organizations"), method: v.string() }, handler: async (ctx, a) => {
  if (a.name === "paywall" && !(entitlements as readonly string[]).includes(a.method)) throw new Error("Unknown feature");
  await recordConversion(ctx, a.name, `${a.name === "paywall" ? a.method + ":" + a.organizationId : a.organizationId + ":" + a.method}`, { organizationId: a.organizationId, method: a.method });
} });

// Internal and test accounts, left out of analytics milestones (so no ad conversion) and of the funnel
// report: ANALYTICS_INTERNAL_EMAILS, ANALYTICS_INTERNAL_EMAIL_DOMAINS (subdomains too) and
// ANALYTICS_INTERNAL_GITHUB_LOGINS, comma-separated; Resend's test addresses (@resend.dev); and the
// reserved test TLDs (.test, .example, .invalid, .localhost). Read when asked, so a changed list applies
// to existing accounts too.
const list = (value: string | undefined) => (value ?? "").split(",").map((s) => s.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
export function isInternal(account: { emails: string[]; githubLogins: string[] }, env: Record<string, string | undefined> = process.env) {
  const emails = list(env.ANALYTICS_INTERNAL_EMAILS), domains = list(env.ANALYTICS_INTERNAL_EMAIL_DOMAINS), logins = list(env.ANALYTICS_INTERNAL_GITHUB_LOGINS);
  return account.emails.some((email) => {
    const address = email.trim().toLowerCase(), domain = address.slice(address.lastIndexOf("@") + 1);
    return emails.includes(address) || domain === "resend.dev" || /\.(test|example|invalid|localhost)$/.test(domain) || domains.some((d) => domain === d || domain.endsWith(`.${d}`));
  }) || account.githubLogins.some((login) => logins.includes(login.toLowerCase()));
}
export async function internalAccount(ctx: QueryCtx, user: Doc<"users">) {
  const identities = await ctx.db.query("identities").withIndex("by_user", (q) => q.eq("userId", user._id)).take(20);
  return isInternal({
    emails: identities.flatMap((i) => (i.email ? [i.email] : [])),
    githubLogins: [...(user.githubId !== undefined ? [user.login] : []), ...identities.flatMap((i) => (i.provider === "github" && i.login ? [i.login] : []))],
  });
}
