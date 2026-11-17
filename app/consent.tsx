"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { loadAnalytics, withLoadedAnalytics } from "../src/analytics-loader";
import { clearAnalyticsStorage, consentCookieValue, consentReopenEvent, needsChoice, type Consent } from "../src/consent";
import { posthogToken } from "../src/telemetry";

const signals = () => navigator as Navigator & { globalPrivacyControl?: boolean };

/** Cookie consent for analytics: shown until the visitor chooses, and again from "Cookie settings". */
export function ConsentBanner() {
  const [open, setOpen] = useState(false);
  const first = useRef<HTMLButtonElement>(null), banner = useRef<HTMLElement>(null), focusNext = useRef(false);
  useEffect(() => {
    // Decided after mount: the cookie and browser signals are only known in the browser.
    setOpen(needsChoice(Boolean(posthogToken), document.cookie, signals()));
    const reopen = () => { focusNext.current = true; setOpen(Boolean(posthogToken)); };
    window.addEventListener(consentReopenEvent, reopen);
    return () => window.removeEventListener(consentReopenEvent, reopen);
  }, []);
  // Reopened from "Cookie settings": move focus into the banner. A first visit never steals focus.
  useEffect(() => {
    if (open && focusNext.current) { focusNext.current = false; first.current?.focus(); }
  }, [open]);
  // Marketing pages pad by the painted height so a fixed banner never covers primary actions.
  // Auth screens take the banner out of `position: fixed` instead (see `.consent` in globals.css).
  useEffect(() => {
    const root = document.documentElement;
    if (!open) {
      root.style.removeProperty("--consent-h");
      return;
    }
    const el = banner.current;
    if (!el) return;
    const sync = () => root.style.setProperty("--consent-h", `${Math.ceil(el.getBoundingClientRect().height)}px`);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => { observer.disconnect(); root.style.removeProperty("--consent-h"); };
  }, [open]);
  if (!open) return null;
  const choose = (choice: Consent) => {
    document.cookie = consentCookieValue(choice, location.protocol === "https:");
    // Accepting downloads PostHog; declining clears its storage and stops it only if it was running.
    if (choice === "granted") void loadAnalytics().then((a) => a.startAnalytics());
    else { clearAnalyticsStorage(); withLoadedAnalytics((a) => a.stopAnalytics()); }
    setOpen(false);
  };
  return <section ref={banner} className="consent" aria-labelledby="consent-heading">
    <div className="consent-copy">
      <h2 id="consent-heading">Analytics cookies</h2>
      <p>May we use cookies to count visits and measure ads? No tracking on other sites. See the <Link href="/privacy">Privacy Policy</Link>.</p>
    </div>
    <div className="consent-actions">
      <button ref={first} type="button" onClick={() => choose("denied")}>Decline</button>
      <button type="button" onClick={() => choose("granted")}>Accept</button>
    </div>
  </section>;
}

/** Footer link that reopens the banner so a visitor can change their choice. */
export function CookieSettings() {
  if (!posthogToken) return null;
  return <> · <button type="button" className="link-button" onClick={() => window.dispatchEvent(new Event(consentReopenEvent))}>Cookie settings</button></>;
}
