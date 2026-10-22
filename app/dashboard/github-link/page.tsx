import Link from "next/link";
import { redirect } from "next/navigation";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { backend, current } from "../../../src/server";
import { githubCredentials, userInstallations, type UserInstallation } from "../../../src/github-link";
import { installHref, installReturnPath, linkHref } from "../../../src/github-install";
import { linkGithubInstallation } from "../actions";

export const metadata = { title: "Link a GitHub installation" };

// Recovery for an OpenReview App installation that exists on GitHub but is not linked to this
// workspace (the install did not return here, or it was installed from github.com directly). Also
// refreshes the repository list of an installation that is already linked.
export default async function GithubLink({ searchParams }: { searchParams: Promise<{ organization?: string; returnTo?: string }> }) {
  const q = await searchParams, returnTo = installReturnPath(q.returnTo), organizationId = q.organization ?? "";
  const here = linkHref(organizationId, returnTo);
  const { token, organizations } = await current(here);
  const organization = organizations.find((o) => o._id === organizationId);
  const back = <p><Link href={returnTo}>Back</Link></p>;
  if (!organization || !["owner", "admin"].includes(organization.role))
    return <main className="welcome"><h1>Link a GitHub installation</h1><p>Only workspace owners and admins can link GitHub installations.</p>{back}</main>;
  if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_APP_SLUG)
    return <main className="welcome"><h1>Link a GitHub installation</h1><p>GitHub App installs are not configured on this server (GITHUB_APP_SLUG and GITHUB_CLIENT_ID).</p>{back}</main>;
  // Listing installations needs a fresh GitHub user token; this re-authorizes without signing in again.
  const credentials = await githubCredentials();
  if (!credentials) redirect(`/api/auth/login?purpose=github-install&next=${encodeURIComponent(here)}`);
  let installations: UserInstallation[] = [], error: string | undefined;
  try { installations = await userInstallations(credentials.token); }
  catch { error = "GitHub didn’t return your installations. Try again in a minute."; }
  const ownership = installations.length ? await backend().query(api.repositories.installationOwnership, { token, secret: process.env.SERVICE_SECRET ?? "", organizationId: organizationId as Id<"organizations">, installationIds: installations.map((i) => i.id) }) : {};
  return <main className="welcome">
    <Link className="brand" href="/dashboard">OpenReview</Link>
    <h1>Link a GitHub installation</h1>
    <p>These are the accounts and organizations where your GitHub user can see the OpenReview App. Link one to <strong>{organization.name}</strong> to review its repositories, or refresh one that is already linked after changing its repository access on GitHub.</p>
    {error && <p role="alert" className="error">{error}</p>}
    {installations.map((i) => {
      const state = ownership[String(i.id)] ?? "none";
      return <form key={i.id} action={linkGithubInstallation} className="card card-head">
        <input type="hidden" name="organizationId" value={organizationId} />
        <input type="hidden" name="installationId" value={i.id} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <div><strong className="mono">{i.account.login}</strong> <span className="muted">{i.account.type === "Organization" ? "organization" : "personal account"}{i.suspended_at ? " · suspended on GitHub" : ""}</span>
          <p className="muted">{state === "here" ? "Linked to this workspace." : state === "elsewhere" ? "Linked to another OpenReview workspace. An installation can belong to only one workspace." : "Not linked yet."}</p></div>
        {state === "elsewhere" || i.suspended_at ? <button type="button" disabled>{state === "elsewhere" ? "Linked elsewhere" : "Suspended"}</button>
          : <button className={state === "here" ? "" : "primary"}>{state === "here" ? "Refresh repositories" : "Link"}</button>}
      </form>;
    })}
    {!error && !installations.length && <p className="muted">No OpenReview installations are visible to your GitHub user yet.</p>}
    {installations.some((i) => ownership[String(i.id)] === "elsewhere") && <p className="muted">An account marked “linked elsewhere” already belongs to another OpenReview workspace. Choosing repositories for it on GitHub changes that workspace, not this one. To review its repositories here, use the workspace it is linked to, or install the App on a different account or organization.</p>}
    <p className="row"><a className="button" href={installHref(organizationId, returnTo)}>Install on another account</a> <Link href={returnTo}>Back</Link></p>
  </main>;
}
