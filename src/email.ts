import { z } from "zod";
import { egressAllowed } from "./egress";

// Transactional email through Resend (https://resend.com/docs/api-reference/emails/send-email).
// Without RESEND_API_KEY and EMAIL_FROM every send is skipped, never an error.
export const emailAddress = z.string().trim().toLowerCase().max(254).email();
/** The mailbox an address reaches, for rate limits only: `+tag` dropped on every domain, and Gmail's
 *  dots and googlemail.com folded too, so variants of one inbox share a limit. Never an identity or a
 *  delivery address: those stay the address as typed (emailAddress). */
export function canonicalEmail(email: string) {
  const address = email.trim().toLowerCase(), at = address.lastIndexOf("@");
  if (at < 1) return address;
  const domain = address.slice(at + 1) === "googlemail.com" ? "gmail.com" : address.slice(at + 1), local = address.slice(0, at).split("+")[0] || address.slice(0, at);
  return `${domain === "gmail.com" ? local.replace(/\./g, "") : local}@${domain}`;
}
export function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM) && egressAllowed("email");
}
// The web app shows email sign-in and email invitations when Convex can send mail; the Resend key
// lives in Convex, so the web app needs EMAIL_SIGN_IN=true (or the same keys) to know.
export const emailOnWeb = () => (process.env.EMAIL_SIGN_IN === "true" || emailConfigured()) && egressAllowed("email");
const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Subject, plain text and an HTML version in OpenReview's brand (brand/README.md): ink text on light ink,
 *  the app icon, one ink button. Inline styles and tables only, since email clients ignore stylesheets. */
export function brandedEmail(origin: string, e: { subject: string; paragraphs: string[]; action: { label: string; path: string } }) {
  const url = `${origin}${e.action.path}`, font = "Inter,system-ui,-apple-system,'Segoe UI','Helvetica Neue',Arial,sans-serif";
  const paragraphs = e.paragraphs.map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:24px;">${escapeHtml(p)}</p>`).join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(e.subject)}</title></head><body style="margin:0;padding:0;background:#edecec;">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#edecec;font-family:${font};color:#26251e;"><tr><td align="center" style="padding:32px 16px;">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;"><tr><td style="padding:32px;">`
    + `<p style="margin:0 0 28px;"><img src="${escapeHtml(origin)}/apple-icon.png" width="32" height="32" alt="" style="border-radius:7px;vertical-align:middle;border:0;"><span style="margin-left:10px;font-size:16px;font-weight:600;letter-spacing:-0.01em;vertical-align:middle;">OpenReview</span></p>`
    + `<h1 style="margin:0 0 16px;font-size:22px;line-height:30px;font-weight:600;letter-spacing:-0.02em;">${escapeHtml(e.subject)}</h1>${paragraphs}`
    + `<p style="margin:24px 0 0;"><a href="${escapeHtml(url)}" style="display:inline-block;background:#26251e;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:12px 20px;border-radius:8px;">${escapeHtml(e.action.label)}</a></p>`
    + `</td></tr></table><p style="margin:16px 0 0;font-size:12px;line-height:18px;color:#6f6d66;">OpenReview · <a href="${escapeHtml(origin)}" style="color:#6f6d66;">${escapeHtml(new URL(origin).host)}</a></p></td></tr></table></body></html>`;
  return { subject: e.subject, text: `${e.paragraphs.join("\n\n")}\n\n${e.action.label}: ${url}`, html };
}
/** `tags` (letters, digits, `_` and `-`) label the message in Resend's logs and webhooks. */
export async function sendEmail(message: { to: string; subject: string; text: string; html?: string; tags?: { name: string; value: string }[] }, fetchImpl: typeof fetch = fetch): Promise<{ id: string } | { skipped: string }> {
  if (!emailConfigured()) return { skipped: "Email delivery is not configured" };
  const to = emailAddress.parse(message.to);
  const response = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject: message.subject.replace(/[\r\n]+/g, " ").slice(0, 200), text: message.text.slice(0, 50000), ...(message.html ? { html: message.html } : {}), ...(message.tags?.length ? { tags: message.tags } : {}) }),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  const data = (await response.json().catch(() => null)) as { id?: unknown } | null;
  if (!response.ok || typeof data?.id !== "string") throw new Error(`Email provider returned HTTP ${response.status}`);
  return { id: data.id };
}
