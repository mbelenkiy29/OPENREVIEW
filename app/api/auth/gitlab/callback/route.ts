import { cookies } from "next/headers";
import { finishOAuth } from "../../../../../src/oauth-flow";
import { gitlabProfile } from "../../../../../src/identity";
import { cookieOptions, seal } from "../../../../../src/server";

export async function GET(request: Request) {
  let token = "", scope = "";
  return finishOAuth(request, "gitlab", (code, redirectUri) => gitlabProfile(code, redirectUri, fetch, (t, s) => { token = t; scope = s; }), async () => {
    // Only the "Join a team" re-authorization grants read_api; keep that token 10 minutes, like GitHub's setup token.
    if (scope.split(" ").includes("read_api")) (await cookies()).set("openreview_gitlab_setup", await seal({ token }), { ...cookieOptions, maxAge: 600 });
  });
}
