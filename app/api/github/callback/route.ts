import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { cookieOptions, current, origin, seal, unseal } from "../../../../src/server";
import { notify } from "../../../../src/toast";
import { githubCredentials, linkInstallation } from "../../../../src/github-link";
import { defaultInstallReturn, installFailurePath, installReturnPath, installStateMaxAge, installTarget, linkHref, resumePath, setupActionMessage } from "../../../../src/github-install";

// GitHub's Setup URL. Large organizations need one admin check per repository.
export const maxDuration = 120;

export async function GET(request: Request) {
  const url = new URL(request.url), resume = resumePath(url);
  const { token, user, organizations } = await current(resume);
  const jar = await cookies();
  const sealed = jar.get("openreview_install_state")?.value;
  const saved = sealed ? await unseal(sealed).catch(() => undefined) : undefined;
  let returnTo = saved ? installReturnPath(saved.returnTo) : defaultInstallReturn;
  try {
    const pending = setupActionMessage(url.searchParams.get("setup_action"));
    if (pending) {
      jar.delete("openreview_install_state");
      throw new Error(pending);
    }
    if (!saved || !url.searchParams.get("state")) {
      // No install in progress in this browser (the state expired), or GitHub came back from its
      // configure page without one. The recovery page lists the installations to link or refresh.
      jar.delete("openreview_install_state");
      const workspace = organizations.find((o) => o._id === jar.get("openreview_workspace")?.value && ["owner", "admin"].includes(o.role)) ?? organizations.find((o) => ["owner", "admin"].includes(o.role));
      if (!workspace?._id) throw new Error("Workspace admin required");
      return NextResponse.redirect(`${origin()}${linkHref(workspace._id, defaultInstallReturn)}`);
    }
    if (saved.state !== url.searchParams.get("state")) {
      jar.delete("openreview_install_state");
      throw new Error("Installation state mismatch; start the install again");
    }
    const target = installTarget(saved, user._id, organizations);
    returnTo = target.returnTo;
    const installationId = z.coerce.number().int().positive().safeParse(url.searchParams.get("installation_id"));
    if (!installationId.success) throw new Error("GitHub did not return an installation; start the install again");
    const credentials = await githubCredentials();
    if (!credentials) {
      // The GitHub sign-in token expired while the user was on GitHub. Get a fresh one (this does not
      // sign in again) and come back here once; a second miss ends with a message instead of a loop.
      if (saved.resumed) throw new Error("GitHub sign-in did not finish; use “Link an existing installation”");
      jar.set("openreview_install_state", await seal({ state: saved.state, organizationId: target.organizationId, userId: user._id, returnTo, resumed: true }, `${installStateMaxAge}s`), { ...cookieOptions, maxAge: installStateMaxAge });
      return NextResponse.redirect(`${origin()}/api/auth/login?purpose=github-install&next=${encodeURIComponent(resume)}`);
    }
    const linked = await linkInstallation({ token, organizationId: target.organizationId, installationId: installationId.data, credentials, legacyGithubId: user.githubId });
    jar.delete("openreview_install_state");
    jar.delete("openreview_github_setup");
    await notify(`Connected ${linked.account} (${linked.repositories} ${linked.repositories === 1 ? "repository" : "repositories"})`);
    return NextResponse.redirect(`${origin()}${returnTo}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Installation failed";
    console.error(JSON.stringify({ event: "github.install_failed", error: message.slice(0, 200) }));
    // The wizard shows the message in place; other pages show it as a toast. Never a raw error page.
    if (!returnTo.startsWith("/dashboard/onboarding/")) await notify(`GitHub installation didn’t finish: ${message}`, "error");
    return NextResponse.redirect(`${origin()}${installFailurePath(returnTo, message)}`);
  }
}
