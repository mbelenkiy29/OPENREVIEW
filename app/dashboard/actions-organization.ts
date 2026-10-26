"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend, current } from "../../src/server";
import { emailOnWeb } from "../../src/email";

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
