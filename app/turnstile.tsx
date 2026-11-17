"use client";
// Cloudflare Turnstile inside a form; the route checks the token (src/turnstile.ts). The widget adds
// the hidden cf-turnstile-response field itself and usually shows nothing ("interaction-only"). The
// script is added from this bundle, which the page CSP's 'strict-dynamic' allows. A submit waits for
// the token and then goes through, so an autofilled form sent at once still carries one; if the
// script fails, stalls for 10 seconds or cannot render, the submit goes ahead and the server answers.
// It waits in monitor mode too, so monitor's log lines show what enforcing would refuse. When
// Cloudflare promotes the widget to a visible check, the form says so and submits itself once the
// token is issued.
import { useEffect, useRef, useState } from "react";

export const turnstileChallengeCopy = "Complete the check below to continue";

type Turnstile = { render: (element: HTMLElement, options: Record<string, unknown>) => string; remove: (id: string) => void };
declare global {
  interface Window { turnstile?: Turnstile }
}
let loading: Promise<Turnstile | null> | undefined;
const load = () => loading ??= new Promise((resolve) => {
  if (window.turnstile) return resolve(window.turnstile);
  const stalled = setTimeout(() => resolve(null), 10_000), done = (value: Turnstile | null) => { clearTimeout(stalled); resolve(value); };
  document.head.appendChild(Object.assign(document.createElement("script"), { src: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", async: true, onload: () => done(window.turnstile ?? null), onerror: () => done(null) }));
});

export function TurnstileField({ siteKey, action }: { siteKey: string; action: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [prompt, setPrompt] = useState(false);
  useEffect(() => {
    const element = ref.current, form = element?.closest("form");
    if (!element || !form) return;
    let token = "", waiting = false, unavailable = false, id: string | undefined, active = true;
    const submitter = () => form.querySelector<HTMLButtonElement>("button:not([type]), button[type=submit]");
    const busy = (on: boolean) => { const button = submitter(); if (button) button.disabled = on; form.setAttribute("aria-busy", on ? "true" : "false"); };
    const release = () => {
      if (!waiting) return;
      waiting = false;
      if (active) setPrompt(false);
      busy(false);
      form.requestSubmit();
    };
    const onSubmit = (event: SubmitEvent) => {
      if (token || unavailable) return;
      event.preventDefault();
      waiting = true;
      busy(true);
    };
    form.addEventListener("submit", onSubmit);
    void load().then((turnstile) => {
      if (!active) return;
      if (!turnstile) { unavailable = true; return release(); }
      try {
        id = turnstile.render(element, {
          sitekey: siteKey, action, appearance: "interaction-only",
          callback: (value: string) => { token = value; release(); },
          "expired-callback": () => { token = ""; },
          "error-callback": () => { unavailable = true; release(); },
          "before-interactive-callback": () => { if (active) setPrompt(true); },
        });
      } catch { unavailable = true; release(); }
    });
    return () => { active = false; busy(false); form.removeEventListener("submit", onSubmit); if (id) window.turnstile?.remove(id); };
  }, [siteKey, action]);
  return <>
    {prompt && <p className="turnstile-prompt" role="status">{turnstileChallengeCopy}</p>}
    <div ref={ref} className="turnstile" />
  </>;
}
