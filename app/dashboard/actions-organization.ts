"use server";
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend, current, origin } from "../../src/server";
import { emailOnWeb } from "../../src/email";
import { notify } from "../../src/toast";
import { githubCredentials, userInstallations } from "../../src/github-link";

// Convex errors carry request IDs and stack frames; show only their message.
const message = (e: unknown, fallback: string) => /Uncaught Error: ([^\n]+?)(?:\s+at |\n|$)/.exec(e instanceof Error ? e.message : "")?.[1] ?? fallback;

export type InviteState = { sent?: number; note?: string; error?: string };
// People → Invite people: one field takes an email address (single-use link, needs email delivery) or a GitHub login.
export async function inviteMember(_state: InviteState, form: FormData): Promise<InviteState> {
  const { token } = await current();
  const who = String(form.get("who") ?? "").trim(), organizationId = String(form.get("organizationId")) as Id<"organizations">;
  const role = z.enum(["admin", "member", "viewer"]).safeParse(form.get("role"));
  if (!who || !role.success) return { error: "Enter an email address or GitHub login and choose a role." };
  const email = who.includes("@") && !who.startsWith("@");
  if (email && !emailOnWeb()) return { error: "Email delivery isn’t configured on this deployment, so invite people by GitHub login." };
  try {
    if (email) {
      const outcome = await backend().action(api.identityJobs.inviteByEmail, { token, organizationId, email: who, role: role.data });
      revalidatePath("/dashboard", "layout");
      return { sent: Date.now(), ...(outcome === "skipped" ? { note: "The invitation is saved, but this deployment didn’t send the email." } : {}) };
    }
    await backend().mutation(api.users.invite, { token, organizationId, githubLogin: who.replace(/^@/, ""), role: role.data });
  } catch (e) { return { error: message(e, "The invitation could not be sent. Check the address or login and try again.") }; }
  revalidatePath("/dashboard", "layout");
  return { sent: Date.now() };
}

// Roles & Access → ⚙: switch to that workspace and open its settings.
export async function openWorkspaceSettings(form: FormData) {
  const user = await current(), id = String(form.get("organizationId"));
  if (!user.organizations.some((o) => o._id === id)) throw new Error("Workspace not accessible");
  const jar = await cookies();
  jar.set("openreview_workspace", id, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  jar.delete("openreview_team");
  revalidatePath("/dashboard", "layout");
  redirect("/dashboard/organization");
}

// Join a Team → Request access. The installations are read again from GitHub here, so Convex can check the team is
// one this GitHub user can see; without a fresh GitHub token, re-authorize first and come back.
export async function requestTeamAccess(form: FormData) {
  const { token } = await current();
  const returnTo = form.get("returnTo") === "/dashboard/onboarding" ? "/dashboard/onboarding" : "/dashboard/account";
  const credentials = await githubCredentials();
  if (!credentials) redirect(`/api/auth/login?purpose=github-install&next=${encodeURIComponent(returnTo)}`);
  try {
    const installationIds = (await userInstallations(credentials.token)).map((i) => i.id);
    await backend().mutation(api.joinRequests.request, { token, secret: process.env.SERVICE_SECRET ?? "", teamId: String(form.get("teamId")) as Id<"teams">, installationIds });
    await notify("Request sent. A team admin will approve it.");
  } catch (e) { await notify(message(e, "The request could not be sent. Try again."), "error"); }
  revalidatePath("/dashboard", "layout");
}

// People → a join request's Approve or Decline.
export async function answerJoinRequest(form: FormData) {
  const { token } = await current();
  const approve = form.get("approve") === "true";
  try {
    await backend().mutation(api.joinRequests.answer, { token, requestId: String(form.get("requestId")) as Id<"joinRequests">, approve });
    await notify(approve ? "Request approved. They are now a Member of this organization and the team." : "Request declined.");
  } catch (e) { await notify(message(e, "The request could not be answered."), "error"); }
  revalidatePath("/dashboard", "layout");
}

export type MemberLinkState = { url?: string; off?: boolean; error?: string };
// People → Member link: a fresh token on each create or reset. Convex keeps only its hash, so the URL shows once.
export async function changeMemberLink(_state: MemberLinkState, form: FormData): Promise<MemberLinkState> {
  const { token } = await current();
  const organizationId = String(form.get("organizationId")) as Id<"organizations">, create = form.get("op") === "create";
  const raw = randomBytes(32).toString("base64url");
  try { await backend().mutation(api.identity.setMemberLink, { token, organizationId, ...(create ? { tokenHash: createHash("sha256").update(raw).digest("hex") } : {}) }); }
  catch (e) { return { error: message(e, "The member link could not be changed.") }; }
  revalidatePath("/dashboard", "layout");
  return create ? { url: `${origin()}/invite?token=${raw}` } : { off: true };
}
