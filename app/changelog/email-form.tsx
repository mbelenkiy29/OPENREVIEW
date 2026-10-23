"use client";
import { useEffect, useState } from "react";

const notes: Record<string, string> = {
  sent: "Check your inbox for a link to confirm.",
  confirmed: "You're subscribed. Updates arrive at most once a week, and every email has an unsubscribe link.",
  invalid: "That confirmation link is invalid or has expired. Subscribe again for a new one.",
  error: "Something went wrong. Try again in a few minutes.",
};

/**
 * Changelog updates by email (convex/changelogJobs.ts). The page is static, so the result of
 * subscribing or confirming comes back as `?email=` and is read here.
 */
export function ChangelogEmail() {
  const [note, setNote] = useState("");
  useEffect(() => { setNote(notes[new URLSearchParams(location.search).get("email") ?? ""] ?? ""); }, []);
  return <form id="email" action="/api/changelog/subscribe" method="post" className="changelog-email">
    <label>Email<input type="email" name="email" required maxLength={254} autoComplete="email" placeholder="you@company.com" /></label>
    <button>Subscribe</button>
    <p role="status" className="muted">{note}</p>
  </form>;
}
