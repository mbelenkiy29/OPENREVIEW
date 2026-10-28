import "server-only";
import { randomBytes } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { ConvexError } from "convex/values";
import { z } from "zod";
import { api } from "../convex/_generated/api";
import { backend, cookieOptions, origin, seal, signSession, unseal } from "./server";
import { newSession, safeNext, type Profile } from "./identity";
import { authQuery } from "./auth-pages";
import { normalizeReferralCode, referralConfig } from "./referrals";
import { notify } from "./toast";

// Shared OAuth sign-in: sealed one-time state, server-side session creation, optional explicit
// linking (`?link=1` while signed in), a safe same-origin `next` redirect, and a referral code
// (`?referral=`) carried to account creation.
type Provider = "github" | "gitlab" | "google";
const stateCookie = (provider: Provider) => provider === "github" ? "openreview_oauth_state" : `openreview_oauth_${provider}`;
export const callbackUrl = (provider: Provider) => `${origin()}/api/auth/${provider === "github" ? "" : provider + "/"}callback`;
export async function beginOAuth(request: Request, provider: Provider, authorize: (state: string, redirectUri: string) => string) {
  const url = new URL(request.url), state = randomBytes(32).toString("hex");
  // A signed-in user re-authorizes GitHub only for a fresh GitHub token, without signing in again:
  // "github-install" verifies an App installation, "github-act" posts a comment as the user (cloud agents).
  // "gitlab-groups" asks GitLab for read_api to list the user's groups for "Join a team".
  const asked = url.searchParams.get("purpose"), link = url.searchParams.get("link") === "1";
  const purpose = provider === "github" && (asked === "github-install" || asked === "github-act") ? asked : provider === "gitlab" && asked === "gitlab-groups" ? asked : undefined;
  const referral = link || purpose ? null : normalizeReferralCode(url.searchParams.get("referral"));
  (await cookies()).set(stateCookie(provider), await seal({ state, next: safeNext(url.searchParams.get("next")), link, ...(purpose ? { purpose } : {}), ...(referral ? { referral } : {}) }), { ...cookieOptions, maxAge: 600 });
  return NextResponse.redirect(authorize(state, callbackUrl(provider)));
}
export async function startSession(userId: string, sid: string) {
  const jar = await cookies();
  // A GitHub token left by an earlier sign-in on this browser belongs to that user; a GitHub sign-in sets its own after this.
  jar.delete("openreview_github_setup");
  jar.delete("openreview_gitlab_setup");
  jar.set("openreview_session", await signSession(userId, sid), { ...cookieOptions, maxAge: 7 * 86400 });
}
export async function finishOAuth(request: Request, provider: Provider, profile: (code: string, redirectUri: string) => Promise<Profile>, after?: () => Promise<void>) {
  const url = new URL(request.url), jar = await cookies(), cookie = jar.get(stateCookie(provider))?.value;
  jar.delete(stateCookie(provider));
  // Where a failure happened: "state" (an expired or replayed visit, or a cancel at the provider: the visitor's doing),
  // "provider" (exchanging the code or reading the profile) or "account" (creating the session).
  let next = "/dashboard", referral: string | undefined, link = false, stage: "state" | "provider" | "account" = "state";
  try {
    const code = url.searchParams.get("code");
    if (!cookie) throw new Error("Missing OAuth state or code");
    const saved = z.object({ state: z.string(), next: z.string().optional(), link: z.boolean().optional(), purpose: z.enum(["github-install", "github-act", "gitlab-groups"]).optional(), referral: z.string().optional() }).passthrough().parse(await unseal(cookie));
    referral = saved.referral; link = saved.link === true; next = safeNext(saved.next);
    if (!code || code.length > 2000) throw new Error("Missing OAuth state or code");
    if (saved.state !== url.searchParams.get("state")) throw new Error("OAuth state mismatch");
    if (saved.purpose) {
      // No sign-in, session or identity link: keep the current session and hand the fresh GitHub
      // token to the flow that asked for it, which re-checks the user and workspace.
      const current = jar.get("openreview_session")?.value;
      if (!current || !(await backend().query(api.identity.sessionValid, { token: current }).catch(() => false))) throw new Error(`Sign in to OpenReview before re-authorizing ${provider === "github" ? "GitHub" : "GitLab"}`);
      stage = "provider";
      await profile(code, callbackUrl(provider));
      await after?.();
      return NextResponse.redirect(origin() + next);
    }
    stage = "provider";
    const p = await profile(code, callbackUrl(provider)), session = newSession();
    stage = "account";
    const linkToken = saved.link ? jar.get("openreview_session")?.value : undefined;
    // Sent only while the web app has the program on, so an older backend never sees the argument.
    const referralCode = !saved.link && referralConfig().enabled ? normalizeReferralCode(saved.referral) : null;
    const userId = await backend().mutation(api.identity.signIn, { secret: process.env.SERVICE_SECRET ?? "", provider, ...p, sessionHash: session.hash, userAgent: (await headers()).get("user-agent")?.slice(0, 200) ?? undefined, ...(linkToken ? { linkToken } : {}), ...(referralCode ? { referralCode } : {}) });
    await startSession(userId, session.sid);
    await after?.();
    return NextResponse.redirect(origin() + next);
  } catch (error) {
    console.error(JSON.stringify({ event: "auth.failed", provider, stage, error: error instanceof Error ? error.message.slice(0, 200) : "Authentication failed" }));
    // Provider and account failures go to Sentry, one issue per provider and step. State failures don't, nor do the
    // refusals the visitor can act on, which the backend throws as ConvexErrors (an account someone else holds,
    // or linking that needs a fresh sign-in).
    if (stage === "provider" || (stage === "account" && !(error instanceof ConvexError))) Sentry.captureException(error, { level: "error", fingerprint: ["auth-oauth-failed", provider, stage], tags: { auth_failure: "oauth", auth_provider: provider, auth_stage: stage } });
    // A failed link returns to the page it started from: /login would offer a plain sign-in, which makes a separate account.
    if (link) { await notify("Couldn’t link that account. It may belong to another OpenReview user, or you need to sign out and back in first.", "error"); return NextResponse.redirect(origin() + next); }
    return NextResponse.redirect(`${origin()}/login${authQuery({ error: "signin", referral })}`);
  }
}
