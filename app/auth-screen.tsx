// Sign-in and sign-up screens: the choices on the left, an animated drawing on the right (hidden on
// small screens). Both pages use the same sign-in flows; only the wording differs.
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { api } from "../convex/_generated/api";
import { billingConfig } from "../src/billing";
import { safeNext } from "../src/identity";
import { backend } from "../src/server";
import { authMessage, authQuery, keepsAuthPage, type AuthMode } from "../src/auth-pages";
import { normalizeReferralCode, referralConfig, referralDisclosure, referralInvite } from "../src/referrals";
import { SignInOptions } from "./sign-in";
import { Mark } from "./ui/logo";

export type AuthQuery = { next?: string; error?: string; email?: string; signedout?: string; reauth?: string; referral?: string };

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

// The right panel: a pull request under review. Diff lines scroll past while a scan band reads them;
// where it finds a problem the line's gutter lights the logo's ember dot and a finding card slides in.
// [indent, width %, kind] per line; kind marks added or removed lines.
const diff: [number, number, ("add" | "del")?][] = [[0, 44], [1, 62], [1, 38, "del"], [1, 56, "add"], [0, 0], [0, 50], [1, 70], [2, 46, "add"], [2, 58, "add"], [1, 30], [0, 0], [0, 64], [1, 52, "add"], [1, 40], [0, 22]];
// [line index, priority, title]: lines the scan reaches at about 20%, 55% and 85% of its pass.
const findings: [number, string, string][] = [[3, "P1", "Workspace membership is not checked before the read"], [8, "P2", "The retry loop never awaits its promise"], [12, "P3", "One query runs per repository in this loop"]];

/** Decorative and CSS-only; reduced motion shows the finished review. */
function AuthArt() {
  return <aside className="auth-art" aria-hidden="true">
    <div className="auth-diff">
      <div className="auth-diff-head"><i /><i /><i /><code>src/routes/workspace.ts</code></div>
      <div className="auth-diff-body">
        <span className="auth-scan" />
        {diff.map(([indent, width, kind], i) => <div key={i} className={`auth-line${kind ? " " + kind : ""}`} style={{ ["--indent" as string]: indent, ["--w" as string]: `${width}%` }}><b>{i + 41}</b><i /></div>)}
        {findings.map(([line, priority, title], i) => <div key={line} className={`auth-finding f${i}`} style={{ ["--line" as string]: line, ["--n" as string]: i }}><span className="auth-dot" /><div><strong>{priority}</strong><p>{title}</p></div></div>)}
      </div>
    </div>
    <p>Reviews that read<br />the whole repository</p>
  </aside>;
}

export async function AuthScreen({ mode, query }: { mode: AuthMode; query: AuthQuery }) {
  const next = query.next ? safeNext(query.next) : undefined, message = authMessage(query), referral = normalizeReferralCode(query.referral);
  const carry = authQuery({ next, referral }), billing = billingConfig(), referrer = await referrerFor(referral), discount = referralConfig().discountLabel;
  return <div className="auth">
    <main className="auth-panel">
      <div className="auth-card">
        <Link className="auth-logo" href="/" aria-label="OpenReview home"><Mark /></Link>
        <h1>{mode === "login" ? "Log into your account" : "Create an account"}</h1>
        <p className="auth-switch">{mode === "login"
          ? <>Don’t have an account? <Link href={`/signup${carry}`}>Sign up</Link></>
          : <>Already have an account? <Link href={`/login${carry}`}>Login</Link></>}</p>
        {referrer && <p className="auth-note">{referralInvite(referrer.login, discount)} {referralDisclosure(referrer.login)}</p>}
        {mode === "signup" && billing.enabled && <p className="auth-note">Start on the Free plan with no card. Starter and Pro come with {billing.trialDays} days free.</p>}
        {message && <p role={message.tone} className={message.tone === "alert" ? "error" : "auth-status"}>{message.text}</p>}
        <SignInOptions next={next} mode={mode} referral={referral} />
      </div>
    </main>
    <AuthArt />
  </div>;
}
