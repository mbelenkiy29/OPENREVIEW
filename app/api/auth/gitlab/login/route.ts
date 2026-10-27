import { NextResponse } from "next/server";
import { beginOAuth } from "../../../../../src/oauth-flow";
import { gitlabAuthorizeUrl } from "../../../../../src/identity";

export async function GET(request: Request) {
  const clientId = process.env.GITLAB_OAUTH_CLIENT_ID;
  if (!clientId || !process.env.GITLAB_OAUTH_CLIENT_SECRET) return NextResponse.json({ error: "Configure GITLAB_OAUTH_CLIENT_ID and GITLAB_OAUTH_CLIENT_SECRET to enable GitLab sign-in." }, { status: 503 });
  // "Join a team" (purpose=gitlab-groups) also asks for read_api to list the user's groups.
  const scope = new URL(request.url).searchParams.get("purpose") === "gitlab-groups" ? "read_user read_api" : "read_user";
  return beginOAuth(request, "gitlab", (state, redirectUri) => gitlabAuthorizeUrl(clientId, redirectUri, state, scope));
}
