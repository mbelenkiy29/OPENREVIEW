import { NextResponse } from "next/server";
import { api } from "../../../../convex/_generated/api";
import { backend, origin } from "../../../../src/server";
import { emailAddress } from "../../../../src/email";
import { clientIp, ipBucket } from "../../../../src/client-ip";
import { limitKey } from "../../../../src/limit-key";
import { checkTurnstile } from "../../../../src/turnstile";

// The changelog page's email form: mails a confirmation link. The response is the same for every address.
// Like the sign-in form (app/api/auth/email/route.ts), another site's form and a failed bot check stop here.
export async function POST(request: Request) {
  const started = Date.now(), form = await request.formData().catch(() => null), email = String(form?.get("email") ?? "").slice(0, 254);
  const finish = (result: string, decision: string, logged: Record<string, unknown> = {}) => {
    console.log(JSON.stringify({ event: "changelog.subscribe", decision, ...logged, ms: Date.now() - started }));
    return NextResponse.redirect(`${origin()}/changelog?email=${result}#email`, 303);
  };
  if (request.headers.get("origin") !== origin()) return finish("error", "origin_rejected");
  const ip = clientIp(request.headers), ipHash = ip ? await limitKey(ipBucket(ip)) : undefined;
  const domain = emailAddress.safeParse(email).data?.split("@")[1] ?? null, challenge = await checkTurnstile(form, "changelog", { hostname: new URL(origin()).hostname, ip });
  const logged = { domain, ip: ipHash?.slice(0, 10) ?? null, ...(challenge.result ? { turnstile: challenge.result } : {}) };
  if (!challenge.allowed) return finish("challenge", "challenge_failed", logged);
  const result = await backend().action(api.changelogJobs.subscribe, { secret: process.env.SERVICE_SECRET ?? "", email, ...(ipHash ? { ipHash } : {}) }).then(() => "sent", () => "error");
  return finish(result, result, logged);
}
