import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { current, origin, unseal } from "../../../../src/server";
import { githubCredentials } from "../../../../src/github-link";
import { pullActionSchema } from "../../../../src/pull-actions";
import { actionError, performPullAction, pullIntentCookie, pullIntentSchema } from "../../../../src/pull-actions-server";

// Finishes a dashboard pull request action after the GitHub re-authorization detour.
export async function GET() {
  const { token, user } = await current("/dashboard/pulls");
  const jar = await cookies();
  const intent = pullIntentSchema.safeParse(await unseal(jar.get(pullIntentCookie)?.value ?? "").catch(() => undefined));
  jar.delete(pullIntentCookie);
  const action = intent.success ? pullActionSchema.safeParse(intent.data.request) : null;
  if (!intent.success || intent.data.userId !== user._id || !action?.success) return NextResponse.redirect(`${origin()}/dashboard/pulls`);
  const back = (result: Record<string, string>) => NextResponse.redirect(`${origin()}/dashboard/pulls/pr/${encodeURIComponent(intent.data.pullRequestId)}?${new URLSearchParams(result)}`);
  const credentials = await githubCredentials();
  if (!credentials) return back({ actionError: "GitHub sign-in did not finish; try the action again" });
  try { return back({ acted: await performPullAction(token, intent.data.pullRequestId, credentials, action.data) }); }
  catch (error) { return back({ actionError: actionError(error) }); }
}
