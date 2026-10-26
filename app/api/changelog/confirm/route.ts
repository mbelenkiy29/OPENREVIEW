import { NextResponse } from "next/server";
import { api } from "../../../../convex/_generated/api";
import { backend, origin } from "../../../../src/server";

// The link in the confirmation email (no session required): adds the address to the changelog emails.
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const result = token.length > 2000 ? "invalid" : await backend().action(api.changelogJobs.confirm, { secret: process.env.SERVICE_SECRET ?? "", token }).then((ok) => ok ? "confirmed" : "invalid", () => "error");
  return NextResponse.redirect(`${origin()}/changelog?email=${result}#email`);
}
