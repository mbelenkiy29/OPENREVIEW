import { safeNext } from "./identity";

// Where the GitHub App installation flow may return to after GitHub redirects back.
const returnPaths = ["/dashboard/onboarding/connect", "/dashboard/providers", "/dashboard/repositories"] as const;
export const defaultInstallReturn = "/dashboard/repositories";
/** The sealed install state lives this long, so a slow install on GitHub can still finish. */
export const installStateMaxAge = 1800;
export function installReturnPath(value: unknown): string {
  return typeof value === "string" && (returnPaths as readonly string[]).includes(value) ? value : defaultInstallReturn;
}
export function installHref(organizationId: string, returnTo: string) {
  return `/api/github/install?organization=${encodeURIComponent(organizationId)}&returnTo=${encodeURIComponent(installReturnPath(returnTo))}`;
}
/** The recovery page that links an installation that already exists on GitHub. */
export function linkHref(organizationId: string, returnTo: string) {
  return `/dashboard/github-link?organization=${encodeURIComponent(organizationId)}&returnTo=${encodeURIComponent(installReturnPath(returnTo))}`;
}
/** The callback URL to come back to after a fresh GitHub sign-in: only the parameters GitHub sends. */
export function resumePath(url: URL) {
  const query = new URLSearchParams();
  for (const key of ["installation_id", "setup_action", "state"]) {
    const value = url.searchParams.get(key);
    if (value && /^[A-Za-z0-9_-]{1,100}$/.test(value)) query.set(key, value);
  }
  const path = `/api/github/callback${query.size ? "?" + query.toString() : ""}`;
  return safeNext(path) === path ? path : "/api/github/callback";
}
/** GitHub sends `setup_action=request` when an organization owner must approve the install first. */
export function setupActionMessage(action: string | null) {
  return action === "request"
    ? "your request was sent to the organization’s owners. After one of them approves it, use “Link an existing installation”"
    : undefined;
}
/** Where a failed or unfinished install lands: the wizard shows the message in place; other pages show a toast. */
export function installFailurePath(returnTo: string, message: string) {
  const path = installReturnPath(returnTo);
  return path.startsWith("/dashboard/onboarding/") ? `${path}?error=github-install&message=${encodeURIComponent(message.slice(0, 200))}` : path;
}

// Callback checks on the sealed install state: it must belong to the current user, who must still
// administer the target workspace when GitHub redirects back.
type Membership = { _id?: string; role: string };
export function installTarget(saved: Record<string, unknown>, userId: string, organizations: readonly Membership[]) {
  if (typeof saved.userId !== "string" || saved.userId !== userId) throw new Error("Installation was started by another session");
  const organizationId = typeof saved.organizationId === "string" ? saved.organizationId : "";
  const membership = organizations.find((o) => o._id === organizationId);
  if (!membership || !["owner", "admin"].includes(membership.role)) throw new Error("Workspace admin required");
  return { organizationId, returnTo: installReturnPath(saved.returnTo) };
}
/** The GitHub account id the installer authenticated as (fresh token first, then the legacy sign-in id). */
export function installerGithubId(credentials: Record<string, unknown>, legacyGithubId: number | undefined) {
  return typeof credentials.githubUserId === "number" ? credentials.githubUserId : legacyGithubId;
}
/** Runs `work` over `items` with at most `limit` in flight; the first failure stops new work and rejects. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0, failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await work(items[index]); }
      catch (error) { failed = true; throw error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
