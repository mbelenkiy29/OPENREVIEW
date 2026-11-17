// Sign-in and sign-up screens: the choices on the left, an animated drawing on the right (hidden on
// small screens). Both pages use the same sign-in flows; only the wording differs.
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { api } from "../convex/_generated/api";
import { billingConfig } from "../src/billing";
import { safeNext } from "../src/identity";
import { backend } from "../src/server";
import { authMessage, authQuery, keepsAuthPage, sentAddress, type AuthMode } from "../src/auth-pages";
import { normalizeReferralCode, referralConfig, referralDisclosure, referralInvite } from "../src/referrals";
import { AuthChrome } from "./auth-chrome";
import { SignInOptions } from "./sign-in";

export type AuthQuery = { next?: string; error?: string; email?: string; to?: string; signedout?: string; reauth?: string; referral?: string };

/** Signed-in visitors skip the page and go where they were headed, unless it shows a result. */
export async function redirectIfSignedIn(query: AuthQuery) {
  if (keepsAuthPage(query)) return;
  const token = (await cookies()).get("openreview_session")?.value;
  if (token && await backend().query(api.identity.sessionValid, { token }).catch(() => false)) redirect(safeNext(query.next));
}
/** Who shared a referral code (GitHub username or null), or null for an unknown code or when the program is off. */
export async function referrerFor(code: string | null) {
  return code && referralConfig().enabled ? backend().query(api.referrals.preview, { secret: process.env.SERVICE_SECRET ?? "", code }).catch(() => null) : null;
}

export async function AuthScreen({ mode, query }: { mode: AuthMode; query: AuthQuery }) {
  const next = query.next ? safeNext(query.next) : undefined, message = authMessage(query), referral = normalizeReferralCode(query.referral);
  const carry = authQuery({ next, referral }), billing = billingConfig(), referrer = await referrerFor(referral), discount = referralConfig().discountLabel;
  const to = sentAddress(query.to);
  return <AuthChrome title={mode === "login" ? "Log into your account" : "Create an account"}>
    <p className="auth-switch">{mode === "login"
      ? <>Don’t have an account? <Link href={`/signup${carry}`}>Sign up</Link></>
      : <>Already have an account? <Link href={`/login${carry}`}>Login</Link></>}</p>
    {referrer && <p className="auth-note">{referralInvite(referrer.login, discount)} {referralDisclosure(referrer.login)}</p>}
    {mode === "signup" && billing.enabled && <p className="auth-note">Starter and Pro come with a {billing.trialDays}-day free trial.</p>}
    {message && <p role={message.tone} className={message.tone === "alert" ? "error" : "auth-status"}>{message.text}</p>}
    <SignInOptions next={next} mode={mode} referral={referral} sentTo={to} cooldown={query.email === "sent"} />
  </AuthChrome>;
}
