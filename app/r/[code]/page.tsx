import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { api } from "../../../convex/_generated/api";
import { backend } from "../../../src/server";
import { normalizeReferralCode, referralConfig, referralDisclosure, referralInvite } from "../../../src/referrals";
import { referrerFor } from "../../auth-screen";
import { SignInOptions } from "../../sign-in";
import { Mark } from "../../ui/logo";

// The title never names the referrer: page titles reach analytics.
export const metadata: Metadata = { title: "You're invited to OpenReview", robots: { index: false, follow: false } };

// Referral link landing: who invited you and what the referral includes, then the usual sign-up
// choices, which carry the code to the new account. Off, malformed or unknown codes go to sign-up.
export default async function Referral({ params }: { params: Promise<{ code: string }> }) {
  const code = normalizeReferralCode((await params).code), referrer = await referrerFor(code);
  if (!code || !referrer) redirect("/signup");
  const session = (await cookies()).get("openreview_session")?.value;
  const signedIn = session ? await backend().query(api.identity.sessionValid, { token: session }).catch(() => false) : false;
  const discount = referralConfig().discountLabel;
  return <main className="welcome">
    <Link className="brand" href="/"><Mark /> OpenReview</Link>
    <h1>You’re invited to OpenReview</h1>
    <p>{referralInvite(referrer.login, discount)}</p>
    {signedIn ? <>
      <p>You’re already signed in. Referral links count when someone creates a new account.</p>
      <Link className="button primary" href={`/dashboard/organization/billing?referral=${code}`}>Go to billing</Link>
    </> : <>
      <p>OpenReview reviews pull requests with the whole repository in view.</p>
      <p className="muted">{referralDisclosure(referrer.login)}</p>
      <SignInOptions mode="signup" referral={code} />
    </>}
  </main>;
}
