import { NextResponse } from "next/server";
import { api } from "../../../../convex/_generated/api";
import { backend, origin } from "../../../../src/server";

// The changelog page's email form: mails a confirmation link. The response is the same for every address.
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null), email = String(form?.get("email") ?? "").slice(0, 254);
  const result = await backend().action(api.changelogJobs.subscribe, { secret: process.env.SERVICE_SECRET ?? "", email }).then(() => "sent", () => "error");
  return NextResponse.redirect(`${origin()}/changelog?email=${result}#email`, 303);
}
