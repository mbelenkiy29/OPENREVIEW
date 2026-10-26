import "server-only";
import { z } from "zod";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { Github } from "./github";
import type { GithubCredentials } from "./github-link";
import { backend } from "./server";
import { runPullAction, type PullAction } from "./pull-actions";

// Cookie that carries a dashboard action across the GitHub re-authorization detour (sealed, 10 minutes).
export const pullIntentCookie = "openreview_pull_action";
export const pullIntentSchema = z.object({ userId: z.string(), pullRequestId: z.string(), request: z.record(z.string(), z.unknown()) });
export async function performPullAction(token: string, pullRequestId: string, credentials: GithubCredentials, action: PullAction) {
  const target = await backend().query(api.pulls.actionTarget, { token, pullRequestId: pullRequestId as Id<"pullRequests"> });
  const github = new Github(credentials.token);
  const me = await github.request("/user", z.object({ id: z.number(), login: z.string() }));
  // The fresh token must belong to a GitHub account this OpenReview user signed in with.
  if (!target.githubIds.includes(me.id)) throw new Error(`You are signed in to GitHub as @${me.login}, which is not linked to this OpenReview account`);
  const done = await runPullAction(github, target.fullName, target.number, action);
  await backend().mutation(api.pulls.recordAction, { token, pullRequestId: pullRequestId as Id<"pullRequests">, action: action.action }).catch(() => undefined);
  return `${done} as @${me.login}`;
}
export const actionError = (error: unknown) => (error instanceof Error ? error.message : "Action failed").replace(/^.*Uncaught Error: /s, "").split("\n")[0].slice(0, 300);
