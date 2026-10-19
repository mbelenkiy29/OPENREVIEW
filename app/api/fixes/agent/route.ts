import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { backend, cookieOptions, current, origin, seal, unseal } from "../../../../src/server";
import { githubCredentials } from "../../../../src/github-link";
import { Github } from "../../../../src/github";
import { agentIntentCookie as intentCookie, cloudAgents, cloudComment, githubCommentUrl, handoffMarker, isCloudAgent } from "../../../../src/fix-agents";
import { fixHandoffUrl } from "../../../../src/fix-command";

export const maxDuration = 60;

// Posts the cloud agent hand-off comment as the signed-in developer, with a fresh GitHub user token
// from the App's sign-in (re-authorized once if needed, never stored). Cloud agents ignore comments
// from bots, and the developer's own write access is what they check.
export async function GET(request: Request) {
  const url = new URL(request.url), requestId = url.searchParams.get("request") ?? "";
  const here = `/api/fixes/agent?request=${encodeURIComponent(requestId)}`;
  const { token, user } = await current(here);
  const jar = await cookies();
  const intent = z.object({ requestId: z.string(), userId: z.string(), reviewId: z.string(), finding: z.string().optional(), detoured: z.boolean().optional() }).safeParse(await unseal(jar.get(intentCookie)?.value ?? "").catch(() => undefined));
  if (!intent.success || intent.data.requestId !== requestId || intent.data.userId !== user._id)
    return NextResponse.redirect(`${origin()}/dashboard?error=handoff`);
  const back = (error?: string) => `${origin()}/fix/${encodeURIComponent(intent.data.reviewId)}?${new URLSearchParams({ ...(intent.data.finding ? { finding: intent.data.finding } : {}), handoff: requestId, ...(error ? { error } : {}) })}`;
  const credentials = await githubCredentials();
  if (!credentials) {
    if (intent.data.detoured) { jar.delete(intentCookie); return NextResponse.redirect(back("GitHub sign-in did not finish; start the hand-off again")); }
    jar.set(intentCookie, await seal({ ...intent.data, detoured: true }, "10m"), { ...cookieOptions, maxAge: 600 });
    return NextResponse.redirect(`${origin()}/api/auth/login?purpose=github-act&next=${encodeURIComponent(here)}`);
  }
  let claimed;
  try { claimed = await backendClaim(token, requestId); }
  catch (error) { jar.delete(intentCookie); return NextResponse.redirect(back(message(error))); }
  try {
    const agent = isCloudAgent(claimed.agent) ? claimed.agent : undefined;
    if (!agent) throw new Error("Unknown cloud agent");
    const github = new Github(credentials.token);
    const me = await github.request("/user", z.object({ id: z.number(), login: z.string() }));
    if (claimed.githubId && me.id !== claimed.githubId) throw new Error("You are signed in to GitHub as a different account than the one linked to OpenReview");
    const repository = await github.request(`/repos/${claimed.repository}`, z.object({ permissions: z.object({ push: z.boolean() }).optional() }));
    if (!repository.permissions?.push) throw new Error(`@${me.login} needs write access to ${claimed.repository}; ${cloudAgents[agent].label} only acts on comments from people who can push`);
    const inThread = cloudAgents[agent].placement === "thread" && claimed.commentId !== undefined;
    const findingUrl = claimed.fingerprint ? fixHandoffUrl(process.env.APP_URL, claimed.reviewId, claimed.fingerprint) : undefined;
    const body = cloudComment({ agent, prompt: claimed.prompt, findingUrl, count: claimed.count });
    const posted = await github.reply(claimed.repository, claimed.prNumber, body, inThread ? claimed.commentId : undefined, handoffMarker(requestId));
    return finish(token, requestId, { commentUrl: githubCommentUrl(claimed.repository, claimed.prNumber, posted.id, inThread), postedAs: me.login }, back(), jar);
  } catch (error) {
    return finish(token, requestId, { error: message(error) }, back(), jar);
  }
}
const message = (error: unknown) => (error instanceof Error ? error.message : "Hand-off failed").replace(/^.*Uncaught Error: /s, "").split("\n")[0].slice(0, 300);
async function backendClaim(token: string, requestId: string) {
  return backend().mutation(api.cloudHandoff.claim, { token, secret: process.env.SERVICE_SECRET ?? "", requestId: requestId as Id<"fixRequests"> });
}
async function finish(token: string, requestId: string, result: { commentUrl?: string; postedAs?: string; error?: string }, to: string, jar: Awaited<ReturnType<typeof cookies>>) {
  await backend().mutation(api.cloudHandoff.complete, { token, secret: process.env.SERVICE_SECRET ?? "", requestId: requestId as Id<"fixRequests">, ...result }).catch(() => undefined);
  jar.delete(intentCookie);
  return NextResponse.redirect(to);
}
