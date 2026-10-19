"use server";
import { cookies } from "next/headers";
import { api } from "../convex/_generated/api";
import { backend } from "../src/server";

/** Marks product milestones as sent to analytics, so they are not sent again. */
export async function reportMilestones(keys: string[]) {
  const token = (await cookies()).get("openreview_session")?.value;
  if (!token || !Array.isArray(keys) || keys.length > 20 || !keys.every((k) => typeof k === "string" && k.length <= 100)) return;
  await backend().mutation(api.analyticsMilestones.markReported, { token, keys }).catch(() => undefined);
}
