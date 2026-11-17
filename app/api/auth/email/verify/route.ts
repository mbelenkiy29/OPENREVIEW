import { createHash } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { api } from "../../../../../convex/_generated/api";
import { backend, origin } from "../../../../../src/server";
import { newSession, safeNext } from "../../../../../src/identity";
import { startSession } from "../../../../../src/oauth-flow";

const valid = (token: string) => /^[A-Za-z0-9_-]{40,64}$/.test(token);

// Opening the link only shows a confirm button: mail scanners that prefetch links must not burn the
// token, and a visitor must not be signed in silently (login CSRF with someone else's link).
export async function GET(request: Request) {
  const url = new URL(request.url), token = url.searchParams.get("token") ?? "";
  if (!valid(token)) return NextResponse.redirect(`${origin()}/login?error=signin`);
  const next = safeNext(url.searchParams.get("next"));
  const query = new URLSearchParams({ token });
  if (next !== "/dashboard") query.set("next", next);
  const response = NextResponse.redirect(`${origin()}/login/verify?${query}`);
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null), token = String(form?.get("token") ?? "");
  // Same-origin only, so another site cannot auto-submit its own link for the visitor.
  if (request.headers.get("origin") !== origin() || !valid(token)) return NextResponse.redirect(`${origin()}/login?error=signin`, 303);
  const session = newSession();
  const userId = await backend().mutation(api.identity.consumeLoginToken, { secret: process.env.SERVICE_SECRET ?? "", tokenHash: createHash("sha256").update(token).digest("hex"), sessionHash: session.hash, userAgent: (await headers()).get("user-agent")?.slice(0, 200) ?? undefined }).catch((error) => {
    // An expired or used link returns null without throwing; a throw is Convex failing, which Sentry should see.
    Sentry.captureException(error, { level: "error", fingerprint: ["auth-email-link-failed"], tags: { auth_failure: "email-link" } });
    return null;
  });
  if (!userId) return NextResponse.redirect(`${origin()}/login?error=link`, 303);
  await startSession(userId, session.sid);
  return NextResponse.redirect(origin() + safeNext(String(form?.get("next") ?? "")), 303);
}
