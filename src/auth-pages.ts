// Sign-in and sign-up pages: which sign-in methods this deployment offers, and the message shown
// after a redirect back to the page. Signing up and signing in are the same flows: an account is
// created the first time a provider identity signs in.
import { offline } from "./egress";
import { normalizeReferralCode } from "./referrals";

export type AuthMode = "login" | "signup";
export type AuthProviderId = "github" | "google" | "gitlab";
export const providerNames: Record<AuthProviderId, string> = { github: "GitHub", google: "Google", gitlab: "GitLab" };
export const providerLoginPaths: Record<AuthProviderId, string> = { github: "/api/auth/login", google: "/api/auth/google/login", gitlab: "/api/auth/gitlab/login" };

/** The OAuth providers with credentials on this deployment, in display order. Offline installs
 *  (OPENREVIEW_OFFLINE=true) cannot reach Google, so it is never offered there. */
export function authProviders(env: Record<string, string | undefined> = process.env): AuthProviderId[] {
  return ([["github", env.GITHUB_CLIENT_ID], ["google", offline(env) ? undefined : env.GOOGLE_CLIENT_ID], ["gitlab", env.GITLAB_OAUTH_CLIENT_ID]] as const).filter(([, id]) => Boolean(id)).map(([p]) => p);
}

/** The page a sign-in redirect returns to: the sign-up page only when the visitor started there. */
export const authPagePath = (from: string | null | undefined) => (from === "signup" ? "/signup" : "/login");
/** The query string sign-in links and redirects carry ("" when empty). `next` must already be safe;
 *  a referral code is kept only in canonical form, so a malformed one is dropped. */
export function authQuery({ next, referral, ...result }: { next?: string; referral?: string | null; error?: string; email?: string }) {
  const code = normalizeReferralCode(referral), query = new URLSearchParams(Object.entries({ ...result, next, referral: code }).filter((e): e is [string, string] => Boolean(e[1])));
  return query.size ? `?${query}` : "";
}

/** Results (an error or an emailed link) stay on the page even for signed-in visitors, so a failed
 *  attempt to link another sign-in method is shown instead of skipped. */
export const keepsAuthPage = (query: { error?: string; email?: string }) => Boolean(query.error || query.email);

export type AuthMessage = { tone: "alert" | "status"; text: string };
export function authMessage(query: { error?: string; email?: string; signedout?: string; reauth?: string }): AuthMessage | null {
  if (query.error === "sso") return { tone: "alert", text: "Single sign-on isn’t set up for that email domain, or the sign-in couldn’t be verified. Ask your workspace admin." };
  if (query.error === "link") return { tone: "alert", text: "That sign-in link is invalid, expired or already used. Request a new one below." };
  if (query.error) return { tone: "alert", text: "Sign-in didn’t finish. Try again, or choose another sign-in method." };
  if (query.email === "sent") return { tone: "status", text: "Check your inbox. The sign-in link expires in 15 minutes." };
  if (query.email === "error") return { tone: "alert", text: "We couldn’t send a sign-in link. Check the address, or try again in a few minutes." };
  if (query.reauth) return { tone: "status", text: "For your security, sign in again to continue." };
  if (query.signedout) return { tone: "status", text: "You’ve been signed out." };
  return null;
}
