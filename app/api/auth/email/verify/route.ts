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
  const next = safeNext(url.searchParams.get("next")).replace(/&/g, "&amp;");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Sign in to OpenReview</title></head><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0"><form method="post" action="/api/auth/email/verify" style="text-align:center"><h1 style="font-size:1.25rem">Sign in to OpenReview</h1><input type="hidden" name="token" value="${token}"><input type="hidden" name="next" value="${next}"><button type="submit" style="font:inherit;padding:.6rem 1.4rem;cursor:pointer">Sign in</button></form></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
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
