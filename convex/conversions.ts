import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

// Funnel milestones, recorded server-side in the transaction that reaches them, once each: the key is
// looked up before the insert and mutations are serializable, so retries and racing requests leave one
// row. Ad pixels never read this table; they fire from convex/analyticsMilestones.ts after consent.
//   signup_verified:<userId>        an account created by a completed sign-in (identity.ts resolveIdentity:
//                                   a used magic link, a verified OAuth callback or SSO assertion)
//   github_app_installed:<org>      the workspace's first GitHub App installation (repositories.ts connect)
//   first_repository_connected:<org>, first_review_completed:<org>, subscribed:<org>
//                                   from lifecycleEmails.ts, which records each once per workspace
export type Conversion = "signup_verified" | "github_app_installed" | "first_repository_connected" | "first_review_completed" | "subscribed";
export async function recordConversion(ctx: MutationCtx, name: Conversion, subject: string, fields: { userId?: Id<"users">; organizationId?: Id<"organizations">; method?: string } = {}) {
  const key = `${name}:${subject}`;
  if (await ctx.db.query("conversionEvents").withIndex("by_key", (q) => q.eq("key", key)).first()) return false;
  await ctx.db.insert("conversionEvents", { name, key, ...fields, at: Date.now() });
  return true;
}

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
