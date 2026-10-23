import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { api } from "../../../../convex/_generated/api";
import { backend, origin } from "../../../../src/server";
import { safeNext } from "../../../../src/identity";
import { authPagePath, authQuery } from "../../../../src/auth-pages";
import { normalizeReferralCode, referralConfig } from "../../../../src/referrals";
import { canonicalEmail, emailAddress } from "../../../../src/email";
import { clientIp, ipBucket } from "../../../../src/client-ip";
import { limitKey } from "../../../../src/limit-key";
import { checkTurnstile } from "../../../../src/turnstile";

// Request a magic link. The response is the same whether or not an account exists. Another site's
// form (no same-origin Origin) and a failed bot check (src/turnstile.ts) stop here, before Convex;
// the per-mailbox, per-network and deployment-wide limits are in convex/identity.ts storeLoginToken.
// One log line per request: hashed address and network, the domain, and the decision, never the
// address, the link or the token.
export async function POST(request: Request) {
  const started = Date.now(), rid = crypto.randomUUID();
  const form = await request.formData().catch(() => null), email = String(form?.get("email") ?? "").slice(0, 254), next = safeNext(String(form?.get("next") ?? ""));
  // Back to the page the visitor started on (sign in or sign up), with the result.
  // A referral code rides along on the link, and survives the redirect so a retry keeps it.
  const page = origin() + authPagePath(String(form?.get("from") ?? "")), referral = normalizeReferralCode(form?.get("referral")), referralCode = referral && referralConfig().enabled ? referral : null;
  let logged: Record<string, unknown> = {};
  const finish = (result: "sent" | "busy" | "challenge" | "error", decision: string) => {
    console.log(JSON.stringify({ event: "auth.magic_link", rid, decision, ...logged, ms: Date.now() - started }));
    return NextResponse.redirect(`${page}${authQuery({ email: result, referral })}`, 303);
  };
  if (request.headers.get("origin") !== origin()) return finish("error", "origin_rejected");
  const address = emailAddress.safeParse(email);
  if (!address.success) return finish("error", "invalid");
  const ip = clientIp(request.headers), ipHash = ip ? await limitKey(ipBucket(ip)) : undefined;
  logged = { email: (await limitKey(canonicalEmail(address.data))).slice(0, 10), ip: ipHash?.slice(0, 10) ?? null, domain: address.data.split("@")[1] };
  const challenge = await checkTurnstile(form, "magic_link", { hostname: new URL(origin()).hostname, ip });
  if (challenge.result) logged.turnstile = challenge.result;
  if (!challenge.allowed) return finish("challenge", "challenge_failed");
  try {
    const result = await backend().action(api.identityJobs.requestMagicLink, { secret: process.env.SERVICE_SECRET ?? "", email: address.data, next, requestId: rid, ...(ipHash ? { ipHash } : {}), ...(referralCode ? { referralCode } : {}) });
    if (result.status === "sent" && result.nearCap) Sentry.captureMessage("Sign-in emails passed half of the deployment-wide cap (AUTH_EMAIL_HOURLY/AUTH_EMAIL_DAILY)", { level: "warning", fingerprint: ["auth-email-near-cap"] });
    return finish(result.status === "limited" ? "busy" : "sent", result.status);
  } catch { return finish("error", "error"); }
}
