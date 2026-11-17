"use client";
import { useEffect, useState } from "react";
import type { AuthMode } from "../src/auth-pages";
import type { TurnstileMode } from "../src/turnstile";
import { TurnstileField } from "./turnstile";
import { Icon } from "./ui/icons";

/** Matches the per-mailbox “one email a minute” limit in convex/identity.ts: a second click
 *  within that window would look like it sent another link. */
const cooldownMs = 60_000;

/** Email magic-link form: keeps the address after send, names it in the field, and shows a
 *  Resend cooldown so a double-click cannot fire a second request. */
export function EmailSignInForm({ next, mode, referral, sentTo, cooldown, turnstile }: {
  next?: string; mode: AuthMode; referral?: string | null; sentTo?: string; cooldown?: boolean;
  turnstile: { mode: TurnstileMode; siteKey?: string };
}) {
  const [email, setEmail] = useState(sentTo ?? "");
  const [until] = useState(() => cooldown && sentTo ? Date.now() + cooldownMs : 0);
  const [now, setNow] = useState(() => Date.now());
  const [submitting, setSubmitting] = useState(false);
  const wait = Math.max(0, until - now);
  const sameAddress = email.trim().toLowerCase() === (sentTo ?? "").toLowerCase();
  const cooling = wait > 0 && sameAddress;
  useEffect(() => {
    if (wait <= 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [wait]);
  const label = cooling ? `Resend link in ${Math.ceil(wait / 1000)}s` : sentTo && sameAddress ? "Resend link" : mode === "signup" ? "Sign up" : "Login";
  return <form action="/api/auth/email" method="post" className={`sign-in-form${cooling ? " cooling" : ""}`} onSubmit={(event) => {
    if (cooling) { event.preventDefault(); return; }
    setSubmitting(true);
  }}>
    {next && <input type="hidden" name="next" value={next} />}
    <input type="hidden" name="from" value={mode} />
    {referral && <input type="hidden" name="referral" value={referral} />}
    <label>Email<input type="email" name="email" required maxLength={254} autoComplete="email" placeholder="me@example.com" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
    <p className="sign-in-hint">We’ll email you a sign-in link. No password needed.</p>
    {turnstile.mode !== "off" && turnstile.siteKey && <TurnstileField siteKey={turnstile.siteKey} action="magic_link" />}
    <button className="primary" disabled={submitting || cooling}>{label}{!cooling && !(sentTo && sameAddress) && <Icon name="arrowRight" />}</button>
    {turnstile.mode === "enforce" && <noscript><p className="muted">Email sign-in needs JavaScript; use another sign-in method.</p></noscript>}
  </form>;
}
