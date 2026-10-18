import { cookies } from "next/headers";
import { api } from "../../../../convex/_generated/api";
import { backend } from "../../../../src/server";
import { userJotConfig, userJotIdentity } from "../../../../src/userjot";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };
// The signed-in user for the UserJot widget (app/userjot.tsx). Anonymous visitors get 204, never a redirect.
export async function GET() {
  const config = userJotConfig();
  if (!config) return Response.json({ error: "Not found" }, { status: 404, headers });
  const token = (await cookies()).get("openreview_session")?.value;
  const me = token ? await backend().query(api.users.me, { token }).catch(() => null) : null;
  if (!me) return new Response(null, { status: 204, headers });
  return Response.json(await userJotIdentity(me, config), { headers });
}
