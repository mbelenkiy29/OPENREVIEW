import "server-only";
import { cookies } from "next/headers";
import { z } from "zod";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { Github } from "./github";
import { installerGithubId, mapLimit } from "./github-install";
import { backend, unseal } from "./server";

// Linking a GitHub App installation to a workspace. The install callback and the "Link an existing
// installation" page share this one path, so the checks cannot drift apart.
export type GithubCredentials = { token: string; githubUserId?: number };
/** The fresh GitHub user token left by sign-in or the re-authorization detour, while it is valid. */
export async function githubCredentials(): Promise<GithubCredentials | undefined> {
  const setup = (await cookies()).get("openreview_github_setup")?.value;
  if (!setup) return undefined;
  const parsed = z.object({ token: z.string().min(1), githubUserId: z.number().optional() }).safeParse(await unseal(setup).catch(() => undefined));
  return parsed.success ? parsed.data : undefined;
}
const installationSchema = z.object({
  id: z.number(),
  app_id: z.number().optional(),
  account: z.object({ id: z.number(), login: z.string(), type: z.string().optional() }),
  suspended_at: z.string().nullish(),
});
export type UserInstallation = z.infer<typeof installationSchema>;
/** This App's installations that the GitHub user behind `token` can access. */
export async function userInstallations(token: string): Promise<UserInstallation[]> {
  const github = new Github(token), found: UserInstallation[] = [];
  for (let page = 1; page <= 10; page++) {
    const response = await github.request(`/user/installations?per_page=100&page=${page}`, z.object({ installations: z.array(installationSchema) }));
    found.push(...response.installations);
    if (response.installations.length < 100) break;
  }
  // A user token from this App only lists this App's installations; the id check is a second guard.
  const appId = Number(process.env.GITHUB_APP_ID);
  return Number.isInteger(appId) && appId > 0 ? found.filter((i) => i.app_id === undefined || i.app_id === appId) : found;
}
export const alreadyLinkedMessage = (account: string) => `OpenReview is already installed on ${account} for another OpenReview workspace, and each GitHub account or organization belongs to one workspace. Install the App on a different account or organization, or open the workspace it is linked to`;
export async function linkInstallation(a: { token: string; organizationId: string; installationId: number; credentials: GithubCredentials; legacyGithubId?: number }) {
  const installation = (await userInstallations(a.credentials.token)).find((i) => i.id === a.installationId);
  if (!installation) throw new Error("Installation is not accessible to the signed-in GitHub user");
  // Saving repository access for an account that already has the App changes that installation; it
  // stays with the workspace it belongs to. Say so plainly instead of failing deep in linking.
  const owner = await backend().query(api.repositories.installationOwnership, { token: a.token, secret: process.env.SERVICE_SECRET ?? "", organizationId: a.organizationId as Id<"organizations">, installationIds: [a.installationId] });
  if (owner[String(a.installationId)] === "elsewhere") throw new Error(alreadyLinkedMessage(installation.account.login));
  if (installation.suspended_at) throw new Error("This installation is suspended on GitHub; unsuspend it there first");
  const github = await Github.installation(a.installationId),
    repositories = await github.repositories();
  // Installs on the installer's own account need no per-repository admin check.
  if (installation.account.id !== installerGithubId(a.credentials, a.legacyGithubId)) {
    const userGithub = new Github(a.credentials.token);
    await mapLimit(repositories, 8, async (repository) => {
      const access = await userGithub.request(`/repos/${repository.full_name}`, z.object({ permissions: z.object({ admin: z.boolean() }) }));
      if (!access.permissions.admin) throw new Error("Connecting organization repositories requires GitHub repository admin access");
    });
  }
  const rows = repositories.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    defaultBranch: r.default_branch,
    ...(r.owner.type === "Organization" && r.owner.id ? { group: { externalId: String(r.owner.id), name: r.owner.login.slice(0, 100) } } : {}),
  }));
  // Chunks keep each Convex transaction small for large organizations; connect is idempotent.
  for (let start = 0; start === 0 || start < rows.length; start += 100)
    await backend().mutation(api.repositories.connect, {
      token: a.token,
      secret: process.env.SERVICE_SECRET ?? "",
      organizationId: a.organizationId as Id<"organizations">,
      installationId: a.installationId,
      account: installation.account.login,
      accountId: installation.account.id,
      ...(installation.account.type ? { accountType: installation.account.type.slice(0, 40) } : {}),
      ...(github.permissions ? { permissions: github.permissions } : {}),
      repositories: rows.slice(start, start + 100),
    });
  return { account: installation.account.login, repositories: repositories.length };
}
