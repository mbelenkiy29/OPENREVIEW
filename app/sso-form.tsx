"use client";
// /sso/start redirects to the workspace's identity provider, which may be any https host. A sign-in page
// reached by client-side navigation keeps the CSP of the page first loaded, whose form-action is narrow
// (src/security-headers.ts), so once hydrated the form navigates instead of submitting. Before hydration
// the sign-in page was loaded itself and its form-action allows any host.
import type { ReactNode } from "react";

export function SsoForm({ children }: { children: ReactNode }) {
  return <form action="/sso/start" method="get" className="sign-in-form" onSubmit={(event) => {
    event.preventDefault();
    const form = event.currentTarget, url = new URL(form.action);
    new FormData(form).forEach((value, key) => url.searchParams.append(key, String(value)));
    location.assign(url);
  }}>{children}</form>;
}
