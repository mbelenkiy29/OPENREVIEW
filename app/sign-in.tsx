// Sign-in choices for the providers this deployment has configured; `next` returns the user to a
// same-origin page (e.g. an invitation) after signing in. The same choices create an account, and
// carry a referral code to it (not SSO: those accounts belong to an existing workspace).
// Email first, as on Greptile's login; we have no passwords, so it sends a one-time sign-in link.
import Link from "next/link";
import { emailOnWeb } from "../src/email";
import { authProviders, authQuery, providerLoginPaths, providerNames, type AuthMode } from "../src/auth-pages";
import { normalizeReferralCode } from "../src/referrals";
import { turnstileConfig } from "../src/turnstile";
import { ProviderIcon } from "./ui/provider-icons";
import { Icon } from "./ui/icons";
import { TurnstileField } from "./turnstile";

export function SignInOptions({ next, mode = "login", referral }: { next?: string; mode?: AuthMode; referral?: string | null }) {
  const code = normalizeReferralCode(referral), q = authQuery({ next, referral: code });
  const providers = authProviders(), email = emailOnWeb(), turnstile = turnstileConfig(), verb = mode === "signup" ? "Sign up" : "Sign in";
  return <div className="sign-in-options">
    {email && <form action="/api/auth/email" method="post" className="sign-in-form">
      {next && <input type="hidden" name="next" value={next} />}
      <input type="hidden" name="from" value={mode} />
      {code && <input type="hidden" name="referral" value={code} />}
      <label>Enter work email<input type="email" name="email" required maxLength={254} autoComplete="email" placeholder="me@example.com" /></label>
      <p className="sign-in-hint">We’ll email you a sign-in link. No password needed.</p>
      {turnstile.mode !== "off" && <TurnstileField siteKey={turnstile.siteKey!} action="magic_link" />}
      <button className="primary">{mode === "signup" ? "Start for Free" : "Login"} <Icon name="arrowRight" /></button>
      {turnstile.mode === "enforce" && <noscript><p className="muted">Email sign-in needs JavaScript; use another sign-in method.</p></noscript>}
    </form>}
    {/* Without email sign-in, the first provider is the primary action. */}
    {providers.map((p, i) => <a key={p} className={`button sign-in-provider${!email && i === 0 ? " primary" : ""}`} href={providerLoginPaths[p] + q}><ProviderIcon provider={p} /> {verb} with {providerNames[p]}</a>)}
    <details className="sso-sign-in"><summary>Use single sign-on</summary>
      <form action="/sso/start" method="get" className="sign-in-form">
        {next && <input type="hidden" name="next" value={next} />}
        <label>Work email<input type="email" name="email" required maxLength={254} autoComplete="email" placeholder="me@example.com" /></label>
        <button>Continue with SSO</button>
      </form>
    </details>
    <p className="sign-in-legal">By {mode === "signup" ? "signing up" : "continuing"}, you agree to the <Link href="/terms">Terms of Service</Link> and <Link href="/privacy">Privacy Policy</Link>.</p>
  </div>;
}
