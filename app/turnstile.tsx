"use client";
// Cloudflare Turnstile inside a form; the route checks the token (src/turnstile.ts). The widget adds
// the hidden cf-turnstile-response field itself and usually shows nothing ("interaction-only"). The
// script is added from this bundle, which the page CSP's 'strict-dynamic' allows. When the check is
// enforced, a submit waits for the token and then goes through, so an autofilled form sent at once
// still carries one; if the script cannot load, the submit goes ahead and the server answers.
import { useEffect, useRef } from "react";

type Turnstile = { render: (element: HTMLElement, options: Record<string, unknown>) => string; remove: (id: string) => void };
declare global {
  interface Window { turnstile?: Turnstile }
}
let loading: Promise<Turnstile | null> | undefined;
const load = () => loading ??= new Promise((resolve) => {
  if (window.turnstile) return resolve(window.turnstile);
  document.head.appendChild(Object.assign(document.createElement("script"), { src: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", async: true, onload: () => resolve(window.turnstile ?? null), onerror: () => resolve(null) }));
});

export function TurnstileField({ siteKey, action, enforce }: { siteKey: string; action: string; enforce: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current, form = element?.closest("form");
    if (!element || !form) return;
    let token = "", waiting = false, unavailable = false, id: string | undefined, active = true;
    const release = () => { if (waiting) { waiting = false; form.requestSubmit(); } };
    const onSubmit = (event: SubmitEvent) => { if (enforce && !token && !unavailable) { event.preventDefault(); waiting = true; } };
    form.addEventListener("submit", onSubmit);
    void load().then((turnstile) => {
      if (!active) return;
      if (!turnstile) { unavailable = true; return release(); }
      id = turnstile.render(element, {
        sitekey: siteKey, action, appearance: "interaction-only",
        callback: (value: string) => { token = value; release(); },
        "expired-callback": () => { token = ""; },
        "error-callback": () => { unavailable = true; release(); },
      });
    });
    return () => { active = false; form.removeEventListener("submit", onSubmit); if (id) window.turnstile?.remove(id); };
  }, [siteKey, action, enforce]);
  return <div ref={ref} className="turnstile" />;
}
