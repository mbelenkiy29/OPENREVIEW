// Sign-in choices for the providers this deployment has configured; `next` returns the user to a
// same-origin page (e.g. an invitation) after signing in. The same choices create an account, and
// carry a referral code to it (not SSO: those accounts belong to an existing workspace).
import Link from "next/link";
import { emailOnWeb } from "../src/email";
import { authProviders, authQuery, providerLoginPaths, providerNames, type AuthMode } from "../src/auth-pages";
import { normalizeReferralCode } from "../src/referrals";
import { turnstileConfig } from "../src/turnstile";
import { ProviderIcon } from "./ui/provider-icons";
import { TurnstileField } from "./turnstile";

export function SignInOptions({ next, mode = "login", referral }: { next?: string; mode?: AuthMode; referral?: string | null }) {
  const code = normalizeReferralCode(referral), q = authQuery({ next, referral: code });
  const providers = authProviders(), email = emailOnWeb(), turnstile = turnstileConfig();
  return <div className="sign-in-options">
    {providers.map((p, i) => <a key={p} className={`button sign-in-provider${i === 0 ? " primary" : ""}`} href={providerLoginPaths[p] + q}><ProviderIcon provider={p} /> Continue with {providerNames[p]}</a>)}
    {email && <>
      {providers.length > 0 && <p className="sign-in-divider"><span>or</span></p>}
      <form action="/api/auth/email" method="post" className="sign-in-form">
        {next && <input type="hidden" name="next" value={next} />}
        <input type="hidden" name="from" value={mode} />
        {code && <input type="hidden" name="referral" value={code} />}
        <label>Work email<input type="email" name="email" required maxLength={254} autoComplete="email" placeholder="you@company.com" /></label>
        {turnstile.mode !== "off" && <TurnstileField siteKey={turnstile.siteKey!} action="magic_link" enforce={turnstile.mode === "enforce"} />}
        <button>Email me a sign-in link</button>
        {turnstile.mode === "enforce" && <noscript><p className="muted">Email sign-in needs JavaScript; use another sign-in method.</p></noscript>}
      </form>
    </>}
    <details className="sso-sign-in"><summary>Use single sign-on</summary>
      <form action="/sso/start" method="get" className="sign-in-form">
        {next && <input type="hidden" name="next" value={next} />}
        <label>Work email<input type="email" name="email" required maxLength={254} autoComplete="email" placeholder="you@company.com" /></label>
        <button>Continue with SSO</button>
      </form>
    </details>
    <p className="sign-in-legal">By continuing you agree to the <Link href="/terms">Terms of Service</Link> and <Link href="/privacy">Privacy Policy</Link>.</p>
  </div>;
}
