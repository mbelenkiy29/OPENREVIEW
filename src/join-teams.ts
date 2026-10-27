import "server-only";
import { cookies } from "next/headers";
import { z } from "zod";
import { githubCredentials, userInstallations } from "./github-link";
import { gitlabBase, gitlabGroupIds } from "./identity";
import { unseal } from "./server";

// "Join a team" proof, read with the fresh tokens a re-authorization leaves for 10 minutes: the OpenReview App
// installations the GitHub user can see, and the GitLab groups the GitLab user belongs to. Convex matches teams to them.
export const recheck = { github: "/api/auth/login?purpose=github-install&next=", gitlab: "/api/auth/gitlab/login?purpose=gitlab-groups&next=" };
async function gitlabToken() {
  const setup = (await cookies()).get("openreview_gitlab_setup")?.value;
  const parsed = z.object({ token: z.string().min(1) }).safeParse(setup ? await unseal(setup).catch(() => undefined) : undefined);
  return parsed.success ? parsed.data.token : undefined;
}
export async function joinProofs() {
  const [github, gitlab] = await Promise.all([githubCredentials(), gitlabToken()]);
  const [installationIds, groupIds] = await Promise.all([github ? userInstallations(github.token).then((all) => all.map((i) => i.id)) : [], gitlab ? gitlabGroupIds(gitlab) : []]);
  return { github: Boolean(github), gitlab: Boolean(gitlab), args: { installationIds, ...(gitlab ? { gitlab: { instance: gitlabBase(), groupIds } } : {}) } };
}
