"use node";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { createHash } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";
import { service } from "./auth";
import { emailAddress, emailConfigured, sendEmail } from "../src/email";
import { digestEmail, feedDigest } from "../src/changelog";

// Changelog updates by email. Subscribers are contacts in a Resend segment (RESEND_CHANGELOG_SEGMENT_ID),
// so Resend keeps the list and handles unsubscribing. Signing up is double opt-in: the confirmation
// link carries the address encrypted, so nothing is stored for an address until it is confirmed.
const appOrigin = () => new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
const segment = () => emailConfigured() && process.env.RESEND_CHANGELOG_SEGMENT_ID?.trim() || null;
// service() has already checked SERVICE_SECRET is set wherever this is used.
const linkKey = () => createHash("sha256").update(`changelog-subscription:${process.env.SERVICE_SECRET}`).digest();
const resend = (path: string, method: string, body?: object) => fetch(`https://api.resend.com${path}`, {
  method,
  headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
  body: body && JSON.stringify(body),
  redirect: "error",
  signal: AbortSignal.timeout(15000),
});

export const subscribe = action({ args: { secret: v.string(), email: v.string() }, handler: async (ctx, a): Promise<"sent"> => {
  service(a.secret);
  if (!segment()) throw new Error("Changelog email is not configured");
  const email = emailAddress.parse(a.email);
  await ctx.runMutation(internal.changelog.limitSubscribe, { emailHash: createHash("sha256").update(email).digest("hex") });
  const token = await new EncryptJWT({ email }).setProtectedHeader({ alg: "dir", enc: "A256GCM" }).setAudience("changelog").setExpirationTime("1d").encrypt(linkKey());
  await sendEmail({ to: email, subject: "Confirm your OpenReview changelog emails", text: `Confirm to get what's new in OpenReview by email, at most once a week:\n${appOrigin()}/api/changelog/confirm?token=${token}\n\nThe link expires in 24 hours. If you did not ask for this, ignore this email.` });
  return "sent";
} });

export const confirm = action({ args: { secret: v.string(), token: v.string() }, handler: async (_ctx, a): Promise<boolean> => {
  service(a.secret);
  const id = segment();
  if (!id) return false;
  const email = await jwtDecrypt(a.token, linkKey(), { audience: "changelog", keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"] })
    .then((r) => emailAddress.parse(r.payload.email)).catch(() => null);
  if (!email) return false;
  if ((await resend("/contacts", "POST", { email, unsubscribed: false, segments: [{ id }] })).ok) return true;
  // Resend already has the address (for example, someone who unsubscribed): subscribe it again and add it to the segment.
  const contact = `/contacts/${encodeURIComponent(email)}`;
  const updated = await resend(contact, "PATCH", { unsubscribed: false });
  const added = updated.ok ? await resend(`${contact}/segments/${id}`, "POST") : updated;
  if (!added.ok) throw new Error(`Email provider returned HTTP ${added.status}`);
  return true;
} });

// Weekly (convex/crons.ts): one broadcast to the segment with the changelog entries that went live
// since the last digest. The first run only records what is already there.
export const digest = internalAction({ args: {}, handler: async (ctx): Promise<string> => {
  const id = segment();
  if (!id) return "not configured";
  const response = await fetch(`${appOrigin()}/changelog/feed.xml`, { redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Changelog feed returned HTTP ${response.status}`);
  const previous = await ctx.runQuery(internal.changelog.digestKeys, {});
  const { sections, keys } = feedDigest(await response.text(), new Set(previous?.split(" ")));
  // An empty feed is a broken response, and recording it would mail the whole changelog next time.
  if (!keys.length) throw new Error("Changelog feed has no entries");
  if (previous !== null && sections.length) {
    const sent = await resend("/broadcasts", "POST", { segment_id: id, from: process.env.EMAIL_FROM, name: `Changelog ${new Date().toISOString().slice(0, 10)}`, send: true, ...digestEmail(sections, appOrigin()) });
    if (!sent.ok) throw new Error(`Email provider returned HTTP ${sent.status}`);
  }
  await ctx.runMutation(internal.changelog.recordDigest, { keys: keys.join(" ") });
  return previous === null ? "recorded the current changelog" : `${sections.length} sections sent`;
} });
