import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { current, seal, cookieOptions, origin } from "../../../../src/server";
import { notify } from "../../../../src/toast";
import { githubCredentials } from "../../../../src/github-link";
import { installFailurePath, installHref, installReturnPath, installStateMaxAge } from "../../../../src/github-install";

export async function GET(request: Request) {
  const url = new URL(request.url),
    orgId = url.searchParams.get("organization"),
    returnTo = installReturnPath(url.searchParams.get("returnTo"));
  const user = await current(orgId ? installHref(orgId, returnTo) : undefined);
  const fail = async (message: string) => {
    if (!returnTo.startsWith("/dashboard/onboarding/")) await notify(message, "error");
    return NextResponse.redirect(`${origin()}${installFailurePath(returnTo, message)}`);
  };
  const membership = user.organizations.find((o) => o._id === orgId);
  if (!orgId || !membership || !["owner", "admin"].includes(membership.role))
    return fail("Only workspace owners and admins can install the GitHub App");
  const slug = process.env.GITHUB_APP_SLUG;
  if (!slug) return fail("GitHub App installs are not configured on this server (GITHUB_APP_SLUG)");
  // The callback verifies the installation with a fresh GitHub user token. When the sign-in token
  // has expired, or the user signed in another way, get one first; this does not sign in again.
  if (!(await githubCredentials())) {
    if (!process.env.GITHUB_CLIENT_ID) return fail("GitHub App installs are not configured on this server (GITHUB_CLIENT_ID)");
    return NextResponse.redirect(`${origin()}/api/auth/login?purpose=github-install&next=${encodeURIComponent(installHref(orgId, returnTo))}`);
  }
  const state = randomBytes(32).toString("hex");
  (await cookies()).set(
    "openreview_install_state",
    await seal({ state, organizationId: orgId, userId: user.user._id, returnTo }, `${installStateMaxAge}s`),
    { ...cookieOptions, maxAge: installStateMaxAge },
  );
  return NextResponse.redirect(
    `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${state}`,
  );
}
