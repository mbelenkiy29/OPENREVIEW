import { NextResponse } from "next/server";
import { api } from "../../../../convex/_generated/api";
import { backend, origin } from "../../../../src/server";
import { safeNext } from "../../../../src/identity";
import { authPagePath, authQuery } from "../../../../src/auth-pages";
import { normalizeReferralCode, referralConfig } from "../../../../src/referrals";

// Request a magic link. The response is the same whether or not an account exists.
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null), email = String(form?.get("email") ?? "").slice(0, 254), next = safeNext(String(form?.get("next") ?? ""));
  // Back to the page the visitor started on (sign in or sign up), with the result.
  // A referral code rides along on the link, and survives the redirect so a retry keeps it.
  const page = origin() + authPagePath(String(form?.get("from") ?? "")), referral = normalizeReferralCode(form?.get("referral")), referralCode = referral && referralConfig().enabled ? referral : null;
  try { await backend().action(api.identityJobs.requestMagicLink, { secret: process.env.SERVICE_SECRET ?? "", email, next, ...(referralCode ? { referralCode } : {}) }); }
  catch { return NextResponse.redirect(`${page}${authQuery({ email: "error", referral })}`, 303); }
  return NextResponse.redirect(`${page}${authQuery({ email: "sent", referral })}`, 303);
}
